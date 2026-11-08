package com.roamkeep.app.geofence;

import static com.roamkeep.app.geofence.GeofenceReceiver.BLOCK_AWAY;
import static com.roamkeep.app.geofence.GeofenceReceiver.BLOCK_NONE;
import static com.roamkeep.app.geofence.GeofenceReceiver.BLOCK_RIVAL;
import static com.roamkeep.app.geofence.GeofenceReceiver.CONFIRM_DWELL_MS;
import static com.roamkeep.app.geofence.GeofenceReceiver.DWELL_EVENT_SLACK_MS;
import static com.roamkeep.app.geofence.GeofenceReceiver.HOLD_BLOCK_AWAY;
import static com.roamkeep.app.geofence.GeofenceReceiver.HOLD_BLOCK_RIVAL;
import static com.roamkeep.app.geofence.GeofenceReceiver.HOLD_CONFIRM;
import static com.roamkeep.app.geofence.GeofenceReceiver.HOLD_DEMOTE;
import static com.roamkeep.app.geofence.GeofenceReceiver.HOLD_RESTART;
import static com.roamkeep.app.geofence.GeofenceReceiver.HOLD_UNBLOCK;
import static com.roamkeep.app.geofence.GeofenceReceiver.HOLD_UPGRADE;
import static com.roamkeep.app.geofence.GeofenceReceiver.HOLD_WAIT;
import static com.roamkeep.app.geofence.GeofenceReceiver.POS_AWAY;
import static com.roamkeep.app.geofence.GeofenceReceiver.POS_EDGE;
import static com.roamkeep.app.geofence.GeofenceReceiver.POS_HERE;
import static com.roamkeep.app.geofence.GeofenceReceiver.POS_NONE;
import static com.roamkeep.app.geofence.GeofenceReceiver.POS_RIVAL;
import static com.roamkeep.app.geofence.GeofenceReceiver.TRAVEL_WINDOW_MS;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * The held-arrival rules. Since 4.12.1 every arrival is held and announced
 * once it has lasted the dwell, so driving through a place says nothing; an
 * arrival the drift gate would not announce is held as before, and confirmed
 * by evidence or discarded at its departure. Getting these wrong either way
 * is silent: too strict and an arrival never reaches the family (a ±88 m
 * ENTER in a multi-storey car park, then "left" with no "arrived"); too loose
 * and a phone sitting near a boundary overnight wakes the whole keep, or a
 * child crossing the edge of home in the school yard sends "left Home" and
 * "arrived Home" every few minutes at pickup.
 */
public class HeldArrivalTest {
    private static final long T = 1_790_000_000_000L;   // the ENTER
    private static final long DUE = T + CONFIRM_DWELL_MS;

    // Metres north of the equator as degrees, on metresBetween's sphere.
    private static double north(double m) { return Math.toDegrees(m / 6_371_000); }

    private static PrefsStore.Place place(String id, double northM, float radius) {
        return new PrefsStore.Place(id, id, "📍", north(northM), 0, radius);
    }

    // A home and a school 117 m apart, both at the 100 m minimum: the case
    // that started this. The circles share a lens 83 m deep.
    private static final PrefsStore.Place HOME = place("home", 0, 100f);
    private static final PrefsStore.Place SCHOOL = place("school", 117, 100f);
    // A town the home lies wholly inside.
    private static final PrefsStore.Place TOWN = place("town", 300, 2000f);

    private static Set<String> inside(String... ids) {
        return new HashSet<>(Arrays.asList(ids));
    }

    private static int pos(PrefsStore.Place p, List<PrefsStore.Place> rivals,
                           double northM, float acc) {
        return GeofenceReceiver.positionFor(p, rivals, north(northM), 0.0, acc);
    }

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

    // ── positionFor ─────────────────────────────────────────────────

    @Test public void onlyAPreciseFixIsEvidence() {
        List<PrefsStore.Place> none = Collections.emptyList();
        assertEquals(POS_NONE, pos(HOME, none, 0, 88f));   // ±88 m, however central
        assertEquals(POS_NONE, pos(HOME, none, 0, -1f));   // unknown accuracy
        assertEquals(POS_NONE, GeofenceReceiver.positionFor(HOME, none, null, null, 5f));
    }

    @Test public void insideByItsErrorIsHere() {
        assertEquals(POS_HERE, pos(HOME, Collections.emptyList(), 40, 8f));
    }

    @Test public void nearTheEdgeSaysNothing() {
        assertEquals(POS_EDGE, pos(HOME, Collections.emptyList(), 95, 8f));
        assertEquals(POS_EDGE, pos(HOME, Collections.emptyList(), 105, 8f));
    }

    @Test public void outsideByItsErrorIsAway() {
        assertEquals(POS_AWAY, pos(HOME, Collections.emptyList(), 130, 8f));
    }

    @Test public void inTheSharedGroundTheNearerMiddleDecides() {
        // 40 m from home's middle, 77 m from the school's: home.
        assertEquals(POS_HERE, pos(HOME, Collections.singletonList(SCHOOL), 40, 8f));
        assertEquals(POS_RIVAL, pos(SCHOOL, Collections.singletonList(HOME), 40, 8f));
        // The school yard, inside home's circle at 90 m: the school.
        assertEquals(POS_RIVAL, pos(HOME, Collections.singletonList(SCHOOL), 90, 8f));
        assertEquals(POS_HERE, pos(SCHOOL, Collections.singletonList(HOME), 90, 8f));
    }

    @Test public void awayBeatsARivalsPick() {
        // Outside the school altogether: AWAY, whichever middle is nearer.
        assertEquals(POS_AWAY, pos(SCHOOL, Collections.singletonList(HOME), -20, 8f));
    }

    // ── rivals ──────────────────────────────────────────────────────

    @Test public void sideBySidePlacesAreRivals() {
        assertTrue(GeofenceReceiver.partiallyOverlap(HOME, SCHOOL));
        assertEquals(Collections.singletonList(SCHOOL), GeofenceReceiver.rivalsOf(HOME,
                Arrays.asList(HOME, SCHOOL, TOWN), inside("home", "school", "town")));
    }

    @Test public void aRivalMustBeInside() {
        assertTrue(GeofenceReceiver.rivalsOf(HOME, Arrays.asList(HOME, SCHOOL),
                inside("home")).isEmpty());
    }

    @Test public void nestingIsNotRivalry() {
        // A home inside a town is in both on purpose: leaving the home must
        // not announce arriving in the town.
        assertFalse(GeofenceReceiver.partiallyOverlap(HOME, TOWN));
        assertFalse(GeofenceReceiver.partiallyOverlap(TOWN, HOME));
    }

    @Test public void placesApartAreNotRivals() {
        assertFalse(GeofenceReceiver.partiallyOverlap(HOME, place("far", 250, 100f)));
    }

    // ── judgeHeld: every arrival waits (4.12.1) ────────────────────

    @Test public void aDwellHoldWaitsOutTheDwell() {
        assertEquals(HOLD_WAIT, GeofenceReceiver.judgeHeld(T, false, true, BLOCK_NONE, false,
                DUE - 1, POS_HERE));
        assertEquals(HOLD_CONFIRM, GeofenceReceiver.judgeHeld(T, false, true, BLOCK_NONE, false,
                DUE, POS_NONE));
    }

    @Test public void aPreciseFixInsideDoesNotConfirmADwellHoldEarly() {
        // A car driving through gives exactly these.
        assertEquals(HOLD_WAIT, GeofenceReceiver.judgeHeld(T, true, true, BLOCK_NONE, false,
                T + 20_000, POS_HERE));
    }

    @Test public void aDwellHoldSeenOutsideStartsAgain() {
        // Driven through, its EXIT not here yet: the dwell must not announce
        // it. Not blocked, though: someone who walked in and went indoors
        // gives no precise fix to unblock it, and must still be announced.
        assertEquals(HOLD_RESTART, GeofenceReceiver.judgeHeld(T, true, true, BLOCK_NONE, false,
                DUE + 60_000, POS_AWAY));
    }

    @Test public void withARivalADwellHoldSeenOutsideIsBlocked() {
        // Time alone would announce it while they are at the other place.
        assertEquals(HOLD_BLOCK_AWAY, GeofenceReceiver.judgeHeld(T, true, true, BLOCK_NONE, true,
                DUE + 60_000, POS_AWAY));
    }

    @Test public void aDwellHoldNearerARivalIsBlocked() {
        assertEquals(HOLD_BLOCK_RIVAL, GeofenceReceiver.judgeHeld(T, false, true, BLOCK_NONE, false,
                T + 60_000, POS_RIVAL));
    }

    @Test public void aBlockedHoldNeverConfirmsOnTime() {
        assertEquals(HOLD_WAIT, GeofenceReceiver.judgeHeld(T, true, true, BLOCK_RIVAL, false,
                T + 8L * 3600_000, POS_NONE));
        assertEquals(HOLD_WAIT, GeofenceReceiver.judgeHeld(T, true, true, BLOCK_AWAY, false,
                T + 8L * 3600_000, POS_EDGE));
    }

    @Test public void aFixHereUnblocksIt() {
        assertEquals(HOLD_UNBLOCK, GeofenceReceiver.judgeHeld(T, false, true, BLOCK_RIVAL, false,
                T + 60_000, POS_HERE));
        assertEquals(HOLD_UNBLOCK, GeofenceReceiver.judgeHeld(T, false, true, BLOCK_AWAY, false,
                T + 60_000, POS_HERE));
    }

    @Test public void onlyAFixHereLiftsABlock() {
        for (int bl : new int[] { BLOCK_RIVAL, BLOCK_AWAY }) {
            for (int pos : new int[] { POS_NONE, POS_EDGE, POS_AWAY, POS_RIVAL }) {
                assertEquals(HOLD_WAIT, GeofenceReceiver.judgeHeld(T, true, true, bl, true,
                        DUE + 60_000, pos));
            }
        }
    }

    // ── judgeHeld: drift holds (4.9.2) ─────────────────────────────

    @Test public void aFixInsideMakesADriftHoldWaitOutTheDwell() {
        // It used to announce at once; a drive through is inside too.
        assertEquals(HOLD_UPGRADE, GeofenceReceiver.judgeHeld(T, false, false, BLOCK_NONE, false,
                T + 10_000, POS_HERE));
    }

    @Test public void aFixInsideAfterTheDwellConfirmsADriftHold() {
        // Dated from its ENTER, so a long-held one is announced at once.
        assertEquals(HOLD_CONFIRM, GeofenceReceiver.judgeHeld(T, false, false, BLOCK_NONE, false,
                T + 8L * 3600_000, POS_HERE));
    }

    @Test public void nearTheEdgeDoesNotUpgrade() {
        assertEquals(HOLD_WAIT, GeofenceReceiver.judgeHeld(T, false, false, BLOCK_NONE, false,
                T + 10_000, POS_EDGE));
    }

    @Test public void preciseFixOutsideDemotesATravelHold() {
        assertEquals(HOLD_DEMOTE, GeofenceReceiver.judgeHeld(T, true, false, BLOCK_NONE, false,
                T + 10_000, POS_AWAY));
    }

    @Test public void preciseFixOutsideLeavesAStillHoldWaiting() {
        // Already needs a precise fix inside; nothing to demote.
        assertEquals(HOLD_WAIT, GeofenceReceiver.judgeHeld(T, false, false, BLOCK_NONE, false,
                T + 10_000, POS_AWAY));
    }

    @Test public void preciseFixOutsideBeatsTheDwell() {
        // Even past the dwell, a place we have visibly left is not announced.
        assertEquals(HOLD_DEMOTE, GeofenceReceiver.judgeHeld(T, true, false, BLOCK_NONE, false,
                DUE + 60_000, POS_AWAY));
    }

    @Test public void travelHoldConfirmsAfterTheDwell() {
        // The rooftop car park: fuzzy fixes, no exit, three minutes on.
        assertEquals(HOLD_CONFIRM, GeofenceReceiver.judgeHeld(T, true, false, BLOCK_NONE, false,
                DUE, POS_NONE));
    }

    @Test public void travelHoldWaitsBeforeTheDwell() {
        assertEquals(HOLD_WAIT, GeofenceReceiver.judgeHeld(T, true, false, BLOCK_NONE, false,
                DUE - 1, POS_NONE));
    }

    @Test public void stillHoldNeverConfirmsOnTime() {
        // A phone sitting near a boundary all night: hours pass, no exit,
        // and it must stay silent.
        assertEquals(HOLD_WAIT, GeofenceReceiver.judgeHeld(T, false, false, BLOCK_NONE, false,
                T + 8L * 3600_000, POS_NONE));
    }

    @Test public void aDriftHoldNearerARivalIsBlocked() {
        assertEquals(HOLD_BLOCK_RIVAL, GeofenceReceiver.judgeHeld(T, true, false, BLOCK_NONE, false,
                T + 60_000, POS_RIVAL));
    }

    @Test public void clockBehindTheEnterWaits() {
        assertEquals(HOLD_WAIT, GeofenceReceiver.judgeHeld(T, true, false, BLOCK_NONE, false,
                T - 60_000, POS_NONE));
        assertEquals(HOLD_WAIT, GeofenceReceiver.judgeHeld(T, true, true, BLOCK_NONE, false,
                T - 60_000, POS_NONE));
    }

    // ── confirmsAtExit ─────────────────────────────────────────────

    @Test public void aDriveThroughIsDiscarded() {
        // ENTER and EXIT a minute apart: neither "arrived" nor "left".
        assertFalse(GeofenceReceiver.confirmsAtExit(T, false, true, BLOCK_NONE, T + 60_000));
    }

    @Test public void aStayIsConfirmedAtItsDeparture() {
        // A device that produced no batch in between: 10:13 → 10:36.
        assertTrue(GeofenceReceiver.confirmsAtExit(T, false, true, BLOCK_NONE, T + 23 * 60_000));
    }

    @Test public void aStayAtARivalIsDiscardedHoweverLong() {
        assertFalse(GeofenceReceiver.confirmsAtExit(T, false, true, BLOCK_RIVAL, T + 8L * 3600_000));
        assertFalse(GeofenceReceiver.confirmsAtExit(T, false, true, BLOCK_AWAY, T + 8L * 3600_000));
    }

    @Test public void aLongStayFromTravelIsConfirmedAtItsDeparture() {
        assertTrue(GeofenceReceiver.confirmsAtExit(T, true, false, BLOCK_NONE, T + 23 * 60_000));
    }

    @Test public void aStillHoldIsDiscardedAtItsExitHoweverLong() {
        assertFalse(GeofenceReceiver.confirmsAtExit(T, false, false, BLOCK_NONE, T + 8L * 3600_000));
    }

    @Test public void exitDwellEdgeIsInclusive() {
        assertTrue(GeofenceReceiver.confirmsAtExit(T, false, true, BLOCK_NONE, DUE));
        assertTrue(GeofenceReceiver.confirmsAtExit(T, true, false, BLOCK_NONE, DUE));
        assertFalse(GeofenceReceiver.confirmsAtExit(T, false, true, BLOCK_NONE, DUE - 1));
    }

    // ── confirmsOnDwellEvent ───────────────────────────────────────

    @Test public void playServicesDwellConfirmsAWaitingArrival() {
        assertTrue(GeofenceReceiver.confirmsOnDwellEvent(T, false, true, BLOCK_NONE, false, DUE));
        // Allowing for the triggering fix's clock against this phone's.
        assertTrue(GeofenceReceiver.confirmsOnDwellEvent(T, false, true, BLOCK_NONE, false,
                DUE - DWELL_EVENT_SLACK_MS));
    }

    @Test public void playServicesDwellDoesNotConfirmARestartedDwell() {
        // Unblocked a minute ago: Play Services' dwell began long before ours.
        assertFalse(GeofenceReceiver.confirmsOnDwellEvent(T, false, true, BLOCK_NONE, false,
                T + 60_000));
    }

    @Test public void playServicesDwellNeverConfirmsABlockedHold() {
        assertFalse(GeofenceReceiver.confirmsOnDwellEvent(T, false, true, BLOCK_RIVAL, false, DUE));
        assertFalse(GeofenceReceiver.confirmsOnDwellEvent(T, false, true, BLOCK_AWAY, false, DUE));
    }

    @Test public void playServicesDwellNeverConfirmsAStillDriftHold() {
        // Play Services believes "inside" on drift for hours.
        assertFalse(GeofenceReceiver.confirmsOnDwellEvent(T, false, false, BLOCK_NONE, false,
                T + 8L * 3600_000));
        assertTrue(GeofenceReceiver.confirmsOnDwellEvent(T, true, false, BLOCK_NONE, false, DUE));
    }

    @Test public void playServicesDwellWaitsForAHeldDeparture() {
        assertFalse(GeofenceReceiver.confirmsOnDwellEvent(T, false, true, BLOCK_NONE, true, DUE));
    }
}
