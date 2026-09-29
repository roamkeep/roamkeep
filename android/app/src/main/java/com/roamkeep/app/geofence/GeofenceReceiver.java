package com.roamkeep.app.geofence;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.location.Location;
import android.util.Log;

import com.google.android.gms.location.Geofence;
import com.google.android.gms.location.GeofenceStatusCodes;
import com.google.android.gms.location.GeofencingEvent;

import org.json.JSONException;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;
import java.util.UUID;

/**
 * Broadcast receiver the OS invokes when a registered geofence
 * transitions ENTER or EXIT — even if the Roamkeep process is
 * not running. This is the whole point of this plugin over the
 * JS-callback approach: the OS wakes *us*, we POST directly to
 * Supabase, done.
 *
 * Uses goAsync() to hold the receiver alive while the HTTP request
 * runs on a worker thread. That buys a bounded window (the broadcast
 * timeout), and a chain of 15 s HTTP timeouts on a bad link can outlast
 * it — which is why every check-in is written to the pending queue
 * BEFORE its POST and leaves it only once it has landed: a process
 * killed mid-request loses nothing. The SupabaseRest helper handles one
 * 401 retry via token refresh.
 */
public class GeofenceReceiver extends BroadcastReceiver {
    private static final String TAG = "RoamkeepGeo";

    // The drift gate below only distrusts IMPRECISE fixes. A fix at or below
    // this accuracy (error radius, m) is a real GPS fix — trusted even right
    // at a boundary, so a genuine crossing (moving between two nearby zones,
    // ±4 m) is never dropped. Stationary drift shows up as much fuzzier
    // network/low-power fixes (±tens of m), which this leaves gated. Tunable.
    // Package-private so LocationUpdateReceiver can gate breadcrumbs on the
    // same definition of "precise". Two subsystems disagreeing about what
    // counts as a real fix is how this bug happened in the first place.
    static final float DRIFT_MIN_ACC_M = 20f;

    // How long "we are inside, but state says we left" must hold before
    // repairMissedArrival believes it and files an arrival.
    //
    // Sized against what it is distinguishing, not picked for feel. Play
    // Services delivers a real ENTER within its own responsiveness window —
    // tens of seconds to a couple of minutes — while a device whose ENTER was
    // lost waits forever. Three minutes sits clear of the first and costs the
    // second nothing, since by then it has usually been stranded for hours.
    //
    // Without a wait the repair simply won the race on EVERY arrival, because
    // "state says outside" is the ordinary condition while you are travelling
    // somewhere. That is not a divergence to repair.
    private static final long REPAIR_SETTLE_MS = 3 * 60_000;

    // ── Held arrivals ──────────────────────────────────────────────
    //
    // The drift gate below may decline to ANNOUNCE an arrival, but it must
    // not decline for ever. It used to: a gated ENTER set state inside and
    // said nothing, and no path ever came back to it — the repair above only
    // looks at places whose state says OUTSIDE. A car driven into a
    // multi-storey car park (concrete overhead, ±88 m) arrived at the shops
    // in silence, and the family then got "left" with no "arrived".
    //
    // So a gated ENTER is HELD, and a held arrival is resolved by evidence:
    // a precise fix inside it, a precise ENTER, or — when the device was
    // arriving from travel — staying past CONFIRM_DWELL_MS. See judgeHeld.
    // If none of that happens before the EXIT, neither side is announced.

    // "Arriving from travel": the motion model said moving, or an announced
    // EXIT happened, within this long before the ENTER. Long enough to cover
    // queueing into a car park with fixes too fuzzy to register movement;
    // short enough that a phone which has sat still for an evening is never
    // mistaken for one that just got somewhere.
    static final long TRAVEL_WINDOW_MS = 10 * 60_000;

    // How long a held arrival from travel must go without an EXIT before it
    // is believed. Same scale as REPAIR_SETTLE_MS and the service's
    // STILL_AFTER, for the same reason: it separates a real stop from
    // driving past, and costs a real arrival only a few minutes' delay. The
    // arrival is announced with its ORIGINAL time, not the confirmation's.
    static final long CONFIRM_DWELL_MS = 3 * 60_000;

    // judgeHeld verdicts.
    static final int HOLD_WAIT = 0;
    static final int HOLD_CONFIRM_POSITION = 1;
    static final int HOLD_CONFIRM_DWELL = 2;
    static final int HOLD_DEMOTE = 3;

    @Override
    public void onReceive(Context context, Intent intent) {
        GeofencingEvent event = GeofencingEvent.fromIntent(intent);
        if (event == null) return;
        // While the member has self-paused, ignore transitions entirely —
        // don't write check-ins and don't re-register dropped fences. The
        // fences are unregistered on pause, but a straggler intent could
        // still arrive; drop it. Same for a device the server has stopped
        // accepting writes from (member removed — see LocationUpdateReceiver).
        PrefsStore gate = new PrefsStore(context.getApplicationContext());
        if (gate.isPaused() || gate.isServerRejected()) return;
        if (event.hasError()) {
            Log.w(TAG, "geofence event error code: " + event.getErrorCode());
            // GEOFENCE_NOT_AVAILABLE (1000): Play Services dropped ALL
            // our fences because location became unavailable (location
            // toggled off, or suspended by deep Doze / battery saver).
            // They do not come back by themselves — until this rebuild
            // they stayed dead until the next app open.
            if (event.getErrorCode() == GeofenceStatusCodes.GEOFENCE_NOT_AVAILABLE) {
                PrefsStore prefs = new PrefsStore(context.getApplicationContext());
                prefs.journal("geo: fences dropped by OS (location unavailable) — re-registering");
                BootReceiver.reRegisterGeofences(context.getApplicationContext(), prefs, "geo-recover");
            }
            return;
        }

        int transition = event.getGeofenceTransition();
        String type;
        if (transition == Geofence.GEOFENCE_TRANSITION_ENTER) {
            type = "arrived";
        } else if (transition == Geofence.GEOFENCE_TRANSITION_EXIT) {
            type = "left";
        } else {
            return; // ignore DWELL and anything unknown
        }

        List<Geofence> triggered = event.getTriggeringGeofences();
        if (triggered == null || triggered.isEmpty()) return;

        // triggeringLocation.getTime() is epoch-ms stamped by the OS at the
        // actual crossing moment — this is what fixes the "stamped 'now'"
        // bug, because the value survives regardless of when we process
        // the intent. We also pass the lat/lng straight through to the
        // member update below so the live map pin moves at boundary
        // crossings even when the BackgroundGeolocation foreground
        // service has been killed by an aggressive OEM battery saver.
        final Location triggeringLoc = event.getTriggeringLocation();
        final long whenMs = triggeringLoc != null
                ? triggeringLoc.getTime()
                : System.currentTimeMillis();
        final Double tLat = triggeringLoc != null ? triggeringLoc.getLatitude()  : null;
        final Double tLng = triggeringLoc != null ? triggeringLoc.getLongitude() : null;
        // Horizontal accuracy (error radius, m) of the fix that caused the
        // transition — used below to reject drift-induced crossings.
        final Float tAcc = (triggeringLoc != null && triggeringLoc.hasAccuracy())
                ? triggeringLoc.getAccuracy() : null;

        // Capture a snapshot of ids BEFORE goAsync so the lambda doesn't
        // close over a mutable List the receiver framework may recycle.
        final String[] ids = new String[triggered.size()];
        for (int i = 0; i < triggered.size(); i++) ids[i] = triggered.get(i).getRequestId();
        final String finalType = type;

        final PendingResult pr = goAsync();
        new Thread(() -> {
            try {
                handleTransitions(context.getApplicationContext(), ids, finalType, whenMs, tLat, tLng, tAcc);
            } catch (Exception e) {
                Log.w(TAG, "receiver worker failed", e);
            } finally {
                pr.finish();
            }
        }, "RoamkeepGeofenceWorker").start();
    }

    private void handleTransitions(Context ctx, String[] ids, String type, long whenMs,
                                   Double tLat, Double tLng, Float tAcc) {
        PrefsStore prefs = new PrefsStore(ctx);
        if (!prefs.hasContext()) {
            Log.w(TAG, "no Supabase context — skipping " + ids.length + " events");
            return;
        }

        // A geofence just fired, so the app is alive and not force-stopped.
        // If the location foreground service isn't running (killed while
        // idle), this is a good moment to bring it back so background
        // breadcrumbs resume. Guarded — a background FGS start can be
        // refused on Android 12+, which is harmless here (START_STICKY /
        // next app open will recover it anyway).
        if (!LocationForegroundService.running) {
            try { LocationForegroundService.start(ctx, "geofence"); }
            catch (Exception e) { Log.i(TAG, "geofence kick: FGS start refused (" + e.getMessage() + ")"); }
        }

        SupabaseRest rest = new SupabaseRest(ctx);

        String isoTime = toIso8601Utc(whenMs);
        String memberId    = prefs.getMemberId();

        boolean anyAccepted = false;
        // Places this event sent a spurious EXIT for. Play Services can send
        // one for a whole list of fences at once, mid-drive, for places
        // nowhere near — ten in one burst on a 2026-09-26 test drive — and
        // a line per place buried everything around it while saying nothing
        // about WHY. One summary line per event, with the fix and the power
        // state, which are the evidence for the suspected triggers.
        List<String> spurious = new ArrayList<>();

        for (String placeId : ids) {
            PrefsStore.Place p = prefs.findPlace(placeId);
            if (p == null) {
                Log.w(TAG, "triggered unknown geofence " + placeId + " — possibly stale from a previous session");
                continue;
            }

            // Anti-drift accuracy gate. Suppress a "crossing" only when the
            // fix is BOTH imprecise (error radius > DRIFT_MIN_ACC_M) AND
            // lands within that error of the boundary — i.e. a fuzzy fix that
            // genuinely can't tell which side you're on. That's GPS drift,
            // not real movement, and it's what spammed arrived/left on
            // stationary phones sitting near a place overnight. A PRECISE
            // fix is always trusted, even right at the edge, so a real
            // crossing between two nearby zones (±4 m) is never dropped — the
            // earlier version wrongly dropped one of those, which then also
            // orphaned its EXIT (state never recorded the ENTER). Radius-
            // independent, so even a small 50 m home stays reliable.
            //
            // IT SUPPRESSES THE ANNOUNCEMENT, NOT THE STATE. Two different
            // questions were being answered by one `continue` here, and
            // conflating them stranded a device. "Is this fix good enough to
            // tell the family about?" is this gate's question. "Where does
            // Play Services think we are?" is what insidePlaceIds is FOR —
            // it exists to pair up Play Services' own event stream, so it has
            // to track what Play Services believes, whatever we decide to say
            // out loud.
            //
            // The failure that forced this: a fuzzy ENTER was dropped, so
            // addInsidePlace never ran, and the device recorded itself
            // OUTSIDE a place it was sitting inside. Play Services only fires
            // on transitions and the phone never crossed the boundary again,
            // so nothing could ever put it back — and the next genuine
            // departure was then discarded as a "spurious EXIT". Dropping an
            // EXIT is recoverable; dropping an ENTER is not, because ENTER is
            // the only event that re-establishes inside-ness.
            //
            // And suppressing the announcement means HOLDING it, not
            // dropping it (4.9.2). An arrival that is never announced while
            // its departure is gives the family "left" with no "arrived" —
            // the exposure this comment used to call known. A gated ENTER is
            // now held until evidence confirms it or its EXIT discards it;
            // see the held-arrival notes at the top of this class.
            if (tLat != null && tLng != null && tAcc != null && tAcc > DRIFT_MIN_ACC_M) {
                float[] d = new float[1];
                Location.distanceBetween(p.lat, p.lng, tLat, tLng, d);
                float distFromEdge = Math.abs(d[0] - p.radius);
                if (distFromEdge < tAcc) {
                    // ENTER records state; EXIT does NOT. The asymmetry is
                    // the same one stated above, and 4.8.8 got it wrong by
                    // treating the two alike.
                    //
                    // Recording a gated ENTER is what stops the stranding:
                    // state says inside, which is where we are, and a later
                    // real EXIT is then accepted.
                    //
                    // Recording a gated EXIT looked symmetrical and was a
                    // regression. It sets state OUTSIDE while the device is
                    // sitting inside — and Play Services, which fired that
                    // EXIT, also believes outside. So the next ordinary
                    // precise fix produces an ENTER that nothing can tell
                    // apart from a real arrival, and it gets announced. A
                    // phone parked near a boundary then wakes the whole keep
                    // with "arrived" all night: exactly the flapping this
                    // gate exists to stop, leaking out one side of it.
                    //
                    // Leaving state alone restores the absorption — the
                    // follow-up ENTER lands on state that already says
                    // inside and is dropped as a duplicate. Nothing is
                    // stranded by that, because stranding needs state to say
                    // OUTSIDE while we are inside, which this can no longer
                    // produce. A genuine later departure still announces.
                    //
                    // A gated ENTER that newly puts us inside is HELD. One
                    // for a place we were already inside is not: that
                    // arrival was either announced long ago or is already
                    // held, and holding it again would announce it twice.
                    String outcome;
                    if ("arrived".equals(type)) {
                        if (prefs.claimInsidePlace(placeId)) {
                            PrefsStore.Motion m = prefs.getMotion();
                            boolean travel = isTravel(m.valid, m.movingUntilMs,
                                    prefs.getLastExitMs(), whenMs);
                            prefs.holdArrival(placeId, whenMs, travel);
                            outcome = "held until confirmed ("
                                    + (travel ? "arriving from travel" : "no recent travel") + ")";
                        } else {
                            outcome = "not announced (already inside)";
                        }
                    } else {
                        outcome = "drift, not announced (state: unchanged)";
                    }
                    prefs.journal("geo: " + type + " " + p.name + " fuzzy fix ±"
                            + Math.round(tAcc) + "m within " + Math.round(distFromEdge)
                            + "m of edge — " + outcome);
                    Log.i(TAG, "drift-gated " + type + " for " + p.name + " (acc " + Math.round(tAcc) + "m)");
                    continue;
                }
            }

            // State-gate the broadcast. Google Play Services fires
            // synthetic EXITs on re-registration, doze wake-up, and
            // some charging-state transitions — these do not
            // correspond to the user actually crossing the boundary.
            // Dropping any EXIT for a place we don't have an unmatched
            // ENTER for eliminates those, at the cost of losing any
            // truly-first EXIT after a fresh install (which has no
            // prior ENTER either, so no activity-log asymmetry).
            // State-gate, and for an arrival claim it in the same step.
            //
            // Flip local state OPTIMISTICALLY — before the DB writes — so a
            // transient network failure can't permanently desync us from the
            // OS's view. If the writes below fail, we lose one check-in row,
            // but the next legitimate transition still gets through (because
            // state matches reality). The earlier "update only on success"
            // version had a real-world failure mode where a flaky network on
            // the EXIT (e.g. WiFi → cellular handoff while leaving home)
            // would leave state stuck at "inside home" forever, silently
            // deduping every future ENTER for that place.
            //
            // The ENTER case tests and sets atomically, because the
            // breadcrumb pipeline now also files arrivals (see
            // repairMissedArrival) from a different thread. A separate
            // isInsidePlace + addInsidePlace would let one homecoming be
            // announced twice.
            //
            // Both branches also resolve a HELD arrival for the place, if
            // there is one — the two transitions are the strongest evidence
            // a hold can get, and each is the last chance to settle it.
            if ("arrived".equals(type)) {
                if (!prefs.claimInsidePlace(placeId)) {
                    // Already inside. If that is because the arrival is
                    // held, this ENTER — one the drift gate let through, so
                    // precise or clearly on the inside of the edge — is the
                    // evidence it was waiting for: announce it, with its
                    // original time.
                    PrefsStore.Held held = prefs.claimHeldArrival(placeId);
                    if (held == null) {
                        Log.i(TAG, "duplicate ENTER for " + p.name + " — already inside, skipping");
                        prefs.journal("geo: duplicate ENTER " + p.name + " dropped");
                        continue;
                    }
                    prefs.journal("geo: arrived " + p.name + " — held arrival confirmed by an"
                            + " unambiguous enter, announced for " + hhmm(held.enterMs));
                    fileCheckin(prefs, rest, p, "arrived", held.enterMs);
                    anyAccepted = true;
                    updateMemberAfter(ctx, rest, memberId, placeId, "arrived", isoTime, tLat, tLng);
                    continue;
                }
            } else {
                if (!prefs.isInsidePlace(placeId)) {
                    Log.i(TAG, "spurious EXIT for " + p.name + " — not currently inside, skipping");
                    spurious.add(p.name);   // journalled once, after the loop
                    continue;
                }
                prefs.removeInsidePlace(placeId);
                // An arrival still held at its own departure. Either the
                // stay itself proves it — arriving from travel and staying
                // past the dwell, which the breadcrumb path would normally
                // have confirmed already — or nothing ever did, and then
                // this departure is not announced either. The family must
                // never get a "left" without its "arrived".
                PrefsStore.Held held = prefs.claimHeldArrival(placeId);
                if (held != null) {
                    if (!confirmsAtExit(held.enterMs, held.travel, whenMs)) {
                        prefs.journal("geo: left " + p.name + " — its arrival ("
                                + hhmm(held.enterMs) + ") was never confirmed; neither announced");
                        continue;
                    }
                    prefs.journal("geo: arrived " + p.name + " — confirmed at departure (stayed "
                            + ((whenMs - held.enterMs) / 60_000) + "m after arriving from travel),"
                            + " announced for " + hhmm(held.enterMs));
                    fileCheckin(prefs, rest, p, "arrived", held.enterMs);
                }
                // An ANNOUNCED departure — and only that — counts as recent
                // travel for the next place's held arrival. A discarded one
                // must not: at night that is a drift EXIT, and letting it
                // vouch for the next drift ENTER would confirm it on dwell.
                prefs.setLastExitMs(whenMs);
            }
            prefs.journal("geo: " + type + " " + p.name);
            anyAccepted = true;

            // The row itself — write-ahead, idempotent, result handled, and
            // shared with every other path that files a check-in. A failed
            // POST is already queued, so carry on to the member update: the
            // avatar should still move.
            fileCheckin(prefs, rest, p, type, whenMs);
            updateMemberAfter(ctx, rest, memberId, placeId, type, isoTime, tLat, tLng);
        }

        if (!spurious.isEmpty()) {
            prefs.journal(spuriousExitLine(spurious, tAcc, SupabaseRest.powerSource(ctx)));
        }

        // Even if every transition was state-gated away as spurious,
        // the OS still handed us a real location fix. Push it through
        // so the avatar reflects movement at the moment of the
        // (suspected-spurious) crossing rather than going stale.
        if (!anyAccepted && tLat != null && tLng != null) {
            try {
                JSONObject upd = new JSONObject();
                upd.put("lat", tLat);
                upd.put("lng", tLng);
                upd.put("last_seen", isoTime);
                rest.updateMember(memberId, upd);
            } catch (JSONException ignored) {}
        }

        // Drain anything left over from earlier failed deliveries. We
        // know the network was just up enough for the OS to wake us
        // (otherwise this fire wouldn't have happened) so this is a
        // good moment to sweep. If a retry still fails, the entry
        // stays in the queue for the next attempt.
        drainPendingCheckins(prefs, rest);
    }

    /**
     * Mirror the JS path after an announced transition: on arrival set
     * last_place_id, on departure clear it. Also push the triggering lat/lng
     * and last_seen so the live map pin tracks the user, and piggyback the
     * battery level so it stays current in the background between location
     * fires.
     */
    private static void updateMemberAfter(Context ctx, SupabaseRest rest, String memberId,
                                          String placeId, String type, String isoTime,
                                          Double tLat, Double tLng) {
        try {
            JSONObject upd = new JSONObject();
            if (tLat != null && tLng != null) {
                upd.put("lat", tLat);
                upd.put("lng", tLng);
                upd.put("last_seen", isoTime);
            }
            int batt = SupabaseRest.currentBatteryLevel(ctx);
            if (batt >= 0) upd.put("battery", batt);
            upd.put("last_place_id", "arrived".equals(type) ? placeId : JSONObject.NULL);
            rest.updateMember(memberId, upd);
        } catch (JSONException e) {
            Log.w(TAG, "member update payload build failed", e);
        }
    }

    /**
     * File one check-in row: build it, queue it, POST it, and settle the
     * queue entry by the result. Every path that tells the family about an
     * arrival or a departure goes through here — the transition itself, the
     * missed-arrival repair and the held-arrival confirmations — so they
     * cannot drift apart in what they send or how they handle a failure.
     *
     * @param eventMs when it HAPPENED, which becomes created_at. For a held
     *                arrival that is the original ENTER, not the moment it
     *                was confirmed.
     */
    static void fileCheckin(PrefsStore prefs, SupabaseRest rest, PrefsStore.Place p,
                            String type, long eventMs) {
        try {
            // Client-generated UUID makes retries idempotent — duplicate
            // INSERTs hit the primary-key constraint as 409, which the retry
            // path treats as "already there".
            JSONObject ci = new JSONObject();
            ci.put("id", UUID.randomUUID().toString());
            ci.put("keep_id", prefs.getKeepId());
            ci.put("member_id", prefs.getMemberId());
            ci.put("member_name", prefs.getMemberName());
            ci.put("member_avatar", prefs.getMemberAvatar());
            ci.put("type", type);
            ci.put("place", p.icon + " " + p.name);
            // v13. `place` is a display string composed here, so it cannot
            // be matched back to a place once one is renamed — place_id is
            // what the per-place mute rule joins on.
            ci.put("place_id", p.id);
            ci.put("created_at", toIso8601Utc(eventMs));

            // WRITE-AHEAD. Queue first, POST second, and only a landed row
            // leaves the queue. Callers flip state before calling this, so
            // if the process died mid-request — memory pressure, or the
            // broadcast deadline passing on a slow link — the check-in used
            // to be lost with nothing to re-send it: never queued, and state
            // already saying the crossing was handled.
            prefs.appendPendingCheckin(ci);
            SupabaseRest.Result r = rest.insertCheckin(ci);
            if (r == SupabaseRest.Result.SUCCESS || r == SupabaseRest.Result.DUPLICATE) {
                prefs.removePendingCheckin(ci.optString("id", null));
            } else if (r == SupabaseRest.Result.REJECTED) {
                // The server will never take this payload; keeping it would
                // only wedge the queue behind it.
                prefs.removePendingCheckin(ci.optString("id", null));
                prefs.journal("geo: " + type + " " + p.name + " refused by server ("
                        + rest.lastSqlState() + ") — dropped");
            } else {
                // Network blip — most commonly a WiFi → cellular handoff at
                // the boundary. It is already queued; the next breadcrumb
                // fire (seconds away on the move), geofence fire, or app
                // launch will retry it.
                prefs.journal("geo: " + type + " " + p.name + " POST failed — queued");
                Log.w(TAG, "checkin insert failed for " + p.name
                        + " — queued for retry (pending=" + prefs.pendingCount() + ")");
            }
        } catch (JSONException e) {
            Log.w(TAG, "checkin payload build failed", e);
        }
    }

    /** Iterate the pending-checkin queue, retry each entry, drop on
     *  success, duplicate (already there) or a permanent rejection. Static
     *  so the NativeGeofencePlugin's flushPending() entrypoint can reuse it
     *  without instantiating a receiver. */
    static int drainPendingCheckins(PrefsStore prefs, SupabaseRest rest) {
        List<JSONObject> pending = prefs.getPendingCheckins();
        if (pending.isEmpty()) return 0;
        int drained = 0, dropped = 0;
        String droppedWhy = null;
        for (JSONObject entry : pending) {
            String id = entry.optString("id", null);
            if (id == null) {
                // Pre-UUID payload from an older build: drop, can't
                // safely retry without idempotency.
                continue;
            }
            SupabaseRest.Result r = rest.insertCheckin(entry);
            if (r == SupabaseRest.Result.SUCCESS || r == SupabaseRest.Result.DUPLICATE) {
                prefs.removePendingCheckin(id);
                drained++;
            } else if (r == SupabaseRest.Result.REJECTED) {
                // The server refused this payload and always will. It used
                // to stop the drain like a network failure, so one such
                // entry at the head held every later check-in back until 50
                // newer ones pushed it out of the queue.
                prefs.removePendingCheckin(id);
                dropped++;
                droppedWhy = rest.lastSqlState();
            } else {
                // Stop on first transient failure — the network is still
                // down (or our token can't refresh). Try again next
                // fire. Avoids burning 50 POSTs against a dead link.
                Log.w(TAG, "drain stalled at " + id + "; " + (pending.size() - drained - dropped) + " still pending");
                break;
            }
        }
        if (drained > 0) {
            Log.i(TAG, "drained " + drained + " pending checkin(s)");
        }
        if (dropped > 0) {
            // Say how many: a drop is otherwise invisible, and the journal
            // is the only witness this path has.
            prefs.journal("drain: dropped " + dropped + " check-in(s) the server refused (" + droppedWhy + ")");
        }
        return drained;
    }

    /**
     * File an arrival we should have had, when the position says we are
     * inside a place our own state thinks we left.
     *
     * WHY THIS EXISTS. Every other path here is a delta handler: it reacts to
     * a transition Play Services reports. The codebase's standing rule is that
     * a delta handler is an optimisation and never the only path, because the
     * one event you miss is the one nothing comes back for. Geofencing is the
     * sharpest case of that — transitions fire only on a CROSSING, so an ENTER
     * that is lost, dropped or never delivered can never be re-sent while the
     * phone sits still inside the place. The device is then stranded: no
     * arrival is ever filed, the timeline keeps a departure with no return,
     * and the next genuine departure is discarded as spurious. Until now the
     * only repair was somebody opening the app.
     *
     * So this reconciles against the authoritative answer — where the device
     * actually is — rather than waiting for another delta.
     *
     * DELIBERATELY ENTER-ONLY. The missing-EXIT direction heals itself: the
     * moment the person really leaves, Play Services fires again and the
     * normal path handles it. Only the ENTER direction is unrecoverable by
     * construction, so only the ENTER direction is repaired here. Symmetry
     * would cost blast radius and buy nothing.
     *
     * The conditions are strict so that drift can never trigger it: the fix
     * must be PRECISE (the same bar GeofenceReceiver uses to trust a crossing
     * at all), and we must be inside by a clear margin — its whole error
     * radius clear of the boundary, not merely inside it. A fuzzy fix, or one
     * hovering near the edge, is exactly what we refuse to act on everywhere
     * else, and acting on it here would manufacture the arrivals the drift
     * gate above exists to suppress.
     *
     * And the divergence must PERSIST — see REPAIR_SETTLE_MS. Being inside a
     * place that state says you left is the ordinary condition on the way to
     * arriving anywhere; only its failure to resolve marks a missed crossing.
     * Acting immediately made this the primary arrival path rather than the
     * backstop it is, beating the geofence to every homecoming.
     *
     * Self-limiting: it fires only while state disagrees with position, and
     * its first action makes them agree. A real ENTER arriving afterwards is
     * absorbed by the duplicate-ENTER guard.
     */
    static void repairMissedArrival(PrefsStore prefs, SupabaseRest rest,
                                    double lat, double lng, float acc, long whenMs) {
        if (acc < 0 || acc > DRIFT_MIN_ACC_M) return;   // not precise enough to act on
        List<PrefsStore.Place> places = prefs.getPlaces();
        if (places == null || places.isEmpty()) return;

        String keepId   = prefs.getKeepId();
        String memberId = prefs.getMemberId();
        if (keepId == null || memberId == null) return;

        JSONObject watch = prefs.getRepairWatch();
        boolean watchChanged = false;

        float[] d = new float[1];
        for (PrefsStore.Place p : places) {
            boolean diverged = !prefs.isInsidePlace(p.id);
            if (diverged) {
                Location.distanceBetween(lat, lng, p.lat, p.lng, d);
                // Inside by a clear margin — the entire error radius within
                // the boundary, so no plausible reading of this fix puts us
                // outside.
                diverged = d[0] < p.radius - acc;
            }
            if (!diverged) {
                // Agrees, or too close to the edge to tell. Either way this
                // is not the condition we are waiting on; forget the clock.
                if (watch.has(p.id)) { watch.remove(p.id); watchChanged = true; }
                continue;
            }

            // Inside, while state says we left. WAIT before acting on it.
            //
            // This is a backstop for a crossing that is never coming, not a
            // competitor to Play Services. Without the wait it fired on every
            // ordinary arrival, because "state says outside" is simply what
            // state says while you are on your way somewhere — and it beat
            // the geofence by seconds, so each homecoming produced a
            // "recovered from position" line followed by a dropped duplicate.
            // That is a journal crying wolf on the one instrument used to
            // diagnose everything else, and it also manufactured arrived/left
            // pairs for places merely passed through.
            //
            // Waiting separates the two cases by the only thing that actually
            // distinguishes them: a real arrival gets its ENTER within the
            // geofence's own responsiveness window, and a stranded device
            // never does. A device that has been stranded for hours can
            // certainly wait REPAIR_SETTLE_MS more.
            long since = watch.optLong(p.id, 0L);
            if (since <= 0L || since > whenMs) {
                // Also resets a stamp that is in the FUTURE: a clock change
                // or a fix with a bad timestamp would otherwise park the wait
                // beyond any elapsed time and disable the repair silently.
                try {
                    watch.put(p.id, whenMs);
                    watchChanged = true;
                } catch (JSONException e) {
                    Log.w(TAG, "repair watch update failed", e);
                }
                continue;                      // start the clock, act later
            }
            if (whenMs - since < REPAIR_SETTLE_MS) continue;

            // Claim it atomically. This runs on the location worker thread
            // while a real ENTER may be landing on the geofence worker, and a
            // check-then-act across those two would file the arrival twice.
            // Whoever loses the claim says nothing.
            //
            // The claim also flips state BEFORE the POST, matching the
            // optimistic ordering the transition path uses: a failed POST
            // costs a row, but never leaves state disagreeing with position,
            // which is the condition this function exists to end.
            watch.remove(p.id);
            watchChanged = true;
            if (!prefs.claimInsidePlace(p.id)) continue;
            prefs.journal("geo: arrived " + p.name + " — recovered from position (no"
                    + " geofence enter in " + ((whenMs - since) / 60_000) + "m)");
            Log.i(TAG, "repaired missed ENTER for " + p.name
                    + " (±" + Math.round(acc) + "m, " + Math.round(d[0]) + "m from centre)");

            fileCheckin(prefs, rest, p, "arrived", whenMs);
            markLastPlace(rest, memberId, p.id);
        }
        if (watchChanged) prefs.setRepairWatch(watch);
    }

    /**
     * Settle held arrivals against a fresh position — the breadcrumb
     * pipeline's half of the held-arrival rules (the transitions settle the
     * rest, in handleTransitions).
     *
     * Runs on every location batch, which keeps arriving while the device is
     * parked, so a held arrival from travel is normally announced within a
     * batch or two of CONFIRM_DWELL_MS rather than at its departure.
     *
     * @param lat,lng,acc the batch's most PRECISE fix, as for
     *                    repairMissedArrival — the position rules rest on
     *                    trusting the reading
     * @param nowMs       the batch's NEWEST fix time, for the dwell rule
     */
    static void confirmHeldArrivals(PrefsStore prefs, SupabaseRest rest,
                                    double lat, double lng, float acc, long nowMs) {
        Map<String, PrefsStore.Held> held = prefs.getHeldArrivals();
        if (held.isEmpty()) return;
        String memberId = prefs.getMemberId();
        if (prefs.getKeepId() == null || memberId == null) return;

        float[] d = new float[1];
        for (Map.Entry<String, PrefsStore.Held> e : held.entrySet()) {
            String id = e.getKey();
            PrefsStore.Held h = e.getValue();
            PrefsStore.Place p = prefs.findPlace(id);
            if (p == null) {
                // removePlace drops a place's hold with it; this covers
                // anything that slipped past. A deleted place is never
                // announced.
                if (prefs.claimHeldArrival(id) != null) {
                    prefs.journal("geo: held arrival dropped — its place no longer exists");
                }
                continue;
            }
            Location.distanceBetween(lat, lng, p.lat, p.lng, d);
            int verdict = judgeHeld(h.enterMs, h.travel, nowMs, d[0], p.radius, acc);
            if (verdict == HOLD_WAIT) continue;
            if (verdict == HOLD_DEMOTE) {
                prefs.demoteHeldArrival(id);
                prefs.journal("geo: held arrival at " + p.name + " — precise fix ±"
                        + Math.round(acc) + "m outside it; now needs a precise fix inside");
                continue;
            }
            // Claim before acting: the geofence worker may be settling this
            // same hold at an EXIT right now, and only one of us may speak.
            PrefsStore.Held c = prefs.claimHeldArrival(id);
            if (c == null) continue;
            prefs.journal("geo: arrived " + p.name + " — held arrival confirmed "
                    + (verdict == HOLD_CONFIRM_POSITION
                        ? "by a precise fix (±" + Math.round(acc) + "m)"
                        : "after " + ((nowMs - c.enterMs) / 60_000) + "m with no exit (arriving from travel)")
                    + ", announced for " + hhmm(c.enterMs));
            fileCheckin(prefs, rest, p, "arrived", c.enterMs);
            markLastPlace(rest, memberId, p.id);
        }
    }

    /**
     * What a fresh fix says about one held arrival. Pure, so the rules can
     * be tested without a device.
     *
     * Position, when the fix is PRECISE (the bar the drift gate itself uses):
     *   - inside by its whole error radius — no plausible reading puts us
     *     outside — CONFIRMS it;
     *   - outside by its whole error radius DEMOTES a hold from travel to one
     *     that needs a precise fix inside. Its departure may simply not have
     *     fired yet, and the dwell rule below must not announce a place we
     *     have visibly left. State is left alone: it tracks Play Services.
     * Otherwise, time: a hold from travel that has gone CONFIRM_DWELL_MS
     * without an EXIT is a stop, not a drive-past, and is CONFIRMED.
     *
     * A hold NOT from travel never confirms on time — that is a phone sitting
     * still near a boundary, which is the case the drift gate exists for.
     * Play Services can believe "inside" on drift for hours.
     *
     * @param accM negative means unknown, which is not precise.
     */
    static int judgeHeld(long enterMs, boolean travel, long nowMs,
                         float distM, float radiusM, float accM) {
        boolean precise = accM >= 0 && accM <= DRIFT_MIN_ACC_M;
        if (precise && distM < radiusM - accM) return HOLD_CONFIRM_POSITION;
        if (precise && distM > radiusM + accM) return travel ? HOLD_DEMOTE : HOLD_WAIT;
        if (travel && nowMs - enterMs >= CONFIRM_DWELL_MS) return HOLD_CONFIRM_DWELL;
        return HOLD_WAIT;
    }

    /**
     * Was the device arriving from travel when this ENTER happened? Either
     * the persisted motion model said moving, or an announced departure was
     * filed, within TRAVEL_WINDOW_MS of it.
     *
     * An unknown motion state (fresh install, sign-out) does NOT count. The
     * breadcrumb path assumes moving when it doesn't know, because there a
     * wrong guess costs a few extra points; here it would cost a false
     * arrival, and the rules that remain — a precise fix, or the EXIT — are
     * enough for a genuine one.
     *
     * Both stamps are bounded on the late side too: a stamp far in the
     * future (a clock change, a fix with a bad time) would otherwise vouch
     * for every ENTER until the clock caught up.
     */
    static boolean isTravel(boolean motionValid, long movingUntilMs, long lastExitMs, long enterMs) {
        long from = enterMs - TRAVEL_WINDOW_MS;
        long to   = enterMs + TRAVEL_WINDOW_MS;
        if (motionValid && movingUntilMs >= from && movingUntilMs <= to) return true;
        return lastExitMs > 0 && lastExitMs >= from && lastExitMs <= to;
    }

    /**
     * An arrival still held when its EXIT comes: does the stay itself prove
     * it? Only from travel, and only if it lasted the dwell — the same
     * condition the breadcrumb path confirms on, applied as a backstop for a
     * device that produced no batch in between. Anything else was a drive
     * past or drift, and neither side is announced.
     */
    static boolean confirmsAtExit(long enterMs, boolean travel, long exitMs) {
        return travel && exitMs - enterMs >= CONFIRM_DWELL_MS;
    }

    private static void markLastPlace(SupabaseRest rest, String memberId, String placeId) {
        try {
            JSONObject upd = new JSONObject();
            upd.put("last_place_id", placeId);
            rest.updateMember(memberId, upd);
        } catch (JSONException e) {
            Log.w(TAG, "last_place_id payload build failed", e);
        }
    }

    // Most place names a spurious-EXIT line lists before "+N more".
    static final int SPURIOUS_NAMES_MAX = 5;

    /**
     * One journal line for every spurious EXIT a single event carried.
     * Pure, so its format is pinned by a test.
     *
     * A single one keeps the old wording, so the journal reads the same in
     * the ordinary case. Either way the line ends with the triggering fix's
     * accuracy and the power source. Those are the two things that could tell
     * the suspected causes apart: a location source that just changed (a
     * tunnel, a GPS dropout — often a fuzzy or absent fix) versus a
     * charging-state change.
     *
     * @param acc   the triggering fix's accuracy, m; null if the event had
     *              no fix or no accuracy
     * @param power SupabaseRest.powerSource's label, or null if unknown
     */
    static String spuriousExitLine(List<String> names, Float acc, String power) {
        int n = names.size();
        StringBuilder sb = new StringBuilder("geo: ");
        if (n == 1) {
            sb.append("spurious EXIT ").append(names.get(0)).append(" dropped");
        } else {
            sb.append(n).append(" spurious EXITs dropped (");
            int shown = Math.min(n, SPURIOUS_NAMES_MAX);
            for (int i = 0; i < shown; i++) {
                if (i > 0) sb.append(", ");
                sb.append(names.get(i));
            }
            if (n > shown) sb.append(" +").append(n - shown).append(" more");
            sb.append(")");
        }
        sb.append(" — fix ").append(acc == null ? "none" : "±" + Math.round(acc) + "m");
        sb.append(", ").append(power == null ? "power unknown" : power);
        return sb.toString();
    }

    /** Local wall-clock HH:mm, for journal lines. */
    private static String hhmm(long ms) {
        return new SimpleDateFormat("HH:mm", Locale.US).format(new Date(ms));
    }

    private static String toIso8601Utc(long ms) {
        SimpleDateFormat fmt = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        fmt.setTimeZone(TimeZone.getTimeZone("UTC"));
        return fmt.format(new Date(ms));
    }
}
