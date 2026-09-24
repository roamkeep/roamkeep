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
     * learn which events are urgent. So every wake does BOTH jobs:
     * notify about new check-ins, and reconcile the place list.
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
     * shipped twice: an unarmed new place (PR #40) and a deleted place
     * that went on filing check-ins (PR #42).
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
                if (o == null) continue;
                String id = o.optString("id", null);
                String name = o.optString("name", null);
                if (id == null || name == null) continue;
                places.add(new PrefsStore.Place(
                        id, name, o.optString("icon", "📍"),
                        o.optDouble("lat"), o.optDouble("lng"),
                        (float) o.optDouble("radius_m", 100)));
            }
        } catch (Exception e) {
            Log.w(TAG, "sync: bad places payload — leaving state alone", e);
            return;
        }

        String sig = GeofenceArmer.signature(places);
        String was = prefs.getPlacesSignature();
        // null means "never armed", which is different from "" ("armed an
        // empty list"). A first-ever arm must go ahead even with nothing
        // in it, so that the signature gets recorded.
        if (sig.equals(was)) return;

        GeofenceArmer.Result r = GeofenceArmer.arm(ctx, places, "push");
        prefs.setPlacesSignature(sig);

        // Journal only when something actually changed. A line on every
        // wake-up would bury the rest of the journal, and the journal is
        // the only witness these headless paths have.
        prefs.journal("push: places changed → " + r.stored + " stored, "
                + r.armed + " armed, " + r.pruned + " pruned");
    }

    private void notify(Context ctx, String id, String title, String text, boolean sos) {
        Intent open = new Intent(ctx, MainActivity.class);
        open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pi = PendingIntent.getActivity(
                ctx, id.hashCode(), open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, sos ? CH_SOS : CH_PLACES)
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
    }

    private static String enc(String s) {
        try { return URLEncoder.encode(s == null ? "" : s, StandardCharsets.UTF_8.name()); }
        catch (Exception e) { return ""; }
    }
}
