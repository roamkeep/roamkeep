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
    /** Play Services' per-app geofence limit. */
    private static final int MAX_FENCES = 100;

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
     * Whether one row of a place list is whole (4.11.1). Both callers that
     * parse a list (the bridge, the push reconcile) used to SKIP a bad row
     * and arm the rest as the complete list, so one malformed row read as
     * "that place was deleted" and was pruned. They now refuse the whole
     * list instead and leave every store as it was. Pure, for PlaceRowTest.
     */
    static boolean validPlaceRow(String id, String name, double lat, double lng, double radius) {
        return SupabaseRest.isUuid(id)
                && name != null && !name.trim().isEmpty()
                && !Double.isNaN(lat) && lat >= -90 && lat <= 90
                && !Double.isNaN(lng) && lng >= -180 && lng <= 180
                && !Double.isNaN(radius) && !Double.isInfinite(radius) && radius > 0;
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
     * Told once the outcome is known (4.11.1). Callers used to record the
     * list as applied the moment they had ASKED Play Services to register
     * it, so a registration that failed was never retried: the next
     * reconcile saw an identical list and skipped it.
     *
     * `accepted` is true when Play Services took the fences, and also when
     * there were none to register or no location permission to register
     * them with. Both of those are settled until something changes, and each
     * change has its own way back in (a new list; reconcileSetup re-arming
     * on a grant). It is false only when the registration was refused or
     * threw, which is the case worth retrying.
     *
     * Runs on the caller's thread for the immediate outcomes and on the main
     * thread for Play Services' answer.
     */
    interface Done {
        void settled(Result result, boolean accepted);
    }

    static Result arm(Context context, List<PrefsStore.Place> places, String why) {
        return arm(context, places, why, null);
    }

    /**
     * Register every place in one shot, and prune anything absent.
     *
     * Play Services' addGeofences is async, so the returned `armed` is what
     * we ASKED to arm; `done`, if given, hears the real outcome. The journal
     * line is written from the callback.
     *
     * @param places the COMPLETE current list — see the class comment.
     */
    static Result arm(Context context, List<PrefsStore.Place> places, String why, Done done) {
        final Context ctx = context.getApplicationContext();
        final PrefsStore prefs = new PrefsStore(ctx);

        List<Geofence> fences = new ArrayList<>();
        Set<String> wanted = new HashSet<>();
        int stored = 0;

        // Callers validate the whole list before calling (4.11.1): a row
        // skipped here would read as a deletion and be pruned.
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

        // Play Services allows an app 100 geofences, and addGeofences is
        // all-or-nothing: one fence over and NOTHING is armed, on every
        // device, with only an "ARM FAILED" line to show for it. Schema v16
        // caps a keep at 90 places, but a database older than that has no
        // cap — so arm the first 100 rather than none, and say so.
        if (fences.size() > MAX_FENCES) {
            prefs.journal("geo: " + fences.size() + " places exceed Android's " + MAX_FENCES
                    + "-geofence limit — arming the first " + MAX_FENCES);
            fences = new ArrayList<>(fences.subList(0, MAX_FENCES));
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
            final int deadCount = dead.size();
            try {
                // The metadata is already gone, so a removal that fails
                // cannot be found again by this scan; at least say so. An
                // orphaned fence that fires is skipped by GeofenceReceiver
                // (no metadata), so it can announce nothing.
                LocationServices.getGeofencingClient(ctx).removeGeofences(dead)
                        .addOnFailureListener(e -> prefs.journal("geo: prune of " + deadCount
                                + " place(s) FAILED in Play Services (" + why + ") — " + e.getMessage()));
            } catch (Exception e) {
                Log.w(TAG, "removeGeofences(dead) failed", e);
            }
            prefs.journal("geo: pruned " + dead.size() + " deleted place(s) (" + why + ")");
        }

        if (fences.isEmpty()) {
            Result r = new Result(0, stored, dead.size(), false);
            if (done != null) done.settled(r, true);
            return r;
        }
        if (!haveFineLocation(ctx)) {
            prefs.journal("geo: " + stored + " place(s) stored but NOT armed (no location permission)");
            Result r = new Result(0, stored, dead.size(), true);
            if (done != null) done.settled(r, true);
            return r;
        }

        final int n = fences.size();
        final int prunedCount = dead.size();
        final boolean bg = haveBackgroundLocation(ctx);
        final Result asked = new Result(n, stored, prunedCount, false);
        GeofencingRequest req = new GeofencingRequest.Builder()
                // 0 = don't fire on initial state (e.g. already-inside)
                .setInitialTrigger(0)
                .addGeofences(fences)
                .build();
        try {
            LocationServices.getGeofencingClient(ctx)
                    .addGeofences(req, pendingIntent(ctx))
                    .addOnSuccessListener(unused -> {
                        prefs.journal("geo: armed " + n + " fence(s) (" + why + ")"
                                + (bg ? "" : " (foreground only — no background permission)"));
                        if (done != null) done.settled(asked, true);
                    })
                    .addOnFailureListener(e -> {
                        Log.w(TAG, "arm failed (" + why + ")", e);
                        prefs.journal("geo: ARM FAILED (" + n + " fence(s), " + why + ") — " + e.getMessage());
                        if (done != null) done.settled(asked, false);
                    });
        } catch (SecurityException e) {
            Log.w(TAG, "arm threw SecurityException", e);
            prefs.journal("geo: ARM FAILED (" + why + ") — " + e.getMessage());
            Result r = new Result(0, stored, prunedCount, true);
            if (done != null) done.settled(r, false);
            return r;
        }
        return asked;
    }
}
