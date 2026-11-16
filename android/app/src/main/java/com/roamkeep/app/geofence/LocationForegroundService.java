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
import android.hardware.Sensor;
import android.hardware.SensorManager;
import android.hardware.TriggerEvent;
import android.hardware.TriggerEventListener;
import android.location.Location;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

import com.google.android.gms.location.CurrentLocationRequest;
import com.google.android.gms.location.FusedLocationProviderClient;
import com.google.android.gms.location.LocationCallback;
import com.google.android.gms.location.LocationRequest;
import com.google.android.gms.location.LocationResult;
import com.google.android.gms.location.LocationServices;
import com.google.android.gms.location.Priority;
import com.google.android.gms.tasks.CancellationTokenSource;
import com.roamkeep.app.R;

import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

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
 * real movement decided here: dense on the move, low-power once genuinely
 * still. Since 4.13.0 several signals can wake GPS out of low power
 * (activity recognition, the motion sensor, leaving a Wi-Fi network, a
 * rough position far from where the phone stopped), but only a precise fix
 * decides. See MotionJudge, and "Noticing a trip start" below.
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

    // Moving-vs-still is DECIDED from precise fixes only. The activity sensor
    // got Auto stuck both ways when it chose the profile, so since 4.13.0 it
    // may only ask for a GPS check (see MotionJudge). On dense, a fix counts
    // as moving by reported speed (catches walking) or by displacement from
    // the last fix (catches movement when speed is absent). We stay dense
    // until STILL_AFTER of no movement, then relax, so red lights don't flap
    // but a genuinely parked phone drops to low power.
    // MOVING_SPEED_MS, MOVING_DISP_M, MOVING_ACC_MULT and SPEED_TRUST_ACC_M
    // are package-private because LocationUpdateReceiver gates breadcrumb
    // WRITES on the same numbers. They were tuned here, against real journeys,
    // and a second copy over there would drift from them silently.
    static final float MOVING_SPEED_MS = 0.6f;   // ~2 km/h (slow walk)
    static final float MOVING_DISP_M = 40f;      // between fixes (above GPS jitter)
    // A displacement only counts as movement if it also clears this fix's
    // own error radius (× the multiplier). Without this, a stationary phone
    // on the low-power profile (network fixes, ±tens of metres) drifts >40 m
    // between samples, reads as "moving", kicks into dense GPS, then settles
    // — flip-flopping every few minutes and draining battery overnight.
    static final float MOVING_ACC_MULT = 1.5f;
    static final float SPEED_TRUST_ACC_M = 50f;  // ignore speed from fuzzier fixes
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

    // ── Noticing a trip start (4.13.0) ────────────────────────────────
    //
    // On the low-power profile the phone's positions come from Wi-Fi and
    // mobile networks, and until 4.13.0 they alone decided when to leave it.
    // They were wrong both ways. On 2026-11-10 a stale one put a phone near
    // home five minutes into a school run: nothing switched to GPS, the drive
    // was never recorded and "left Home" came 9.5 minutes late (Play
    // Services' fences, fed the same positions, were fooled too). On
    // 2026-11-09 drifting ones put GPS on 19 times in a day at home.
    //
    // So several signals may now say "maybe moving", and only a precise fix
    // decides (MotionJudge has the rules and the reasons):
    //
    //  - activity recognition (MotionSignalReceiver), if the person allowed
    //    Physical activity: a vehicle or bicycle opens a WATCH (dense for
    //    STILL_AFTER, as a doze exit does), walking asks for a CHECK;
    //  - the significant-motion sensor: a CHECK;
    //  - losing the last Wi-Fi network: a WATCH;
    //  - a rough position far from the ANCHOR, where the phone stopped: a
    //    CHECK, where it used to go dense outright.
    //
    // A CHECK is one fresh GPS fix (getCurrentLocation, no cached answer
    // accepted). Each source backs off after turning out to be nothing.
    // Everything here runs on the main looper: the location callback, the
    // check's answer, the sensor, and the Wi-Fi and activity signals, which
    // are posted to it. One thread decides, so nothing here needs a lock.
    private static final long CHECK_TIMEOUT_MS = 30_000;
    private MotionJudge.Anchor anchor;              // low-power only; null when unknown
    private double provenDriftM = 0;                // see MotionJudge.roughAsksForCheck
    private final MotionJudge.Backoff[] backoff = newBackoffs();
    private int denseSource = MotionJudge.SRC_NONE; // what opened the current dense spell
    private boolean denseMoved = false;             // did that spell see real movement?
    private float lastFixAcc = -1f;
    private boolean checking = false;
    private int checkSource = MotionJudge.SRC_NONE;
    private double checkRoughM = 0;
    private CancellationTokenSource checkCancel;
    private int checkGen = 0;
    private PowerManager.WakeLock checkLock;
    private SensorManager sensors;
    private Sensor sigMotion;
    private boolean sensorArmed = false;
    private ConnectivityManager.NetworkCallback wifiCallback;
    private final Set<Network> wifiUp = new HashSet<>();

    private static MotionJudge.Backoff[] newBackoffs() {
        MotionJudge.Backoff[] b = new MotionJudge.Backoff[MotionJudge.SOURCES];
        for (int i = 0; i < b.length; i++) b[i] = new MotionJudge.Backoff();
        return b;
    }

    // ── The "permanent" notification, and what Android allows ─────────
    //
    // Android 13 made foreground-service notifications dismissable by
    // default, but setOngoing(true) still held them in place. Android 14
    // took that away for every app: an ongoing notification can now be
    // swiped, and stays put only on the lock screen and against "Clear
    // all". The exemptions — calls, media sessions, enterprise device
    // policy — do not describe a location app, and borrowing one of their
    // styles would be misrepresentation. No API makes this notification
    // undismissable on 14+. setOngoing(true) is still set below, because
    // on 13, on the lock screen and against Clear all it still works.
    //
    // It is posted once, by startForeground() in onStartCommand, which does
    // not fire again while the service lives. So a swipe used to leave
    // tracking running with nothing on screen to say so — quietly
    // falsifying landing/privacy's "shows a permanent notification
    // whenever it is recording your location".
    //
    // So the notification carries a deleteIntent, and a swipe re-posts it
    // at once (NotificationRestoreReceiver -> onTrackingNotificationDismissed).
    // Same id on an IMPORTANCE_LOW channel: no sound, no vibration, no
    // heads-up — it simply reappears. That is the closest to "cannot be
    // dismissed" the platform allows, and for an app that is recording
    // someone's location, the disclosure staying on screen is the point.
    //
    // This replaced restoring at the next fix (up to one 5-minute re-arm
    // later), which was chosen so as not to fight the user's swipe.
    // Keeping the disclosure continuously visible was judged to matter
    // more. The per-fix check (restoreNotificationIfDismissed) stays as the
    // backstop, for a deleteIntent the system never delivered.
    private static final int DISMISS_REQ = 4712;
    private volatile long lastNotifRestoreJournalMs = 0;
    private volatile int  restoresSinceJournal = 0;
    // Journal restorations at most this often. One swipe is worth a line;
    // a device that somehow flaps must not bury the rest of the journal.
    private static final long RESTORE_JOURNAL_EVERY_MS = 30 * 60_000;

    // Did startForeground() actually succeed? A background start on Android
    // 12+ can be refused outright, and the failure used to go to logcat only
    // — the service kept running as an ordinary background service, which
    // the OS is free to freeze. A frozen process starves the location
    // callback AND stops the Handler that is supposed to re-arm it, which is
    // exactly the "hours of silence, zero re-arms, dense profile" signature
    // in the journals. Reported on the start line and on every gap line,
    // because "armed" told us nothing about whether we were promoted.
    private volatile boolean promoted = false;
    /** When startForeground() last succeeded, so the restore check below can
     *  ignore the window where the OS has not yet listed our notification. */
    private volatile long promotedAtMs = 0;
    /** How long to leave getActiveNotifications() alone after posting. Long
     *  enough for the shade to settle, far shorter than the 5-minute re-arm
     *  that provides the backstop. */
    private static final long PROMOTE_SETTLE_MS = 30_000;
    static final String EXTRA_WHY = "why";

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable rearm = new Runnable() {
        @Override public void run() {
            rearmsSinceFix++;
            applyProfile();   // re-registers the request; heals a stale callback
            // The floor on how long a dismissed notification can stay
            // gone: at worst one re-arm period, even if the device is
            // sitting still and producing no fixes.
            restoreNotificationIfDismissed();
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
        // Assume movement until proven still. No line of its own: the doze
        // line above already says "dense profile".
        enterDense(MotionJudge.SRC_NONE, null);
        try {
            fused.getCurrentLocation(Priority.PRIORITY_HIGH_ACCURACY, null)
                    .addOnSuccessListener(loc -> {
                        if (loc == null) return;
                        // Through the shared serial worker, NOT a thread of
                        // its own: this fix has to be folded into the same
                        // anchor and stillness average as every other one, in
                        // order. A doze exit landing beside a callback
                        // delivery was one of the ways two batches used to
                        // read the same state and clobber each other.
                        // forcePin: the family should see the phone catch up
                        // the moment it wakes, whatever the pin cadence says.
                        LocationUpdateReceiver.submit(getApplicationContext(),
                                Collections.singletonList(loc), null, true);
                    })
                    .addOnFailureListener(e -> Log.w(TAG, "doze-exit getCurrentLocation failed", e));
        } catch (SecurityException e) {
            Log.w(TAG, "doze-exit: missing location permission", e);
        }
    }

    public static void start(Context ctx) { start(ctx, "unknown"); }

    public static void start(Context ctx, String why) {
        // 4.11.5: not at all while the notification can't be shown. Started,
        // the service could only stop itself again, and a stop that lands
        // while another startForegroundService() is still pending kills the
        // app (ForegroundServiceDidNotStartInTimeException). On a new install
        // that was the first tap of Allow on Location: notifications come
        // later in the setup sheet, and the grant fires two starts (the
        // resume self-heal and restartGPS), 25 ms apart on the device log.
        if (!canDisclose(ctx)) {
            noteSharingStopped(ctx, "service start: " + why);
            return;
        }
        Intent i = new Intent(ctx.getApplicationContext(), LocationForegroundService.class);
        i.putExtra(EXTRA_WHY, why);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            ctx.getApplicationContext().startForegroundService(i);
        } else {
            ctx.getApplicationContext().startService(i);
        }
    }

    public static void stop(Context ctx) {
        // Every deliberate stop comes through here (pause, sign-out's
        // stopLocationUpdates, no notification, server rejection), so this is
        // where the activity signal is withdrawn too: it outlives the process
        // on purpose, to restart a service the OS killed, and must not
        // restart one that was stopped deliberately.
        MotionSignalReceiver.unregister(ctx);
        ctx.getApplicationContext().stopService(
                new Intent(ctx.getApplicationContext(), LocationForegroundService.class));
    }

    /**
     * Activity recognition says the person has started moving
     * (MotionSignalReceiver). Running: hand it to the decider. Not running
     * (killed by the OS, or not yet started since boot): start it, which
     * starts dense, which is the watch. An activity-transition broadcast is
     * one of the events Android 12+ allows a foreground-service start from.
     * start() still checks the notification can be shown.
     */
    static void onActivitySignal(Context ctx, int source, String what) {
        PrefsStore prefs = new PrefsStore(ctx);
        if (!prefs.hasContext() || prefs.isPaused() || prefs.isServerRejected()) return;
        final LocationForegroundService svc = instance;
        if (svc != null) {
            svc.handler.post(() -> svc.onSignal(source));
            return;
        }
        start(ctx, "activity: " + what);
    }

    // ── No recording without the notification (4.11.1) ────────────────
    //
    // The privacy page promises a notification "whenever it is recording
    // your location". Until 4.11.1 that held only while nothing went wrong:
    // with the app's notifications turned off, or this channel blocked, the
    // service ran and recorded with nothing on screen, and a start Android
    // refused to promote carried on as an ordinary service. For an app that
    // records where someone is, a notification that can be switched off
    // while recording carries on is the difference between sharing and
    // covert tracking. So the notification is a precondition, not a
    // courtesy: every path that records asks canDisclose() first, and when
    // the answer is no, sharing stops (owner decision 2026-10-09). The
    // family is told once, through this member's status, and the app tells
    // the person why when it is next opened.

    /** What a stopped member's status says, shared with app.js
     *  (STATUS_NOTIFICATIONS_OFF). */
    static final String STATUS_NOTIFICATIONS_OFF = "🔕 Not sharing: notifications are off";
    static final String STATUS_DEFAULT = "📍 Location sharing on";

    /** Whether the tracking notification can be shown right now. */
    static boolean canDisclose(Context ctx) {
        boolean appEnabled = NotificationManagerCompat.from(ctx).areNotificationsEnabled();
        int importance = -1;   // no channel yet: it is created at start, at LOW
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            NotificationChannel ch = nm == null ? null : nm.getNotificationChannel(CHANNEL_ID);
            if (ch != null) importance = ch.getImportance();
        }
        return disclosureAllowed(appEnabled, importance);
    }

    /** Pure, for DisclosureGateTest. The app's notifications must be on,
     *  and the tracking channel not blocked (IMPORTANCE_NONE, which is 0).
     *  -1 means no channel exists yet. */
    static boolean disclosureAllowed(boolean appEnabled, int channelImportance) {
        return appEnabled && channelImportance != NotificationManager.IMPORTANCE_NONE;
    }

    /**
     * Stop sharing because the notification cannot be shown. Safe to call
     * from any thread and any number of times: the journal line and the
     * status the family sees are written once per stop, not per call.
     */
    static void stopForDisclosure(Context context, String why) {
        noteSharingStopped(context, why);
        stop(context.getApplicationContext());
    }

    /**
     * stopForDisclosure without stopping the service: for start() and
     * onStartCommand, which must not call stopService (see start()).
     */
    static void noteSharingStopped(Context context, String why) {
        final Context ctx = context.getApplicationContext();
        final PrefsStore prefs = new PrefsStore(ctx);
        if (prefs.markSharingStopped()) {
            prefs.journal("sharing: STOPPED, the tracking notification can't be shown ("
                    + why + "); nothing is recorded until it can");
            postStatus(ctx, prefs, STATUS_NOTIFICATIONS_OFF);
        } else if (prefs.getStatusOwed() != null) {
            // Already stopped, and the family was never told: this is the
            // retry. Every transition and start attempt while stopped comes
            // through here, so it is tried again at each.
            new Thread(() -> sendOwedStatus(ctx), "RoamkeepStatus").start();
        }
    }

    /**
     * Owe the family a status, then send it, off the calling thread
     * (onStartCommand is on main).
     *
     * It used to be one fire-and-forget PATCH with its result ignored, the
     * same shape as the member update that left a departed member "At Home"
     * (4.11.4). A "not sharing" notice lost that way left the family reading
     * "Location sharing on" from a phone that had stopped. So the status is
     * owed first, in PrefsStore, and stays owed until it lands: retried at
     * the next stop call while stopped, and at the pin cadence while sharing.
     */
    private static void postStatus(Context ctx, PrefsStore prefs, String status) {
        if (!prefs.hasContext()) return;
        prefs.setStatusOwed(status);
        new Thread(() -> sendOwedStatus(ctx), "RoamkeepStatus").start();
    }

    /**
     * Send the status this member still owes, if any. Blocking: call it off
     * the main thread.
     *
     * Taking the notice back (STATUS_DEFAULT) is conditional on the row still
     * carrying the notice, as the app's own restore is. A retry can land long
     * after it was owed, and must not overwrite a status set since, an SOS's
     * among them.
     */
    static void sendOwedStatus(Context context) {
        final Context ctx = context.getApplicationContext();
        final PrefsStore prefs = new PrefsStore(ctx);
        final String owed = prefs.getStatusOwed();
        if (owed == null || !prefs.hasContext()) return;
        int st;
        try {
            org.json.JSONObject upd = new org.json.JSONObject();
            upd.put("status", owed);
            SupabaseRest rest = new SupabaseRest(ctx);
            st = STATUS_DEFAULT.equals(owed)
                    ? rest.updateMemberIfStatus(prefs.getMemberId(), STATUS_NOTIFICATIONS_OFF, upd)
                    : rest.updateMemberStatus(prefs.getMemberId(), upd);
        } catch (Exception e) {
            Log.w(TAG, "status update failed", e);
            st = -1;
        }
        if (st >= 200 && st < 300) {
            if (prefs.settleStatusOwed(owed)) {
                prefs.journal("sharing: the family's status was updated on a retry");
            }
        } else if (prefs.markStatusOwedFailed()) {
            prefs.journal("sharing: couldn't update the family's status (HTTP " + st + "); will retry");
        }
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
        setUpMotionSignals();
        fused = LocationServices.getFusedLocationProviderClient(this);
        locationCallback = new LocationCallback() {
            @Override
            public void onLocationResult(LocationResult result) {
                final List<android.location.Location> locs = result.getLocations();
                if (locs == null || locs.isEmpty()) return;
                // A fix means we are demonstrably recording location right
                // now, which is precisely when the disclosure has to be on
                // screen. Cheaper than it looks — a set membership test on
                // the active notifications, and a no-op in the normal case.
                restoreNotificationIfDismissed();
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
                final android.location.Location newest = locs.get(locs.size() - 1);
                lastFixAcc = newest.hasAccuracy() ? newest.getAccuracy() : -1f;
                if (isAuto() && !dense) {
                    // Low power: these fixes are judged against the anchor,
                    // and only a precise one decides (4.13.0).
                    judgeLowPowerFixes(locs);
                } else {
                    // Decide moving-vs-still from these fixes and flip the
                    // profile if it changed. Dense while moving; low-power
                    // after STILL_AFTER of no movement.
                    if (detectMoving(locs)) {
                        lastMovingMs = System.currentTimeMillis();
                        // Real movement resets every backoff. "Real" is
                        // judged from the anchor, by a precise fix: an indoor
                        // GPS fix jittering 45 m between samples keeps a watch
                        // open, but must not erase what the backoff learned.
                        if (dense && !denseMoved && movedFromAnchor(locs)) {
                            denseMoved = true;
                            resetBackoffs();
                        }
                    }
                    boolean shouldBeDense = System.currentTimeMillis() - lastMovingMs < STILL_AFTER_MS;
                    if (shouldBeDense != dense) {
                        if (shouldBeDense) {
                            // Fixed modes only: auto leaves low power above.
                            dense = true;
                            applyProfile();
                            new PrefsStore(LocationForegroundService.this).journal("auto: moving — dense profile");
                        } else {
                            enterStill();
                        }
                    }
                }
                // Off the main thread — processLocations does blocking HTTP —
                // and onto the ONE worker that runs batches in order, because
                // the drift anchor and stillness average are sequential state.
                LocationUpdateReceiver.submit(getApplicationContext(), locs, null);
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
            promotedAtMs = System.currentTimeMillis();
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
        // The same for a device the server has stopped accepting writes from
        // (see LocationUpdateReceiver.stopForServerRejection).
        //
        // Every way out below is stopSelf(startId), never stopSelf() or
        // stopService (4.11.5). Those stop the service whatever is queued, and
        // a stop while a later startForegroundService() is still pending is a
        // crash (see start()). stopSelf(startId) does nothing if a newer start
        // is on its way, and that start calls startForeground and decides again.
        final PrefsStore gate = new PrefsStore(this);
        if (gate.isPaused() || gate.isServerRejected()) {
            gate.journal("fgs: start skipped (" + (gate.isPaused() ? "paused" : "server rejected this member") + ")");
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
            stopSelf(startId);
            return START_NOT_STICKY;
        }

        // 4.11.1: no notification, no recording (see canDisclose). A start
        // Android would not promote used to carry on as an ordinary service,
        // recording with nothing on screen. The next app open, boot or
        // geofence kick starts it again, promoted.
        if (!promoted) {
            gate.journal("fgs: stopped, not foreground so no notification (" + why + "); nothing recorded");
            stopSelf(startId);
            return START_NOT_STICKY;
        }
        if (!canDisclose(this)) {
            noteSharingStopped(this, "service start: " + why);
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
            stopSelf(startId);
            return START_NOT_STICKY;
        }
        // Back after a stop: say so, once, and put the family's view back.
        if (gate.clearSharingStopped()) {
            gate.journal("sharing: resumed, the tracking notification is showing again");
            postStatus(this, gate, STATUS_DEFAULT);
        }

        // Cancel any leftover PendingIntent-based request from a previous
        // app version so it can't double-deliver alongside our callback.
        try { NativeGeofencePlugin.disarmLocationUpdates(getApplicationContext()); } catch (Exception ignored) {}

        // Register the in-process location callback. Runs on every start,
        // including the START_STICKY restart after a kill (intent == null),
        // so tracking self-heals. Start dense so the beginning of any trip
        // is captured; the callback relaxes it once genuinely still.
        // A start on a running service (the app opened, a geofence kick)
        // keeps its anchor: measure the first dense fix from it, as
        // enterDense does.
        if (!dense && anchor != null) {
            lastLat = anchor.lat;
            lastLng = anchor.lng;
        }
        dense = true;
        lastMovingMs = System.currentTimeMillis();
        denseSource = MotionJudge.SRC_NONE;
        denseMoved = false;
        disarmSensor();
        cancelCheck();
        PrefsStore prefs = new PrefsStore(this);
        if (prefs.hasContext()) {
            applyProfile();
            // (Re-)register activity recognition on every start: a
            // registration does not survive a reboot, and Physical activity
            // may have been allowed since the last one.
            boolean activity = MotionSignalReceiver.register(this);
            prefs.journal("fgs: start — " + why + ", foreground=" + (promoted ? "yes" : "no")
                    + ", armed (dense); signals: activity " + (activity ? "on" : "off")
                    + ", motion sensor " + (sigMotion != null ? "on" : "none")
                    + ", Wi-Fi " + (wifiCallback != null ? "on" : "off"));
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

    // ── Noticing a trip start (4.13.0): the decider ───────────────────

    /** Only auto adapts. live, balanced and saver are the person's choice. */
    private boolean isAuto() {
        String m = new PrefsStore(this).getTrackMode();
        return !("live".equals(m) || "balanced".equals(m) || "saver".equals(m));
    }

    /** The in-process signals: the motion sensor and the Wi-Fi watch. */
    private void setUpMotionSignals() {
        sensors = (SensorManager) getSystemService(Context.SENSOR_SERVICE);
        // Optional hardware: most phones have it, and without it the other
        // signals still work. It is a one-shot wake-up sensor, re-armed
        // after each event (armSensor).
        sigMotion = sensors == null ? null : sensors.getDefaultSensor(Sensor.TYPE_SIGNIFICANT_MOTION);

        // Losing the last Wi-Fi network: the phone has probably left the
        // building it was in. Counted only when NO Wi-Fi network is left, so
        // a mesh or a hand-over between access points is not a departure.
        ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null) return;
        ConnectivityManager.NetworkCallback cb = new ConnectivityManager.NetworkCallback() {
            @Override public void onAvailable(Network n) {
                handler.post(() -> wifiUp.add(n));
            }
            @Override public void onLost(Network n) {
                handler.post(() -> {
                    if (wifiUp.remove(n) && wifiUp.isEmpty()) onSignal(MotionJudge.SRC_WIFI);
                });
            }
        };
        try {
            cm.registerNetworkCallback(new NetworkRequest.Builder()
                    .addTransportType(NetworkCapabilities.TRANSPORT_WIFI).build(), cb);
            wifiCallback = cb;
        } catch (Exception e) {
            Log.w(TAG, "Wi-Fi watch unavailable", e);
        }
    }

    private final TriggerEventListener sigListener = new TriggerEventListener() {
        @Override public void onTrigger(TriggerEvent event) {
            // One-shot: the system disarmed it in firing.
            handler.post(() -> {
                sensorArmed = false;
                onSignal(MotionJudge.SRC_SENSOR);
            });
        }
    };

    private final Runnable armSensorLater = this::armSensor;

    /** Arm the motion sensor while auto is on low power. If its backoff is
     *  running, arm it when the backoff ends: armed now, it would wake the
     *  processor at every step round the house only to be ignored. */
    private void armSensor() {
        handler.removeCallbacks(armSensorLater);
        if (sigMotion == null || sensors == null || dense || !isAuto() || sensorArmed) return;
        long wait = backoff[MotionJudge.SRC_SENSOR].untilMs - System.currentTimeMillis();
        if (wait > 0) {
            handler.postDelayed(armSensorLater, wait);
            return;
        }
        try {
            sensorArmed = sensors.requestTriggerSensor(sigListener, sigMotion);
        } catch (Exception e) {
            Log.w(TAG, "motion sensor arm failed", e);
        }
    }

    private void disarmSensor() {
        handler.removeCallbacks(armSensorLater);
        if (sensorArmed && sensors != null && sigMotion != null) {
            try { sensors.cancelTriggerSensor(sigListener, sigMotion); } catch (Exception ignored) {}
        }
        sensorArmed = false;
    }

    private void resetBackoffs() {
        for (MotionJudge.Backoff b : backoff) b.reset();
    }

    /**
     * Something says the phone may be moving. On dense it is already
     * watching, so there is nothing to do; on low power a strong signal opens
     * a watch and a weak one asks for a check, unless that source is backing
     * off.
     */
    void onSignal(int source) {
        if (!isAuto() || dense || fused == null) return;
        if (!backoff[source].allow(System.currentTimeMillis())) {
            if (source == MotionJudge.SRC_SENSOR) armSensor();
            return;
        }
        if (MotionJudge.responseFor(source) == MotionJudge.WATCH) {
            enterDense(source, MotionJudge.sourceName(source));
        } else {
            check(source, 0);
        }
    }

    /** Low-power fixes: judged against the anchor. A precise fix decides; a
     *  rough one can only ask for a check. */
    private void judgeLowPowerFixes(List<android.location.Location> locs) {
        for (android.location.Location l : locs) {
            final double lat = l.getLatitude(), lng = l.getLongitude();
            final float acc = l.hasAccuracy() ? l.getAccuracy() : -1f;
            final float speed = l.hasSpeed() ? l.getSpeed() : 0f;
            lastLat = lat;
            lastLng = lng;
            int v = MotionJudge.judgeFix(lat, lng, acc, speed, anchor);
            if (v == MotionJudge.MOVING) {
                resetBackoffs();
                enterDense(MotionJudge.SRC_NONE, "precise fix " + fromAnchor(lat, lng) + " from where it stopped");
                return;
            }
            if (v == MotionJudge.STILL) {
                anchor = anchor == null ? MotionJudge.Anchor.of(lat, lng, acc) : anchor.fold(lat, lng, acc);
                continue;
            }
            // Rough. With no anchor yet, the best available position starts
            // one; it says how rough it is, and a precise fix soon outweighs it.
            if (anchor == null) {
                if (acc >= 0 && acc <= 150f) anchor = MotionJudge.Anchor.of(lat, lng, acc);
                continue;
            }
            double d = GeofenceReceiver.metresBetween(anchor.lat, anchor.lng, lat, lng);
            if (d <= MotionJudge.movingBar(acc, anchor)) continue;
            boolean allows = backoff[MotionJudge.SRC_ROUGH].allow(System.currentTimeMillis());
            if (MotionJudge.roughAsksForCheck(d, acc, anchor, allows, provenDriftM)) {
                check(MotionJudge.SRC_ROUGH, d);
                return;
            }
        }
    }

    /**
     * One fresh GPS fix decides. maxUpdateAge 0, so a cached network position
     * (the very thing in doubt) cannot answer; 30 s, then no answer. Held
     * under a wake lock so the processor does not sleep through it. One at a
     * time: a signal arriving during a check is answered by it.
     */
    private void check(int source, double roughM) {
        if (checking || fused == null) return;
        checking = true;
        checkSource = source;
        checkRoughM = roughM;
        disarmSensor();
        try {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm != null) {
                if (checkLock == null) {
                    checkLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "roamkeep:check");
                    checkLock.setReferenceCounted(false);
                }
                checkLock.acquire(CHECK_TIMEOUT_MS + 5_000);
            }
        } catch (Exception e) {
            Log.w(TAG, "check wake lock failed", e);
        }
        checkCancel = new CancellationTokenSource();
        // A check abandoned by cancelCheck can still answer late; the
        // generation makes sure that answer is never read as a newer one's.
        final int gen = ++checkGen;
        try {
            CurrentLocationRequest req = new CurrentLocationRequest.Builder()
                    .setPriority(Priority.PRIORITY_HIGH_ACCURACY)
                    .setMaxUpdateAgeMillis(0)
                    .setDurationMillis(CHECK_TIMEOUT_MS)
                    .build();
            fused.getCurrentLocation(req, checkCancel.getToken())
                    .addOnCompleteListener(task -> {
                        if (gen != checkGen) return;
                        onCheckResult(task.isSuccessful() ? task.getResult() : null, task.isCanceled());
                    });
        } catch (SecurityException e) {
            Log.w(TAG, "check: missing location permission", e);
            finishCheck();
        }
    }

    private void finishCheck() {
        checking = false;
        if (checkLock != null) {
            try { if (checkLock.isHeld()) checkLock.release(); } catch (Exception ignored) {}
        }
    }

    /** Abandon a check in flight (the profile went dense another way, or the
     *  service is stopping). Its answer is then ignored. */
    private void cancelCheck() {
        checkGen++;
        if (checkCancel != null) {
            try { checkCancel.cancel(); } catch (Exception ignored) {}
            checkCancel = null;
        }
        finishCheck();
    }

    private void onCheckResult(android.location.Location loc, boolean cancelled) {
        if (!checking || cancelled) return;     // abandoned: dense already, or stopping
        finishCheck();
        final int source = checkSource;
        final long now = System.currentTimeMillis();
        int v = MotionJudge.UNKNOWN;
        if (loc != null) {
            final float acc = loc.hasAccuracy() ? loc.getAccuracy() : -1f;
            v = MotionJudge.judgeFix(loc.getLatitude(), loc.getLongitude(), acc,
                    loc.hasSpeed() ? loc.getSpeed() : 0f, anchor);
            // Through the shared serial worker like any other fix, so the
            // pin and trail see it (the doze-exit fix does the same).
            LocationUpdateReceiver.submit(getApplicationContext(), Collections.singletonList(loc), null);
        }
        new PrefsStore(this).recordMotionCheck(v, source);
        if (dense || !isAuto()) return;         // decided another way meanwhile

        if (MotionJudge.checkGoesDense(v, source)) {
            if (v == MotionJudge.MOVING) {
                resetBackoffs();
                enterDense(MotionJudge.SRC_NONE, "check after " + MotionJudge.sourceName(source) + ", "
                        + fromAnchor(loc.getLatitude(), loc.getLongitude()) + " from where it stopped");
            } else {
                // No GPS answer to a rough position: GPS anyway, as before
                // 4.13.0. If that watch ends still, this source backs off.
                enterDense(source, MotionJudge.sourceName(source) + ", no GPS fix to check it");
            }
            return;
        }
        if (v == MotionJudge.STILL) {
            final float acc = loc.hasAccuracy() ? loc.getAccuracy() : -1f;
            anchor = anchor == null ? MotionJudge.Anchor.of(loc.getLatitude(), loc.getLongitude(), acc)
                                    : anchor.fold(loc.getLatitude(), loc.getLongitude(), acc);
            if (source == MotionJudge.SRC_ROUGH) provenDriftM = Math.max(provenDriftM, checkRoughM);
        }
        backoff[source].onNothing(now);
        armSensor();
    }

    /** Has any fix in this batch left the anchor by MotionJudge's rule? With
     *  no anchor there is nothing to have left, and detectMoving's verdict
     *  (which the caller has already had) stands. */
    private boolean movedFromAnchor(List<android.location.Location> locs) {
        if (anchor == null) return true;
        for (android.location.Location l : locs) {
            if (MotionJudge.judgeFix(l.getLatitude(), l.getLongitude(),
                    l.hasAccuracy() ? l.getAccuracy() : -1f,
                    l.hasSpeed() ? l.getSpeed() : 0f, anchor) == MotionJudge.MOVING) return true;
        }
        return false;
    }

    /** "240m" from the anchor, or "?" without one. Distances only: the
     *  journal never carries a coordinate. */
    private String fromAnchor(double lat, double lng) {
        if (anchor == null) return "?";
        long m = Math.round(GeofenceReceiver.metresBetween(anchor.lat, anchor.lng, lat, lng));
        return m >= 1000 ? String.format(java.util.Locale.US, "%.1fkm", m / 1000.0) : m + "m";
    }

    /**
     * Go dense (GPS). `source` is the signal that opened this spell, or
     * SRC_NONE when movement is already established; if the spell ends still
     * without seeing movement, that source backs off. `why` goes on the
     * journal line, or null for no line (the caller wrote its own).
     *
     * detectMoving measures the first GPS fix against the previous fix,
     * which on low power was a rough one; measured from the anchor instead,
     * a watch at home does not count its own first fix as travel.
     */
    private void enterDense(int source, String why) {
        final boolean was = dense;
        if (!was && anchor != null) {
            lastLat = anchor.lat;
            lastLng = anchor.lng;
        }
        dense = true;
        lastMovingMs = System.currentTimeMillis();
        denseSource = source;
        denseMoved = false;
        disarmSensor();
        cancelCheck();
        applyProfile();
        if (!was && why != null) {
            new PrefsStore(this).journal("auto: moving — dense profile (" + why + ")");
        }
    }

    /**
     * Back to low power after STILL_AFTER of no movement. The new anchor is
     * the last fix, folded into the old one if this was a watch that went
     * nowhere (same place, and what was learned there about drift still
     * holds); otherwise a fresh start.
     */
    private void enterStill() {
        final long now = System.currentTimeMillis();
        final boolean auto = isAuto();
        if (auto && !denseMoved && denseSource != MotionJudge.SRC_NONE) {
            backoff[denseSource].onNothing(now);
        }
        final boolean wentNowhere = !denseMoved;
        dense = false;
        denseSource = MotionJudge.SRC_NONE;
        denseMoved = false;
        if (!Double.isNaN(lastLat) && lastFixAcc >= 0 && lastFixAcc <= 150f) {
            boolean samePlace = wentNowhere && anchor != null
                    && GeofenceReceiver.metresBetween(anchor.lat, anchor.lng, lastLat, lastLng)
                       <= MotionJudge.movingBar(lastFixAcc, anchor);
            if (samePlace) {
                anchor = anchor.fold(lastLat, lastLng, lastFixAcc);
            } else {
                anchor = MotionJudge.Anchor.of(lastLat, lastLng, lastFixAcc);
                provenDriftM = 0;
            }
        } else if (!wentNowhere) {
            anchor = null;
            provenDriftM = 0;
        }
        applyProfile();
        new PrefsStore(this).journal("auto: still — low-power profile");
        if (auto) armSensor();
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
        // The in-process signals end with the service. Activity recognition
        // does not: it is how a killed service comes back (stop() withdraws
        // it when the stop is deliberate).
        disarmSensor();
        cancelCheck();
        if (wifiCallback != null) {
            try {
                ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
                if (cm != null) cm.unregisterNetworkCallback(wifiCallback);
            } catch (Exception ignored) {}
            wifiCallback = null;
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

    /**
     * BACKSTOP: put the tracking notification back if it is missing.
     *
     * A swipe is normally undone at once by the deleteIntent path
     * (onTrackingNotificationDismissed). This runs on every fix and every
     * re-arm for the case that path cannot see — a deleteIntent the system
     * never delivered — so the worst case stays one re-arm period.
     *
     * Checked rather than re-posted blindly: getActiveNotifications() is
     * cheap, and a needless notify() every five minutes would churn the
     * shade and could interrupt someone reading it.
     *
     * Silent by construction — same notification id, IMPORTANCE_LOW
     * channel, PRIORITY_LOW, setShowBadge(false). Nothing about this
     * makes a sound or a heads-up; it just reappears in the list.
     *
     * Does nothing unless we actually hold the foreground service. If
     * startForeground failed (a background start Android refused), the
     * notification is not ours to restore and posting one would claim we
     * are tracking when we are not.
     */
    private void restoreNotificationIfDismissed() {
        if (!promoted) return;
        // Just posted it? Then an absence from getActiveNotifications() means
        // the OS has not caught up, not that anybody swiped. After a reboot
        // the first fix lands within seconds of startForeground() and this
        // read came back empty, so the journal reported a dismissal that
        // never happened — a line claiming something untrue, in a journal
        // whose only value is being believed. Nobody can swipe a
        // notification they have not seen yet; if they do, the deleteIntent
        // path restores it regardless of this window.
        if (System.currentTimeMillis() - promotedAtMs < PROMOTE_SETTLE_MS) return;
        // Notifications switched off for the app entirely: there is no
        // notification to restore and notify() would throw on every fix.
        // Nothing to do here — the setup sheet is what asks for this
        // permission, and it already flags the absence.
        if (!NotificationManagerCompat.from(this).areNotificationsEnabled()) return;
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        try {
            boolean present = false;
            for (android.service.notification.StatusBarNotification sbn : nm.getActiveNotifications()) {
                if (sbn.getId() == NOTIF_ID) { present = true; break; }
            }
            if (present) return;
            repostNotification();
        } catch (Exception e) {
            // getActiveNotifications can throw on some OEM builds. Not worth
            // killing the tracking service over.
            Log.w(TAG, "notification check failed", e);
        }
    }

    /**
     * The user just swiped the tracking notification away (its deleteIntent
     * fired). Called on the main thread by NotificationRestoreReceiver.
     *
     * A no-op unless this process is running the service: if it is not,
     * nothing is being recorded and there is nothing to disclose. The
     * system does not fire a deleteIntent when the app itself removes the
     * notification — stopForeground on pause, stopSelf — so a pause never
     * brings it back; the pause check below is belt and braces.
     */
    static void onTrackingNotificationDismissed() {
        LocationForegroundService svc = instance;
        if (svc == null || !svc.promoted) return;
        if (new PrefsStore(svc).isPaused()) return;
        svc.repostNotification();
    }

    /** Put the tracking notification back and journal it, rate-limited.
     *  Shared by the immediate deleteIntent path and the per-fix backstop. */
    private void repostNotification() {
        // Notifications switched off for the app entirely: there is nothing
        // to restore and notify() would throw. The setup sheet is what asks
        // for this permission, and it already flags the absence.
        if (!NotificationManagerCompat.from(this).areNotificationsEnabled()) return;
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        try {
            createChannel();
            nm.notify(NOTIF_ID, buildNotification());

            // Rate-limited so one swipe reads clearly and someone swiping
            // repeatedly cannot drown the journal — the count carries what
            // the suppressed lines would have said.
            restoresSinceJournal++;
            long now = System.currentTimeMillis();
            if (now - lastNotifRestoreJournalMs >= RESTORE_JOURNAL_EVERY_MS) {
                new PrefsStore(this).journal(
                        "fgs: tracking notification was dismissed — restored"
                        + (restoresSinceJournal > 1 ? " (x" + restoresSinceJournal + ")" : ""));
                lastNotifRestoreJournalMs = now;
                restoresSinceJournal = 0;
            }
        } catch (Exception e) {
            // notify() throws without POST_NOTIFICATIONS on API 33+. Not
            // worth killing the tracking service over.
            Log.w(TAG, "notification restore failed", e);
        }
    }

    private Notification buildNotification() {
        PendingIntent tap = null;
        Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (launch != null) {
            int flags = PendingIntent.FLAG_UPDATE_CURRENT
                    | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0);
            tap = PendingIntent.getActivity(this, 0, launch, flags);
        }
        // Fired by the system when the user swipes the notification away —
        // not when the app removes it — so it can be put straight back. See
        // the note on the "permanent" notification above.
        PendingIntent onDismiss = PendingIntent.getBroadcast(this, DISMISS_REQ,
                new Intent(this, NotificationRestoreReceiver.class),
                PendingIntent.FLAG_UPDATE_CURRENT
                        | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0));
        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("🏰 Roamkeep")
                // What is happening to the person holding the phone, plainly:
                // this notification is the standing disclosure that their
                // location is being shared (see the "permanent" note above).
                // Fixed text, so it needs no state of its own to stay true.
                .setContentText("Roamkeep is sharing your location with your family")
                // The Roamkeep mark as an alpha-only glyph: the system tints
                // it to match the other status-bar icons. No setColor(), so
                // the shade uses the system colour too.
                .setSmallIcon(R.drawable.ic_stat_roamkeep)
                .setOngoing(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setContentIntent(tap)
                .setDeleteIntent(onDismiss)
                .build();
    }
}
