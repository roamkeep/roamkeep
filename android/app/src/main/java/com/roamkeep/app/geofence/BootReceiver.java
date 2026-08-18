package com.roamkeep.app.geofence;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;

import com.google.android.gms.location.Geofence;
import com.google.android.gms.location.GeofencingClient;
import com.google.android.gms.location.GeofencingRequest;
import com.google.android.gms.location.LocationServices;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

/**
 * Android clears all registered geofences on device reboot, so we
 * re-register every stored place when BOOT_COMPLETED fires. The
 * Supabase auth context and the places list are both in SharedPreferences
 * so we don't need the app to have been opened post-reboot for
 * transitions to keep working.
 *
 * Also handles MY_PACKAGE_REPLACED: every APK update kills the process
 * (ApplicationExitInfo showed five such kills in two weeks on a family
 * device — WebView updates do it too via PACKAGE_UPDATED), and nothing
 * restarted the foreground service until the next manual app open, so
 * breadcrumbs silently stopped after each update. Both actions are on
 * Android's exemption list for starting a foreground service from the
 * background.
 */
public class BootReceiver extends BroadcastReceiver {
    private static final String TAG = "RoamkeepGeo";

    /** Unique name for the periodic location-update work. MainActivity
     *  cancels by this name when the app opens, so the BG-geolocation
     *  plugin's continuous tracking takes over without two systems
     *  racing to update keep_members.lat/lng. */
    public static final String LOCATION_WORK_NAME = "roamkeep-location-poll";

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        boolean pkgReplaced = Intent.ACTION_MY_PACKAGE_REPLACED.equals(action);
        if (!pkgReplaced
                && !Intent.ACTION_BOOT_COMPLETED.equals(action)
                && !Intent.ACTION_LOCKED_BOOT_COMPLETED.equals(action)
                && !"android.intent.action.QUICKBOOT_POWERON".equals(action)) {
            return;
        }
        String why = pkgReplaced ? "update" : "boot";
        PrefsStore prefs = new PrefsStore(context);
        if (!prefs.hasContext()) {
            Log.w(TAG, why + ": no Supabase context, skipping");
            return;
        }
        // An active self-pause must survive a reboot / app update: don't
        // re-arm the service, the poll, or the geofences until it elapses.
        if (prefs.isPaused()) {
            prefs.journal(why + ": paused — skipping re-arm");
            // Alarms do NOT survive a reboot, so a pause that was still
            // running when the device restarted would lose its resume
            // alarm and stay dark until the next app open. Re-arm it.
            PauseExpiryReceiver.schedule(context.getApplicationContext(), prefs.getPausedUntil());
            return;
        }
        prefs.journal(why + ": re-arming pipeline");

        // Schedule periodic location pushes so the live map pin keeps
        // moving while the user hasn't opened the app post-reboot (or
        // post-update). 15 min is WorkManager's minimum periodic
        // interval. KEEP policy means if the work is already enqueued
        // (e.g. from a previous boot) we don't reset its schedule.
        // MainActivity cancels this by name on app launch.
        try {
            PeriodicWorkRequest req = new PeriodicWorkRequest.Builder(
                    LocationUpdateWorker.class, 15, TimeUnit.MINUTES)
                    .setConstraints(new Constraints.Builder()
                            .setRequiredNetworkType(NetworkType.CONNECTED)
                            .build())
                    .build();
            WorkManager.getInstance(context.getApplicationContext())
                    .enqueueUniquePeriodicWork(
                            LOCATION_WORK_NAME,
                            ExistingPeriodicWorkPolicy.KEEP,
                            req);
            Log.i(TAG, why + ": enqueued periodic location poll");
        } catch (Exception e) {
            Log.w(TAG, why + ": WorkManager enqueue failed", e);
        }

        // Restart the location foreground service. It arms the location
        // updates itself (and keeps the app out of the App Standby
        // throttle). Both BOOT_COMPLETED and MY_PACKAGE_REPLACED are
        // allowed contexts for starting a foreground service.
        try {
            LocationForegroundService.start(context.getApplicationContext(), pkgReplaced ? "pkg-replaced" : "boot");
            Log.i(TAG, why + ": started location foreground service (" + prefs.getTrackMode() + ")");
        } catch (Exception e) {
            Log.w(TAG, why + ": failed to start location service", e);
        }

        reRegisterGeofences(context, prefs, why);
    }

    /** Re-seed every stored place into GeofencingClient. Shared by the
     *  boot / package-replaced path and GeofenceReceiver's
     *  GEOFENCE_NOT_AVAILABLE recovery (Play Services drops all fences
     *  when location becomes unavailable — without this they'd stay
     *  dead until the next app open). */
    static void reRegisterGeofences(Context context, PrefsStore prefs, String why) {
        List<PrefsStore.Place> places = prefs.getPlaces();
        if (places.isEmpty()) return;

        GeofencingClient client = LocationServices.getGeofencingClient(context.getApplicationContext());
        List<Geofence> list = new ArrayList<>();
        for (PrefsStore.Place p : places) {
            list.add(new Geofence.Builder()
                    .setRequestId(p.id)
                    .setCircularRegion(p.lat, p.lng, p.radius)
                    .setExpirationDuration(Geofence.NEVER_EXPIRE)
                    .setTransitionTypes(Geofence.GEOFENCE_TRANSITION_ENTER | Geofence.GEOFENCE_TRANSITION_EXIT)
                    .build());
        }
        GeofencingRequest req = new GeofencingRequest.Builder()
                // 0 = don't fire on initial state (e.g. already-inside)
                .setInitialTrigger(0)
                .addGeofences(list)
                .build();

        Intent receiver = new Intent(context.getApplicationContext(), GeofenceReceiver.class);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE;
        PendingIntent pi = PendingIntent.getBroadcast(
                context.getApplicationContext(), 0, receiver, flags);

        try {
            client.addGeofences(req, pi)
                    .addOnSuccessListener(unused -> {
                        Log.i(TAG, why + ": re-registered " + list.size() + " geofences");
                        prefs.journal("geo: re-armed " + list.size() + " fence(s) (" + why + ")");
                    })
                    .addOnFailureListener(e -> {
                        Log.w(TAG, why + ": re-register failed", e);
                        prefs.journal("geo: RE-ARM FAILED (" + why + ") — " + e.getMessage());
                    });
        } catch (SecurityException e) {
            Log.w(TAG, why + ": missing ACCESS_FINE_LOCATION?", e);
        }
    }
}
