package com.roamkeep.app.geofence;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.BatteryManager;
import android.util.Log;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;

/**
 * Tiny HTTP helper for calling Supabase REST + Auth endpoints from
 * the broadcast receiver, without pulling in OkHttp. Blocks on its
 * own thread (the receiver calls it via goAsync(); see GeofenceReceiver).
 *
 * Handles one round of JWT refresh on 401 — if the stored access
 * token has expired while the app was dead, we grab a fresh one via
 * the refresh-token grant, persist the new pair, and retry the call
 * once. If the refresh also fails we give up (the user needs to
 * reopen the app to get a fresh session).
 */
public class SupabaseRest {
    private static final String TAG = "RoamkeepGeo";
    private static final int TIMEOUT_MS = 15_000;

    /** SharedPreferences file the @capacitor/preferences plugin writes
     *  to by default. The WebView's supabase-js session lives here
     *  under the key sb-&lt;project-ref&gt;-auth-token; we mirror our
     *  refreshed tokens into that blob so the next app launch finds a
     *  valid session instead of trying to re-use a refresh token we
     *  already consumed. */
    private static final String CAP_PREFS_NAME = "CapacitorStorage";

    /** One refresh at a time, process-wide. The geofence worker, the
     *  location worker, the messaging service and the plugin's flush thread
     *  can all hit an expired token in the same second; without this each
     *  spent the same refresh token. */
    private static final Object REFRESH_LOCK = new Object();

    /** PostgREST's SQLSTATE for "new row violates row-level security". */
    static final String RLS_DENIED = "42501";

    private final Context appCtx;
    private final PrefsStore prefs;

    /** SQLSTATE of this instance's most recent failed request, or null. */
    private volatile String lastSqlState;

    public SupabaseRest(Context ctx) {
        this.appCtx = ctx.getApplicationContext();
        this.prefs = new PrefsStore(ctx);
    }

    /** SQLSTATE of the last failed request made through this instance —
     *  "never a row value" (see sqlStateOf), so safe to log and branch on. */
    public String lastSqlState() { return lastSqlState; }

    /** Outcome buckets for callers that need to tell a row that landed from
     *  one that will land later and one that never will.
     *
     *  SUCCESS   — inserted now.
     *  DUPLICATE — already there: a retry hit the primary key (23505). The
     *              row IS in the DB; we just missed the first 2xx.
     *  FAILED    — transient (network, 5xx, an expired session): keep it
     *              and try again later.
     *  REJECTED  — the server refused THIS payload and always will (a
     *              constraint, an RLS denial after removal, a foreign key
     *              to a deleted place). Retrying cannot help; holding it
     *              would wedge the queue behind it. */
    public enum Result { SUCCESS, DUPLICATE, FAILED, REJECTED }

    /**
     * POST /rest/v1/checkins with the given body. Retries once after a
     * token refresh if the first attempt returns 401.
     */
    public Result insertCheckin(JSONObject body) {
        int status = doJsonWithRefresh("POST", "/rest/v1/checkins", body.toString(), "return=minimal");
        if (status >= 200 && status < 300) return Result.SUCCESS;
        // PostgREST reports every constraint violation as 409 — the primary
        // key (23505, a retried row that already landed) AND a foreign key
        // (23503: e.g. a place deleted since the crossing). Only the first
        // means "already there"; treating both as it used to drop the second
        // silently as if it had been delivered.
        if (status == 409 && "23505".equals(lastSqlState)) return Result.DUPLICATE;
        if (status == 400 || status == 403 || status == 404 || status == 409 || status == 422) {
            return Result.REJECTED;
        }
        return Result.FAILED;
    }

    /** Convenience boolean wrapper for insertCheckin — true when the
     *  row is in the DB (either freshly inserted or already present). */
    public boolean insertCheckinOk(JSONObject body) {
        Result r = insertCheckin(body);
        return r == Result.SUCCESS || r == Result.DUPLICATE;
    }

    /**
     * PATCH /rest/v1/keep_members?id=eq.<memberId> with the given body.
     */
    public boolean updateMember(String memberId, JSONObject body) {
        String path = "/rest/v1/keep_members?id=eq." + memberId;
        int status = doJsonWithRefresh("PATCH", path, body.toString(), "return=minimal");
        return status >= 200 && status < 300;
    }

    /**
     * POST a whole batch of breadcrumbs as ONE request, returning the raw
     * HTTP status.
     *
     * One request per batch rather than one per fix: every request wakes
     * the cellular radio, which then idles in a high-power tail for
     * seconds, so a dense trail written fix by fix cost far more battery
     * than the same rows sent together.
     *
     * `columns` names every column any row may carry. PostgREST otherwise
     * insists all objects in a bulk insert have identical keys, and ours do
     * not (speed is withheld from a fuzzy fix); with `columns`, a key a row
     * lacks is written NULL, which is what an absent speed or accuracy means.
     *
     * The raw status matters to the caller: a 400 on a batch carrying
     * accuracy means the v15 column is missing, and the rows are re-sent
     * without it rather than lost.
     */
    public int insertLocationHistoryBatchStatus(org.json.JSONArray rows, String columns) {
        String path = "/rest/v1/location_history?columns=" + columns;
        return doJsonWithRefresh("POST", path, rows.toString(), "return=minimal");
    }

    /**
     * Upsert this member's push token (keep_member_push is keyed on
     * member_id). Used when FCM rotates the token while the app is closed —
     * otherwise the new token is only saved at the next app open, and until
     * then the old one is dead and this phone gets no alerts at all.
     */
    public boolean upsertPushToken(String memberId, String keepId, String token) {
        try {
            JSONObject body = new JSONObject();
            body.put("member_id", memberId);
            body.put("keep_id", keepId);
            body.put("fcm_token", token);
            body.put("updated_at", toIso8601Utc(System.currentTimeMillis()));
            int status = doJsonWithRefresh("POST", "/rest/v1/keep_member_push?on_conflict=member_id",
                    body.toString(), "resolution=merge-duplicates,return=minimal");
            return status >= 200 && status < 300;
        } catch (JSONException e) {
            return false;
        }
    }

    /** Epoch-ms → the ISO-8601 UTC form PostgREST expects in filters. */
    static String toIso8601Utc(long ms) {
        java.text.SimpleDateFormat fmt = new java.text.SimpleDateFormat(
                "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", java.util.Locale.US);
        fmt.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));
        return fmt.format(new java.util.Date(ms));
    }

    /** Percent-encode a value for a PostgREST query string. */
    static String enc(String s) {
        try { return URLEncoder.encode(s == null ? "" : s, StandardCharsets.UTF_8.name()); }
        catch (Exception e) { return ""; }
    }

    /** Current battery percentage (0–100), or -1 if unavailable. Cheap
     *  synchronous read — the receivers piggyback it onto their existing
     *  keep_members PATCH so the family sees a fresh battery level in the
     *  background without any extra wakeups. */
    static int currentBatteryLevel(Context ctx) {
        try {
            BatteryManager bm = (BatteryManager) ctx.getSystemService(Context.BATTERY_SERVICE);
            if (bm != null) {
                int pct = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY);
                if (pct >= 0 && pct <= 100) return pct;
            }
        } catch (Exception ignored) {}
        return -1;
    }

    // ── internals ───────────────────────────────────────────────────

    /** A GET's outcome: the HTTP status (-1 on IO error) and, on 2xx, the body. */
    public static final class GetResult {
        public final int status;
        public final String body;
        GetResult(int status, String body) { this.status = status; this.body = body; }
        public boolean ok() { return status >= 200 && status < 300 && body != null; }
    }

    /**
     * GET a PostgREST path. Refreshes the session once on a 401.
     *
     * Returns the status as well as the body so a caller can tell "that
     * view does not exist on this database" (404) from "the network is
     * down" — the push path falls back to an unfiltered query only in the
     * first case; doing it on every failure leaked muted notifications.
     */
    public GetResult getResult(String path) {
        String token = prefs.getAccessToken();
        GetResult r = doGet(path, token);
        if (r.status == 401 && refreshAccessToken(token)) r = doGet(path, prefs.getAccessToken());
        return r;
    }

    /** Body of a successful GET, or null. See getResult for the status. */
    public String getWithRefresh(String path) {
        GetResult r = getResult(path);
        return r.ok() ? r.body : null;
    }

    private GetResult doGet(String path, String bearerToken) {
        HttpURLConnection conn = null;
        try {
            URL url = new URL(prefs.getSupabaseUrl() + path);
            conn = (HttpURLConnection) url.openConnection();
            conn.setConnectTimeout(TIMEOUT_MS);
            conn.setReadTimeout(TIMEOUT_MS);
            conn.setRequestMethod("GET");
            conn.setRequestProperty("Accept", "application/json");
            conn.setRequestProperty("apikey", prefs.getAnonKey());
            if (bearerToken != null) {
                conn.setRequestProperty("Authorization", "Bearer " + bearerToken);
            }
            int code = conn.getResponseCode();
            if (code < 200 || code >= 300) {
                Log.w(TAG, "GET " + path + " → " + code);
                return new GetResult(code, null);
            }
            try (BufferedReader r = new BufferedReader(new InputStreamReader(
                    conn.getInputStream(), StandardCharsets.UTF_8))) {
                StringBuilder sb = new StringBuilder();
                String line;
                while ((line = r.readLine()) != null) sb.append(line);
                return new GetResult(code, sb.toString());
            }
        } catch (IOException e) {
            Log.w(TAG, "GET " + path + " IO error: " + e.getMessage());
            return new GetResult(-1, null);
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    /**
     * Send, and refresh the session once if — and only if — the server
     * says the token is no good (401).
     *
     * It used to refresh on 403 as well. PostgREST answers 403 when ROW-
     * LEVEL SECURITY refuses a write (42501), which no new token can fix —
     * and which is exactly what a device sees after its member is removed
     * from the Keep. Every rejected breadcrumb then rotated the refresh
     * token, several times a minute, on a phone nobody was looking at.
     *
     * Also keeps the RLS-rejection streak (PrefsStore.bumpRejectStreak) for
     * INSERTs: a successful insert resets it, a 42501 extends it. PATCHes
     * are left out on purpose — updating a row that no longer exists
     * matches nothing and PostgREST calls that success (204), which would
     * reset a streak that is in fact running.
     */
    private int doJsonWithRefresh(String method, String path, String body, String preferHeader) {
        String token = prefs.getAccessToken();
        int status = doJson(method, path, body, preferHeader, token);
        if (status == 401 && refreshAccessToken(token)) {
            status = doJson(method, path, body, preferHeader, prefs.getAccessToken());
        }
        if ("POST".equals(method)) {
            if (status >= 200 && status < 300) prefs.resetRejectStreak();
            else if (status == 403 && RLS_DENIED.equals(lastSqlState)) prefs.bumpRejectStreak();
        }
        if (status < 200 || status >= 300) Log.w(TAG, method + " " + path + " → " + status);
        return status;
    }

    /**
     * @return HTTP status code, or -1 on IO error.
     */
    private int doJson(String method, String path, String body, String preferHeader, String bearerToken) {
        HttpURLConnection conn = null;
        lastSqlState = null;
        try {
            URL url = new URL(prefs.getSupabaseUrl() + path);
            conn = (HttpURLConnection) url.openConnection();
            conn.setConnectTimeout(TIMEOUT_MS);
            conn.setReadTimeout(TIMEOUT_MS);
            conn.setRequestMethod(method);
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", "application/json");
            conn.setRequestProperty("apikey", prefs.getAnonKey());
            if (bearerToken != null) {
                conn.setRequestProperty("Authorization", "Bearer " + bearerToken);
            }
            if (preferHeader != null) {
                conn.setRequestProperty("Prefer", preferHeader);
            }

            byte[] payload = body.getBytes(StandardCharsets.UTF_8);
            try (OutputStream os = conn.getOutputStream()) {
                os.write(payload);
            }

            int code = conn.getResponseCode();
            if (code >= 400) {
                // Drain the error stream so keep-alive can reuse the socket — that
                // is the reason this reads at all — but log only the SQLSTATE.
                //
                // The whole body used to go to logcat, and a PostgREST error body
                // quotes the offending row back in its "details" and "hint" fields:
                // a constraint failure on a check-in would print that check-in's
                // own coordinates. logcat is readable over adb, so a failed write
                // was one row value away from being a location leak. The SQLSTATE says which kind of
                // failure it was and can never carry a row value; the method, path
                // and HTTP status are already logged by doJsonWithRefresh.
                try (BufferedReader r = new BufferedReader(new InputStreamReader(
                        conn.getErrorStream() != null ? conn.getErrorStream() : conn.getInputStream(),
                        StandardCharsets.UTF_8))) {
                    StringBuilder sb = new StringBuilder();
                    String line;
                    while ((line = r.readLine()) != null) sb.append(line);
                    lastSqlState = sqlStateOf(sb.toString());
                    Log.w(TAG, "error sqlstate: " + lastSqlState);
                } catch (IOException ignored) {}
            }
            return code;
        } catch (IOException e) {
            Log.w(TAG, method + " " + path + " IO error: " + e.getMessage());
            return -1;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    /**
     * Pulls the SQLSTATE out of a PostgREST error body, which is
     * {"code","details","hint","message"} — of those only "code" is
     * guaranteed to be free of row values, so it is the only part allowed
     * near logcat. A body that will not parse reports its size and nothing
     * else: an unknown shape is exactly the case where no field can be
     * assumed safe to quote.
     */
    private static String sqlStateOf(String body) {
        if (body == null || body.isEmpty()) return "(empty)";
        try {
            String code = new JSONObject(body).optString("code", "");
            return code.isEmpty() ? "(none)" : code;
        } catch (JSONException e) {
            return "(unparsed, " + body.length() + " bytes)";
        }
    }

    /**
     * Calls /auth/v1/token?grant_type=refresh_token, persists new tokens.
     *
     * Serialised process-wide. `staleAccessToken` is the token the failed
     * request carried: if the stored one has changed since, another thread
     * has already refreshed, and spending the refresh token again would at
     * best waste a rotation and at worst trip Supabase's reuse detection,
     * which revokes the whole session.
     *
     * @return true if a usable token is now stored, false if refresh was rejected.
     */
    private boolean refreshAccessToken(String staleAccessToken) {
        synchronized (REFRESH_LOCK) {
            String current = prefs.getAccessToken();
            if (current != null && !current.equals(staleAccessToken)) return true;
            return doRefresh();
        }
    }

    private boolean doRefresh() {
        HttpURLConnection conn = null;
        try {
            String refresh = prefs.getRefreshToken();
            if (refresh == null) return false;
            URL url = new URL(prefs.getSupabaseUrl() + "/auth/v1/token?grant_type=refresh_token");
            conn = (HttpURLConnection) url.openConnection();
            conn.setConnectTimeout(TIMEOUT_MS);
            conn.setReadTimeout(TIMEOUT_MS);
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", "application/json");
            conn.setRequestProperty("apikey", prefs.getAnonKey());

            JSONObject body = new JSONObject();
            body.put("refresh_token", refresh);
            byte[] payload = body.toString().getBytes(StandardCharsets.UTF_8);
            try (OutputStream os = conn.getOutputStream()) {
                os.write(payload);
            }

            int code = conn.getResponseCode();
            if (code < 200 || code >= 300) {
                Log.w(TAG, "refresh failed: " + code);
                return false;
            }

            StringBuilder sb = new StringBuilder();
            try (BufferedReader r = new BufferedReader(new InputStreamReader(
                    conn.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = r.readLine()) != null) sb.append(line);
            }
            JSONObject res = new JSONObject(sb.toString());
            String newAccess = res.optString("access_token", null);
            String newRefresh = res.optString("refresh_token", refresh);
            int expiresIn = res.optInt("expires_in", 3600);
            if (newAccess == null) return false;
            prefs.setTokens(newAccess, newRefresh);
            // Mirror the rotated tokens into the WebView's session
            // storage. Without this, supabase-js reads its (now stale)
            // refresh_token next time the app opens, the auth server
            // rejects it as "Refresh Token Already Used", and the user
            // gets bounced to the login screen — even though the
            // native side is fully authenticated.
            mirrorIntoCapacitorSession(newAccess, newRefresh, expiresIn);
            return true;
        } catch (IOException | JSONException e) {
            Log.w(TAG, "refresh error: " + e.getMessage());
            return false;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    /** Write the freshly-rotated tokens into the SharedPreferences blob
     *  that the WebView's @capacitor/preferences-backed supabase-js
     *  storage adapter reads from. Mutate the existing JSON in place
     *  so we preserve other session fields (user object, etc.).
     *
     *  Silently does nothing if the WebView has never written a session
     *  blob (very first launch) — supabase-js will write one when the
     *  user logs in, and from that point on we keep it in sync. */
    private void mirrorIntoCapacitorSession(String accessToken, String refreshToken, int expiresInSec) {
        String url = prefs.getSupabaseUrl();
        String ref = extractProjectRef(url);
        if (ref == null) {
            Log.w(TAG, "mirror skipped: can't derive project ref from " + url);
            return;
        }
        String key = "sb-" + ref + "-auth-token";
        SharedPreferences cap = appCtx.getSharedPreferences(CAP_PREFS_NAME, Context.MODE_PRIVATE);
        String existing = cap.getString(key, null);
        if (existing == null) {
            // No prior session blob to mutate. Don't fabricate one —
            // we'd be missing the `user` object and other fields
            // supabase-js requires. Next time the WebView writes its
            // session, future refreshes will mirror correctly.
            return;
        }
        try {
            JSONObject root = new JSONObject(existing);
            // Newer gotrue-js (v2.66+) stores the session flat at the
            // root; older versions wrap it under "currentSession".
            // Detect which by looking for access_token at root.
            JSONObject target = root.has("access_token")
                    ? root
                    : root.optJSONObject("currentSession");
            if (target == null) {
                // Schema we don't recognise — bail rather than corrupt.
                Log.w(TAG, "mirror skipped: unfamiliar session blob shape");
                return;
            }
            long nowSec = System.currentTimeMillis() / 1000;
            target.put("access_token", accessToken);
            target.put("refresh_token", refreshToken);
            target.put("expires_in", expiresInSec);
            target.put("expires_at", nowSec + expiresInSec);
            target.put("token_type", "bearer");
            cap.edit().putString(key, root.toString()).apply();
        } catch (JSONException e) {
            Log.w(TAG, "mirror parse failed: " + e.getMessage());
        }
    }

    /** Pull the project ref out of a Supabase URL. Returns null if the
     *  URL doesn't look like the standard https://&lt;ref&gt;.supabase.co
     *  shape (e.g. self-hosted instances). */
    private static String extractProjectRef(String url) {
        if (url == null) return null;
        String s = url;
        int proto = s.indexOf("://");
        if (proto >= 0) s = s.substring(proto + 3);
        int dot = s.indexOf('.');
        if (dot <= 0) return null;
        String host = s.substring(0, dot);
        // Defensive: reject obviously-wrong values so we don't write
        // garbage keys into the SharedPreferences file.
        if (host.isEmpty() || host.length() > 40) return null;
        return host;
    }
}
