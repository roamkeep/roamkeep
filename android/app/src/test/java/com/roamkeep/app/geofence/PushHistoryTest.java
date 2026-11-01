package com.roamkeep.app.geofence;

import static com.roamkeep.app.geofence.RoamkeepMessagingService.COLD_FETCH_MS;
import static com.roamkeep.app.geofence.RoamkeepMessagingService.COLD_START_LOOKBACK_MS;
import static com.roamkeep.app.geofence.RoamkeepMessagingService.OVERLAP_MS;
import static com.roamkeep.app.geofence.RoamkeepMessagingService.isHistory;
import static com.roamkeep.app.geofence.RoamkeepMessagingService.parseIsoMs;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

import org.junit.Test;

/**
 * What a phone with no watermark treats as news (4.12.0). Owner report
 * 2026-11-01: after a reinstall, a new arrival came with older ones.
 */
public class PushHistoryTest {
    private static final long MIN = 60_000L;
    private static final long NOW = 1_790_000_000_000L;

    @Test public void aColdWakeRaisesWhatJustHappened() {
        assertFalse(isHistory(NOW - 2 * MIN, NOW, true, -1));
        assertFalse(isHistory(NOW - COLD_START_LOOKBACK_MS, NOW, true, -1));
    }

    @Test public void aColdWakeDoesNotRaiseOlder() {
        assertTrue(isHistory(NOW - COLD_START_LOOKBACK_MS - 1, NOW, true, -1));
        assertTrue(isHistory(NOW - 25 * MIN, NOW, true, -1));
    }

    @Test public void aWarmWakeLeavesTheOverlapToTheSeenSet() {
        // A late row re-read behind the watermark is exactly what the overlap
        // is for; only the seen set may refuse it.
        assertFalse(isHistory(NOW - 25 * MIN, NOW, false, -1));
    }

    @Test public void nothingFromBeforeThePhoneWasListening() {
        long floor = NOW - 5 * MIN;
        assertTrue(isHistory(floor - 1, NOW, true, floor));
        assertTrue(isHistory(floor - 1, NOW, false, floor));
        assertFalse(isHistory(floor, NOW, true, floor));
        assertFalse(isHistory(NOW - MIN, NOW, false, floor));
    }

    @Test public void anUnreadableTimeIsNews() {
        assertFalse(isHistory(parseIsoMs(null), NOW, true, NOW - MIN));
        assertFalse(isHistory(parseIsoMs("not a time"), NOW, false, NOW));
    }

    @Test public void theColdReadCoversTheNextWakesOverlap() {
        // The bug's shape: whatever the next wake re-reads, the cold wake must
        // already have looked at and recorded.
        assertTrue(COLD_FETCH_MS >= OVERLAP_MS);
        assertTrue(COLD_START_LOOKBACK_MS <= COLD_FETCH_MS);
    }

    /**
     * The reported sequence, end to end: check-ins at 10:00, 10:15 and 10:22;
     * the phone is reinstalled and signed in at 10:24; the first wake is
     * 10:25 (a new arrival) and the second 10:40 (another). Before 4.12.0
     * the 10:25 wake raised 10:22 too, and the 10:40 wake raised 10:15.
     */
    @Test public void aReinstalledPhoneRaisesOnlyWhatCameAfter() {
        long t0 = NOW;  // 10:00
        List<long[]> rows = new ArrayList<>();
        rows.add(new long[] { 1, t0 });
        rows.add(new long[] { 2, t0 + 15 * MIN });
        rows.add(new long[] { 3, t0 + 22 * MIN });
        long floor = t0 + 24 * MIN - RoamkeepMessagingService.FLOOR_SLACK_MS;
        Set<Long> seen = new HashSet<>();

        rows.add(new long[] { 4, t0 + 25 * MIN });
        List<Long> first = wake(rows, seen, t0 + 25 * MIN, -1, floor);
        assertEquals(List.of(4L), first);

        rows.add(new long[] { 5, t0 + 40 * MIN });
        List<Long> second = wake(rows, seen, t0 + 40 * MIN, t0 + 25 * MIN, floor);
        assertEquals(List.of(5L), second);
    }

    /**
     * The overlap half on its own, with the floor long past: signed in at
     * 09:00, but the wake-ups for 10:00 and 10:12 never came (push is best
     * effort). The first wake, 10:25, is cold. Before 4.12.0 it read only
     * from 10:15, so 10:00 and 10:12 were never recorded, and the 10:40
     * wake's overlap, from 09:55, raised both then as if new.
     */
    @Test public void aMissedWakeIsNotRaisedOnTheOneAfterTheFirst() {
        long t0 = NOW;  // 10:00
        List<long[]> rows = new ArrayList<>();
        rows.add(new long[] { 1, t0 });
        rows.add(new long[] { 2, t0 + 12 * MIN });
        long floor = t0 - 60 * MIN - RoamkeepMessagingService.FLOOR_SLACK_MS;
        Set<Long> seen = new HashSet<>();

        rows.add(new long[] { 3, t0 + 25 * MIN });
        assertEquals(List.of(3L), wake(rows, seen, t0 + 25 * MIN, -1, floor));

        rows.add(new long[] { 4, t0 + 40 * MIN });
        assertEquals(List.of(4L), wake(rows, seen, t0 + 40 * MIN, t0 + 25 * MIN, floor));
    }

    /** notifyNewCheckins' window, seen set and isHistory, without the network. */
    private static List<Long> wake(List<long[]> rows, Set<Long> seen, long now, long mark, long floor) {
        boolean cold = mark < 0;
        long from = cold ? now - COLD_FETCH_MS : mark - OVERLAP_MS;
        List<Long> raised = new ArrayList<>();
        for (long[] r : rows) {
            if (r[1] <= from || r[1] > now || seen.contains(r[0])) continue;
            seen.add(r[0]);
            if (!isHistory(r[1], now, cold, floor)) raised.add(r[0]);
        }
        return raised;
    }
}
