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
import java.util.Date;
import java.util.List;
import java.util.Locale;
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
 * runs on a worker thread. The Android docs guarantee ~10s of
 * wall-clock before the system can kill the receiver, which is
 * well above our 15s HTTP timeout budget — but on flaky networks
 * this can still fail. The SupabaseRest helper handles one 401
 * retry via token refresh; any other failure is logged and the
 * transition is lost. No retry queue yet (see follow-up).
 */
public class GeofenceReceiver extends BroadcastReceiver {
    private static final String TAG = "RoamkeepGeo";

    // The drift gate below only distrusts IMPRECISE fixes. A fix at or below
    // this accuracy (error radius, m) is a real GPS fix — trusted even right
    // at a boundary, so a genuine crossing (moving between two nearby zones,
    // ±4 m) is never dropped. Stationary drift shows up as much fuzzier
    // network/low-power fixes (±tens of m), which this leaves gated. Tunable.
    private static final float DRIFT_MIN_ACC_M = 20f;

    @Override
    public void onReceive(Context context, Intent intent) {
        GeofencingEvent event = GeofencingEvent.fromIntent(intent);
        if (event == null) return;
        // While the member has self-paused, ignore transitions entirely —
        // don't write check-ins and don't re-register dropped fences. The
        // fences are unregistered on pause, but a straggler intent could
        // still arrive; drop it.
        if (new PrefsStore(context.getApplicationContext()).isPaused()) return;
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
        String keepId      = prefs.getKeepId();
        String memberId    = prefs.getMemberId();
        String memberName  = prefs.getMemberName();
        String memberAv    = prefs.getMemberAvatar();

        boolean anyAccepted = false;

        for (String placeId : ids) {
            PrefsStore.Place p = prefs.findPlace(placeId);
            if (p == null) {
                Log.w(TAG, "triggered unknown geofence " + placeId + " — possibly stale from a previous session");
                continue;
            }

            // Anti-drift accuracy gate. Drop a "crossing" only when the fix
            // is BOTH imprecise (error radius > DRIFT_MIN_ACC_M) AND lands
            // within that error of the boundary — i.e. a fuzzy fix that
            // genuinely can't tell which side you're on. That's GPS drift,
            // not real movement, and it's what spammed arrived/left on
            // stationary phones sitting near a place overnight. A PRECISE
            // fix is always trusted, even right at the edge, so a real
            // crossing between two nearby zones (±4 m) is never dropped — the
            // earlier version wrongly dropped one of those, which then also
            // orphaned its EXIT (state never recorded the ENTER). Radius-
            // independent, so even a small 50 m home stays reliable.
            if (tLat != null && tLng != null && tAcc != null && tAcc > DRIFT_MIN_ACC_M) {
                float[] d = new float[1];
                Location.distanceBetween(p.lat, p.lng, tLat, tLng, d);
                float distFromEdge = Math.abs(d[0] - p.radius);
                if (distFromEdge < tAcc) {
                    prefs.journal("geo: " + type + " " + p.name + " fuzzy fix ±"
                            + Math.round(tAcc) + "m within " + Math.round(distFromEdge) + "m of edge — drift, dropped");
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
            boolean currentlyInside = prefs.isInsidePlace(placeId);
            if ("arrived".equals(type) && currentlyInside) {
                Log.i(TAG, "duplicate ENTER for " + p.name + " — already inside, skipping");
                prefs.journal("geo: duplicate ENTER " + p.name + " dropped");
                continue;
            }
            if ("left".equals(type) && !currentlyInside) {
                Log.i(TAG, "spurious EXIT for " + p.name + " — not currently inside, skipping");
                prefs.journal("geo: spurious EXIT " + p.name + " dropped");
                continue;
            }
            prefs.journal("geo: " + type + " " + p.name);

            // Flip local state OPTIMISTICALLY — before the DB writes —
            // so a transient network failure can't permanently desync
            // us from the OS's view. If the writes below fail, we lose
            // one check-in row, but the next legitimate transition
            // still gets through (because state matches reality). The
            // earlier "update only on success" version had a real-world
            // failure mode where a flaky network on the EXIT (e.g. WiFi
            // → cellular handoff while leaving home) would leave state
            // stuck at "inside home" forever, silently deduping every
            // future ENTER for that place.
            if ("arrived".equals(type)) {
                prefs.addInsidePlace(placeId);
            } else {
                prefs.removeInsidePlace(placeId);
            }
            anyAccepted = true;

            try {
                // Client-generated UUID makes retries idempotent —
                // duplicate INSERTs hit the primary-key constraint as
                // 409, which the retry path treats as "already there".
                JSONObject ci = new JSONObject();
                ci.put("id", UUID.randomUUID().toString());
                ci.put("keep_id", keepId);
                ci.put("member_id", memberId);
                ci.put("member_name", memberName);
                ci.put("member_avatar", memberAv);
                ci.put("type", type);
                ci.put("place", p.icon + " " + p.name);
                ci.put("created_at", isoTime);

                SupabaseRest.Result ciResult = rest.insertCheckin(ci);
                if (ciResult == SupabaseRest.Result.FAILED) {
                    // Network blip at the boundary crossing — most
                    // commonly a WiFi → cellular handoff while leaving
                    // home. Park the payload; the next breadcrumb fire
                    // (seconds away on the move), geofence fire, or app
                    // launch will retry it.
                    prefs.appendPendingCheckin(ci);
                    prefs.journal("geo: " + type + " " + p.name + " POST failed — queued");
                    Log.w(TAG, "checkin insert failed for " + p.name + " — queued for retry (pending=" + prefs.pendingCount() + ")");
                    // Don't `continue` — still try to push the live
                    // location below so the avatar at least moves.
                }

                // Mirror the JS path: on arrival, set last_place_id; on
                // departure, clear it. Also push the triggering lat/lng
                // and last_seen so the live map pin tracks the user, and
                // piggyback the battery level so it stays current in the
                // background between location fires.
                JSONObject upd = new JSONObject();
                if (tLat != null && tLng != null) {
                    upd.put("lat", tLat);
                    upd.put("lng", tLng);
                    upd.put("last_seen", isoTime);
                }
                int batt = SupabaseRest.currentBatteryLevel(ctx);
                if (batt >= 0) upd.put("battery", batt);
                if ("arrived".equals(type)) {
                    upd.put("last_place_id", placeId);
                } else {
                    upd.put("last_place_id", JSONObject.NULL);
                }
                rest.updateMember(memberId, upd);
            } catch (JSONException e) {
                Log.w(TAG, "payload build failed", e);
            }
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

    /** Iterate the pending-checkin queue, retry each entry, drop on
     *  success or 409 (already there). Static so the
     *  NativeGeofencePlugin's flushPending() entrypoint can reuse it
     *  without instantiating a receiver. */
    static int drainPendingCheckins(PrefsStore prefs, SupabaseRest rest) {
        List<JSONObject> pending = prefs.getPendingCheckins();
        if (pending.isEmpty()) return 0;
        int drained = 0;
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
            } else {
                // Stop on first hard failure — the network is still
                // down (or our token can't refresh). Try again next
                // fire. Avoids burning 50 PATCHes against a dead link.
                Log.w(TAG, "drain stalled at " + id + "; " + (pending.size() - drained) + " still pending");
                break;
            }
        }
        if (drained > 0) {
            Log.i(TAG, "drained " + drained + " pending checkin(s)");
        }
        return drained;
    }

    private static String toIso8601Utc(long ms) {
        SimpleDateFormat fmt = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        fmt.setTimeZone(TimeZone.getTimeZone("UTC"));
        return fmt.format(new Date(ms));
    }
}
