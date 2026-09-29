package com.roamkeep.app.geofence;

import static org.junit.Assert.assertEquals;

import java.util.Arrays;
import java.util.Collections;

import org.junit.Test;

/**
 * The one journal line a burst of spurious EXITs becomes. The journal is the
 * only witness for what Play Services does with the app closed, so its
 * wording is pinned: the single case must read as it always has, and the
 * burst case must carry the count, the fix and the power source — the
 * evidence for WHY a whole list of fences fired at once mid-drive.
 */
public class SpuriousExitLineTest {

    @Test public void singleKeepsTheOldWordingPlusContext() {
        assertEquals("geo: spurious EXIT Cheer Energy dropped — fix ±12m, on battery",
                GeofenceReceiver.spuriousExitLine(
                        Collections.singletonList("Cheer Energy"), 12.4f, "on battery"));
    }

    @Test public void burstListsUpToFiveThenCounts() {
        // The 2026-09-26 drive: ten places in one event.
        assertEquals("geo: 10 spurious EXITs dropped (School - MFHS, Balcombe Heights,"
                        + " Greyhound Rescue, TG Pump Track, Bike Track +5 more)"
                        + " — fix ±64m, plugged in (USB)",
                GeofenceReceiver.spuriousExitLine(Arrays.asList(
                        "School - MFHS", "Balcombe Heights", "Greyhound Rescue",
                        "TG Pump Track", "Bike Track", "Nonna Suzy's", "FC Bike Track",
                        "Catalina's House", "Castle Cove - Dirt Jumps", "Cheer Energy"),
                        64f, "plugged in (USB)"));
    }

    @Test public void exactlyFiveHasNoMoreSuffix() {
        assertEquals("geo: 5 spurious EXITs dropped (A, B, C, D, E) — fix ±5m, on battery",
                GeofenceReceiver.spuriousExitLine(
                        Arrays.asList("A", "B", "C", "D", "E"), 5f, "on battery"));
    }

    @Test public void missingFixAndPowerAreSaidOutright() {
        assertEquals("geo: 2 spurious EXITs dropped (A, B) — fix none, power unknown",
                GeofenceReceiver.spuriousExitLine(Arrays.asList("A", "B"), null, null));
    }
}
