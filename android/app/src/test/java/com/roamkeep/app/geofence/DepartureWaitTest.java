package com.roamkeep.app.geofence;

import static com.roamkeep.app.geofence.GeofenceReceiver.DEPART_WAIT_MS;
import static com.roamkeep.app.geofence.GeofenceReceiver.WAKE_NOTE_MS;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

import org.junit.Test;

/**
 * Every departure waits (4.13.1). Play Services sent EXIT Home on a phone's
 * first location after deep Doze and ENTER Home 6 to 9 s later, four times in
 * a week, and the family got "left Home" and "arrived Home" for someone asleep
 * in bed. A departure now waits DEPART_WAIT_MS for Play Services to take it
 * back. Wrong one way, the phantom is announced; wrong the other, a real
 * departure never is. The wait's end and the journal's account of each EXIT
 * are pinned here; the orchestration (PrefsStore, the timer) needs a device.
 */
public class DepartureWaitTest {
    private static final long T = 1_790_000_000_000L;   // when the EXIT was received

    private static String hhmm(long ms) {
        return new SimpleDateFormat("HH:mm", Locale.US).format(new Date(ms));
    }

    // ── waitOver ────────────────────────────────────────────────────

    @Test public void theLongestPhantomSeenIsInsideTheWait() {
        // 9 s from EXIT to ENTER, the longest of the four; with room to spare
        // for a slower one.
        long due = T + DEPART_WAIT_MS;
        assertFalse(GeofenceReceiver.waitOver(due, T + 9_000));
        assertTrue(DEPART_WAIT_MS >= 3 * 9_000);
    }

    @Test public void aRealDepartureIsAnnouncedWithinHalfAMinute() {
        assertTrue(DEPART_WAIT_MS <= 30_000);
        long due = T + DEPART_WAIT_MS;
        assertFalse(GeofenceReceiver.waitOver(due, due - 1));
        assertTrue(GeofenceReceiver.waitOver(due, due));
        assertTrue(GeofenceReceiver.waitOver(due, due + 10 * 60_000));
    }

    @Test public void aDriftHoldIsNeverSettledByTime() {
        // Only fixes settle a gated EXIT (4.11.4); hours make no difference.
        assertFalse(GeofenceReceiver.waitOver(0L, T));
        assertFalse(GeofenceReceiver.waitOver(0L, T + 24 * 60 * 60_000L));
    }

    @Test public void aClockSetBackDoesNotParkAWaitOutOfReach() {
        long due = T + DEPART_WAIT_MS;
        // Just made: exactly one wait ahead is still waiting.
        assertFalse(GeofenceReceiver.waitOver(due, T));
        // The clock went back an hour after it was made: over now.
        assertTrue(GeofenceReceiver.waitOver(due, T - 60 * 60_000L));
    }

    // ── fixNote ─────────────────────────────────────────────────────

    @Test public void theFixSaysHowSureAndWhichSide() {
        assertEquals("exit fix ±28m, 140m out",
                GeofenceReceiver.fixNote(28.4f, 140.2f, T, 0L, 0L));
        assertEquals("exit fix ±28m, 12m in",
                GeofenceReceiver.fixNote(28f, -12f, T, 0L, 0L));
    }

    @Test public void missingPiecesAreSaidNotGuessed() {
        assertEquals("no exit fix", GeofenceReceiver.fixNote(null, null, T, 0L, 0L));
        assertEquals("exit fix ±?, 40m out", GeofenceReceiver.fixNote(null, 40f, T, 0L, 0L));
        assertEquals("exit fix ±16m", GeofenceReceiver.fixNote(16f, null, T, 0L, 0L));
    }

    @Test public void anExitRightAfterAWakeSaysSo() {
        // The 15 Nov case: the fix that fired EXIT came within the second the
        // phone left two hours of deep Doze.
        assertEquals("exit fix ±28m, 3m in, 4s after the phone woke",
                GeofenceReceiver.fixNote(28f, -3f, T + 4_000, T, 0L));
    }

    @Test public void aFixStampedJustBeforeTheWakeCountsAsAtIt() {
        assertEquals("exit fix ±28m, 3m in, 0s after the phone woke",
                GeofenceReceiver.fixNote(28f, -3f, T - 2_000, T, 0L));
        // Well before it is not about the wake.
        assertEquals("exit fix ±28m, 3m in",
                GeofenceReceiver.fixNote(28f, -3f, T - 60_000, T, 0L));
    }

    @Test public void theNearerOfAWakeAndAnArmIsNamed() {
        assertEquals("exit fix ±17m, 5s after the fences were armed",
                GeofenceReceiver.fixNote(17f, null, T + 5_000, T - 60_000, T));
        assertEquals("exit fix ±17m, 5s after the phone woke",
                GeofenceReceiver.fixNote(17f, null, T + 5_000, T, T - 60_000));
    }

    @Test public void anOldWakeIsNotMentioned() {
        assertEquals("exit fix ±17m",
                GeofenceReceiver.fixNote(17f, null, T + WAKE_NOTE_MS + 1, T, 0L));
        assertEquals("exit fix ±17m, 120s after the phone woke",
                GeofenceReceiver.fixNote(17f, null, T + WAKE_NOTE_MS, T, 0L));
    }

    // ── waitNote ────────────────────────────────────────────────────

    @Test public void anOrdinaryDepartureCarriesItsFix() {
        assertEquals(" (exit fix ±12m, 85m out)",
                GeofenceReceiver.waitNote("exit fix ±12m, 85m out", DEPART_WAIT_MS + 300, T, T));
    }

    @Test public void aWaitThatOutlivedItsTimerSaysHowLate() {
        // The process died during the wait and a batch settled it.
        assertEquals(" (exit fix ±12m, 85m out; announced 6m after the exit, for " + hhmm(T) + ")",
                GeofenceReceiver.waitNote("exit fix ±12m, 85m out", 6 * 60_000 + 5_000, T, T));
    }

    @Test public void aDriftHoldThatBecameAWaitSaysWhenItWasFrom() {
        long drift = T - 20 * 60_000;
        long dep = T - 2 * 60_000;
        assertEquals(" (no exit fix; held since " + hhmm(drift) + ", for " + hhmm(dep) + ")",
                GeofenceReceiver.waitNote("", DEPART_WAIT_MS, dep, drift));
    }

    // ── takenBack ───────────────────────────────────────────────────

    @Test public void aPhantomTakenBackIsJournalledWithItsFix() {
        PrefsStore.HeldExit hx = new PrefsStore.HeldExit(T, T, 0L, T + DEPART_WAIT_MS,
                "exit fix ±28m, 3m in, 0s after the phone woke");
        assertEquals("its exit at " + hhmm(T) + " was taken back 9s later, so it was not"
                        + " announced (exit fix ±28m, 3m in, 0s after the phone woke)",
                GeofenceReceiver.takenBack(hx, T + 9_400));
    }

    @Test public void aDriftHoldKeepsItsOldWording() {
        PrefsStore.HeldExit hx = new PrefsStore.HeldExit(T, 0L, 0L, 0L, "");
        assertEquals("the departure held since " + hhmm(T) + " was drift, discarded",
                GeofenceReceiver.takenBack(hx, T + 9_000));
    }
}
