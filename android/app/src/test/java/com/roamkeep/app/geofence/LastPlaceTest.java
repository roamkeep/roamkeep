package com.roamkeep.app.geofence;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * What keep_members.last_place_id should say (4.11.4): the place the family
 * has been told the member is at. The pin write re-sends it whenever it
 * differs from what last landed, so a lost member update heals in one pin
 * interval; these rules decide what "it" is.
 */
public class LastPlaceTest {
    private static final PrefsStore.Place HOME =
            new PrefsStore.Place("b-home", "Home", "🏠", 0, 0, 80f);
    private static final PrefsStore.Place STREET =
            new PrefsStore.Place("a-street", "Street", "🏘", 0, 0, 400f);
    private static final PrefsStore.Place SHOP =
            new PrefsStore.Place("c-shop", "Shop", "🛒", 1, 1, 80f);
    private static final List<PrefsStore.Place> PLACES = Arrays.asList(STREET, HOME, SHOP);
    private static final Set<String> NONE = Collections.emptySet();

    // 0.001° of latitude is ~111 m. A home and a school side by side, their
    // centres ~117 m apart with 100 m circles: the owner's screenshot,
    // 2026-11-02. The school is the bigger one here so that "smallest wins",
    // the 4.11.4 rule, gets the school end wrong.
    private static final PrefsStore.Place NEXT_HOME =
            new PrefsStore.Place("d-home", "Home", "🏠", 0, 0, 100f);
    private static final PrefsStore.Place SCHOOL =
            new PrefsStore.Place("e-school", "School", "🏫", 0.00105, 0, 130f);
    private static final PrefsStore.Place TOWN =
            new PrefsStore.Place("f-town", "Town", "🏙", 0.0004, 0, 2000f);
    private static final List<PrefsStore.Place> SIDE_BY_SIDE = Arrays.asList(NEXT_HOME, SCHOOL, TOWN);

    private static Set<String> set(String... ids) {
        return new HashSet<>(Arrays.asList(ids));
    }

    private static String show(Set<String> inside, Set<String> held, String prefer) {
        return GeofenceReceiver.placeToShow(inside, held, PLACES, prefer, null, null);
    }

    private static String at(double lat, String prefer, String... inside) {
        return GeofenceReceiver.placeToShow(set(inside), NONE, SIDE_BY_SIDE, prefer, lat, 0.0);
    }

    @Test public void outsideEverywhereIsNone() {
        assertNull(show(NONE, NONE, "b-home"));
    }

    @Test public void theOnePlaceWeAreIn() {
        assertEquals("b-home", show(set("b-home"), NONE, null));
    }

    @Test public void aHeldArrivalIsNotShown() {
        // The family has not been told; the row moves with the announcement.
        assertNull(show(set("c-shop"), set("c-shop"), "c-shop"));
    }

    @Test public void theMostSpecificPlaceWins() {
        assertEquals("b-home", show(set("a-street", "b-home"), NONE, ""));
    }

    @Test public void aValueAlreadyWrittenIsKeptWhileItHolds() {
        // Arrived at the street first: no reason to swap it on the next pin.
        assertEquals("a-street", show(set("a-street", "b-home"), NONE, "a-street"));
    }

    @Test public void aValueNoLongerTrueIsReplaced() {
        // Left home, still in the street: that, not "none" and not "home".
        assertEquals("a-street", show(set("a-street"), NONE, "b-home"));
    }

    @Test public void tiesGoToTheLowerId() {
        assertEquals("b-home", show(set("c-shop", "b-home"), NONE, null));
    }

    @Test public void aPlaceWeNoLongerHaveIsNeverSent() {
        // last_place_id is a foreign key: an id with no metadata here is a
        // place deleted elsewhere, and the server would refuse it.
        assertNull(show(set("gone"), NONE, "gone"));
    }

    // ---- inside two overlapping places at once (4.12.1) ----

    @Test public void sideBySideTheNearerMiddleWins() {
        // In the shared strip, nearer the school's middle: the school, though
        // it is the bigger of the two.
        assertEquals("e-school", at(0.00075, "", "d-home", "e-school"));
        // The other end of the strip: home.
        assertEquals("d-home", at(0.0004, "", "d-home", "e-school"));
    }

    @Test public void sideBySideStillKeepsWhatWasWritten() {
        // Stickiness first, as before: a written school is not swapped for
        // home while both still hold.
        assertEquals("e-school", at(0.0004, "e-school", "d-home", "e-school"));
    }

    @Test public void aTownGivesWayToTheHomeInsideIt() {
        // At the edge of home, 53 m from the town's centre: by share of
        // radius the town is far nearer (0.03 against 0.98), but home lies
        // wholly inside it, so home is the answer anywhere within home.
        assertEquals("d-home", at(0.00088, "", "d-home", "f-town"));
    }

    @Test public void aTownGivesWayAndTheNeighboursAreRankedAsBefore() {
        assertEquals("e-school", at(0.00075, "", "d-home", "e-school", "f-town"));
    }

    @Test public void withNoPositionTheSmallerPlaceWins() {
        assertEquals("d-home", GeofenceReceiver.placeToShow(set("d-home", "e-school"), NONE,
                SIDE_BY_SIDE, "", null, null));
    }

    @Test public void theDistanceIsGoodEnoughToRankWith() {
        // 0.001° of latitude at the equator is 111.2 m.
        assertEquals(111.2, GeofenceReceiver.metresBetween(0, 0, 0.001, 0), 0.1);
    }
}
