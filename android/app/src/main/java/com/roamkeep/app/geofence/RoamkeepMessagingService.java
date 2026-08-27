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

import org.json.JSONArray;
import org.json.JSONObject;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

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
    // Cap what one wake-up can raise, so a burst can't spam the shade.
    private static final int MAX_PER_WAKE = 5;
    // First wake-up after an install has no watermark; only look back
    // this far so we don't replay old history as fresh notifications.
    private static final long COLD_START_LOOKBACK_MS = 10 * 60 * 1000L;

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

    /** Fetch anything newer than the watermark and notify about it. */
    private void notifyNewCheckins(Context ctx, PrefsStore prefs) {
        String since = prefs.getLastPushSeen();
        if (since == null) {
            since = SupabaseRest.toIso8601Utc(System.currentTimeMillis() - COLD_START_LOOKBACK_MS);
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
        String path = "/rest/v1/my_checkin_feed"
                + "?select=id,member_name,member_avatar,type,place,created_at"
                + "&created_at=gt." + enc(since)
                + "&order=created_at.desc"
                + "&limit=" + MAX_PER_WAKE;

        SupabaseRest rest = new SupabaseRest(ctx);
        String body = rest.getWithRefresh(path);

        if (body == null) {
            // The view is missing on a database that has not run the v13
            // migration. Fall back to the pre-v13 query so an app that
            // arrives ahead of its family's schema update still raises
            // notifications, rather than going silently deaf.
            Log.w(TAG, "sync: feed fetch failed — falling back to checkins");
            body = rest.getWithRefresh("/rest/v1/checkins"
                    + "?select=id,member_name,member_avatar,type,place,created_at"
                    + "&keep_id=eq." + enc(prefs.getKeepId())
                    + "&member_id=neq." + enc(prefs.getMemberId())
                    + "&created_at=gt." + enc(since)
                    + "&type=in.(arrived,left,sos)"
                    + "&order=created_at.desc"
                    + "&limit=" + MAX_PER_WAKE);
        }
        if (body == null) { Log.w(TAG, "sync: fetch failed"); return; }

        JSONArray rows;
        try { rows = new JSONArray(body); } catch (Exception e) {
            Log.w(TAG, "sync: bad payload", e); return;
        }
        if (rows.length() == 0) return;

        ensureChannels(ctx);
        String newest = null;

        // Rows arrive newest-first; walk backwards so the shade ends up in
        // chronological order.
        for (int i = rows.length() - 1; i >= 0; i--) {
            JSONObject r = rows.optJSONObject(i);
            if (r == null) continue;
            String type   = r.optString("type", "");
            String name   = r.optString("member_name", "Someone");
            String avatar = r.optString("member_avatar", "📍");
            String place  = r.optString("place", "");
            String at     = r.optString("created_at", null);
            if (newest == null || (at != null && at.compareTo(newest) > 0)) newest = at;

            boolean sos = "sos".equals(type);
            String title = sos
                    ? "🆘 " + name + " sent an SOS"
                    : avatar + " " + name + " " + ("arrived".equals(type) ? "arrived at" : "left") + " " + place;
            String text = sos ? "Tap to see their location on the map" : "";
            notify(ctx, r.optString("id", String.valueOf(i)), title, text, sos);
        }

        if (newest != null) prefs.setLastPushSeen(newest);
        prefs.journal("push: wake-up → " + rows.length() + " notification(s)");
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
                .setSmallIcon(ctx.getApplicationInfo().icon)
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
