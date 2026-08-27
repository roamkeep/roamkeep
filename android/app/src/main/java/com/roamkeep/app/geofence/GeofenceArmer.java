package com.roamkeep.app.geofence;

import android.Manifest;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.util.Log;

import androidx.core.content.ContextCompat;

import com.google.android.gms.location.Geofence;
import com.google.android.gms.location.GeofencingRequest;
import com.google.android.gms.location.LocationServices;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * The one place that turns "here is the complete list of places" into
 * registered geofences, stored metadata, and a prune of everything else.
 *
 * Extracted from NativeGeofencePlugin.armPlaces, which could only be
 * reached across the Capacitor bridge — i.e. only while the WebView was
 * alive. Three callers need it now and only one of them has a bridge:
 *
 *   * NativeGeofencePlugin.armPlaces  — the app, on launch and resume.
 *   * BootReceiver                    — after a reboot or package replace.
 *   * RoamkeepMessagingService        — a push wake-up saying the place
 *                                       list changed, app dead.
 *
 * ── The contract, and why it matters ────────────────────────────
 *
 * The caller passes the COMPLETE current place list. Anything registered
 * that is not in it has been deleted, and is pruned. This is not a
 * convenience — it is the architecture. Three stores mirror what
 * keep_places says (the Play Services fence registry, PrefsStore's place
 * metadata, PrefsStore's inside set) and none of them is the database.
 * Reconciling against the whole authoritative list is the only thing that
 * reliably converges them; applying deltas does not, because the delta
 * stream (realtime) is dropped whenever the app is backgrounded.
 *
 * Two consequences that have each cost a shipped bug:
 *
 *   * An EMPTY list is a meaningful state, not a no-op. "Every place was
 *     deleted" has to reach the OS, or the prune never runs in the case
 *     that needs it most.
 *   * A caller must never pass an empty list because a FETCH FAILED.
 *     That is indistinguishable here from a real deletion of everything,
 *     and would silently unregister every fence on the device. Deciding
 *     "did I actually read the list?" is the caller's job.
 */
final class GeofenceArmer {
    private static final String TAG = "RoamkeepGeo";
    private static final int PI_REQUEST_CODE = 0;

    private GeofenceArmer() {}

    /** What one arm did, for journalling and for the bridge's resolve(). */
    static final class Result {
        final int armed;    // fences handed to Play Services
        final int stored;   // places whose metadata was written
        final int pruned;   // places that had gone from the list
        final boolean permissionMissing;

        Result(int armed, int stored, int pruned, boolean permissionMissing) {
            this.armed = armed;
            this.stored = stored;
            this.pruned = pruned;
            this.permissionMissing = permissionMissing;
        }
    }

    static PendingIntent pendingIntent(Context ctx) {
        Intent intent = new Intent(ctx.getApplicationContext(), GeofenceReceiver.class);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE;
        return PendingIntent.getBroadcast(ctx.getApplicationContext(), PI_REQUEST_CODE, intent, flags);
    }

    static boolean haveFineLocation(Context ctx) {
        return ContextCompat.checkSelfPermission(ctx,
                Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    /** Below API 29 there is no separate background permission — fine
     *  location covers it. */
    static boolean haveBackgroundLocation(Context ctx) {
        return Build.VERSION.SDK_INT < 29 || ContextCompat.checkSelfPermission(ctx,
                Manifest.permission.ACCESS_BACKGROUND_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    /**
     * A stable fingerprint of a place list.
     *
     * Includes name and icon, not just geometry. The JS-side signature
     * originally hashed only id/lat/lng/radius, which meant a RENAME never
     * triggered a re-arm — and GeofenceReceiver composes its check-in text
     * from the name held in PrefsStore, so a renamed place went on filing
     * check-ins under its old name indefinitely. Same bug family as the
     * add and delete cases, one field narrower.
     */
    static String signature(List<PrefsStore.Place> places) {
        List<String> parts = new ArrayList<>(places.size());
        for (PrefsStore.Place p : places) {
            parts.add(p.id + ':' + p.lat + ':' + p.lng + ':' + p.radius + ':' + p.name + ':' + p.icon);
        }
        java.util.Collections.sort(parts);
        StringBuilder sb = new StringBuilder();
        for (String s : parts) { if (sb.length() > 0) sb.append('|'); sb.append(s); }
        return sb.toString();
    }

    /**
     * Register every place in one shot, and prune anything absent.
     *
     * Synchronous as far as the caller is concerned: Play Services'
     * addGeofences is async, so `armed` is what we ASKED to arm. The
     * journal line is written from the callback with the real outcome.
     *
     * @param places the COMPLETE current list — see the class comment.
     */
    static Result arm(Context context, List<PrefsStore.Place> places, String why) {
        final Context ctx = context.getApplicationContext();
        final PrefsStore prefs = new PrefsStore(ctx);

        List<Geofence> fences = new ArrayList<>();
        Set<String> wanted = new HashSet<>();
        int stored = 0;

        for (PrefsStore.Place p : places) {
            if (p == null || p.id == null || p.name == null) continue;
            wanted.add(p.id);
            // Metadata first and unconditionally, so a device that can't
            // arm yet (no permission) is still repairable later.
            prefs.putPlace(p);
            stored++;
            fences.add(new Geofence.Builder()
                    .setRequestId(p.id)
                    .setCircularRegion(p.lat, p.lng, p.radius)
                    .setExpirationDuration(Geofence.NEVER_EXPIRE)
                    .setTransitionTypes(Geofence.GEOFENCE_TRANSITION_ENTER
                            | Geofence.GEOFENCE_TRANSITION_EXIT)
                    .build());
        }

        // Anything still registered that is not in the list has been
        // deleted. Prune it.
        //
        // Without this a deleted place lived on forever: addGeofences only
        // replaces fences by requestId and never removes absent ones, and
        // putPlace only writes. A place deleted on one device while
        // another was backgrounded therefore kept firing arrived/left on
        // that device — headless, from stale PrefsStore metadata, under
        // its old name and icon — with nothing on any screen to explain
        // where a check-in for a place that no longer exists came from.
        //
        // Also drop the stale inside-flag, or the prune would leave a
        // place marked "inside" that can never be left.
        List<String> dead = new ArrayList<>();
        for (PrefsStore.Place p : prefs.getPlaces()) {
            if (!wanted.contains(p.id)) dead.add(p.id);
        }
        if (!dead.isEmpty()) {
            for (String id : dead) {
                prefs.removePlace(id);
                prefs.removeInsidePlace(id);
            }
            try {
                LocationServices.getGeofencingClient(ctx).removeGeofences(dead);
            } catch (Exception e) {
                Log.w(TAG, "removeGeofences(dead) failed", e);
            }
            prefs.journal("geo: pruned " + dead.size() + " deleted place(s) (" + why + ")");
        }

        if (fences.isEmpty()) {
            return new Result(0, stored, dead.size(), false);
        }
        if (!haveFineLocation(ctx)) {
            prefs.journal("geo: " + stored + " place(s) stored but NOT armed (no location permission)");
            return new Result(0, stored, dead.size(), true);
        }

        final int n = fences.size();
        final int prunedCount = dead.size();
        final boolean bg = haveBackgroundLocation(ctx);
        GeofencingRequest req = new GeofencingRequest.Builder()
                // 0 = don't fire on initial state (e.g. already-inside)
                .setInitialTrigger(0)
                .addGeofences(fences)
                .build();
        try {
            LocationServices.getGeofencingClient(ctx)
                    .addGeofences(req, pendingIntent(ctx))
                    .addOnSuccessListener(unused -> prefs.journal(
                            "geo: armed " + n + " fence(s) (" + why + ")"
                                    + (bg ? "" : " (foreground only — no background permission)")))
                    .addOnFailureListener(e -> {
                        Log.w(TAG, "arm failed (" + why + ")", e);
                        prefs.journal("geo: ARM FAILED (" + n + " fence(s), " + why + ") — " + e.getMessage());
                    });
        } catch (SecurityException e) {
            Log.w(TAG, "arm threw SecurityException", e);
            prefs.journal("geo: ARM FAILED (" + why + ") — " + e.getMessage());
            return new Result(0, stored, prunedCount, true);
        }
        return new Result(n, stored, prunedCount, false);
    }
}
