package com.roamkeep.app.geofence;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * The journal names places and times ("geo: arrived Home"), so it keeps no
 * line older than the 7 days the privacy page promises for everything else
 * about where someone has been (4.11.1). Before, only a count capped it, and
 * on a quiet phone 120 lines could reach back weeks.
 */
public class JournalAgeTest {

    private static final long NOW = 1_760_000_000_000L;
    private static final long DAY = 24L * 60 * 60 * 1000;

    @Test public void aLineFromToday() {
        assertTrue(PrefsStore.keepJournalEntry(NOW - 60_000, NOW));
    }

    @Test public void aLineFromSixDaysAgo() {
        assertTrue(PrefsStore.keepJournalEntry(NOW - 6 * DAY, NOW));
    }

    @Test public void aLineExactlySevenDaysOldIsStillKept() {
        assertTrue(PrefsStore.keepJournalEntry(NOW - 7 * DAY, NOW));
    }

    @Test public void aLineOverSevenDaysOldIsDropped() {
        assertFalse(PrefsStore.keepJournalEntry(NOW - 7 * DAY - 1, NOW));
        assertFalse(PrefsStore.keepJournalEntry(NOW - 30 * DAY, NOW));
    }

    @Test public void aLineFromTheFutureIsKept() {
        // The clock moved back. It cannot be judged, and the count cap still
        // bounds it.
        assertTrue(PrefsStore.keepJournalEntry(NOW + DAY, NOW));
    }

    @Test public void aLineWithNoTimeIsDropped() {
        assertFalse(PrefsStore.keepJournalEntry(0, NOW));
    }
}
