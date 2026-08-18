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

/**
 * Target of the PendingIntent we hand to
 * FusedLocationProviderClient.requestLocationUpdates(). The OS delivers
 * location batches here even when the Roamkeep process is dead — the
 * whole point of moving breadcrumb logging off the JS path, which Android
 * suspends whenever the WebView is backgrounded.
 *
 * For each location we POST a location_history breadcrumb and refresh the
 * live pin (keep_members.lat/lng). Distance-gating is done by the OS via
 * the request's setMinUpdateDistanceMeters — we just persist whatever it
 * hands us.
 *
 * Mirrors GeofenceReceiver's headless pattern: goAsync() + worker thread,
 * Supabase auth + member context from PrefsStore, one 401 refresh retry
 * handled inside SupabaseRest.
 */
public class LocationUpdateReceiver extends BroadcastReceiver {
    private static final String TAG = "RoamkeepGeo";
    public static final String ACTION = "com.roamkeep.app.LOCATION_UPDATE";

    @Override
    public void onReceive(Context context, Intent intent) {
        LocationResult result = LocationResult.extractResult(intent);
        if (result == null) return;
        final List<Location> locations = result.getLocations();
        if (locations == null || locations.isEmpty()) return;

        final Context appCtx = context.getApplicationContext();
        final PendingResult pr = goAsync();
        new Thread(() -> {
            try {
                processLocations(appCtx, locations);
            } catch (Exception e) {
                Log.w(TAG, "location worker failed", e);
            } finally {
                pr.finish();
            }
        }, "RoamkeepLocationWorker").start();
    }

    /**
     * Shared breadcrumb + pin write path, called by both this receiver
     * (legacy PendingIntent deliveries) and the LocationForegroundService's
     * in-process LocationCallback (the primary path). Runs synchronously —
     * callers must invoke it off the main thread.
     */
    public static void processLocations(Context ctx, List<Location> locations) {
        if (locations == null || locations.isEmpty()) return;
        final int n = locations.size();
        final double[] lats = new double[n];
        final double[] lngs = new double[n];
        final long[] times = new long[n];
        final float[] speeds = new float[n];   // m/s; -1 = not reported
        for (int i = 0; i < n; i++) {
            Location l = locations.get(i);
            lats[i] = l.getLatitude();
            lngs[i] = l.getLongitude();
            times[i] = l.getTime() > 0 ? l.getTime() : System.currentTimeMillis();
            speeds[i] = l.hasSpeed() ? l.getSpeed() : -1f;
        }

        PrefsStore prefs = new PrefsStore(ctx);
        if (!prefs.hasContext()) return;   // not signed in — nothing to write
        if (prefs.isPaused()) return;      // self-paused — write nothing
        SupabaseRest rest = new SupabaseRest(ctx);
        String keepId   = prefs.getKeepId();
        String memberId = prefs.getMemberId();
        List<PrefsStore.Place> places = prefs.getPlaces();

        int written = 0, suppressed = 0;
        for (int i = 0; i < lats.length; i++) {
            // Don't record breadcrumbs while inside a saved place —
            // wandering around the house with the phone shouldn't show up
            // as a trip. The live pin (below) still updates so others see
            // you're home; only the trail is suppressed.
            if (isInsideAnyPlace(places, lats[i], lngs[i])) { suppressed++; continue; }
            String iso = toIso8601Utc(times[i]);
            try {
                JSONObject row = new JSONObject();
                row.put("keep_id", keepId);
                row.put("member_id", memberId);
                row.put("lat", lats[i]);
                row.put("lng", lngs[i]);
                row.put("recorded_at", iso);
                // GPS speed feeds the timeline's walk/drive classifier;
                // omit when the fix has none so the row stays NULL.
                if (speeds[i] >= 0) row.put("speed", (double) speeds[i]);
                if (rest.insertLocationHistory(row)) written++;
            } catch (JSONException e) {
                Log.w(TAG, "breadcrumb payload build failed", e);
            }
        }

        // Diagnostics: stamp that we fired and how many points landed vs.
        // were suppressed inside a place, so the app (and the user) can see
        // whether native breadcrumb logging is running — and whether a low
        // breadcrumb count is throttling or just home-suppression.
        prefs.recordLocationFire(System.currentTimeMillis(), written, suppressed);
        Log.i(TAG, "location fire: " + lats.length + " fixes, " + written
                + " written, " + suppressed + " suppressed");

        // Refresh the live pin from the most recent fix in the batch so the
        // map keeps moving for other members even when the BG-geolocation
        // foreground service has been killed by an OEM battery saver.
        int last = lats.length - 1;
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

    /** True if (lat,lng) falls within the radius of any saved place. */
    private static boolean isInsideAnyPlace(List<PrefsStore.Place> places, double lat, double lng) {
        if (places == null || places.isEmpty()) return false;
        float[] out = new float[1];
        for (PrefsStore.Place p : places) {
            Location.distanceBetween(lat, lng, p.lat, p.lng, out);
            if (out[0] <= p.radius) return true;
        }
        return false;
    }

    private static String toIso8601Utc(long ms) {
        SimpleDateFormat fmt = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        fmt.setTimeZone(TimeZone.getTimeZone("UTC"));
        return fmt.format(new Date(ms));
    }
}
