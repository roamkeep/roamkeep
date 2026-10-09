package com.roamkeep.app.geofence;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * No recording without the tracking notification (4.11.1). Every path that
 * records asks LocationForegroundService.canDisclose first; this pins the
 * decision it reduces to. The privacy page promises the notification
 * "whenever it is recording your location", so the rule is the notification
 * can be shown, or nothing is recorded.
 *
 * Channel importance is NotificationManager's: 0 is IMPORTANCE_NONE (the
 * person blocked the channel), 2 is IMPORTANCE_LOW (how ours is made). -1
 * means the channel does not exist yet; it is created, at LOW, when the
 * service starts.
 */
public class DisclosureGateTest {

    @Test public void notificationsOnAndTheChannelOpen() {
        assertTrue(LocationForegroundService.disclosureAllowed(true, 2));
    }

    @Test public void beforeTheChannelExists() {
        assertTrue(LocationForegroundService.disclosureAllowed(true, -1));
    }

    @Test public void theAppsNotificationsSwitchedOff() {
        // Android 13's permission refused, or switched off in settings.
        assertFalse(LocationForegroundService.disclosureAllowed(false, 2));
        assertFalse(LocationForegroundService.disclosureAllowed(false, -1));
    }

    @Test public void theTrackingChannelBlocked() {
        // Notifications on for the app, but this one channel turned off:
        // the tracking notification is exactly the one that would not show.
        assertFalse(LocationForegroundService.disclosureAllowed(true, 0));
    }
}
