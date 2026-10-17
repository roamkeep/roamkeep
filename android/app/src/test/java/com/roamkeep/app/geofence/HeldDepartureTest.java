package com.roamkeep.app.geofence;

import static com.roamkeep.app.geofence.GeofenceReceiver.EXIT_CONFIRM;
import static com.roamkeep.app.geofence.GeofenceReceiver.EXIT_OUT;
import static com.roamkeep.app.geofence.GeofenceReceiver.EXIT_SETTLE_MS;
import static com.roamkeep.app.geofence.GeofenceReceiver.EXIT_THERE;
import static com.roamkeep.app.geofence.GeofenceReceiver.EXIT_UNSURE;
import static com.roamkeep.app.geofence.GeofenceReceiver.EXIT_WAIT;
import static com.roamkeep.app.geofence.GeofenceReceiver.TRAVEL_WINDOW_MS;
import static org.junit.Assert.assertEquals;

import org.junit.Test;

/**
 * The held-departure rules (4.11.4). A departure the drift gate would not
 * announce is held, then confirmed by precise fixes outside or discarded by
 * Play Services' next ENTER. Wrong one way, and a member who drove off stays
 * "At Home" with no "left" (the bug: one fuzzy EXIT at the front door, never
 * sent again). Wrong the other, and a phone parked by its home's edge wakes
 * the family with "left Home" at night, which the gate exists to stop.
 */
public class HeldDepartureTest {
    private static final long T = 1_790_000_000_000L;   // the gated EXIT
    private static final float R = 100f;                 // place radius, m
    private static final float PRECISE = 8f;             // a GPS fix, m
    private static final float FUZZY = 60f;              // a network fix, m

    private static int judge(long outSince, long fixMs, float dist, float acc) {
        return GeofenceReceiver.judgeHeldExit(T, outSince, fixMs, dist, R, acc);
    }

    // ── judgeHeldExit ───────────────────────────────────────────────

    @Test public void aFixFromBeforeTheExitSaysNothing() {
        assertEquals(EXIT_WAIT, judge(0, T - 1, 2_000f, PRECISE));
    }

    @Test public void aPreciseFixClearlyOutsideStartsTheWait() {
        assertEquals(EXIT_OUT, judge(0, T + 30_000, R + 50f, PRECISE));
    }

    @Test public void oneConfidentFixNeverConfirmsHoweverFar() {
        // Holds are made nightly near boundaries; a single wrong fix that
        // claims to be precise must not wake the family.
        assertEquals(EXIT_OUT, judge(0, T + 30_000, 5_000f, PRECISE));
    }

    @Test public void theWaitMustRunItsLength() {
        long out = T + 30_000;
        assertEquals(EXIT_WAIT, judge(out, out + EXIT_SETTLE_MS - 1, R + 500f, PRECISE));
    }

    @Test public void preciseFixesOutsideForTheWholeWaitConfirm() {
        // Driving away: a fix 3 minutes after the first one that proved it.
        long out = T + 30_000;
        assertEquals(EXIT_CONFIRM, judge(out, out + EXIT_SETTLE_MS, 2_400f, PRECISE));
    }

    @Test public void outsideMeansByTheWholeErrorRadius() {
        // Centre outside the radius, but within its own error of the edge.
        assertEquals(EXIT_UNSURE, judge(0, T + 30_000, R + PRECISE - 1f, PRECISE));
    }

    @Test public void aFuzzyFixFarAwayProvesNothing() {
        // The drift gate's own bar: only a precise fix is trusted to say
        // which side we are on. Saver mode may never give one; then the hold
        // waits, which is no worse than before 4.11.4.
        assertEquals(EXIT_WAIT, judge(0, T + 30_000, 2_000f, FUZZY));
    }

    @Test public void aFuzzyFixDoesNotStopARunningWait() {
        long out = T + 30_000;
        assertEquals(EXIT_WAIT, judge(out, out + 60_000, R + 30f, FUZZY));
    }

    @Test public void aFixWithNoAccuracyIsNotPrecise() {
        assertEquals(EXIT_WAIT, judge(0, T + 30_000, 2_000f, -1f));
    }

    @Test public void aFixInsideRestartsTheWaitWithoutDiscarding() {
        // Walking to the car in the drive. Play Services still has us
        // outside and will not fire again when we go, so this is THERE, not a
        // discard: the departure is still to come.
        assertEquals(EXIT_THERE, judge(T + 30_000, T + 60_000, R - 30f, PRECISE));
    }

    @Test public void aFuzzyFixCentredInsideStillCountsAsThere() {
        // It cannot rule out being there, so the departure is no earlier.
        assertEquals(EXIT_THERE, judge(0, T + 60_000, R - 10f, FUZZY));
    }

    @Test public void aFixWithNoAccuracyInsideIsThere() {
        assertEquals(EXIT_THERE, judge(0, T + 60_000, 0f, -1f));
    }

    @Test public void aFutureClockRestartsTheWait() {
        // A wait stamped in the future would otherwise never elapse.
        assertEquals(EXIT_OUT, judge(T + 60 * 60_000, T + 60_000, R + 200f, PRECISE));
    }

    @Test public void theNightCase() {
        // Parked 90 m from the centre of a 100 m home. A drift EXIT is held;
        // one wrong "precise" fix lands outside (the wait starts), and the
        // next fix lands back inside (the wait restarts). Nothing confirms.
        long out = T + 10 * 60_000;
        assertEquals(EXIT_OUT, judge(0, out, R + 25f, PRECISE));
        assertEquals(EXIT_THERE, judge(out, out + 8 * 60_000, 90f, FUZZY));
    }

    // ── departureTime ───────────────────────────────────────────────

    @Test public void withNothingLaterItIsTheExit() {
        assertEquals(T, GeofenceReceiver.departureTime(T, 0, T + 40_000));
    }

    @Test public void aLaterFixThereMovesItOn() {
        // A fuzzy EXIT at the front door, the car still in the drive.
        assertEquals(T + 90_000, GeofenceReceiver.departureTime(T, T + 90_000, T + 150_000));
    }

    @Test public void neverAfterTheProof() {
        assertEquals(T + 40_000, GeofenceReceiver.departureTime(T, T + 90_000, T + 40_000));
    }

    @Test public void noProofYetMeansTheLastWeKnew() {
        assertEquals(T + 90_000, GeofenceReceiver.departureTime(T, T + 90_000, 0));
    }

    @Test public void aDriftExitInTheNightDoesNotDateAMorningDeparture() {
        // EXIT held at 03:12 with nothing since; proof of leaving at 08:31.
        long proof = T + (5 * 60 + 19) * 60_000L;
        assertEquals(proof, GeofenceReceiver.departureTime(T, 0, proof));
    }

    @Test public void aRecentFixThereStillDatesIt() {
        long proof = T + (5 * 60 + 19) * 60_000L;
        long there = proof - 6 * 60_000;
        assertEquals(there, GeofenceReceiver.departureTime(T, there, proof));
    }

    @Test public void theTravelWindowEdgeIsInclusive() {
        assertEquals(T, GeofenceReceiver.departureTime(T, 0, T + TRAVEL_WINDOW_MS));
        assertEquals(T + TRAVEL_WINDOW_MS + 1,
                GeofenceReceiver.departureTime(T, 0, T + TRAVEL_WINDOW_MS + 1));
    }
}
