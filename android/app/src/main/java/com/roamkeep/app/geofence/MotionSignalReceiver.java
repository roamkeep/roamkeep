package com.roamkeep.app.geofence;

import android.Manifest;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.SystemClock;
import android.util.Log;

import androidx.core.content.ContextCompat;

import com.google.android.gms.location.ActivityRecognition;
import com.google.android.gms.location.ActivityTransition;
import com.google.android.gms.location.ActivityTransitionEvent;
import com.google.android.gms.location.ActivityTransitionRequest;
import com.google.android.gms.location.ActivityTransitionResult;
import com.google.android.gms.location.DetectedActivity;

import java.util.ArrayList;
import java.util.List;

/**
 * Activity recognition: Play Services telling us the person has started
 * driving, cycling, walking or running (4.13.0). Needs the Physical activity
 * permission, which is optional: without it the other signals still work.
 *
 * It is a TRIGGER, never a decider. Until 4.5 the same API chose the
 * profile, and got Auto stuck both ways (stranded "still" on car trips, stuck
 * "walking" at home). Here it can only open a GPS watch (vehicle, bicycle)
 * or ask for one GPS check (on foot); the GPS fix decides. A missed event
 * costs nothing that the other signals don't cover, and a false one costs a
 * check. See MotionJudge.
 *
 * Registered with a PendingIntent, so it survives the process: when the OS
 * has killed the tracking service, this is one of the ways it comes back.
 * Withdrawn by LocationForegroundService.stop(), on every deliberate stop.
 *
 * What it learns stays on the phone: nothing here is sent anywhere, and the
 * journal records only which kind of signal arrived.
 */
public class MotionSignalReceiver extends BroadcastReceiver {
    private static final String TAG = "RoamkeepGeo";
    private static final int PI_REQUEST_CODE = 7;

    /** Whether the person has allowed Physical activity. Below Android 10 it
     *  is the Play Services permission, granted at install. */
    static boolean allowed(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return true;
        return ContextCompat.checkSelfPermission(ctx, Manifest.permission.ACTIVITY_RECOGNITION)
                == PackageManager.PERMISSION_GRANTED;
    }

    private static PendingIntent pendingIntent(Context ctx) {
        Intent i = new Intent(ctx.getApplicationContext(), MotionSignalReceiver.class);
        // Mutable: Play Services writes the result into it.
        int flags = PendingIntent.FLAG_UPDATE_CURRENT
                | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? PendingIntent.FLAG_MUTABLE : 0);
        return PendingIntent.getBroadcast(ctx.getApplicationContext(), PI_REQUEST_CODE, i, flags);
    }

    /** Ask for transitions into the four moving activities. Idempotent.
     *  Returns whether it was allowed to ask. */
    static boolean register(Context ctx) {
        if (!allowed(ctx)) return false;
        List<ActivityTransition> wanted = new ArrayList<>();
        for (int type : new int[] { DetectedActivity.IN_VEHICLE, DetectedActivity.ON_BICYCLE,
                                    DetectedActivity.WALKING, DetectedActivity.RUNNING }) {
            wanted.add(new ActivityTransition.Builder()
                    .setActivityType(type)
                    .setActivityTransition(ActivityTransition.ACTIVITY_TRANSITION_ENTER)
                    .build());
        }
        try {
            ActivityRecognition.getClient(ctx.getApplicationContext())
                    .requestActivityTransitionUpdates(new ActivityTransitionRequest(wanted), pendingIntent(ctx))
                    .addOnFailureListener(e -> new PrefsStore(ctx).journal(
                            "move: activity signal NOT registered (" + e.getClass().getSimpleName() + ")"));
            return true;
        } catch (SecurityException e) {
            Log.w(TAG, "activity recognition: permission missing", e);
            return false;
        }
    }

    /** Withdraw it. Safe to call when it was never registered. */
    static void unregister(Context ctx) {
        try {
            ActivityRecognition.getClient(ctx.getApplicationContext())
                    .removeActivityTransitionUpdates(pendingIntent(ctx));
        } catch (Exception e) {
            Log.w(TAG, "activity recognition: unregister failed", e);
        }
    }

    @Override
    public void onReceive(Context ctx, Intent intent) {
        if (!ActivityTransitionResult.hasResult(intent)) return;
        ActivityTransitionResult result = ActivityTransitionResult.extractResult(intent);
        if (result == null) return;
        final long nowNanos = SystemClock.elapsedRealtimeNanos();
        int source = MotionJudge.SRC_NONE;
        String what = null;
        for (ActivityTransitionEvent e : result.getTransitionEvents()) {
            if (e.getTransitionType() != ActivityTransition.ACTIVITY_TRANSITION_ENTER) continue;
            // An old "entered a vehicle" says nothing about now.
            if (!MotionJudge.freshEvent(e.getElapsedRealTimeNanos(), nowNanos)) continue;
            int s = sourceFor(e.getActivityType());
            if (s == MotionJudge.SRC_NONE) continue;
            // The strongest wins: a vehicle over walking to it.
            if (source == MotionJudge.SRC_NONE || s == MotionJudge.SRC_VEHICLE) {
                source = s;
                what = nameFor(e.getActivityType());
            }
        }
        if (source == MotionJudge.SRC_NONE) return;
        LocationForegroundService.onActivitySignal(ctx, source, what);
    }

    private static int sourceFor(int activityType) {
        switch (activityType) {
            case DetectedActivity.IN_VEHICLE:
            case DetectedActivity.ON_BICYCLE: return MotionJudge.SRC_VEHICLE;
            case DetectedActivity.WALKING:
            case DetectedActivity.RUNNING:    return MotionJudge.SRC_FOOT;
            default:                          return MotionJudge.SRC_NONE;
        }
    }

    private static String nameFor(int activityType) {
        switch (activityType) {
            case DetectedActivity.IN_VEHICLE: return "in a vehicle";
            case DetectedActivity.ON_BICYCLE: return "on a bicycle";
            case DetectedActivity.WALKING:    return "walking";
            case DetectedActivity.RUNNING:    return "running";
            default:                          return "moving";
        }
    }
}
