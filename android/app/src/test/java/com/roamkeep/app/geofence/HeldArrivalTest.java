package com.roamkeep.app.geofence;

import static com.roamkeep.app.geofence.GeofenceReceiver.CONFIRM_DWELL_MS;
import static com.roamkeep.app.geofence.GeofenceReceiver.HOLD_CONFIRM_DWELL;
import static com.roamkeep.app.geofence.GeofenceReceiver.HOLD_CONFIRM_POSITION;
import static com.roamkeep.app.geofence.GeofenceReceiver.HOLD_DEMOTE;
import static com.roamkeep.app.geofence.GeofenceReceiver.HOLD_WAIT;
import static com.roamkeep.app.geofence.GeofenceReceiver.TRAVEL_WINDOW_MS;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * The held-arrival rules. An arrival the drift gate would not announce is
 * held, then confirmed by evidence or discarded at its departure. Getting
 * these wrong either way is silent: too strict and an arrival never reaches
 * the family (the bug this exists for — a ±88 m ENTER in a multi-storey car
 * park, then "left" with no "arrived"); too loose and a phone sitting near a
 * boundary overnight wakes the whole keep, which the gate exists to stop.
 */
public class HeldArrivalTest {
    private static final long T = 1_790_000_000_000L;   // the gated ENTER
    private static final float R = 150f;                 // place radius, m

    // ── isTravel ────────────────────────────────────────────────────

    @Test public void movingJustBeforeTheEnterIsTravel() {
        assertTrue(GeofenceReceiver.isTravel(true, T - 2 * 60_000, 0, T));
    }

    @Test public void movingAtTheEnterIsTravel() {
        assertTrue(GeofenceReceiver.isTravel(true, T + 60_000, 0, T));
    }

    @Test public void movingOnlyLongBeforeIsNotTravel() {
        assertFalse(GeofenceReceiver.isTravel(true, T - TRAVEL_WINDOW_MS - 1, 0, T));
    }

    @Test public void travelWindowEdgeIsInclusive() {
        assertTrue(GeofenceReceiver.isTravel(true, T - TRAVEL_WINDOW_MS, 0, T));
    }

    @Test public void unknownMotionIsNotTravel() {
        // Invalid motion carries a zero stamp; even a plausible-looking one
        // must not count when the model says it knows nothing.
        assertFalse(GeofenceReceiver.isTravel(false, T, 0, T));
    }

    @Test public void aRecentAnnouncedDepartureIsTravel() {
        // The drive to the shops: left Home at 10:08, gated ENTER at 10:13.
        assertTrue(GeofenceReceiver.isTravel(true, 0, T - 5 * 60_000, T));
    }

    @Test public void anOldDepartureIsNotTravel() {
        assertFalse(GeofenceReceiver.isTravel(true, 0, T - TRAVEL_WINDOW_MS - 1, T));
    }

    @Test public void futureStampsDoNotVouchForever() {
        long farFuture = T + 24L * 3600_000;
        assertFalse(GeofenceReceiver.isTravel(true, farFuture, 0, T));
        assertFalse(GeofenceReceiver.isTravel(true, 0, farFuture, T));
    }

    // ── judgeHeld: position ────────────────────────────────────────

    @Test public void preciseFixInsideByItsErrorConfirms() {
        assertEquals(HOLD_CONFIRM_POSITION,
                GeofenceReceiver.judgeHeld(T, false, T + 10_000, 100f, R, 8f));
    }

    @Test public void preciseFixNearTheEdgeDoesNotConfirm() {
        // Inside, but within its own error of the boundary — ambiguous.
        assertEquals(HOLD_WAIT,
                GeofenceReceiver.judgeHeld(T, false, T + 10_000, 145f, R, 8f));
    }

    @Test public void fuzzyFixDeepInsideDoesNotConfirmByPosition() {
        // ±88 m is not a precise fix, however central it claims to be.
        assertEquals(HOLD_WAIT,
                GeofenceReceiver.judgeHeld(T, false, T + 10_000, 10f, R, 88f));
    }

    @Test public void unknownAccuracyIsNotPrecise() {
        assertEquals(HOLD_WAIT,
                GeofenceReceiver.judgeHeld(T, false, T + 10_000, 10f, R, -1f));
    }

    @Test public void preciseFixOutsideDemotesATravelHold() {
        assertEquals(HOLD_DEMOTE,
                GeofenceReceiver.judgeHeld(T, true, T + 10_000, 200f, R, 8f));
    }

    @Test public void preciseFixOutsideLeavesAStillHoldWaiting() {
        // Already needs a precise fix inside; nothing to demote.
        assertEquals(HOLD_WAIT,
                GeofenceReceiver.judgeHeld(T, false, T + 10_000, 200f, R, 8f));
    }

    @Test public void preciseFixOutsideBeatsTheDwell() {
        // Even past the dwell, a place we have visibly left is not announced.
        assertEquals(HOLD_DEMOTE,
                GeofenceReceiver.judgeHeld(T, true, T + CONFIRM_DWELL_MS + 60_000, 200f, R, 8f));
    }

    // ── judgeHeld: dwell ───────────────────────────────────────────

    @Test public void travelHoldConfirmsAfterTheDwell() {
        // The rooftop car park: fuzzy fixes, no exit, three minutes on.
        assertEquals(HOLD_CONFIRM_DWELL,
                GeofenceReceiver.judgeHeld(T, true, T + CONFIRM_DWELL_MS, 60f, R, 88f));
    }

    @Test public void travelHoldWaitsBeforeTheDwell() {
        assertEquals(HOLD_WAIT,
                GeofenceReceiver.judgeHeld(T, true, T + CONFIRM_DWELL_MS - 1, 60f, R, 88f));
    }

    @Test public void stillHoldNeverConfirmsOnTime() {
        // A phone sitting near a boundary all night: hours pass, no exit,
        // and it must stay silent.
        assertEquals(HOLD_WAIT,
                GeofenceReceiver.judgeHeld(T, false, T + 8L * 3600_000, 140f, R, 60f));
    }

    @Test public void clockBehindTheEnterWaits() {
        assertEquals(HOLD_WAIT,
                GeofenceReceiver.judgeHeld(T, true, T - 60_000, 60f, R, 88f));
    }

    // ── confirmsAtExit ─────────────────────────────────────────────

    @Test public void aLongStayFromTravelIsConfirmedAtItsDeparture() {
        // 10:13 → 10:36: announce the arrival, then the departure.
        assertTrue(GeofenceReceiver.confirmsAtExit(T, true, T + 23 * 60_000));
    }

    @Test public void aDrivePastIsDiscarded() {
        assertFalse(GeofenceReceiver.confirmsAtExit(T, true, T + 60_000));
    }

    @Test public void aStillHoldIsDiscardedAtItsExitHoweverLong() {
        assertFalse(GeofenceReceiver.confirmsAtExit(T, false, T + 8L * 3600_000));
    }

    @Test public void exitDwellEdgeIsInclusive() {
        assertTrue(GeofenceReceiver.confirmsAtExit(T, true, T + CONFIRM_DWELL_MS));
    }
}
