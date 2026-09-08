package com.roamkeep.app.geofence;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.location.Location;
import android.util.Log;

import com.google.android.gms.location.LocationResult;

import org.json.JSONException;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.TimeZone;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Target of the PendingIntent we hand to
 * FusedLocationProviderClient.requestLocationUpdates(). The OS delivers
 * location batches here even when the Roamkeep process is dead — the
 * whole point of moving breadcrumb logging off the JS path, which Android
 * suspends whenever the WebView is backgrounded.
 *
 * For each location we POST a location_history breadcrumb and refresh the
 * live pin (keep_members.lat/lng).
 *
 * WHY THERE ARE GATES HERE AT ALL. This used to persist whatever the OS
 * handed it, leaning entirely on the request's setMinUpdateDistanceMeters.
 * That gate turned out to be full of holes: every applyProfile() re-arm
 * re-registers the request and so resets its reference point, and the
 * doze-exit one-shot in LocationForegroundService calls getCurrentLocation()
 * and pushes the result straight in here, past the OS filter entirely. On a
 * device that doze-cycles every few minutes — a Pixel in closed testing did
 * exactly this — a stationary phone therefore wrote a cold, fuzzy fix every
 * few minutes, and the History timeline added them up into "Drive · 4.6 km ·
 * top 139 km/h" for an afternoon spent sitting at home.
 *
 * The deeper problem was an ASYMMETRY. GeofenceReceiver already refused to
 * act on an imprecise fix near a boundary (DRIFT_MIN_ACC_M), and
 * LocationForegroundService.detectMoving already refused to believe a fuzzy
 * fix's reported speed (SPEED_TRUST_ACC_M) or a displacement inside its own
 * error (MOVING_DISP_M / MOVING_ACC_MULT). The journal caught the two paths
 * reaching OPPOSITE verdicts about one fix: "arrived Home fuzzy fix ±66m
 * within 46m of edge — drift, dropped", while that same fix was written here
 * without question. So the gates below are not new rules; they are the
 * existing rules, applied to writes, from the same constants.
 *
 * TWO GATES, ANSWERING TWO DIFFERENT QUESTIONS. Getting these confused is
 * what made the first attempt at this fix fall short.
 *
 *   "Has the device MOVED?" cannot be answered from one fix. A single sample
 *   lands beyond any threshold a fixed fraction of the time, however good the
 *   reference you compare it against — so a per-fix test does not stop a
 *   still phone writing, it merely filters the writes down to the BIGGEST
 *   jumps, which the timeline then sums into an even longer phantom. It takes
 *   an AVERAGE, whose noise falls as sqrt(N), to answer it. That is the
 *   stillness gate, and while it says still, nothing is written at all.
 *
 *   "How far apart should recorded points be?" is answered per fix, by the
 *   anchor gate — an anchor that only advances when a fix is accepted, so
 *   that displacement accumulates for a device that is genuinely travelling.
 *
 * THE RULE THEY ARE WRITTEN AGAINST (LocationForegroundService:106-111):
 * never make a real trip harder to record. So every gate here distrusts only
 * IMPRECISE fixes — a fix at or below DRIFT_MIN_ACC_M is written
 * unconditionally, even while the device is judged still — a trusted speed
 * reading alone is enough to count as moving, and an unknown state is
 * assumed to be moving, the same call onDozeExit makes. The cost of guessing
 * "moving" wrongly is a few surplus points; the cost of guessing "still"
 * wrongly is the start of somebody's journey.
 *
 * Mirrors GeofenceReceiver's headless pattern: goAsync() + worker thread,
 * Supabase auth + member context from PrefsStore, one 401 refresh retry
 * handled inside SupabaseRest.
 */
public class LocationUpdateReceiver extends BroadcastReceiver {
    private static final String TAG = "RoamkeepGeo";
    public static final String ACTION = "com.roamkeep.app.LOCATION_UPDATE";

    // Above this error radius a fix is not a position. It cannot tell which
    // side of the timeline's 120 m "is this a trip" line it sits on, so it
    // can manufacture a whole journey by itself. Well above every fix that
    // carries real trail information (a BALANCED_POWER wifi fix is ±20-60 m;
    // this is cell trilateration). Its other job is anchor hygiene: a ±500 m
    // fix must not drag the anchor half a kilometre and re-open the hole.
    private static final float BREADCRUMB_MAX_ACC_M = 150f;

    // ── Stillness ──────────────────────────────────────────────────
    //
    // The anchor gate below sets the SPACING of written points. It cannot
    // decide whether the device is moving at all — no single-fix test can,
    // because one sample lands beyond any threshold a fixed fraction of the
    // time however good the reference. Simulated against the reported fix
    // quality, the anchor gate alone still let a still phone write ~30 points
    // an hour, each one a bigger jump than before, which the timeline sums
    // into kilometres. Averaging is what breaks that: the mean of N fixes has
    // sqrt(N) less noise than one fix, so it can be asked the question.
    //
    // Time constant of the average. 90 s is the compromise: long enough that
    // a still phone's average barely moves, short enough that a real
    // departure is noticed within ~100 m of walking — and MOVING_SPEED_MS
    // below usually notices it long before that anyway.
    private static final long CENTROID_TAU_MS = 90_000;
    // How far the average must move before the device is credited with having
    // gone somewhere. A FLOOR, then scaled by the fix's own error radius —
    // because the averaged noise scales with it too, so a fixed number is
    // either leaky at ±120 m or needlessly deaf at ±25 m. Measured, a flat
    // 50 m still let a ±120 m phone manufacture 4.5 km of phantom in an hour.
    // Scaling keeps the test at a constant number of standard deviations,
    // which is the only version that behaves the same at every fix quality.
    private static final float CENTROID_MOVE_M = 50f;
    // Once movement is confirmed, stop asking for a while — otherwise the
    // stillness test doubles as a second distance filter during travel,
    // thinning trails for no reason; the anchor gate already owns spacing.
    // Kept SHORT because this is the multiplier on a false positive: every
    // spurious "moving" buys a whole grace window of free writing, and at two
    // minutes that was most of the residual phantom.
    private static final long MOVING_GRACE_MS = 60_000;

    // Rate limit on the rejection summary. Same value and same reasoning as
    // LocationForegroundService.RESTORE_JOURNAL_EVERY_MS — the journal is the
    // only witness for a headless bug, and a line that cries wolf is worse
    // than no line at all.
    private static final long REJECT_JOURNAL_EVERY_MS = 30 * 60_000;

    // Pending detail for that summary. Statics, not prefs: a process death
    // under-reports one window, and the lifetime counter in Diagnostics is
    // the authoritative number. Four more prefs keys would cost more than the
    // extra precision is worth.
    private static volatile int   pendDrift, pendStill, pendUnusable;
    private static volatile float pendWorstAcc, pendWorstDist;
    private static volatile long  pendSinceMs;

    @Override
    public void onReceive(Context context, Intent intent) {
        LocationResult result = LocationResult.extractResult(intent);
        if (result == null) return;
        final List<Location> locations = result.getLocations();
        if (locations == null || locations.isEmpty()) return;

        final Context appCtx = context.getApplicationContext();
        final PendingResult pr = goAsync();
        submit(appCtx, locations, pr::finish);
    }

    /**
     * The ONE thread every location delivery is processed on, in order.
     *
     * processLocations is a SEQUENTIAL pipeline: the drift anchor and the
     * stillness average are read, updated from this fix, and written back, so
     * each fix has to see what the one before it left behind. It used to run
     * on a fresh Thread per delivery from three call sites, which broke that
     * outright — two batches read the same anchor, both wrote, and one update
     * was simply lost.
     *
     * The same race quietly ate the diagnostics counters, and it hid well:
     * all four are written in a single edit(), so a lost update drops all
     * four together and the "fires == written + suppressed + rejected"
     * identity keeps balancing perfectly while under-reporting badly. A
     * stationary night journalled 393 dropped fixes while the counters showed
     * 74 — the identity was not evidence of health, it was preserved by
     * construction.
     *
     * PrefsStore's `synchronized` does not help: it locks the instance, and
     * every call site builds its own, so it guards nothing shared.
     *
     * Queueing is what a sequential pipeline wants anyway, and this work is
     * never on the main thread, so a backlog can never ANR — it just delays.
     */
    private static final ExecutorService WORKER =
            Executors.newSingleThreadExecutor(r -> new Thread(r, "RoamkeepLocationWorker"));

    /**
     * Hand a batch to the shared worker. Two batches never run at once,
     * whichever of the three producers they came from.
     *
     * @param onDone run after the batch completes, however it completes —
     *               the receiver uses it to release its goAsync() token.
     */
    static void submit(Context ctx, List<Location> locations, Runnable onDone) {
        WORKER.execute(() -> {
            try {
                processLocations(ctx, locations);
            } catch (Exception e) {
                Log.w(TAG, "location worker failed", e);
            } finally {
                if (onDone != null) onDone.run();
            }
        });
    }

    /**
     * Shared breadcrumb + pin write path, fed by this receiver (legacy
     * PendingIntent deliveries), the LocationForegroundService's in-process
     * LocationCallback (the primary path) and its doze-exit one-shot.
     *
     * PRIVATE on purpose. Every caller must come through submit(), because
     * this reads sequential state (the drift anchor, the stillness average)
     * that two concurrent calls would clobber. It used to be public and each
     * producer span its own thread — which is precisely how that happened.
     */
    private static void processLocations(Context ctx, List<Location> locations) {
        if (locations == null || locations.isEmpty()) return;
        final int n = locations.size();
        final double[] lats = new double[n];
        final double[] lngs = new double[n];
        final long[] times = new long[n];
        final float[] speeds = new float[n];   // m/s; -1 = not reported
        // Horizontal error radius, m; -1 = not reported. A fix with NO
        // accuracy counts as precise for the drop gates below — we never
        // discard a fix we cannot prove is bad, which is the same call
        // GeofenceReceiver makes (its gate requires tAcc != null before it
        // will drop anything). For the speed column the polarity flips, and
        // for the same reason detectMoving flips it: an unverifiable speed
        // is not evidence.
        final float[] accs = new float[n];
        for (int i = 0; i < n; i++) {
            Location l = locations.get(i);
            lats[i] = l.getLatitude();
            lngs[i] = l.getLongitude();
            times[i] = l.getTime() > 0 ? l.getTime() : System.currentTimeMillis();
            speeds[i] = l.hasSpeed() ? l.getSpeed() : -1f;
            accs[i] = l.hasAccuracy() ? l.getAccuracy() : -1f;
        }

        PrefsStore prefs = new PrefsStore(ctx);
        if (!prefs.hasContext()) return;   // not signed in — nothing to write
        if (prefs.isPaused()) return;      // self-paused — write nothing
        SupabaseRest rest = new SupabaseRest(ctx);
        String keepId   = prefs.getKeepId();
        String memberId = prefs.getMemberId();
        List<PrefsStore.Place> places = prefs.getPlaces();

        // The drift anchor: read once, carried in locals through the batch,
        // written back once at the end — one prefs write per fire, matching
        // the existing recordLocationFire cadence rather than one per fix.
        PrefsStore.Anchor anchor = prefs.getBreadcrumbAnchor();
        double aLat = anchor != null ? anchor.lat : Double.NaN;
        double aLng = anchor != null ? anchor.lng : Double.NaN;
        boolean anchorMoved = false;

        // Stillness state, carried in locals through the batch and written
        // back once, like the anchor.
        PrefsStore.Motion m = prefs.getMotion();
        boolean motionValid = m.valid;
        double emaLat = m.emaLat, emaLng = m.emaLng;
        long emaMs = m.emaMs;
        double stillLat = m.stillLat, stillLng = m.stillLng;
        long movingUntilMs = m.movingUntilMs;

        int written = 0, suppressed = 0, rejDrift = 0, rejStill = 0, rejUnusable = 0;
        float worstAcc = 0f, worstDist = 0f;
        for (int i = 0; i < lats.length; i++) {
            final float acc = accs[i];

            // 1. Unusable. Not a trail point at any threshold — and this test
            //    comes FIRST so a wild fix cannot become the anchor, or poison
            //    the average, and drag the reference point off with it.
            if (acc > BREADCRUMB_MAX_ACC_M) { rejUnusable++; continue; }

            // 2. Fold this fix into the running average of where we are.
            //    Every usable fix updates it, including ones rejected below —
            //    it estimates POSITION, not what we chose to store.
            if (!motionValid) {
                // Nothing known yet (fresh install, sign-out, first fire).
                // Seed it and assume MOVING, the same call onDozeExit makes:
                // the cost of a wrong "moving" is a few extra points, and of
                // a wrong "still" is the start of someone's journey.
                emaLat = lats[i]; emaLng = lngs[i];
                stillLat = lats[i]; stillLng = lngs[i];
                movingUntilMs = times[i] + MOVING_GRACE_MS;
                motionValid = true;
            } else {
                double dt = times[i] - emaMs;
                // Weight by elapsed time, so the smoothing is the same
                // whether the profile is delivering every 4 s or every 30 s.
                double alpha = dt <= 0 ? 1.0 : 1.0 - Math.exp(-dt / (double) CENTROID_TAU_MS);
                if (alpha > 1.0) alpha = 1.0;
                emaLat += alpha * (lats[i] - emaLat);
                emaLng += alpha * (lngs[i] - emaLng);
            }
            emaMs = times[i];

            // 3. Has the device actually gone anywhere? Two ways to say yes,
            //    and only one of them has to hold. A trusted speed reading is
            //    the fastest answer and is the same test detectMoving makes;
            //    the average having left where it sat is the slower one that
            //    works when no speed is reported.
            boolean movingNow = speeds[i] > LocationForegroundService.MOVING_SPEED_MS
                    && acc >= 0 && acc < LocationForegroundService.SPEED_TRUST_ACC_M;
            if (!movingNow) {
                float[] cd = new float[1];
                Location.distanceBetween(stillLat, stillLng, emaLat, emaLng, cd);
                movingNow = cd[0] > Math.max(CENTROID_MOVE_M, acc);
            }
            if (movingNow) {
                stillLat = emaLat; stillLng = emaLng;
                movingUntilMs = times[i] + MOVING_GRACE_MS;
            }

            // 4. Still, and imprecise: write nothing. A PRECISE fix is never
            //    suppressed here — the rule is that a real GPS fix is always
            //    recorded, and a tight cluster of precise fixes is harmless
            //    anyway because the timeline's span test refuses to call
            //    something that never left a 120 m circle a trip.
            if (times[i] > movingUntilMs && acc > GeofenceReceiver.DRIFT_MIN_ACC_M) {
                rejStill++;
                worstAcc = Math.max(worstAcc, acc);
                continue;
            }

            // 5. Anti-drift. Only IMPRECISE fixes are distrusted, exactly as
            //    in GeofenceReceiver: a fix at or below DRIFT_MIN_ACC_M is a
            //    real GPS fix and is written even one metre from the anchor.
            //    The bar is detectMoving's own bar, unchanged — it is simply
            //    asked against a stabler reference. That is not a higher bar:
            //    against the PREVIOUS fix a slow mover can stay below it
            //    forever, while against an anchor that does not move,
            //    displacement accumulates until it clears.
            final boolean precise = acc < 0 || acc <= GeofenceReceiver.DRIFT_MIN_ACC_M;
            if (!precise && !Double.isNaN(aLat)) {
                float[] d = new float[1];
                Location.distanceBetween(aLat, aLng, lats[i], lngs[i], d);
                float need = Math.max(LocationForegroundService.MOVING_DISP_M,
                                      acc * LocationForegroundService.MOVING_ACC_MULT);
                if (d[0] < need) {
                    rejDrift++;
                    worstAcc = Math.max(worstAcc, acc);
                    worstDist = Math.max(worstDist, d[0]);
                    continue;   // anchor NOT advanced — that is the mechanism
                }
            }

            // 6. Accepted as somewhere we genuinely are. The anchor advances
            //    HERE, before the place check, because it tracks where the
            //    device IS and not what we chose to store. If it only moved
            //    on written rows, an evening at home would leave it at the
            //    last outdoor point and every fix near the house would read
            //    as travel the moment someone stepped outside the radius.
            aLat = lats[i];
            aLng = lngs[i];
            anchorMoved = true;

            // 7. Don't record breadcrumbs while inside a saved place —
            // wandering around the house with the phone shouldn't show up
            // as a trip. The live pin (below) still updates so others see
            // you're home; only the trail is suppressed.
            if (isInsideAnyPlace(places, lats[i], lngs[i], acc, movingNow)) { suppressed++; continue; }
            String iso = toIso8601Utc(times[i]);
            try {
                JSONObject row = new JSONObject();
                row.put("keep_id", keepId);
                row.put("member_id", memberId);
                row.put("lat", lats[i]);
                row.put("lng", lngs[i]);
                row.put("recorded_at", iso);
                // GPS speed feeds the timeline's walk/drive classifier;
                // omit when the fix has none so the row stays NULL — and
                // omit it from a fuzzy fix too, which is the same call
                // detectMoving makes for the same reason: a low-power fix
                // invents speed while the device is still. That invention is
                // where the timeline's "top 139 km/h" came from, and it then
                // cleared DRIVE_MAX_MS and labelled an hour of drift a Drive.
                // A NULL here is not a loss: tripStats falls back to the
                // trip's own distance over time.
                if (speeds[i] >= 0 && acc >= 0
                        && acc < LocationForegroundService.SPEED_TRUST_ACC_M) {
                    row.put("speed", (double) speeds[i]);
                }
                if (rest.insertLocationHistory(row)) written++;
            } catch (JSONException e) {
                Log.w(TAG, "breadcrumb payload build failed", e);
            }
        }
        if (anchorMoved) prefs.setBreadcrumbAnchor(aLat, aLng, System.currentTimeMillis());
        if (motionValid) prefs.setMotion(emaLat, emaLng, emaMs, stillLat, stillLng, movingUntilMs);

        // Diagnostics: stamp that we fired and how many points landed vs.
        // were suppressed inside a place vs. rejected as unusable or drift,
        // so the app (and the user) can see whether native breadcrumb logging
        // is running — and whether a low breadcrumb count is throttling,
        // home-suppression, or the drift gate doing its job.
        final int rejected = rejDrift + rejStill + rejUnusable;
        prefs.recordLocationFire(System.currentTimeMillis(), written, suppressed, rejected);
        Log.i(TAG, "location fire: " + lats.length + " fixes, " + written
                + " written, " + suppressed + " suppressed, " + rejected + " rejected");
        if (rejected > 0) journalRejects(prefs, rejDrift, rejStill, rejUnusable, worstAcc, worstDist);

        // Refresh the live pin from the most recent fix in the batch so the
        // map keeps moving for other members even when the BG-geolocation
        // foreground service has been killed by an OEM battery saver.
        //
        // Deliberately NOT gated on any of the above. A drift-rejected fix is
        // still a real location the OS handed us, and GeofenceReceiver sets
        // the same precedent — the family's map must never go staler because
        // we got fussier about the trail. The one exception is an unusable
        // fix, which would teleport the avatar; prefer the last one that
        // cleared the ceiling, and fall back to the raw last if none did.
        int last = lats.length - 1;
        for (int i = lats.length - 1; i >= 0; i--) {
            if (accs[i] <= BREADCRUMB_MAX_ACC_M) { last = i; break; }
        }
        try {
            JSONObject upd = new JSONObject();
            upd.put("lat", lats[last]);
            upd.put("lng", lngs[last]);
            upd.put("last_seen", toIso8601Utc(times[last]));
            upd.put("online", true);
            // Piggyback the battery level so it stays current in the
            // background (the JS battery listener only runs foreground).
            int batt = SupabaseRest.currentBatteryLevel(ctx);
            if (batt >= 0) upd.put("battery", batt);
            rest.updateMember(memberId, upd);
        } catch (JSONException e) {
            Log.w(TAG, "pin update payload build failed", e);
        }

        // Retry any check-ins parked by GeofenceReceiver. A queued entry
        // means the POST failed at the boundary crossing (classically the
        // WiFi → cellular handoff while leaving home), and until now the
        // retry waited for the NEXT geofence fire or app open — which
        // could be hours, with the family seeing no "left" alert the
        // whole time even though breadcrumbs were flowing happily on the
        // recovered network. These fires run every few seconds on the
        // move, so a fire with a non-empty queue is both the earliest
        // and the best-evidenced moment to retry (drain stops on first
        // hard failure, so a still-dead network costs one request).
        if (prefs.pendingCount() > 0) {
            int drained = GeofenceReceiver.drainPendingCheckins(prefs, rest);
            if (drained > 0) {
                prefs.journal("drain: " + drained + " queued checkin(s) delivered on breadcrumb fire");
            }
        }
    }

    /**
     * Summarise rejections into the journal, at most once every
     * REJECT_JOURNAL_EVERY_MS. Counts accumulate in between so the line
     * describes a window rather than one batch.
     *
     * The line carries "max Nm from anchor" on purpose: it is the built-in
     * falsifier. A gate doing its job reports tens of metres — that is drift
     * being measured. A gate eating a real journey reports hundreds. One
     * number on one line tells the next reader which of the two is happening,
     * without a device in hand.
     */
    private static void journalRejects(PrefsStore prefs, int drift, int still, int unusable,
                                       float worstAcc, float worstDist) {
        final long now = System.currentTimeMillis();
        if (pendSinceMs == 0) pendSinceMs = now;
        pendDrift += drift;
        pendStill += still;
        pendUnusable += unusable;
        pendWorstAcc = Math.max(pendWorstAcc, worstAcc);
        pendWorstDist = Math.max(pendWorstDist, worstDist);

        long lastJournal = prefs.getLastRejectJournal();
        // First ever window: start the clock rather than emitting at once, so
        // a fresh install doesn't open its journal with a rejection line.
        if (lastJournal == 0) { prefs.setLastRejectJournal(now); return; }
        if (now - lastJournal < REJECT_JOURNAL_EVERY_MS) return;

        StringBuilder sb = new StringBuilder("crumbs: ")
                .append(pendDrift + pendStill + pendUnusable)
                .append(" fixes dropped in ").append((now - pendSinceMs) / 60_000).append("m — ");
        boolean first = true;
        if (pendStill > 0) {
            sb.append(pendStill).append(" still");
            first = false;
        }
        if (pendDrift > 0) {
            if (!first) sb.append(", ");
            sb.append(pendDrift).append(" drift (max ")
              .append(Math.round(pendWorstDist)).append("m from anchor)");
            first = false;
        }
        if (pendUnusable > 0) {
            if (!first) sb.append(", ");
            sb.append(pendUnusable).append(" unusable (>")
              .append(Math.round(BREADCRUMB_MAX_ACC_M)).append("m)");
            first = false;
        }
        sb.append(", worst ±").append(Math.round(pendWorstAcc)).append("m");
        prefs.journal(sb.toString());
        prefs.setLastRejectJournal(now);
        pendDrift = 0; pendStill = 0; pendUnusable = 0;
        pendWorstAcc = 0f; pendWorstDist = 0f; pendSinceMs = 0;
    }

    /**
     * True if (lat,lng) falls within the radius of any saved place — or, for
     * an IMPRECISE fix, within its own error of the edge, where it genuinely
     * cannot tell which side it is on.
     *
     * The padding is the same call GeofenceReceiver makes about a crossing,
     * for the same reason: a ±66 m fix landing 46 m outside a home radius is
     * not a walk down the street. Without it, that fix escaped suppression
     * and became a 501 m "Drive" on top of a stay at home.
     *
     * Note the deliberate asymmetry with GeofenceReceiver: there an ambiguous
     * fix drops the transition, here it counts as inside. Both refuse to act
     * on a fix that cannot tell which side it is on.
     *
     * BUT THE PADDING IS CONDITIONAL, and 4.8.6 is where that was learned.
     * Padding unconditionally clips the START OF EVERY DEPARTURE by roughly
     * the fix's own accuracy — on a device running ±50 m that is 50 m of
     * missing trail every time you leave anywhere, which showed up as bike
     * rides beginning well down the road.
     *
     * It is also, by then, protecting almost nothing. The stillness gate
     * (step 4) runs BEFORE this check, so a stationary phone's fuzzy fixes
     * never arrive here at all — they were rejected several steps earlier.
     * The only fix that reaches this padding is one from a device the
     * pipeline already believes is moving, which is exactly when the points
     * are wanted.
     *
     * So pad only when THIS fix shows no movement of its own. A real
     * departure carries a trusted speed or has already dragged the centroid,
     * so movingNow is true and nothing is clipped. Drift leaking through a
     * grace window has neither, so it is still suppressed — which is the one
     * hole the padding was left to cover.
     *
     * A PRECISE fix outside the radius is always a trail point, even right at
     * the edge — so a walk that genuinely starts at the front door is not
     * clipped.
     */
    private static boolean isInsideAnyPlace(List<PrefsStore.Place> places,
                                            double lat, double lng, float acc,
                                            boolean movingNow) {
        if (places == null || places.isEmpty()) return false;
        final boolean fuzzy = !movingNow && acc > GeofenceReceiver.DRIFT_MIN_ACC_M;
        float[] out = new float[1];
        for (PrefsStore.Place p : places) {
            Location.distanceBetween(lat, lng, p.lat, p.lng, out);
            if (out[0] <= p.radius) return true;
            if (fuzzy && Math.abs(out[0] - p.radius) < acc) return true;
        }
        return false;
    }

    private static String toIso8601Utc(long ms) {
        SimpleDateFormat fmt = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        fmt.setTimeZone(TimeZone.getTimeZone("UTC"));
        return fmt.format(new Date(ms));
    }
}
