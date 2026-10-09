package com.roamkeep.app.geofence;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * What the native side accepts from the web layer and the database before it
 * stores it, sends credentials to it, or arms a geofence from it (4.11.1).
 * The web layer is trusted and normally passes good values; these are the
 * second fence for when it does not.
 */
public class NativeInputTest {

    private static final String ID = "3f2b8c1e-9a4d-4e6f-b1c2-0d9e8f7a6b5c";

    // ── Where credentials go ─────────────────────────────────────────

    @Test public void aSupabaseProjectAddressIsAccepted() {
        assertTrue(SupabaseRest.isHttpsServerUrl("https://abcdefghijklmnop.supabase.co"));
    }

    @Test public void aSelfHostedAddressWithAPathIsAccepted() {
        // Requests are built as the address plus "/rest/v1/...", so a path
        // cannot send them to another host.
        assertTrue(SupabaseRest.isHttpsServerUrl("https://family.example.org/supabase"));
    }

    @Test public void plainHttpIsRefused() {
        assertFalse(SupabaseRest.isHttpsServerUrl("http://abcdefghijklmnop.supabase.co"));
    }

    @Test public void userInfoIsRefused() {
        // https://good@evil reads as "good" to a person and goes to "evil".
        assertFalse(SupabaseRest.isHttpsServerUrl("https://abcdefghijklmnop.supabase.co@evil.example"));
        assertFalse(SupabaseRest.isHttpsServerUrl("https://user:pass@abcdefghijklmnop.supabase.co"));
    }

    @Test public void aQueryOrFragmentIsRefused() {
        assertFalse(SupabaseRest.isHttpsServerUrl("https://abcdefghijklmnop.supabase.co?x=1"));
        assertFalse(SupabaseRest.isHttpsServerUrl("https://abcdefghijklmnop.supabase.co#x"));
    }

    @Test public void nothingAndNonsenseAreRefused() {
        assertFalse(SupabaseRest.isHttpsServerUrl(null));
        assertFalse(SupabaseRest.isHttpsServerUrl(""));
        assertFalse(SupabaseRest.isHttpsServerUrl("https://"));
        assertFalse(SupabaseRest.isHttpsServerUrl("not a url at all"));
        assertFalse(SupabaseRest.isHttpsServerUrl("javascript:alert(1)"));
    }

    // ── What filters are built from ──────────────────────────────────

    @Test public void uuidsAreRecognised() {
        assertTrue(SupabaseRest.isUuid(ID));
        assertTrue(SupabaseRest.isUuid(ID.toUpperCase()));
    }

    @Test public void anythingElseIsNotAUuid() {
        assertFalse(SupabaseRest.isUuid(null));
        assertFalse(SupabaseRest.isUuid(""));
        assertFalse(SupabaseRest.isUuid(ID + "&keep_id=neq.x"));   // a second filter, smuggled in
        assertFalse(SupabaseRest.isUuid(ID.replace("-", "")));
        assertFalse(SupabaseRest.isUuid("zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz"));
    }

    // ── What logcat is told ──────────────────────────────────────────

    @Test public void logPathDropsTheQuery() {
        assertEquals("/rest/v1/keep_members",
                SupabaseRest.logPath("/rest/v1/keep_members?id=eq." + ID));
        assertEquals("/rest/v1/checkins", SupabaseRest.logPath("/rest/v1/checkins"));
        assertEquals("", SupabaseRest.logPath(null));
    }

    // ── What a geofence is armed from ────────────────────────────────

    @Test public void aWholePlaceRowIsValid() {
        assertTrue(GeofenceArmer.validPlaceRow(ID, "Home", -33.87, 151.21, 100));
    }

    @Test public void aRowMissingItsIdOrNameIsNot() {
        assertFalse(GeofenceArmer.validPlaceRow(null, "Home", -33.87, 151.21, 100));
        assertFalse(GeofenceArmer.validPlaceRow("home", "Home", -33.87, 151.21, 100));
        assertFalse(GeofenceArmer.validPlaceRow(ID, null, -33.87, 151.21, 100));
        assertFalse(GeofenceArmer.validPlaceRow(ID, "   ", -33.87, 151.21, 100));
    }

    @Test public void aRowWithImpossibleGeometryIsNot() {
        assertFalse(GeofenceArmer.validPlaceRow(ID, "Home", Double.NaN, 151.21, 100));   // optDouble's "missing"
        assertFalse(GeofenceArmer.validPlaceRow(ID, "Home", -33.87, Double.NaN, 100));
        assertFalse(GeofenceArmer.validPlaceRow(ID, "Home", 91, 151.21, 100));
        assertFalse(GeofenceArmer.validPlaceRow(ID, "Home", -33.87, 181, 100));
        assertFalse(GeofenceArmer.validPlaceRow(ID, "Home", -33.87, 151.21, 0));
        assertFalse(GeofenceArmer.validPlaceRow(ID, "Home", -33.87, 151.21, Double.POSITIVE_INFINITY));
    }
}
