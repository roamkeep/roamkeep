package com.roamkeep.app.geofence;

import static com.roamkeep.app.geofence.RoamkeepMessagingService.RESET_KNOWN;
import static com.roamkeep.app.geofence.RoamkeepMessagingService.RESET_PUSH_MAX_AGE_MS;
import static com.roamkeep.app.geofence.RoamkeepMessagingService.RESET_RAISE;
import static com.roamkeep.app.geofence.RoamkeepMessagingService.RESET_STALE;
import static com.roamkeep.app.geofence.RoamkeepMessagingService.judgeResetNotice;
import static org.junit.Assert.assertEquals;

import org.junit.Test;

/**
 * When a wake-up raises "a reset code was made for your account" or "your
 * password was changed". The reset row is never deleted, so the bug this
 * exists for was a member re-told about a days-old reset after every
 * reconnect: the only memory of having told them was a key that sign-out
 * wiped and that could age out of a capped set.
 */
public class ResetNoticeTest {
    private static final long NOW = 1_790_000_000_000L;
    private static final String MADE = "made:2026-10-06T09:00:00.123456+00:00";
    private static final String USED = "used:2026-10-06T09:05:00+00:00";

    @Test public void aFreshCodeIsRaised() {
        assertEquals(RESET_RAISE, judgeResetNotice(MADE, NOW - 60_000, NOW, null, false));
    }

    @Test public void oneAlreadyRaisedOrShownIsNot() {
        assertEquals(RESET_KNOWN, judgeResetNotice(MADE, NOW - 60_000, NOW, MADE, false));
    }

    @Test public void theKeyAnOlderBuildLeftStillCounts() {
        assertEquals(RESET_KNOWN, judgeResetNotice(MADE, NOW - 60_000, NOW, null, true));
    }

    @Test public void theCodeBeingUsedIsNewsAfterItsCreationWasTold() {
        assertEquals(RESET_RAISE, judgeResetNotice(USED, NOW - 60_000, NOW, MADE, false));
    }

    @Test public void aResetOverADayOldIsNotPushedEvenIfNeverTold() {
        // The rc9 case: the marker wiped by a reconnect, the row still there.
        assertEquals(RESET_STALE, judgeResetNotice(MADE, NOW - RESET_PUSH_MAX_AGE_MS - 1, NOW, null, false));
    }

    @Test public void justInsideTheDayIsStillNews() {
        assertEquals(RESET_RAISE, judgeResetNotice(MADE, NOW - RESET_PUSH_MAX_AGE_MS, NOW, null, false));
    }

    @Test public void anUnreadableTimeIsNeverPushed() {
        assertEquals(RESET_STALE, judgeResetNotice("made:", -1, NOW, null, false));
    }

    @Test public void aClockBehindTheServerStillRaises() {
        assertEquals(RESET_RAISE, judgeResetNotice(MADE, NOW + 5 * 60_000, NOW, null, false));
    }
}
