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

    private final Context appCtx;
    private final PrefsStore prefs;

    public SupabaseRest(Context ctx) {
        this.appCtx = ctx.getApplicationContext();
        this.prefs = new PrefsStore(ctx);
    }

    /** Outcome buckets for callers that need to distinguish "row already
     *  landed" (a duplicate retry hitting the primary-key UNIQUE
     *  constraint) from real failures. The retry queue treats DUPLICATE
     *  as success — the row IS in the DB, we just didn't see the 2xx
     *  the first time around. */
    public enum Result { SUCCESS, DUPLICATE, FAILED }

    /**
     * POST /rest/v1/checkins with the given body. Retries once after a
     * token refresh if the first attempt returns 401.
     */
    public Result insertCheckin(JSONObject body) {
        int status = doJsonWithRefresh("POST", "/rest/v1/checkins", body, "return=minimal");
        if (status >= 200 && status < 300) return Result.SUCCESS;
        // PostgREST surfaces a unique-violation as 409 with PG code 23505.
        // For the retry queue's purposes any 409 on this endpoint means
        // "the row with this client-generated id already exists" — safe
        // to drop from the queue.
        if (status == 409) return Result.DUPLICATE;
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
        int status = doJsonWithRefresh("PATCH", path, body, "return=minimal");
        return status >= 200 && status < 300;
    }

    /**
     * POST /rest/v1/location_history with the given body. Breadcrumb rows
     * carry no client-supplied id, so there's no duplicate-key case to
     * special-case — just success or failure.
     */
    public boolean insertLocationHistory(JSONObject body) {
        int status = doJsonWithRefresh("POST", "/rest/v1/location_history", body, "return=minimal");
        return status >= 200 && status < 300;
    }

    /** Epoch-ms → the ISO-8601 UTC form PostgREST expects in filters. */
    static String toIso8601Utc(long ms) {
        java.text.SimpleDateFormat fmt = new java.text.SimpleDateFormat(
                "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", java.util.Locale.US);
        fmt.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));
        return fmt.format(new java.util.Date(ms));
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

    /** @return raw HTTP status, or -1 on IO error. */
    /**
     * GET a PostgREST path and return the response body, or null.
     *
     * Needed since push went content-free: the relay only wakes us, so the
     * notification text has to be read back out of the family's own
     * Supabase here on the device. Same one-shot 401 refresh as the
     * write path.
     */
    public String getWithRefresh(String path) {
        String out = doGet(path, prefs.getAccessToken());
        if (out != null) return out;
        if (refreshAccessToken()) return doGet(path, prefs.getAccessToken());
        return null;
    }

    private String doGet(String path, String bearerToken) {
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
                return null;
            }
            try (BufferedReader r = new BufferedReader(new InputStreamReader(
                    conn.getInputStream(), StandardCharsets.UTF_8))) {
                StringBuilder sb = new StringBuilder();
                String line;
                while ((line = r.readLine()) != null) sb.append(line);
                return sb.toString();
            }
        } catch (IOException e) {
            Log.w(TAG, "GET " + path + " IO error: " + e.getMessage());
            return null;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private int doJsonWithRefresh(String method, String path, JSONObject body, String preferHeader) {
        int status = doJson(method, path, body, preferHeader, prefs.getAccessToken());
        if (status >= 200 && status < 300) return status;
        if (status == 401 || status == 403) {
            // Try one refresh, then retry once.
            if (refreshAccessToken()) {
                status = doJson(method, path, body, preferHeader, prefs.getAccessToken());
                if (status >= 200 && status < 300) return status;
            }
        }
        Log.w(TAG, method + " " + path + " → " + status);
        return status;
    }

    /**
     * @return HTTP status code, or -1 on IO error.
     */
    private int doJson(String method, String path, JSONObject body, String preferHeader, String bearerToken) {
        HttpURLConnection conn = null;
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

            byte[] payload = body.toString().getBytes(StandardCharsets.UTF_8);
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
                    Log.w(TAG, "error sqlstate: " + sqlStateOf(sb.toString()));
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
     * @return true on success, false if refresh was rejected.
     */
    private boolean refreshAccessToken() {
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
