package com.roamkeep.app.geofence;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Target of the tracking notification's deleteIntent: the user swiped it
 * away, so put it straight back.
 *
 * From Android 14 no app can make that notification undismissable —
 * setOngoing(true) holds only on the lock screen and against "Clear all" —
 * so re-posting on dismissal is the closest the platform allows. It is what
 * keeps "a notification shows whenever your location is being recorded"
 * true. The reasoning, and the per-fix backstop, live with the notification
 * in LocationForegroundService.
 *
 * Explicit-intent target of our own PendingIntent, so exported=false.
 * Runs on the main thread, as does the service it calls into.
 */
public class NotificationRestoreReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        LocationForegroundService.onTrackingNotificationDismissed();
    }
}
