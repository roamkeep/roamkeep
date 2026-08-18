package com.roamkeep.app.geofence;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

/**
 * Restarts the tracking pipeline the moment a self-pause expires.
 *
 * PrefsStore.isPaused() expires by itself — it just compares the stored
 * instant to the clock — but expiry is passive: pausing stopped the
 * foreground service, disarmed location updates and removed the geofences,
 * and nothing put them back. So tracking stayed dead from the expiry
 * instant until the app happened to be opened next (a 6pm pause was
 * observed still dark at 9:42pm).
 *
 * setAndAllowWhileIdle fires even in Doze and needs no special permission
 * (unlike exact alarms from API 31). It can be deferred by a few minutes
 * under Doze, which is an acceptable trade for "resumes by itself".
 */
public class PauseExpiryReceiver extends BroadcastReceiver {
    private static final String TAG = "RoamkeepGeo";
    private static final String ACTION = "com.roamkeep.app.PAUSE_EXPIRED";
    private static final int REQ = 7;

    private static PendingIntent pi(Context ctx) {
        Intent i = new Intent(ctx, PauseExpiryReceiver.class).setAction(ACTION);
        return PendingIntent.getBroadcast(ctx, REQ, i,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /** Wake up at `whenMs` and re-arm. Replaces any previously scheduled
     *  expiry (FLAG_UPDATE_CURRENT), so extending a pause reschedules. */
    static void schedule(Context ctx, long whenMs) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        try {
            if (Build.VERSION.SDK_INT >= 23) {
                am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, whenMs, pi(ctx));
            } else {
                am.set(AlarmManager.RTC_WAKEUP, whenMs, pi(ctx));
            }
            new PrefsStore(ctx).journal("pause: resume alarm set for " + whenMs);
        } catch (Exception e) {
            Log.w(TAG, "could not schedule pause-expiry alarm", e);
        }
    }

    static void cancel(Context ctx) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        try { am.cancel(pi(ctx)); } catch (Exception ignored) {}
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        Context app = context.getApplicationContext();
        PrefsStore prefs = new PrefsStore(app);
        if (!prefs.hasContext()) return;
        // The pause may have been extended after this alarm was set; the
        // reschedule replaces the PendingIntent, but a stale fire is still
        // possible. Re-check rather than trusting the alarm.
        if (prefs.isPaused()) {
            prefs.journal("pause: expiry alarm fired but still paused — ignoring");
            return;
        }
        prefs.journal("pause: expired — re-arming pipeline");
        try {
            LocationForegroundService.start(app, "pause-expiry");
        } catch (Exception e) {
            Log.w(TAG, "pause expiry: failed to start location service", e);
        }
        BootReceiver.reRegisterGeofences(app, prefs, "pause-expiry");
    }
}
