package com.roamkeep.app.geofence;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

import com.google.android.gms.location.FusedLocationProviderClient;
import com.google.android.gms.location.LocationCallback;
import com.google.android.gms.location.LocationRequest;
import com.google.android.gms.location.LocationResult;
import com.google.android.gms.location.LocationServices;
import com.google.android.gms.location.Priority;

import java.util.Collections;
import java.util.List;

/**
 * Foreground service that owns Roamkeep's location engine.
 *
 * Two jobs in one:
 *   1. Being a foreground service keeps the app in an active process
 *      state, so its background location isn't throttled by App Standby
 *      buckets on idle devices (a child's phone left charging overnight
 *      falls into a restricted bucket otherwise). START_STICKY so the OS
 *      recreates it after a memory kill; restarted on boot + geofence
 *      transitions.
 *   2. It holds a live, in-process FusedLocationProvider LocationCallback.
 *      This is the key to dense, accurate trails: the OS honours a live
 *      foreground callback faithfully, whereas the old PendingIntent
 *      delivery was batched/deferred, so we had to over-request to
 *      compensate. Now one lean, distance-governed request per mode is
 *      delivered as asked — best accuracy per unit of battery.
 *
 * The callback hands each batch to LocationUpdateReceiver.processLocations
 * (breadcrumb + live-pin + battery writes). For 'auto', the rate adapts to
 * real GPS movement decided here — dense on the move, low-power once
 * genuinely still — rather than the (unreliable) activity sensor.
 *
 * (A hard OEM force-stop — Samsung "Deep sleeping apps" — cancels even
 * this; that needs the "Never sleeping apps" device setting. But a device
 * whose geofences still fire is not force-stopped, and this service
 * restores its breadcrumbs.)
 */
public class LocationForegroundService extends Service {
    private static final String TAG = "RoamkeepGeo";
    private static final String CHANNEL_ID = "roamkeep_tracking";
    private static final int NOTIF_ID = 4711;

    /** Whether the service is currently alive — surfaced in diagnostics. */
    public static volatile boolean running = false;
    private static LocationForegroundService instance;

    private FusedLocationProviderClient fused;
    private LocationCallback locationCallback;

    // Moving-vs-still is decided purely from GPS — the only reliable signal
    // (the activity sensor got Auto stuck both ways). A fix counts as moving
    // by reported speed (catches walking) or by displacement from the last
    // fix (catches movement when speed is absent). We stay dense until
    // STILL_AFTER of no movement, then relax — so red lights don't flap, but
    // a genuinely parked phone drops to low power.
    private static final float MOVING_SPEED_MS = 0.6f;   // ~2 km/h (slow walk)
    private static final float MOVING_DISP_M = 40f;      // between fixes (above GPS jitter)
    // A displacement only counts as movement if it also clears this fix's
    // own error radius (× the multiplier). Without this, a stationary phone
    // on the low-power profile (network fixes, ±tens of metres) drifts >40 m
    // between samples, reads as "moving", kicks into dense GPS, then settles
    // — flip-flopping every few minutes and draining battery overnight.
    private static final float MOVING_ACC_MULT = 1.5f;
    private static final float SPEED_TRUST_ACC_M = 50f;  // ignore speed from fuzzier fixes
    private static final long STILL_AFTER_MS = 3 * 60_000;
    private static final long REARM_MS = 5 * 60_000;     // periodic self-heal
    private volatile long lastMovingMs = 0;
    private boolean dense = true;                         // current profile state
    private double lastLat = Double.NaN, lastLng = Double.NaN;

    // 4.5.4 raised the bar above twice over — a combined error budget across
    // both fixes, plus a requirement that displacement show up in two
    // consecutive batches — to stop a stationary phone flip-flopping
    // overnight. It worked, and it cost trail density: at driving speed the
    // bar went from 75 m to 150 m at ±50 m accuracy, so a phone with a
    // mediocre position (in a bag rather than a hand) stayed on the
    // low-power profile through whole trips. Low-power yields a breadcrumb
    // roughly every 450 m at driving speed against dense's 60 m — a ~7x
    // coarser trail, seen directly in two phones' trails of one car journey.
    // Reverted in 4.5.9.
    //
    // THE RULE THIS BROKE, TWICE: never raise the bar for concluding
    // "moving" — that makes real trips invisible, and trips are the product.
    // Flapping is a battery and journal-noise problem, so pay for it on the
    // stillness side: be slower to conclude "still", or compare against an
    // anchor position held over a window rather than the previous fix (drift
    // is a random walk and stays near its origin; travel accumulates).
    // Silence detection. A stretch with no fixes is invisible in the
    // journal — nothing is written when the callback is armed, when a fix
    // lands, or when one fails to. Twice now a device has gone dark for an
    // hour and the journal could not distinguish "service dead" from
    // "armed but starved" from "OS suppressed it".
    //
    // So count the periodic re-arms since the last fix and report both when
    // the silence breaks. That one line is the discriminator: re-arms
    // roughly equal to the gap divided by REARM_MS means the process was
    // alive and the OS delivered nothing; a count near zero means the
    // Handler itself was frozen — which matters, because this self-heal
    // runs on the main looper and is therefore subject to the very
    // starvation it exists to repair (PauseExpiryReceiver uses
    // setAndAllowWhileIdle for exactly that reason).
    // Two more facts, because the re-arm count alone could not tell a lost
    // trip from the system working. BOTH profiles carry a distance filter
    // (15 m dense, 30 m low-power), so a stationary phone is silent BY
    // DESIGN — a sleeping device reporting "237m silence" is correct, not
    // broken, and the first version of this line cried wolf every night.
    //
    // `moved` settles it: a silence ending 12 m from where it began is the
    // filter doing its job; one ending 4 km away is a trip we lost. `dozed`
    // says how much of the gap the OS had location off device-wide, which
    // nothing in the app can do anything about.
    //
    // The window is 30 minutes rather than 10 for the same reason — on
    // low-power a still phone routinely exceeds 10 minutes with nothing
    // wrong.
    private static final long GAP_REPORT_MS = 30 * 60_000;
    private volatile long lastFixMs = 0;
    private volatile double lastFixLat = Double.NaN, lastFixLng = Double.NaN;
    private volatile int rearmsSinceFix = 0;
    private volatile long dozeMsSinceFix = 0;
    private volatile long dozeEnteredMs = 0;

    // Did startForeground() actually succeed? A background start on Android
    // 12+ can be refused outright, and the failure used to go to logcat only
    // — the service kept running as an ordinary background service, which
    // the OS is free to freeze. A frozen process starves the location
    // callback AND stops the Handler that is supposed to re-arm it, which is
    // exactly the "hours of silence, zero re-arms, dense profile" signature
    // in the journals. Reported on the start line and on every gap line,
    // because "armed" told us nothing about whether we were promoted.
    private volatile boolean promoted = false;
    static final String EXTRA_WHY = "why";

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable rearm = new Runnable() {
        @Override public void run() {
            rearmsSinceFix++;
            applyProfile();   // re-registers the request; heals a stale callback
            handler.postDelayed(this, REARM_MS);
        }
    };

    // Deep Doze switches the location provider off DEVICE-WIDE
    // (`ProviderRequest[OFF]` in dumpsys location) — no permission,
    // whitelist or foreground service exempts an app from that, so our
    // callback simply starves and geofence evaluation goes dark with it.
    // Nothing can get location back while idle, but the moment the
    // device exits idle we can act instead of waiting for the OS to
    // wander back to us: re-arm the request and push one fresh fix
    // through the breadcrumb path. ACTION_DEVICE_IDLE_MODE_CHANGED is
    // delivered to runtime-registered receivers only, which is why this
    // lives here (the service is the longest-lived context we own).
    private BroadcastReceiver dozeReceiver;

    private void registerDozeReceiver() {
        if (Build.VERSION.SDK_INT < 23 || dozeReceiver != null) return;
        dozeReceiver = new BroadcastReceiver() {
            @Override public void onReceive(Context ctx, Intent intent) {
                PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
                if (pm == null) return;
                PrefsStore prefs = new PrefsStore(ctx);
                if (pm.isDeviceIdleMode()) {
                    dozeEnteredMs = System.currentTimeMillis();
                    prefs.journal("doze: enter (location suspends device-wide)");
                } else {
                    if (dozeEnteredMs > 0) {
                        dozeMsSinceFix += System.currentTimeMillis() - dozeEnteredMs;
                        dozeEnteredMs = 0;
                    }
                    prefs.journal("doze: exit — re-armed, dense profile");
                    onDozeExit();
                }
            }
        };
        ContextCompat.registerReceiver(this, dozeReceiver,
                new IntentFilter(PowerManager.ACTION_DEVICE_IDLE_MODE_CHANGED),
                ContextCompat.RECEIVER_NOT_EXPORTED);
    }

    /** Doze just ended. Re-apply the location request (heals a starved
     *  callback immediately instead of waiting for the periodic re-arm)
     *  and grab one fresh fix so the pin, trail and — indirectly —
     *  Play Services' fence evaluation catch up right now rather than
     *  at the OS's leisure. */
    private void onDozeExit() {
        dense = true;                     // assume movement until proven still
        lastMovingMs = System.currentTimeMillis();
        applyProfile();
        try {
            fused.getCurrentLocation(Priority.PRIORITY_HIGH_ACCURACY, null)
                    .addOnSuccessListener(loc -> {
                        if (loc == null) return;
                        final Location l = loc;
                        new Thread(() -> {
                            try {
                                LocationUpdateReceiver.processLocations(
                                        getApplicationContext(), Collections.singletonList(l));
                            } catch (Exception e) {
                                Log.w(TAG, "doze-exit fix process failed", e);
                            }
                        }, "RoamkeepDozeExitWorker").start();
                    })
                    .addOnFailureListener(e -> Log.w(TAG, "doze-exit getCurrentLocation failed", e));
        } catch (SecurityException e) {
            Log.w(TAG, "doze-exit: missing location permission", e);
        }
    }

    public static void start(Context ctx) { start(ctx, "unknown"); }

    public static void start(Context ctx, String why) {
        Intent i = new Intent(ctx.getApplicationContext(), LocationForegroundService.class);
        i.putExtra(EXTRA_WHY, why);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            ctx.getApplicationContext().startForegroundService(i);
        } else {
            ctx.getApplicationContext().startService(i);
        }
    }

    public static void stop(Context ctx) {
        ctx.getApplicationContext().stopService(
                new Intent(ctx.getApplicationContext(), LocationForegroundService.class));
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();
        // A "created" entry with no preceding "destroyed" means the
        // previous process died without ceremony — the journal's way of
        // catching kills that ApplicationExitInfo attributes later.
        new PrefsStore(this).journal("fgs: created");
        registerDozeReceiver();
        fused = LocationServices.getFusedLocationProviderClient(this);
        locationCallback = new LocationCallback() {
            @Override
            public void onLocationResult(LocationResult result) {
                final List<android.location.Location> locs = result.getLocations();
                if (locs == null || locs.isEmpty()) return;
                // Break in the silence. Everything needed to classify it goes
                // on one line: how long, whether the re-arm kept running,
                // whether we were promoted, HOW FAR the device actually
                // travelled while silent, and how much of the gap the OS had
                // location switched off device-wide.
                final long nowMs = System.currentTimeMillis();
                final android.location.Location first = locs.get(0);
                if (lastFixMs > 0 && nowMs - lastFixMs > GAP_REPORT_MS) {
                    long dozed = dozeMsSinceFix
                            + (dozeEnteredMs > 0 ? nowMs - dozeEnteredMs : 0);
                    String movedTxt = "?";
                    if (!Double.isNaN(lastFixLat)) {
                        float[] d = new float[1];
                        android.location.Location.distanceBetween(
                                lastFixLat, lastFixLng,
                                first.getLatitude(), first.getLongitude(), d);
                        movedTxt = d[0] >= 1000f
                                ? String.format(java.util.Locale.US, "%.1fkm", d[0] / 1000f)
                                : Math.round(d[0]) + "m";
                    }
                    new PrefsStore(LocationForegroundService.this).journal(
                            "fgs: first fix after " + ((nowMs - lastFixMs) / 60_000)
                            + "m silence (" + rearmsSinceFix + " re-arms, profile "
                            + (dense ? "dense" : "low-power")
                            + ", fg=" + (promoted ? "yes" : "no")
                            + ", moved " + movedTxt
                            + ", dozed " + (dozed / 60_000) + "m)");
                }
                lastFixMs = nowMs;
                lastFixLat = first.getLatitude();
                lastFixLng = first.getLongitude();
                rearmsSinceFix = 0;
                dozeMsSinceFix = 0;
                // Still idle? Restart the clock so the next gap only counts
                // doze time that actually falls inside it.
                if (dozeEnteredMs > 0) dozeEnteredMs = nowMs;
                // Decide moving-vs-still from these fixes and flip the profile
                // if it changed. Dense while moving; low-power after
                // STILL_AFTER of no movement.
                if (detectMoving(locs)) lastMovingMs = System.currentTimeMillis();
                boolean shouldBeDense = System.currentTimeMillis() - lastMovingMs < STILL_AFTER_MS;
                if (shouldBeDense != dense) {
                    dense = shouldBeDense;
                    applyProfile();
                    new PrefsStore(LocationForegroundService.this)
                            .journal(dense ? "auto: moving — dense profile" : "auto: still — low-power profile");
                }
                // Off the main thread — processLocations does blocking HTTP.
                new Thread(() -> {
                    try { LocationUpdateReceiver.processLocations(getApplicationContext(), locs); }
                    catch (Exception e) { Log.w(TAG, "location process failed", e); }
                }, "RoamkeepLocationWorker").start();
            }
        };
    }

    /** True if the batch shows the device actually moving — by reported
     *  speed, or by displacement from the last fix we saw. */
    private boolean detectMoving(List<android.location.Location> locs) {
        boolean moving = false;
        for (android.location.Location l : locs) {
            float acc = l.hasAccuracy() ? l.getAccuracy() : 0f;
            // Trust a speed reading only from a reasonably precise fix — a
            // low-power/network fix can report spurious speed while still.
            if (l.hasSpeed() && l.getSpeed() > MOVING_SPEED_MS
                    && l.hasAccuracy() && acc < SPEED_TRUST_ACC_M) moving = true;
            if (!Double.isNaN(lastLat)) {
                float[] out = new float[1];
                android.location.Location.distanceBetween(lastLat, lastLng, l.getLatitude(), l.getLongitude(), out);
                // Movement must clear GPS noise: beyond the fixed floor AND
                // beyond this fix's own error radius (scaled). A 40 m "jump"
                // between two ±50 m fixes is drift, not travel.
                float need = Math.max(MOVING_DISP_M, acc * MOVING_ACC_MULT);
                if (out[0] > need) moving = true;
            }
            lastLat = l.getLatitude();
            lastLng = l.getLongitude();
        }
        return moving;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // Who asked for this start, so a background restart that fails
        // promotion can be told apart from an app-open one that succeeds.
        // A null intent is the START_STICKY restart after a kill.
        String why = intent == null ? "sticky-restart" : intent.getStringExtra(EXTRA_WHY);
        if (why == null) why = "unknown";

        promoted = false;
        try {
            Notification n = buildNotification();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
            } else {
                startForeground(NOTIF_ID, n);
            }
            promoted = true;
        } catch (Exception e) {
            // ForegroundServiceStartNotAllowedException is the one to expect
            // here. Name it in the journal — logcat is gone by the time
            // anyone looks, which is why this was invisible.
            new PrefsStore(this).journal(
                    "fgs: NOT foreground — " + e.getClass().getSimpleName() + " (" + why + ")");
            Log.w(TAG, "startForeground failed", e);
        }

        // Respect an active self-pause. START_STICKY, boot, and geofence
        // kicks can all try to (re)start this service; while the user has
        // paused, stop right back out instead of arming location. We had to
        // startForeground first (the startForegroundService contract), so
        // drop the notification on the way out.
        if (new PrefsStore(this).isPaused()) {
            new PrefsStore(this).journal("fgs: start skipped (paused)");
            stopForeground(true);
            stopSelf();
            return START_NOT_STICKY;
        }

        // Cancel any leftover PendingIntent-based request from a previous
        // app version so it can't double-deliver alongside our callback.
        try { NativeGeofencePlugin.disarmLocationUpdates(getApplicationContext()); } catch (Exception ignored) {}

        // Register the in-process location callback. Runs on every start,
        // including the START_STICKY restart after a kill (intent == null),
        // so tracking self-heals. Start dense so the beginning of any trip
        // is captured; the callback relaxes it once genuinely still.
        dense = true;
        lastMovingMs = System.currentTimeMillis();
        PrefsStore prefs = new PrefsStore(this);
        if (prefs.hasContext()) {
            applyProfile();
            prefs.journal("fgs: start — " + why + ", foreground=" + (promoted ? "yes" : "no") + ", armed (dense)");
        } else {
            // Nothing will record until initialize() supplies context. Worth
            // a line: the counters look identical to "armed but starved".
            prefs.journal("fgs: start — " + why + ", foreground=" + (promoted ? "yes" : "no") + ", NOT armed (no stored context)");
        }
        // Periodic re-arm: re-registers the request every few minutes so a
        // long-running session can't leave a silently-dead callback (the
        // "long running app" half of the stuck-trip bug).
        handler.removeCallbacks(rearm);
        handler.postDelayed(rearm, REARM_MS);

        instance = this;
        running = true;
        return START_STICKY;
    }

    /** (Re)apply the location request for the current mode + movement state.
     *  Safe to call repeatedly. */
    void applyProfile() {
        if (fused == null || locationCallback == null) return;
        String mode = new PrefsStore(this).getTrackMode();
        LocationRequest req = NativeGeofencePlugin.requestFor(mode, dense);
        try {
            fused.removeLocationUpdates(locationCallback);
            fused.requestLocationUpdates(req, locationCallback, Looper.getMainLooper())
                    .addOnFailureListener(e -> Log.w(TAG, "requestLocationUpdates failed", e));
        } catch (SecurityException e) {
            Log.w(TAG, "service: missing location permission", e);
        }
    }

    @Override
    public void onDestroy() {
        running = false;
        handler.removeCallbacks(rearm);
        instance = null;
        new PrefsStore(this).journal("fgs: destroyed");
        if (dozeReceiver != null) {
            try { unregisterReceiver(dozeReceiver); } catch (Exception ignored) {}
            dozeReceiver = null;
        }
        if (fused != null && locationCallback != null) {
            try { fused.removeLocationUpdates(locationCallback); } catch (Exception ignored) {}
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        if (nm.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel ch = new NotificationChannel(
                CHANNEL_ID, "Location sharing", NotificationManager.IMPORTANCE_LOW);
        ch.setDescription("Keeps the family map and trail up to date.");
        ch.setShowBadge(false);
        nm.createNotificationChannel(ch);
    }

    private Notification buildNotification() {
        PendingIntent tap = null;
        Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (launch != null) {
            int flags = PendingIntent.FLAG_UPDATE_CURRENT
                    | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0);
            tap = PendingIntent.getActivity(this, 0, launch, flags);
        }
        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("🏰 Roamkeep")
                .setContentText("Keeping track of where your family roams")
                .setSmallIcon(android.R.drawable.ic_menu_mylocation)
                .setOngoing(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setContentIntent(tap)
                .build();
    }
}
