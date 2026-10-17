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

    private static Set<String> set(String... ids) {
        return new HashSet<>(Arrays.asList(ids));
    }

    @Test public void outsideEverywhereIsNone() {
        assertNull(GeofenceReceiver.placeToShow(NONE, NONE, PLACES, "b-home"));
    }

    @Test public void theOnePlaceWeAreIn() {
        assertEquals("b-home", GeofenceReceiver.placeToShow(set("b-home"), NONE, PLACES, null));
    }

    @Test public void aHeldArrivalIsNotShown() {
        // The family has not been told; the row moves with the announcement.
        assertNull(GeofenceReceiver.placeToShow(set("c-shop"), set("c-shop"), PLACES, "c-shop"));
    }

    @Test public void theMostSpecificPlaceWins() {
        assertEquals("b-home", GeofenceReceiver.placeToShow(set("a-street", "b-home"), NONE, PLACES, ""));
    }

    @Test public void aValueAlreadyWrittenIsKeptWhileItHolds() {
        // Arrived at the street first: no reason to swap it on the next pin.
        assertEquals("a-street",
                GeofenceReceiver.placeToShow(set("a-street", "b-home"), NONE, PLACES, "a-street"));
    }

    @Test public void aValueNoLongerTrueIsReplaced() {
        // Left home, still in the street: that, not "none" and not "home".
        assertEquals("a-street", GeofenceReceiver.placeToShow(set("a-street"), NONE, PLACES, "b-home"));
    }

    @Test public void tiesGoToTheLowerId() {
        assertEquals("b-home", GeofenceReceiver.placeToShow(set("c-shop", "b-home"), NONE, PLACES, null));
    }

    @Test public void aPlaceWeNoLongerHaveIsNeverSent() {
        // last_place_id is a foreign key: an id with no metadata here is a
        // place deleted elsewhere, and the server would refuse it.
        assertNull(GeofenceReceiver.placeToShow(set("gone"), NONE, PLACES, "gone"));
    }
}
