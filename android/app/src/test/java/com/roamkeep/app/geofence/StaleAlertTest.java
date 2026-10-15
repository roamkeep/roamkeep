package com.roamkeep.app.geofence;

import static com.roamkeep.app.geofence.RoamkeepMessagingService.ALERT_MAX_AGE_MS;
import static com.roamkeep.app.geofence.RoamkeepMessagingService.parseIsoMs;
import static com.roamkeep.app.geofence.RoamkeepMessagingService.tooOldToRaise;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * Which arrivals and departures are too old to raise (4.11.3). The case this
 * exists for: a phone off or out of signal for hours got every one of them
 * when it came back, each looking as if it had just happened.
 */
public class StaleAlertTest {
    private static final long NOW = 1_790_000_000_000L;

    @Test public void aMinuteOldIsRaised() {
        assertFalse(tooOldToRaise(NOW - 60_000, NOW));
    }

    @Test public void justInsideTheHourIsRaised() {
        assertFalse(tooOldToRaise(NOW - ALERT_MAX_AGE_MS, NOW));
    }

    @Test public void overAnHourIsNot() {
        assertTrue(tooOldToRaise(NOW - ALERT_MAX_AGE_MS - 1, NOW));
    }

    @Test public void twoDaysOffIsNot() {
        assertTrue(tooOldToRaise(NOW - 2 * 24 * 3_600_000L, NOW));
    }

    @Test public void aTimeAheadOfThisPhoneIsRaised() {
        // This phone's clock runs behind the server's.
        assertFalse(tooOldToRaise(NOW + 5 * 60_000, NOW));
    }

    @Test public void anUnreadableTimeIsRaised() {
        // Dropping a real one is the worse mistake.
        assertFalse(tooOldToRaise(parseIsoMs(null), NOW));
        assertFalse(tooOldToRaise(parseIsoMs("not a time"), NOW));
    }

    @Test public void aServerTimestampParsesIntoTheWindow() {
        long at = parseIsoMs("2026-10-12T09:14:03.481207+00:00");
        assertFalse(tooOldToRaise(at, at + 59 * 60_000));
        assertTrue(tooOldToRaise(at, at + 61 * 60_000));
    }
}
