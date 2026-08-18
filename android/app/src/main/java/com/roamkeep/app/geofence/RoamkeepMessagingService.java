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

    /** Fetch anything newer than the watermark and notify about it. */
    private void handleSync() {
        Context ctx = getApplicationContext();
        PrefsStore prefs = new PrefsStore(ctx);
        if (!prefs.hasContext()) return;

        String since = prefs.getLastPushSeen();
        if (since == null) {
            since = SupabaseRest.toIso8601Utc(System.currentTimeMillis() - COLD_START_LOOKBACK_MS);
        }

        String path = "/rest/v1/checkins"
                + "?select=id,member_name,member_avatar,type,place,created_at"
                + "&keep_id=eq." + enc(prefs.getKeepId())
                + "&member_id=neq." + enc(prefs.getMemberId())
                + "&created_at=gt." + enc(since)
                + "&type=in.(arrived,left,sos)"
                + "&order=created_at.desc"
                + "&limit=" + MAX_PER_WAKE;

        String body = new SupabaseRest(ctx).getWithRefresh(path);
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
