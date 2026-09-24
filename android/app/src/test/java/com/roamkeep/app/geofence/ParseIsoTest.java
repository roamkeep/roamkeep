package com.roamkeep.app.geofence;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

/**
 * RoamkeepMessagingService pages push notifications by timestamps PostgREST
 * returns, parsed by hand (java.time needs API 26; this app supports 23).
 * A wrong parse moves the watermark wrongly — silently skipping or repeating
 * notifications — so the formats PostgREST actually emits are pinned here.
 */
public class ParseIsoTest {
    // 2026-09-23T10:33:48Z in epoch-ms.
    private static final long BASE = 1790159628000L;

    @Test public void microsecondsWithUtcOffset() {
        assertEquals(BASE + 581, RoamkeepMessagingService.parseIsoMs("2026-09-23T10:33:48.581234+00:00"));
    }

    @Test public void millisecondsWithZ() {
        assertEquals(BASE + 581, RoamkeepMessagingService.parseIsoMs("2026-09-23T10:33:48.581Z"));
    }

    @Test public void noFraction() {
        assertEquals(BASE, RoamkeepMessagingService.parseIsoMs("2026-09-23T10:33:48+00:00"));
    }

    @Test public void shortFractionIsTenths() {
        assertEquals(BASE + 500, RoamkeepMessagingService.parseIsoMs("2026-09-23T10:33:48.5+00:00"));
    }

    @Test public void positiveOffsetIsSubtracted() {
        // 20:33:48 at +10:00 is 10:33:48 UTC.
        assertEquals(BASE, RoamkeepMessagingService.parseIsoMs("2026-09-23T20:33:48+10:00"));
    }

    @Test public void negativeOffsetIsAdded() {
        assertEquals(BASE, RoamkeepMessagingService.parseIsoMs("2026-09-23T05:33:48-05:00"));
    }

    @Test public void spaceSeparatorAccepted() {
        assertEquals(BASE, RoamkeepMessagingService.parseIsoMs("2026-09-23 10:33:48+00"));
    }

    @Test public void matchesTheFormatThisAppWrites() {
        long now = 1790159628123L;
        assertEquals(now, RoamkeepMessagingService.parseIsoMs(SupabaseRest.toIso8601Utc(now)));
    }

    @Test public void garbageIsMinusOne() {
        assertEquals(-1, RoamkeepMessagingService.parseIsoMs(null));
        assertEquals(-1, RoamkeepMessagingService.parseIsoMs(""));
        assertEquals(-1, RoamkeepMessagingService.parseIsoMs("not a timestamp at all"));
    }
}
