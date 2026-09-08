package com.roamkeep.app.geofence;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collection;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Typed wrapper around SharedPreferences for the native geofence
 * plugin. Holds the Supabase auth context the broadcast receiver
 * needs to POST check-ins without the app process being alive, plus
 * the place metadata keyed by geofence id (so the receiver can build
 * a human-readable check-in payload from just the triggering id).
 *
 * Stored as plaintext. The tokens here are the same Supabase JWT +
 * refresh token the WebView keeps in localStorage, so we're not
 * exposing anything that wasn't already present on the device. If
 * we later want encryption-at-rest we can swap for EncryptedSharedPreferences
 * without changing callers.
 */
public class PrefsStore {
    private static final String PREFS = "roamkeep_geofence";

    // Auth + keep context.
    private static final String K_SUPABASE_URL   = "supabase_url";
    private static final String K_ANON_KEY       = "anon_key";
    private static final String K_ACCESS_TOKEN   = "access_token";
    private static final String K_REFRESH_TOKEN  = "refresh_token";
    private static final String K_USER_ID        = "user_id";
    private static final String K_KEEP_ID        = "keep_id";
    /** Pre-v9 name of K_KEEP_ID; see migrateNestIdKey(). */
    private static final String LEGACY_K_NEST_ID = "nest_id";
    private static final String K_MEMBER_ID      = "member_id";
    private static final String K_MEMBER_NAME    = "member_name";
    private static final String K_MEMBER_AVATAR  = "member_avatar";

    // Places: JSON array of { id, name, icon, lat, lng, radius }.
    private static final String K_PLACES = "places";

    // Fingerprint of the place list as it was last ARMED (see
    // GeofenceArmer.signature). A push wake-up refetches keep_places and
    // compares against this, so the common case — a wake-up caused by
    // something else entirely — costs one comparison instead of a
    // pointless re-registration.
    //
    // Deliberately NOT K_LAST_PUSH_SEEN: that one means "newest check-in
    // already notified" and advancing it for a place change would drop
    // notifications.
    private static final String K_PLACES_SIG = "places_sig";

    // Active tracking mode (auto|live|balanced|saver). Persisted so the
    // BootReceiver can re-arm native location updates headlessly after a
    // reboot without waiting for the app to open.
    private static final String K_TRACK_MODE = "track_mode";

    // Diagnostics: the last time LocationUpdateReceiver fired and running
    // counters of how many breadcrumbs it wrote vs. suppressed (inside a
    // place). Surfaced via the plugin so a device can self-report whether
    // native breadcrumb logging is actually working.
    private static final String K_LAST_LOC_FIRE   = "last_loc_fire";
    private static final String K_LOC_FIRE_COUNT   = "loc_fire_count";
    private static final String K_CRUMB_COUNT      = "crumb_count";
    private static final String K_SUPPRESSED_COUNT = "suppressed_count";
    // Fixes the receiver refused to record: too imprecise to be a position,
    // or indistinguishable from drift about the anchor below. Before this
    // existed the three counters above always summed exactly to the fire
    // count, because nothing was ever rejected — which read as healthy and
    // was in fact the bug.
    private static final String K_REJECTED_COUNT   = "rejected_count";
    // Rate-limit stamp for the rejection journal summary. PERSISTED, not a
    // static: this path runs in short-lived processes, and an in-memory
    // stamp would emit a line on the first rejection after every process
    // death — every few minutes on a doze-cycling device, which is exactly
    // the journal noise that makes a journal useless.
    private static final String K_LAST_REJ_JOURNAL = "last_rej_journal";

    // ── Breadcrumb drift anchor ────────────────────────────────────
    //
    // The last position LocationUpdateReceiver accepted as somewhere the
    // device genuinely was. An imprecise fix is measured against THIS, not
    // against the previous fix: drift is a random walk that stays near its
    // origin, so an anchor that only advances on an accepted fix can never
    // be walked away from by noise — while real travel accumulates against
    // it and always clears the bar eventually. That asymmetry is the whole
    // mechanism, and it is why this can thin a trail but never end one.
    //
    // PERSISTED because the pipeline is headless. The foreground service
    // callback, the doze-exit one-shot and the legacy receiver can each run
    // in a freshly created process; an in-memory anchor would reset to "no
    // anchor" — accept everything — on every process death, which on the
    // device that produced this bug is every few minutes.
    //
    // Deliberately NO expiry. A stale anchor can only ever make the gate
    // MORE permissive (you are far from it, so fixes pass), never less.
    // There is no age at which forgetting it would protect a real trip.
    private static final String K_ANCHOR_LAT = "crumb_anchor_lat";
    private static final String K_ANCHOR_LNG = "crumb_anchor_lng";
    private static final String K_ANCHOR_T   = "crumb_anchor_t";

    // ── Stillness estimate ─────────────────────────────────────────
    //
    // The anchor above sets the SPACING of written points. It cannot decide
    // whether the device is moving at all, because that question cannot be
    // answered from one fix: a single sample lands beyond any threshold a
    // fixed fraction of the time, whatever you compare it against. Measured,
    // that left a still phone on ±66 m fixes still writing ~30 points an hour
    // — fewer than before, but each one a bigger jump, which the timeline
    // sums into kilometres.
    //
    // So stillness is decided from an AVERAGED position, whose noise falls
    // with the number of samples. `ema` is that average; `still` is where it
    // sat when the device was last known to be moving. While the average has
    // not left `still`, the device has not left either, and nothing is
    // written.
    //
    // An exponential average rather than a ring buffer because this has to
    // survive process death in SharedPreferences, and its weighting is by
    // TIME, not sample count, so the smoothing does not change when the
    // tracking profile does.
    private static final String K_EMA_LAT      = "motion_ema_lat";
    private static final String K_EMA_LNG      = "motion_ema_lng";
    private static final String K_EMA_T        = "motion_ema_t";
    private static final String K_STILL_LAT    = "motion_still_lat";
    private static final String K_STILL_LNG    = "motion_still_lng";
    private static final String K_MOVING_UNTIL = "motion_moving_until";

    // IDs of places the device is *currently* considered inside. The
    // receiver uses this to dedupe ENTERs and drop synthetic EXITs
    // that Google Play Services sometimes fires on re-registration,
    // doze wake-up, or charging-state transitions. Without this,
    // users see spurious "left <place>" check-ins for places they
    // never actually entered this session.
    private static final String K_INSIDE_PLACE_IDS = "inside_place_ids";

    // Black-box event journal: JSON array of { t: epochMs, e: text },
    // capped at JOURNAL_CAP (oldest dropped). Written by the service,
    // receivers and plugin at lifecycle-significant moments (doze
    // transitions, service create/destroy, geofence fires, package
    // updates) and surfaced in the Diagnostics panel — so the next
    // tracking anomaly can be explained from the phone screen instead
    // of a perishable adb logcat buffer.
    private static final String K_JOURNAL = "journal";
    private static final int JOURNAL_CAP = 120;

    // Check-in payloads the receiver tried to POST but couldn't deliver
    // (transient network failure on the boundary crossing — most often
    // a WiFi → cellular handoff while leaving home). Stored as a JSON
    // array; drained on every subsequent receiver fire, on every
    // breadcrumb fire with a non-empty queue (the earliest proof the
    // network is back), and on every app launch via the flushPending
    // plugin method. Capped at PENDING_CAP entries; oldest dropped on
    // overflow.
    private static final String K_PENDING_CHECKINS = "pending_checkins";
    private static final int PENDING_CAP = 50;

    private final SharedPreferences sp;

    public PrefsStore(Context ctx) {
        this.sp = ctx.getApplicationContext()
                .getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        migrateNestIdKey();
    }

    /** v9 renamed the stored key "nest_id" → "keep_id", and the column
     *  it names in Supabase along with it. Without this copy, an
     *  in-place upgrade orphans the value: hasContext() goes false and
     *  every headless path (geofence receiver, breadcrumbs,
     *  BootReceiver, push wake-up) silently bails until the user next
     *  opens the app and initialize() rewrites the context.
     *
     *  The pending-checkin queue needs the same treatment for a
     *  different reason: an entry queued before the upgrade carries a
     *  "nest_id" field, which the migrated database rejects. The drain
     *  loop stops at the first failure, so one stale entry would wedge
     *  the queue permanently.
     *
     *  One-shot — the old key is removed, so this is a no-op from the
     *  second construction onwards. */
    private void migrateNestIdKey() {
        if (!sp.contains(LEGACY_K_NEST_ID)) return;
        SharedPreferences.Editor e = sp.edit();
        String legacy = sp.getString(LEGACY_K_NEST_ID, null);
        if (legacy != null && sp.getString(K_KEEP_ID, null) == null) {
            e.putString(K_KEEP_ID, legacy);
        }
        e.remove(LEGACY_K_NEST_ID);

        try {
            JSONArray arr = new JSONArray(sp.getString(K_PENDING_CHECKINS, "[]"));
            boolean touched = false;
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.getJSONObject(i);
                if (o.has("nest_id")) {
                    o.put("keep_id", o.remove("nest_id"));
                    touched = true;
                }
            }
            if (touched) e.putString(K_PENDING_CHECKINS, arr.toString());
        } catch (JSONException ignored) { /* corrupt → leave it */ }

        e.apply();
    }

    // ── Auth / context ─────────────────────────────────────────────

    public void setContext(String supabaseUrl, String anonKey,
                           String userId, String keepId, String memberId,
                           String memberName, String memberAvatar) {
        sp.edit()
                .putString(K_SUPABASE_URL, supabaseUrl)
                .putString(K_ANON_KEY, anonKey)
                .putString(K_USER_ID, userId)
                .putString(K_KEEP_ID, keepId)
                .putString(K_MEMBER_ID, memberId)
                .putString(K_MEMBER_NAME, memberName)
                .putString(K_MEMBER_AVATAR, memberAvatar)
                .apply();
    }

    public void setTokens(String accessToken, String refreshToken) {
        sp.edit()
                .putString(K_ACCESS_TOKEN, accessToken)
                .putString(K_REFRESH_TOKEN, refreshToken)
                .apply();
    }

    public String getSupabaseUrl()  { return sp.getString(K_SUPABASE_URL, null); }
    public String getAnonKey()      { return sp.getString(K_ANON_KEY, null); }
    public String getAccessToken()  { return sp.getString(K_ACCESS_TOKEN, null); }
    public String getRefreshToken() { return sp.getString(K_REFRESH_TOKEN, null); }
    public String getUserId()       { return sp.getString(K_USER_ID, null); }
    public String getKeepId()       { return sp.getString(K_KEEP_ID, null); }
    public String getMemberId()     { return sp.getString(K_MEMBER_ID, null); }
    public String getMemberName()   { return sp.getString(K_MEMBER_NAME, "Someone"); }
    public String getMemberAvatar() { return sp.getString(K_MEMBER_AVATAR, "📍"); }

    public void setTrackMode(String mode) {
        sp.edit().putString(K_TRACK_MODE, mode).apply();
    }
    public String getTrackMode() { return sp.getString(K_TRACK_MODE, "auto"); }

    // Adult self-pause: the epoch-ms instant tracking should stay off
    // until (0 = not paused). The whole native pipeline consults isPaused()
    // — the foreground service, boot re-arm and both receivers refuse to
    // run while it's true — so a pause actually silences tracking rather
    // than just hiding the pin. Auto-expires: once the instant passes,
    // isPaused() is false again with no write needed.
    private static final String K_PAUSED_UNTIL = "paused_until";
    public void setPausedUntil(long ms) { sp.edit().putLong(K_PAUSED_UNTIL, ms).apply(); }
    public long getPausedUntil()        { return sp.getLong(K_PAUSED_UNTIL, 0); }

    // Newest check-in we have already raised a notification for, as the
    // raw created_at string. Push is content-free now, so a wake-up just
    // means "something happened" — this is how the device works out what
    // is actually new and avoids re-notifying the same row.
    private static final String K_LAST_PUSH_SEEN = "last_push_seen";
    public String getLastPushSeen()            { return sp.getString(K_LAST_PUSH_SEEN, null); }
    public void setLastPushSeen(String isoTs)  { sp.edit().putString(K_LAST_PUSH_SEEN, isoTs).apply(); }

    /** null = never armed. Distinct from "" (armed an empty list), which
     *  is a real state meaning every place was deleted. */
    public String getPlacesSignature()          { return sp.getString(K_PLACES_SIG, null); }
    public void setPlacesSignature(String sig)  { sp.edit().putString(K_PLACES_SIG, sig).apply(); }
    public boolean isPaused()           { return getPausedUntil() > System.currentTimeMillis(); }

    /** Record a LocationUpdateReceiver firing: stamp the time and bump the
     *  fire / breadcrumb / suppressed-inside-place / rejected counters.
     *  The four should account for every fix, so
     *  {@code written + suppressed + rejected} summing to the fixes seen is
     *  a real check rather than an accident of nothing ever being dropped. */
    public synchronized void recordLocationFire(long whenMs, int crumbsWritten,
                                                int suppressed, int rejected) {
        sp.edit()
                .putLong(K_LAST_LOC_FIRE, whenMs)
                .putInt(K_LOC_FIRE_COUNT, sp.getInt(K_LOC_FIRE_COUNT, 0) + 1)
                .putInt(K_CRUMB_COUNT, sp.getInt(K_CRUMB_COUNT, 0) + crumbsWritten)
                .putInt(K_SUPPRESSED_COUNT, sp.getInt(K_SUPPRESSED_COUNT, 0) + suppressed)
                .putInt(K_REJECTED_COUNT, sp.getInt(K_REJECTED_COUNT, 0) + rejected)
                .apply();
    }
    public long getLastLocationFire() { return sp.getLong(K_LAST_LOC_FIRE, 0); }
    public int getLocationFireCount() { return sp.getInt(K_LOC_FIRE_COUNT, 0); }
    public int getBreadcrumbCount()   { return sp.getInt(K_CRUMB_COUNT, 0); }
    public int getSuppressedCount()   { return sp.getInt(K_SUPPRESSED_COUNT, 0); }
    public int getRejectedCount()     { return sp.getInt(K_REJECTED_COUNT, 0); }

    public long getLastRejectJournal()          { return sp.getLong(K_LAST_REJ_JOURNAL, 0); }
    public void setLastRejectJournal(long ms)   { sp.edit().putLong(K_LAST_REJ_JOURNAL, ms).apply(); }

    /** The last position accepted as real. Null until one has been recorded
     *  (fresh install, or after a sign-out clears everything). */
    public synchronized Anchor getBreadcrumbAnchor() {
        long t = sp.getLong(K_ANCHOR_T, 0);
        if (t == 0) return null;
        return new Anchor(Double.longBitsToDouble(sp.getLong(K_ANCHOR_LAT, 0)),
                          Double.longBitsToDouble(sp.getLong(K_ANCHOR_LNG, 0)), t);
    }

    /** ONE editor, so the three values commit together. A torn anchor — the
     *  latitude of one fix with the longitude of another — would be a
     *  position that never existed, and the gate would measure drift against
     *  it forever. If this is ever split into separate writes, that bug
     *  comes back. */
    public synchronized void setBreadcrumbAnchor(double lat, double lng, long tMs) {
        sp.edit()
                .putLong(K_ANCHOR_LAT, Double.doubleToRawLongBits(lat))
                .putLong(K_ANCHOR_LNG, Double.doubleToRawLongBits(lng))
                .putLong(K_ANCHOR_T, tMs)
                .apply();
    }

    /** SharedPreferences has no double; raw long bits keep it exact. */
    public static final class Anchor {
        public final double lat, lng;
        public final long tMs;
        Anchor(double lat, double lng, long tMs) { this.lat = lat; this.lng = lng; this.tMs = tMs; }
    }

    /** The whole stillness estimate, read and written as one unit. */
    public static final class Motion {
        /** false = never seeded (fresh install, or just after a sign-out). */
        public final boolean valid;
        public final double emaLat, emaLng;
        public final long emaMs;
        public final double stillLat, stillLng;
        public final long movingUntilMs;
        Motion(boolean valid, double emaLat, double emaLng, long emaMs,
               double stillLat, double stillLng, long movingUntilMs) {
            this.valid = valid; this.emaLat = emaLat; this.emaLng = emaLng;
            this.emaMs = emaMs; this.stillLat = stillLat; this.stillLng = stillLng;
            this.movingUntilMs = movingUntilMs;
        }
    }

    public synchronized Motion getMotion() {
        long t = sp.getLong(K_EMA_T, 0);
        if (t == 0) return new Motion(false, 0, 0, 0, 0, 0, 0);
        return new Motion(true,
                Double.longBitsToDouble(sp.getLong(K_EMA_LAT, 0)),
                Double.longBitsToDouble(sp.getLong(K_EMA_LNG, 0)), t,
                Double.longBitsToDouble(sp.getLong(K_STILL_LAT, 0)),
                Double.longBitsToDouble(sp.getLong(K_STILL_LNG, 0)),
                sp.getLong(K_MOVING_UNTIL, 0));
    }

    /** One editor, for the same reason the anchor uses one: a half-written
     *  motion state would describe a device that was never anywhere. */
    public synchronized void setMotion(double emaLat, double emaLng, long emaMs,
                                       double stillLat, double stillLng, long movingUntilMs) {
        sp.edit()
                .putLong(K_EMA_LAT, Double.doubleToRawLongBits(emaLat))
                .putLong(K_EMA_LNG, Double.doubleToRawLongBits(emaLng))
                .putLong(K_EMA_T, emaMs)
                .putLong(K_STILL_LAT, Double.doubleToRawLongBits(stillLat))
                .putLong(K_STILL_LNG, Double.doubleToRawLongBits(stillLng))
                .putLong(K_MOVING_UNTIL, movingUntilMs)
                .apply();
    }

    /**
     * Shared monitor for read-modify-write state.
     *
     * `synchronized` on an instance method locks `this`, and every call site
     * in this codebase constructs its own PrefsStore — so instance locking
     * guards nothing at all. Every method below that reads a value, changes
     * it and writes it back therefore needs a lock that all instances share.
     * SharedPreferences itself is process-wide, so the data being guarded is
     * shared even though the wrappers are not.
     *
     * The remaining `synchronized` methods in this class have the same latent
     * flaw. They are left alone for now because the pipeline that touches
     * them is serialised at its source (LocationUpdateReceiver.submit); this
     * lock covers the journal, which genuinely is written from several
     * threads at once — the foreground service's main looper, the geofence
     * worker and the location worker — and is the only witness we have for
     * headless behaviour, so losing lines to a race is expensive.
     */
    private static final Object LOCK = new Object();

    /** Append a line to the black-box journal. Cheap and safe to call
     *  from any thread; failures are swallowed — diagnostics must never
     *  break the pipeline they're diagnosing. */
    public void journal(String event) {
        synchronized (LOCK) { journalLocked(event); }
    }

    private void journalLocked(String event) {
        if (event == null) return;
        try {
            JSONArray arr = new JSONArray(sp.getString(K_JOURNAL, "[]"));
            JSONObject e = new JSONObject();
            e.put("t", System.currentTimeMillis());
            e.put("e", event);
            arr.put(e);
            while (arr.length() > JOURNAL_CAP) arr.remove(0);
            sp.edit().putString(K_JOURNAL, arr.toString()).apply();
        } catch (JSONException ignored) {}
    }

    public String getJournalRaw() {
        synchronized (LOCK) { return sp.getString(K_JOURNAL, "[]"); }
    }

    public boolean hasContext() {
        return getSupabaseUrl() != null && getAnonKey() != null
                && getAccessToken() != null && getKeepId() != null
                && getMemberId() != null;
    }

    public void clearAll() {
        sp.edit().clear().apply();
    }

    // ── Places ──────────────────────────────────────────────────────

    public static class Place {
        public final String id;
        public final String name;
        public final String icon;
        public final double lat;
        public final double lng;
        public final float radius;

        public Place(String id, String name, String icon, double lat, double lng, float radius) {
            this.id = id;
            this.name = name;
            this.icon = icon;
            this.lat = lat;
            this.lng = lng;
            this.radius = radius;
        }

        JSONObject toJson() throws JSONException {
            JSONObject o = new JSONObject();
            o.put("id", id);
            o.put("name", name);
            o.put("icon", icon);
            o.put("lat", lat);
            o.put("lng", lng);
            o.put("radius", radius);
            return o;
        }

        static Place fromJson(JSONObject o) throws JSONException {
            return new Place(
                    o.getString("id"),
                    o.getString("name"),
                    o.getString("icon"),
                    o.getDouble("lat"),
                    o.getDouble("lng"),
                    (float) o.getDouble("radius")
            );
        }
    }

    public synchronized List<Place> getPlaces() {
        String raw = sp.getString(K_PLACES, "[]");
        List<Place> out = new ArrayList<>();
        try {
            JSONArray arr = new JSONArray(raw);
            for (int i = 0; i < arr.length(); i++) {
                out.add(Place.fromJson(arr.getJSONObject(i)));
            }
        } catch (JSONException ignored) { /* corrupt → treat as empty */ }
        return out;
    }

    public synchronized Place findPlace(String id) {
        for (Place p : getPlaces()) if (p.id.equals(id)) return p;
        return null;
    }

    public synchronized void putPlace(Place p) {
        List<Place> places = getPlaces();
        // Replace any existing entry with same id.
        for (int i = 0; i < places.size(); i++) {
            if (places.get(i).id.equals(p.id)) { places.remove(i); break; }
        }
        places.add(p);
        writePlaces(places);
    }

    public synchronized void removePlace(String id) {
        List<Place> places = getPlaces();
        for (int i = 0; i < places.size(); i++) {
            if (places.get(i).id.equals(id)) { places.remove(i); break; }
        }
        writePlaces(places);
        // If we were tracking ourselves as inside this place, drop
        // it — the geofence no longer exists, so we should not
        // expect a matching EXIT to clear the state later.
        removeInsidePlace(id);
    }

    public synchronized void clearPlaces() {
        writePlaces(new ArrayList<>());
    }

    private void writePlaces(List<Place> places) {
        JSONArray arr = new JSONArray();
        try {
            for (Place p : places) arr.put(p.toJson());
        } catch (JSONException ignored) {}
        sp.edit().putString(K_PLACES, arr.toString()).apply();
    }

    // ── Inside-place tracking ──────────────────────────────────────
    //
    // The receiver treats this set as the authoritative record of
    // "places we have an unmatched ENTER for". A place is added on
    // successful ENTER check-in insert and removed on successful EXIT.
    // An EXIT broadcast for a place *not* in this set is treated as
    // synthetic (OS re-evaluation noise) and dropped. An ENTER for a
    // place *already* in the set is treated as a duplicate.

    public synchronized Set<String> getInsidePlaceIds() {
        String raw = sp.getString(K_INSIDE_PLACE_IDS, "[]");
        Set<String> out = new HashSet<>();
        try {
            JSONArray arr = new JSONArray(raw);
            for (int i = 0; i < arr.length(); i++) {
                String id = arr.optString(i, null);
                if (id != null) out.add(id);
            }
        } catch (JSONException ignored) {}
        return out;
    }

    public synchronized boolean isInsidePlace(String id) {
        return getInsidePlaceIds().contains(id);
    }

    public synchronized void setInsidePlaceIds(Collection<String> ids) {
        JSONArray arr = new JSONArray();
        if (ids != null) for (String id : ids) arr.put(id);
        sp.edit().putString(K_INSIDE_PLACE_IDS, arr.toString()).apply();
    }

    /** Union-merge — adds jsState on top of existing native state rather
     *  than overwriting. Preserves any ENTERs the receiver captured
     *  while the app was closed (and that JS doesn't know about yet
     *  because last_place_id only tracks one place). */
    public synchronized void mergeInsidePlaceIds(Collection<String> ids) {
        if (ids == null || ids.isEmpty()) return;
        Set<String> existing = getInsidePlaceIds();
        if (existing.addAll(ids)) setInsidePlaceIds(existing);
    }

    public synchronized void addInsidePlace(String id) {
        if (id == null) return;
        Set<String> set = getInsidePlaceIds();
        if (set.add(id)) setInsidePlaceIds(set);
    }

    public synchronized void removeInsidePlace(String id) {
        if (id == null) return;
        Set<String> set = getInsidePlaceIds();
        if (set.remove(id)) setInsidePlaceIds(set);
    }

    // ── Pending check-in queue ─────────────────────────────────────
    //
    // Idempotency depends on each entry carrying a client-generated
    // UUID under "id" — duplicate INSERTs land as 409 Conflict on the
    // primary-key constraint, which the receiver treats as success
    // (the row already made it; we just didn't see the response).

    public synchronized List<JSONObject> getPendingCheckins() {
        String raw = sp.getString(K_PENDING_CHECKINS, "[]");
        List<JSONObject> out = new ArrayList<>();
        try {
            JSONArray arr = new JSONArray(raw);
            for (int i = 0; i < arr.length(); i++) {
                out.add(arr.getJSONObject(i));
            }
        } catch (JSONException ignored) { /* corrupt → empty */ }
        return out;
    }

    public synchronized void appendPendingCheckin(JSONObject payload) {
        if (payload == null) return;
        List<JSONObject> list = getPendingCheckins();
        list.add(payload);
        // Trim from the front if we've blown through the cap. Older
        // entries are most likely already stale (e.g. user has been
        // offline for days) and dropping them is preferable to
        // unbounded SharedPreferences growth.
        while (list.size() > PENDING_CAP) list.remove(0);
        writePending(list);
    }

    public synchronized void removePendingCheckin(String id) {
        if (id == null) return;
        List<JSONObject> list = getPendingCheckins();
        boolean changed = false;
        for (int i = list.size() - 1; i >= 0; i--) {
            String entryId = list.get(i).optString("id", null);
            if (id.equals(entryId)) {
                list.remove(i);
                changed = true;
            }
        }
        if (changed) writePending(list);
    }

    public synchronized int pendingCount() {
        return getPendingCheckins().size();
    }

    private void writePending(List<JSONObject> list) {
        JSONArray arr = new JSONArray();
        for (JSONObject p : list) arr.put(p);
        sp.edit().putString(K_PENDING_CHECKINS, arr.toString()).apply();
    }
}
