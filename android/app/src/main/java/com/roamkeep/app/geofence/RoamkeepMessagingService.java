package com.roamkeep.app.geofence;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import com.capacitorjs.plugins.pushnotifications.MessagingService;
import com.google.firebase.messaging.RemoteMessage;
import com.roamkeep.app.MainActivity;
import com.roamkeep.app.R;

import org.json.JSONArray;
import org.json.JSONObject;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Turns a content-free push wake-up into a real notification.
 *
 * Push used to carry the notification text, which meant the sending
 * server saw who arrived where. It can't any more: every family runs
 * their own Supabase, so their Edge Function has no access to the
 * Roamkeep Firebase key and instead asks the relay to send a fixed
 * {"t":"sync"} with no content at all.
 *
 * This service is the other half of that trade. When the wake-up lands we
 * read the check-in back out of the family's OWN Supabase — over the
 * credentials already in PrefsStore, the same headless path the geofence
 * receiver uses — and compose the text here on the device. Names, places
 * and coordinates never pass through anything the author operates.
 *
 * Extends Capacitor's MessagingService rather than replacing it so token
 * registration (onNewToken → the JS 'registration' listener) still works;
 * the plugin's own <service> is removed in AndroidManifest so there is no
 * ambiguity about which one FCM delivers to.
 */
public class RoamkeepMessagingService extends MessagingService {
    private static final String TAG = "RoamkeepGeo";

    private static final String CH_PLACES = "roamkeep_places";
    private static final String CH_SOS    = "roamkeep_sos";
    // v17: "<name> wants to join" and "<child> asked to delete their account",
    // owners only. Separate from place alerts so muting those can't silence a
    // request that only an owner can answer.
    private static final String CH_FAMILY = "roamkeep_family";
    // Cap on ordinary (arrive/leave) notifications per wake-up, so a burst
    // cannot spam the shade; anything over it is summarised in one line.
    // SOS is never capped.
    private static final int MAX_PER_WAKE = 5;
    // First wake-up after an install has no watermark; only look back
    // this far so we don't replay old history as fresh notifications.
    private static final long COLD_START_LOOKBACK_MS = 10 * 60 * 1000L;
    // How far BEHIND the watermark each fetch re-reads. A check-in can land
    // after a newer one — a crossing queued through a Wi-Fi→cellular
    // handoff, or Play Services delivering one phone's ENTER a minute late —
    // and a strict "newer than the newest I've seen" query skipped it for
    // good. The seen-ID set stops the overlap raising anything twice.
    private static final long OVERLAP_MS = 30 * 60 * 1000L;
    // Pre-v16 databases only (paging by the device-supplied created_at):
    // ignore rows dated further ahead than this. One row dated tomorrow used
    // to pin the watermark to tomorrow and silence every alert until then.
    private static final long FUTURE_SLACK_MS = 60 * 60 * 1000L;
    private static final int FETCH_LIMIT = 50;
    // checkins.inserted_at (server receipt time) exists from schema v16.
    private static final int SCHEMA_WITH_INSERTED_AT = 16;
    // keep_members.approved, and joins that wait for an owner, from v17.
    private static final int SCHEMA_WITH_APPROVAL = 17;
    // Owner requests share the check-in seen-id set, under their own prefixes.
    // A deletion request is keyed on its time too, so one asked again after
    // being taken back is raised again.
    private static final String JOIN_SEEN_PREFIX = "join:";
    private static final String DELETE_SEEN_PREFIX = "delreq:";
    // A reset code made for this account, or used on it: keyed on the event's
    // time, so each new code and each use is raised once. The key lives in
    // PrefsStore.getResetSeen; this prefix is the notification's tag, and what
    // rc8/rc9 left in the push-seen set, which still counts as seen.
    private static final String RESET_SEEN_PREFIX = "reset:";
    // A reset event older than this is not pushed. A phone that missed the
    // wake (switched off, or signed out) hears it from the app when next
    // opened, with its time. A day, because that is how long the account
    // stays undeletable after a reset: the window in which hearing matters.
    static final long RESET_PUSH_MAX_AGE_MS = 24 * 3_600_000L;
    static final int RESET_RAISE = 0, RESET_KNOWN = 1, RESET_STALE = 2;

    /**
     * FCM rotated this device's token. Saved natively as well as handed to
     * the JS registration listener (super), because that listener only runs
     * while the app is open — until 4.9.0 a token that rotated with the app
     * closed was not saved until the next app open, and meanwhile the old
     * token was dead: this phone received no alerts at all.
     */
    @Override
    public void onNewToken(@NonNull String token) {
        super.onNewToken(token);
        PrefsStore prefs = new PrefsStore(getApplicationContext());
        if (!prefs.hasContext() || prefs.isServerRejected()) return;
        boolean ok = new SupabaseRest(getApplicationContext())
                .upsertPushToken(prefs.getMemberId(), prefs.getKeepId(), token);
        prefs.journal("push: new FCM token " + (ok ? "saved" : "NOT saved — the app will save it when next opened"));
    }

    @Override
    public void onMessageReceived(@NonNull RemoteMessage remoteMessage) {
        Map<String, String> data = remoteMessage.getData();
        if (data != null && "sync".equals(data.get("t"))) {
            // Our wake-up. Deliberately NOT forwarded to the Capacitor
            // plugin — there is nothing for the JS layer to render, and
            // the app is usually not running anyway.
            try {
                handleSync();
            } catch (Exception e) {
                Log.w(TAG, "sync wake-up failed", e);
            }
            return;
        }
        super.onMessageReceived(remoteMessage);
    }

    /**
     * A wake-up carries no event type — by design, so the relay cannot
     * learn which events are urgent. So every wake does every job:
     * notify about new check-ins, reconcile the place list, and (v17) tell
     * an owner about anyone waiting to join or a child asking to have their
     * account deleted.
     *
     * That the place reconcile also runs on check-in wakes is a feature,
     * not waste. Native place state drifting from the database is the
     * recurring bug class in this codebase, and until now the only repair
     * was somebody opening the app.
     */
    private void handleSync() {
        Context ctx = getApplicationContext();
        PrefsStore prefs = new PrefsStore(ctx);
        if (!prefs.hasContext()) return;

        notifyNewCheckins(ctx, prefs);
        reconcilePlaces(ctx, prefs);
        notifyOwnerRequests(ctx, prefs);
        notifyResetNotice(ctx, prefs);
    }

    /**
     * v17 (self-review R1): a password reset code was made for this account,
     * or used on it. An owner can reset any member who is not an owner,
     * adults included, so the member must hear about it at once, not at
     * their next launch. on_reset_notice wakes this account's phones; the row
     * is read back here, like everything else.
     *
     * RLS returns only this account's own row, and only its notice columns
     * (never code_hash). The issuer's name comes from the family's member
     * list. The app shows the same notice in-app the next time it opens.
     */
    private void notifyResetNotice(Context ctx, PrefsStore prefs) {
        if (prefs.getSchemaVersion() < SCHEMA_WITH_APPROVAL) return;
        SupabaseRest rest = new SupabaseRest(ctx);
        SupabaseRest.GetResult res = rest.getResult(
                "/rest/v1/password_reset_codes?select=issued_by,issued_at,redeemed_at");
        if (!res.ok()) return;   // older server, or nothing to say
        JSONObject row;
        try {
            JSONArray arr = new JSONArray(res.body);
            if (arr.length() == 0) return;
            row = arr.optJSONObject(0);
        } catch (Exception e) {
            Log.w(TAG, "sync: bad reset notice payload", e);
            return;
        }
        if (row == null) return;
        boolean used = !row.isNull("redeemed_at");
        String at = row.optString(used ? "redeemed_at" : "issued_at", "");
        String event = (used ? "used:" : "made:") + at;
        String key = RESET_SEEN_PREFIX + event;
        int verdict = judgeResetNotice(event, parseIsoMs(at), System.currentTimeMillis(),
                prefs.getResetSeen(), prefs.getPushSeenIds().contains(key));
        if (verdict == RESET_KNOWN) return;
        prefs.setResetSeen(event);
        if (verdict == RESET_STALE) {
            prefs.journal("push: wake-up → reset notice from over a day ago, not raised (the app shows it when opened)");
            return;
        }

        String who = "An owner";
        String issuer = row.isNull("issued_by") ? "" : row.optString("issued_by", "");
        if (!issuer.isEmpty()) {
            SupabaseRest.GetResult m = rest.getResult("/rest/v1/keep_members?keep_id=eq."
                    + enc(prefs.getKeepId()) + "&user_id=eq." + enc(issuer) + "&select=name");
            try {
                if (m.ok()) {
                    JSONArray ma = new JSONArray(m.body);
                    if (ma.length() > 0) who = ma.getJSONObject(0).optString("name", who);
                }
            } catch (Exception ignored) { /* keep "An owner" */ }
        }
        String talkTo = "An owner".equals(who) ? "your family's owners" : who;

        ensureChannels(ctx);
        if (used) {
            notifyOn(ctx, CH_FAMILY, key, "🔑 Your password was changed",
                    "It was changed with a reset code from " + who + ". If that wasn't you, talk to "
                            + talkTo + ", and change your password in Settings.", false);
        } else {
            notifyOn(ctx, CH_FAMILY, key, "🔑 A reset code was made for your account",
                    who + " made a password reset code for your account. If you didn't ask for one, talk to "
                            + talkTo + ".", false);
        }
        prefs.journal("push: wake-up → reset notice (" + (used ? "code used" : "code made") + ")");
    }

    /**
     * Whether a wake-up should raise a reset notice for {@code event}
     * ("made:<ts>" / "used:<ts>", happening at {@code eventMs}). Pure, for
     * ResetNoticeTest.
     *
     * Known: this phone already raised it, or the app showed it, or its user
     * did it here. Stale: too old to be news, or its time is unreadable. A
     * time ahead of this phone's clock is a skewed clock, not a stale event.
     */
    static int judgeResetNotice(String event, long eventMs, long nowMs, String seen, boolean seenLegacy) {
        if (event.equals(seen) || seenLegacy) return RESET_KNOWN;
        if (eventMs < 0 || nowMs - eventMs > RESET_PUSH_MAX_AGE_MS) return RESET_STALE;
        return RESET_RAISE;
    }

    /**
     * v17: something is waiting for an owner. Someone joined with an invite
     * and needs approving, or a child asked to have their account deleted.
     *
     * The wake that brings this is the usual content-free one
     * (on_join_request / on_deletion_request → notify-places, addressed to
     * the keep's owners), so the names are read back here, like a check-in's.
     * One request answers both questions, whether this phone's member is an
     * owner and what is waiting: our own row plus every pending or asking
     * one. Reading the role fresh rather than keeping a copy in PrefsStore is
     * deliberate; a mirrored role would be one more piece of database state
     * left to drift.
     *
     * Each request is raised once (the seen-id set). It stays visible in the
     * app's Family tab until an owner deals with it.
     */
    private void notifyOwnerRequests(Context ctx, PrefsStore prefs) {
        if (prefs.getSchemaVersion() < SCHEMA_WITH_APPROVAL) return;
        String me = prefs.getMemberId();
        SupabaseRest rest = new SupabaseRest(ctx);
        String base = "/rest/v1/keep_members?keep_id=eq." + enc(prefs.getKeepId());
        SupabaseRest.GetResult res = rest.getResult(base
                + "&select=id,name,role,approved,member_type,deletion_requested_at"
                + "&or=(approved.is.false,deletion_requested_at.not.is.null,id.eq." + enc(me) + ")");
        if (res.status == 400) {
            // A v17 server from before deletion requests (staging, before its
            // re-apply): PostgREST refuses the whole query over the unknown
            // column. Still raise join requests.
            res = rest.getResult(base + "&select=id,name,role,approved"
                    + "&or=(approved.is.false,id.eq." + enc(me) + ")");
        }
        if (!res.ok()) { Log.w(TAG, "sync: owner requests fetch failed (" + res.status + ")"); return; }

        boolean owner = false;
        List<JSONObject> waiting = new ArrayList<>();
        List<JSONObject> asking = new ArrayList<>();
        try {
            JSONArray arr = new JSONArray(res.body);
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.optJSONObject(i);
                if (o == null) continue;
                String id = o.optString("id", "");
                if (id.equals(me)) {
                    owner = "owner".equals(o.optString("role")) && o.optBoolean("approved", true);
                } else if (!o.optBoolean("approved", true)) {
                    waiting.add(o);
                } else if ("child".equals(o.optString("member_type"))
                        && !o.isNull("deletion_requested_at")) {
                    asking.add(o);
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "sync: bad owner requests payload", e);
            return;
        }
        if (!owner || (waiting.isEmpty() && asking.isEmpty())) return;

        Set<String> seen = prefs.getPushSeenIds();
        List<String> raised = new ArrayList<>();
        int joins = 0, asks = 0;
        for (JSONObject o : waiting) {
            String key = JOIN_SEEN_PREFIX + o.optString("id", "");
            if (seen.contains(key)) continue;
            if (raised.isEmpty()) ensureChannels(ctx);
            notifyOn(ctx, CH_FAMILY, key,
                    "🙋 " + o.optString("name", "Someone") + " wants to join",
                    "Open Roamkeep to approve or decline.", false);
            raised.add(key);
            joins++;
        }
        for (JSONObject o : asking) {
            String key = DELETE_SEEN_PREFIX + o.optString("id", "") + ":" + o.optString("deletion_requested_at", "");
            if (seen.contains(key)) continue;
            if (raised.isEmpty()) ensureChannels(ctx);
            notifyOn(ctx, CH_FAMILY, key,
                    "🗑 " + o.optString("name", "A child") + " asked to delete their account",
                    "Open Roamkeep to delete it, in the Family tab.", false);
            raised.add(key);
            asks++;
        }
        if (raised.isEmpty()) return;
        prefs.addPushSeenIds(raised);
        prefs.journal("push: wake-up → " + joins + " join request(s), " + asks + " deletion request(s) for owners");
    }

    /**
     * Fetch what arrived since the watermark and notify about it.
     *
     * WHICH CLOCK. From schema v16 this pages by checkins.inserted_at — the
     * server's receipt time, set by a trigger no client can override. Before
     * that it pages by created_at, which is whatever time the WRITING device
     * reported; that is what let one future-dated row silence the keep and a
     * late row slip past. On an older database the old clock stays, fenced by
     * FUTURE_SLACK_MS and the overlap.
     */
    private void notifyNewCheckins(Context ctx, PrefsStore prefs) {
        final boolean serverClock = prefs.getSchemaVersion() >= SCHEMA_WITH_INSERTED_AT;
        final String col = serverClock ? "inserted_at" : "created_at";
        final long nowMs = System.currentTimeMillis();

        String mark = serverClock ? prefs.getLastPushSeenInserted() : prefs.getLastPushSeen();
        // First run on the server clock: carry the old watermark across. For
        // historical rows inserted_at was backfilled from created_at, so the
        // two agree where it matters.
        if (mark == null && serverClock) mark = prefs.getLastPushSeen();
        long markMs = parseIsoMs(mark);
        // A watermark already pinned in the future by a poisoned row (device
        // clock only means anything on the device-reported clock).
        if (!serverClock && markMs > nowMs + FUTURE_SLACK_MS) { mark = null; markMs = -1; }

        final Set<String> seen = prefs.getPushSeenIds();
        final String from;
        if (mark == null || markMs < 0) {
            from = SupabaseRest.toIso8601Utc(nowMs - COLD_START_LOOKBACK_MS);
        } else if (seen.isEmpty()) {
            // Nothing recorded as seen yet (first run of this logic): no
            // overlap this once, or everything in the window would be raised
            // again. The exact watermark string, so the boundary row is excluded.
            from = mark;
        } else {
            from = SupabaseRest.toIso8601Utc(markMs - OVERLAP_MS);
        }

        // my_checkin_feed, not checkins. The view applies the caller's own
        // per-person, per-place mutes server-side (and the member_id and
        // type filters that used to be spelled out here).
        //
        // This filter is NOT redundant with the one in notify-checkin.
        // The wake-up is content-free and untargeted: an SOS, or an
        // unmuted event about someone else, wakes every phone — and this
        // method then fetches EVERYTHING newer than the watermark. Without
        // a filter on this side, a muted notification rides in on an
        // unrelated wake.
        //
        // Filtering in a database view rather than against a local copy of
        // the preferences is deliberate: a mute set mirrored into
        // PrefsStore would be a fourth store of database state that can
        // silently drift, which is the failure this codebase keeps paying
        // for.
        //
        // SOS is fetched on its own and never capped. It used to share one
        // newest-first query with a limit of five, so an SOS sixth from the
        // top of a burst was skipped — and the watermark then moved past it.
        String select = "?select=id,member_name,member_avatar,type,place,created_at"
                + (serverClock ? ",inserted_at" : "");
        String window = "&" + col + "=gt." + enc(from)
                // Only the device-reported clock needs a ceiling: the server's
                // cannot run ahead of itself, and comparing it against this
                // phone's clock would hide rows from a phone that runs slow.
                + (serverClock ? "" : "&" + col + "=lte." + enc(SupabaseRest.toIso8601Utc(nowMs + FUTURE_SLACK_MS)))
                + "&order=" + col + ".desc&limit=" + FETCH_LIMIT;

        SupabaseRest rest = new SupabaseRest(ctx);
        SupabaseRest.GetResult sosRes = rest.getResult("/rest/v1/my_checkin_feed" + select + window + "&type=eq.sos");
        SupabaseRest.GetResult otherRes = rest.getResult("/rest/v1/my_checkin_feed" + select + window + "&type=in.(arrived,left)");

        if (sosRes.status == 404 || otherRes.status == 404) {
            // The view does not exist: a database that never ran v13. Fall
            // back to the table so an app ahead of its family's schema still
            // raises notifications. ONLY on 404 — this query applies no
            // mutes, and taking it on any failure (a timeout, an expired
            // session) leaked muted notifications through.
            Log.w(TAG, "sync: my_checkin_feed missing — falling back to checkins");
            String base = "/rest/v1/checkins" + "?select=id,member_name,member_avatar,type,place,created_at"
                    + "&keep_id=eq." + enc(prefs.getKeepId())
                    + "&member_id=neq." + enc(prefs.getMemberId())
                    + "&created_at=gt." + enc(from)
                    + "&created_at=lte." + enc(SupabaseRest.toIso8601Utc(nowMs + FUTURE_SLACK_MS))
                    + "&order=created_at.desc&limit=" + FETCH_LIMIT;
            sosRes = rest.getResult(base + "&type=eq.sos");
            otherRes = rest.getResult(base + "&type=in.(arrived,left)");
        }
        if (!sosRes.ok() || !otherRes.ok()) {
            // Say so: a wake-up that fetched nothing is otherwise invisible,
            // and it is exactly how a missed SOS would look from the outside.
            prefs.journal("push: wake-up — feed fetch failed (" + sosRes.status + "/" + otherRes.status
                    + "), nothing raised; retried on the next wake-up");
            return;
        }

        List<JSONObject> sos, others;
        try {
            sos = unseen(new JSONArray(sosRes.body), seen);
            others = unseen(new JSONArray(otherRes.body), seen);
        } catch (Exception e) {
            Log.w(TAG, "sync: bad payload", e);
            return;
        }

        // Advance the watermark to the newest row either query returned —
        // seen before or not — so it keeps moving even through a burst of
        // rows already raised on an earlier wake.
        String newest = mark;
        for (String b : new String[] { sosRes.body, otherRes.body }) {
            try {
                JSONArray arr = new JSONArray(b);
                for (int i = 0; i < arr.length(); i++) {
                    String at = arr.optJSONObject(i) == null ? null : arr.optJSONObject(i).optString(col, null);
                    if (at != null && (newest == null || parseIsoMs(at) > parseIsoMs(newest))) newest = at;
                }
            } catch (Exception ignored) {}
        }

        if (sos.isEmpty() && others.isEmpty()) {
            if (newest != null) saveMark(prefs, serverClock, newest);
            prefs.journal("push: wake-up → 0 new");
            return;
        }

        ensureChannels(ctx);
        List<String> raised = new ArrayList<>();
        // Every SOS, oldest first.
        for (int i = sos.size() - 1; i >= 0; i--) {
            JSONObject r = sos.get(i);
            notify(ctx, r.optString("id", "sos-" + i),
                    "🆘 " + r.optString("member_name", "Someone") + " sent an SOS",
                    "Tap to see their location on the map", true);
            raised.add(r.optString("id", null));
        }
        // The newest MAX_PER_WAKE arrivals/departures, oldest first; the rest
        // are summarised rather than silently dropped.
        int shown = Math.min(MAX_PER_WAKE, others.size());
        for (int i = shown - 1; i >= 0; i--) {
            JSONObject r = others.get(i);
            String type = r.optString("type", "");
            notify(ctx, r.optString("id", "ci-" + i),
                    r.optString("member_avatar", "📍") + " " + r.optString("member_name", "Someone") + " "
                            + ("arrived".equals(type) ? "arrived at" : "left") + " " + r.optString("place", ""),
                    "", false);
        }
        if (others.size() > shown) {
            notify(ctx, "roamkeep-summary", "+" + (others.size() - shown) + " more updates",
                    "Open Roamkeep to see them all", false);
        }
        for (JSONObject r : others) raised.add(r.optString("id", null));

        prefs.addPushSeenIds(raised);
        if (newest != null) saveMark(prefs, serverClock, newest);
        prefs.journal("push: wake-up → " + (sos.size() + shown) + " notification(s)"
                + (others.size() > shown ? " + " + (others.size() - shown) + " summarised" : ""));
    }

    /** Rows of `arr` (newest first) not already raised. */
    private static List<JSONObject> unseen(JSONArray arr, Set<String> seen) {
        List<JSONObject> out = new ArrayList<>();
        for (int i = 0; i < arr.length(); i++) {
            JSONObject r = arr.optJSONObject(i);
            if (r == null) continue;
            String id = r.optString("id", null);
            if (id != null && seen.contains(id)) continue;
            out.add(r);
        }
        return out;
    }

    private static void saveMark(PrefsStore prefs, boolean serverClock, String iso) {
        if (serverClock) prefs.setLastPushSeenInserted(iso); else prefs.setLastPushSeen(iso);
    }

    /**
     * Epoch-ms of a PostgREST timestamptz ("2026-09-23T10:33:48.581234+00:00"
     * or "...Z"), or -1. Hand-rolled because java.time needs API 26 and this
     * app supports 23. Sub-second digits are kept to the millisecond.
     */
    static long parseIsoMs(String s) {
        if (s == null || s.length() < 19) return -1;
        try {
            java.text.SimpleDateFormat f = new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", java.util.Locale.US);
            f.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));
            long ms = f.parse(s.substring(0, 19).replace(' ', 'T')).getTime();
            int i = 19;
            if (i < s.length() && s.charAt(i) == '.') {
                int j = i + 1;
                while (j < s.length() && Character.isDigit(s.charAt(j))) j++;
                String frac = (s.substring(i + 1, j) + "000").substring(0, 3);
                ms += Integer.parseInt(frac);
                i = j;
            }
            if (i < s.length() && (s.charAt(i) == '+' || s.charAt(i) == '-')) {
                int sign = s.charAt(i) == '+' ? 1 : -1;
                String off = s.substring(i + 1).replace(":", "");
                int hh = Integer.parseInt(off.substring(0, 2));
                int mm = off.length() >= 4 ? Integer.parseInt(off.substring(2, 4)) : 0;
                ms -= sign * (hh * 3_600_000L + mm * 60_000L);
            }
            return ms;
        } catch (Exception e) {
            return -1;
        }
    }

    /**
     * Re-read the family's place list and re-arm the OS if it changed.
     *
     * This is what makes a place added or deleted on one phone reach the
     * others within seconds instead of at the next app open. Until now the
     * only delivery path was the realtime subscription, which Android
     * suspends whenever the WebView is backgrounded and Supabase never
     * replays — so a backgrounded phone simply never found out. That gap
     * shipped twice: an unarmed new place (fixed in 4.5.2) and a deleted
     * place that went on filing check-ins (fixed in 4.5.5).
     *
     * The whole list is fetched and pushed, never a delta. A delta needs
     * a reliable event stream, and this device is proof there isn't one.
     */
    private void reconcilePlaces(Context ctx, PrefsStore prefs) {
        String body = new SupabaseRest(ctx).getWithRefresh("/rest/v1/keep_places"
                + "?select=id,name,icon,lat,lng,radius_m"
                + "&keep_id=eq." + enc(prefs.getKeepId()));

        // ── The one distinction that matters in this method ──────────
        //
        // "The fetch failed" and "the fetch succeeded and returned []"
        // are one `if` apart and demand OPPOSITE actions:
        //
        //   * A successful empty list is meaningful. Every place really
        //     was deleted, and the prune has to run — that is precisely
        //     the case the prune exists for.
        //   * A failed read must change NOTHING. Treating it as an empty
        //     list would unregister every geofence on the device, from a
        //     receiver with no screen, with nothing to explain it.
        //
        // So: bail on null or unparseable, and only then trust an empty
        // array. Never let a failed read overwrite good state.
        if (body == null) { Log.w(TAG, "sync: places fetch failed — leaving state alone"); return; }

        List<PrefsStore.Place> places = new ArrayList<>();
        try {
            JSONArray arr = new JSONArray(body);
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.optJSONObject(i);
                String id = o == null ? null : o.optString("id", null);
                String name = o == null ? null : o.optString("name", null);
                double lat = o == null ? Double.NaN : o.optDouble("lat");
                double lng = o == null ? Double.NaN : o.optDouble("lng");
                double radius = o == null ? Double.NaN : o.optDouble("radius_m", 100);
                // 4.11.1: a row that isn't whole refuses the whole list, the
                // same as an unreadable body. Skipping it and arming the rest
                // as "complete" pruned that place as if it had been deleted.
                if (!GeofenceArmer.validPlaceRow(id, name, lat, lng, radius)) {
                    prefs.journal("push: places list had a malformed row — leaving state alone");
                    return;
                }
                places.add(new PrefsStore.Place(id, name, o.optString("icon", "📍"), lat, lng, (float) radius));
            }
        } catch (Exception e) {
            Log.w(TAG, "sync: bad places payload — leaving state alone", e);
            return;
        }

        final String sig = GeofenceArmer.signature(places);
        String was = prefs.getPlacesSignature();
        // null means "never armed" (or "the last registration failed",
        // 4.11.1), which is different from "" ("armed an empty list"). A
        // first-ever arm must go ahead even with nothing in it, so that the
        // signature gets recorded.
        if (sig.equals(was)) return;

        // Recorded only once Play Services has taken it (4.11.1). If this
        // process is gone before it answers, nothing is recorded and the
        // next wake simply arms again.
        GeofenceArmer.Result r = GeofenceArmer.arm(ctx, places, "push",
                (res, accepted) -> prefs.setPlacesSignature(accepted ? sig : null));

        // Journal only when something actually changed. A line on every
        // wake-up would bury the rest of the journal, and the journal is
        // the only witness these headless paths have.
        prefs.journal("push: places changed → " + r.stored + " stored, "
                + r.armed + " armed, " + r.pruned + " pruned");
    }

    private void notify(Context ctx, String id, String title, String text, boolean sos) {
        notifyOn(ctx, sos ? CH_SOS : CH_PLACES, id, title, text, sos);
    }

    private void notifyOn(Context ctx, String channel, String id, String title, String text, boolean sos) {
        Intent open = new Intent(ctx, MainActivity.class);
        open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pi = PendingIntent.getActivity(
                ctx, id.hashCode(), open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, channel)
                // Alpha-only Roamkeep mark, tinted by the system like every
                // other status-bar icon. The launcher icon used to go here,
                // and Android flattens a full-colour icon to its alpha — a
                // blank white blob.
                .setSmallIcon(R.drawable.ic_stat_roamkeep)
                .setContentTitle(title)
                .setAutoCancel(true)
                .setContentIntent(pi)
                .setPriority(sos ? NotificationCompat.PRIORITY_MAX : NotificationCompat.PRIORITY_DEFAULT);
        if (!text.isEmpty()) b.setContentText(text);
        if (sos) {
            b.setCategory(NotificationCompat.CATEGORY_ALARM)
             .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
             .setDefaults(NotificationCompat.DEFAULT_ALL);
        }
        try {
            // No-ops without POST_NOTIFICATIONS on API 33+, which is fine:
            // the setup sheet asks for it and the app still works without.
            NotificationManagerCompat.from(ctx).notify(id.hashCode(), b.build());
        } catch (SecurityException e) {
            Log.w(TAG, "notify blocked (no POST_NOTIFICATIONS?)", e);
        }
    }

    /**
     * The JS layer creates these on app open, but a wake-up can arrive on
     * a device where the app has never been foregrounded since install —
     * posting to a missing channel on API 26+ silently drops the
     * notification, so create them defensively.
     */
    private void ensureChannels(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm == null) return;
        if (nm.getNotificationChannel(CH_PLACES) == null) {
            NotificationChannel c = new NotificationChannel(
                    CH_PLACES, "Place alerts", NotificationManager.IMPORTANCE_DEFAULT);
            c.setDescription("When family arrive at or leave a saved place.");
            nm.createNotificationChannel(c);
        }
        if (nm.getNotificationChannel(CH_SOS) == null) {
            NotificationChannel c = new NotificationChannel(
                    CH_SOS, "SOS alerts", NotificationManager.IMPORTANCE_HIGH);
            c.setDescription("Emergency SOS alerts from your family.");
            c.enableVibration(true);
            c.setLockscreenVisibility(android.app.Notification.VISIBILITY_PUBLIC);
            nm.createNotificationChannel(c);
        }
        if (nm.getNotificationChannel(CH_FAMILY) == null) {
            NotificationChannel c = new NotificationChannel(
                    CH_FAMILY, "Requests for owners", NotificationManager.IMPORTANCE_DEFAULT);
            c.setDescription("When someone asks to join your Keep, or a child asks to delete their account. Owners only.");
            nm.createNotificationChannel(c);
        }
    }

    private static String enc(String s) {
        try { return URLEncoder.encode(s == null ? "" : s, StandardCharsets.UTF_8.name()); }
        catch (Exception e) { return ""; }
    }
}
