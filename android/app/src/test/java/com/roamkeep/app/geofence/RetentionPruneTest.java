package com.roamkeep.app.geofence;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * Every tracking phone runs the family's 7-day retention at most once a day
 * (4.11.1), so the privacy page's promise no longer rests on pg_cron being
 * enabled or on someone opening the app.
 */
public class RetentionPruneTest {

    private static final long NOW = 1_760_000_000_000L;
    private static final long HOUR = 60L * 60 * 1000;

    @Test public void neverPrunedOnThisPhone() {
        assertTrue(LocationUpdateReceiver.pruneDue(0, NOW));
    }

    @Test public void prunedAnHourAgo() {
        assertFalse(LocationUpdateReceiver.pruneDue(NOW - HOUR, NOW));
    }

    @Test public void prunedJustUnderADayAgo() {
        assertFalse(LocationUpdateReceiver.pruneDue(NOW - 24 * HOUR + 1, NOW));
    }

    @Test public void prunedADayAgo() {
        assertTrue(LocationUpdateReceiver.pruneDue(NOW - 24 * HOUR, NOW));
    }

    @Test public void theClockMovedBack() {
        // A stamp in the future would otherwise block the prune until the
        // clock caught up, which could be any length of time.
        assertTrue(LocationUpdateReceiver.pruneDue(NOW + HOUR, NOW));
    }
}
