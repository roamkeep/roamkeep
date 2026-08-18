package com.roamkeep.mockgps;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.location.Location;
import android.location.LocationManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.SystemClock;

import com.google.android.gms.location.FusedLocationProviderClient;
import com.google.android.gms.location.LocationServices;

import java.util.ArrayList;
import java.util.List;

/**
 * Replays a route into the OS test location providers.
 *
 * WHY A FOREGROUND SERVICE
 * ------------------------
 * The entire use case is: start this, switch to Roamkeep, screen-record
 * Roamkeep. This app is therefore in the background for the whole take. A
 * plain service would be frozen within minutes and the injected trail would
 * simply stop part-way through the shot, which looks exactly like the bug
 * the video is meant to disprove.
 *
 * WHICH PROVIDERS
 * ---------------
 * Roamkeep reads Play Services' FusedLocationProvider, not the raw gps
 * provider. Which underlying provider FLP honours has varied across
 * versions, so all three are mocked and the notification reports which ones
 * were accepted. If the pin does not move, that line is the first thing to
 * read — it distinguishes "the mock app is not selected in Developer
 * options" from "FLP is ignoring this provider".
 */
public class MockService extends Service {

    public static final String ACTION_START = "com.roamkeep.mockgps.START";
    /**
     * Sit still at one coordinate, indefinitely.
     *
     * Not a convenience. Until something is being injected the device
     * reports where it ACTUALLY is, so connecting a phone to the demo
     * backend and signing in writes the author's real position — home — into
     * a database whose credentials are handed to Google. Hold has to be
     * running before Roamkeep is opened, not just before the route plays.
     *
     * It also gives a recording a sane opening frame: the map shows the
     * member at Home rather than jumping there when playback begins.
     */
    public static final String ACTION_HOLD = "com.roamkeep.mockgps.HOLD";
    public static final String ACTION_STOP = "com.roamkeep.mockgps.STOP";

    public static final String EXTRA_LAT = "lat";
    public static final String EXTRA_LNG = "lng";
    public static final String EXTRA_KMH = "kmh";
    public static final String EXTRA_LOOP = "loop";
    public static final String EXTRA_HOLD_LAT = "holdLat";
    public static final String EXTRA_HOLD_LNG = "holdLng";

    private static final String CHANNEL_ID = "mockgps";
    private static final int NOTIF_ID = 1;
    /**
     * Four fixes per second.
     *
     * Was one per second, which left a gap wide enough for Play Services to
     * answer a consumer's request from its own cache or its own engine
     * before the next injection landed — one source of the real/mock
     * alternation seen on a handset. Roamkeep's densest profile ("live")
     * asks every 2 s, so injecting at 4 Hz means a freshly mocked fix is
     * always the newest thing available.
     *
     * The cost is negligible: setTestProviderLocation is a binder call
     * against a value already computed.
     */
    private static final long TICK_MS = 250;

    /** Read by MainActivity to render status. Volatile, not a binder —
     *  there is one process and one activity. */
    public static volatile boolean running = false;
    public static volatile String status = "Stopped";
    public static volatile double progressM = 0, totalM = 0;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private LocationManager lm;
    /**
     * The one that matters. Roamkeep reads Play Services' fused client, not
     * LocationManager, and the fused client runs its own engine — mocking
     * every LocationManager provider still left real fixes coming through.
     */
    private FusedLocationProviderClient fused;
    private volatile boolean fusedMocked = false;
    private final List<String> providers = new ArrayList<>();
    private Route route;
    private double speedMs;
    private boolean loop;
    private long startedAt;
    /** true = parked on holdLat/holdLng; false = replaying `route`. */
    private boolean holding;
    private double holdLat, holdLng;
    private double lastLat, lastLng;
    private long lastCheckMs, lastNotifyMs;
    /** Appended to `status` when the OS is not holding our injected fix. */
    private volatile String warning = "";

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || ACTION_STOP.equals(intent.getAction())) {
            stopSelf();
            return START_NOT_STICKY;
        }

        // A second start on a live service must not leave the first tick
        // loop running — two loops would race to set the same provider and
        // the position would jitter between hold point and route.
        handler.removeCallbacks(tick);

        if (ACTION_HOLD.equals(intent.getAction())) {
            holdLat = intent.getDoubleExtra(EXTRA_HOLD_LAT, Double.NaN);
            holdLng = intent.getDoubleExtra(EXTRA_HOLD_LNG, Double.NaN);
            if (Double.isNaN(holdLat) || Double.isNaN(holdLng)
                    || holdLat < -90 || holdLat > 90 || holdLng < -180 || holdLng > 180) {
                status = "Hold position is not a valid coordinate";
                stopSelf();
                return START_NOT_STICKY;
            }
            holding = true;
            route = null;
            speedMs = 0;
            totalM = 0;
            progressM = 0;
        } else {
            double[] lat = intent.getDoubleArrayExtra(EXTRA_LAT);
            double[] lng = intent.getDoubleArrayExtra(EXTRA_LNG);
            if (lat == null || lng == null || lat.length < 2) {
                status = "No route";
                stopSelf();
                return START_NOT_STICKY;
            }
            holding = false;
            route = Route.fromArrays(lat, lng);
            speedMs = Math.max(0.2, intent.getFloatExtra(EXTRA_KMH, 45f) / 3.6);
            loop = intent.getBooleanExtra(EXTRA_LOOP, false);
            totalM = route.lengthM();
            progressM = 0;
        }

        lm = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
        // Already registered if this is hold -> play on a live service.
        if (providers.isEmpty() && !addProviders()) {
            stopSelf();
            return START_NOT_STICKY;
        }
        enableFusedMockMode();

        startForeground(NOTIF_ID, notification());
        running = true;
        startedAt = SystemClock.elapsedRealtime();
        handler.post(tick);
        return START_NOT_STICKY;
    }

    /**
     * Mock EVERY provider the device has, not a hardcoded three.
     *
     * The first version mocked gps, network and (API 31+) fused. On a real
     * handset that produced a trail alternating between the replayed route
     * and the device's actual position — long spikes out and back, several
     * per minute. Roamkeep reads Play Services' FusedLocationProviderClient,
     * which fuses whatever sources it can reach; leave one un-mocked and it
     * keeps feeding real fixes in among the injected ones, and the consumer
     * cannot tell them apart.
     *
     * getAllProviders() includes OEM-specific providers, which is the point:
     * a hardcoded list cannot know what a given Samsung ships. PASSIVE is
     * skipped deliberately — it is a pass-through of whatever other
     * providers emit, not a source, and it cannot be mocked.
     *
     * @return false if the OS refused, which in practice always means this
     *         app is not the one selected in Developer options.
     */
    private boolean addProviders() {
        List<String> want = new ArrayList<>();
        try {
            for (String p : lm.getAllProviders()) {
                if (!LocationManager.PASSIVE_PROVIDER.equals(p)) want.add(p);
            }
        } catch (Exception ignored) { }
        // Belt and braces: these must be present even if getAllProviders()
        // is unhelpful on some device.
        for (String p : new String[]{LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER}) {
            if (!want.contains(p)) want.add(p);
        }
        if (Build.VERSION.SDK_INT >= 31 && !want.contains(LocationManager.FUSED_PROVIDER)) {
            want.add(LocationManager.FUSED_PROVIDER);
        }

        for (String p : want) {
            try {
                lm.addTestProvider(p, false, false, false, false, true, true, true,
                        android.location.Criteria.POWER_LOW, android.location.Criteria.ACCURACY_FINE);
                lm.setTestProviderEnabled(p, true);
                providers.add(p);
            } catch (SecurityException e) {
                status = "Not allowed. Set Developer options → Select mock location app → Roamkeep MockGPS.";
                return false;
            } catch (IllegalArgumentException e) {
                // This provider does not exist on this device. Others may.
            }
        }
        if (providers.isEmpty()) {
            status = "The OS accepted no test provider on this device.";
            return false;
        }
        return true;
    }

    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            if (!running) return;

            if (holding) {
                // Keep re-injecting rather than setting it once. A test
                // provider's last fix goes stale, and Roamkeep's foreground
                // service asks for a fresh one every couple of seconds —
                // one shot would let the real GPS answer the next request.
                injectPoint(holdLat, holdLng, 0, 0);
                selfCheck(holdLat, holdLng);
                status = String.format("Holding %.5f, %.5f", holdLat, holdLng) + warning;
                notifyAgain();
                handler.postDelayed(this, TICK_MS);
                return;
            }

            double elapsed = (SystemClock.elapsedRealtime() - startedAt) / 1000.0;
            double travelled = elapsed * speedMs;
            double total = route.lengthM();

            if (loop) {
                // Bounce: out and back, forever. Simpler than restarting at
                // the origin, and it never teleports — a jump from the end
                // back to the start would register as an impossible speed.
                double cycle = total * 2;
                double m = travelled % cycle;
                travelled = m <= total ? m : cycle - m;
            } else if (travelled >= total) {
                // Park at the destination rather than stopping. Stopping
                // tears down the test providers, and the device instantly
                // reverts to reporting where it really is — which lands the
                // author's actual position in the demo database and, on
                // camera, teleports the pin home at the end of the take.
                holding = true;
                holdLat = route.lat[route.size() - 1];
                holdLng = route.lng[route.size() - 1];
                progressM = total;
                injectPoint(holdLat, holdLng, 0, 0);
                status = String.format("Arrived — holding %.5f, %.5f", holdLat, holdLng) + warning;
                notifyAgain();
                handler.postDelayed(this, TICK_MS);
                return;
            }

            inject(travelled);
            progressM = travelled;
            selfCheck(lastLat, lastLng);
            status = String.format("Playing — %.0f%% of %.2f km at %.0f km/h",
                    (travelled / total) * 100, total / 1000, speedMs * 3.6) + warning;
            notifyAgain();
            handler.postDelayed(this, TICK_MS);
        }
    };

    private void inject(double metres) {
        double[] p = route.at(metres);
        injectPoint(p[0], p[1], (float) p[2], (float) speedMs);
    }

    /**
     * Put Play Services' fused provider into mock mode.
     *
     * Without this, everything else in this class is writing to a system the
     * app under test does not read. setMockMode needs the same Developer
     * options appop as addTestProvider, so if the test providers registered,
     * this normally succeeds too.
     */
    private void enableFusedMockMode() {
        if (fusedMocked) return;
        try {
            fused = LocationServices.getFusedLocationProviderClient(this);
            fused.setMockMode(true)
                    .addOnSuccessListener(v -> fusedMocked = true)
                    .addOnFailureListener(e -> {
                        fusedMocked = false;
                        warning = "  ⚠ fused mock mode refused (" + e.getMessage() + ")";
                    });
        } catch (Throwable t) {
            // No Play Services on this device: the LocationManager providers
            // are all there is, and an app reading the fused client will not
            // see the mock. Say so rather than looking like it worked.
            fusedMocked = false;
            warning = "  ⚠ Play Services unavailable — fused clients will see real GPS";
        }
    }

    /**
     * Ask the FUSED client what it thinks the location is, and complain if it
     * is not what we just told it.
     *
     * The first version of this check asked LocationManager for the last
     * known location of a provider it had just written to — so it read back
     * its own injection and could never detect the failure it was written
     * for. The fused client is the one that was serving real fixes, so it is
     * the one worth interrogating.
     */
    private void selfCheck(double lat, double lng) {
        long ms = SystemClock.elapsedRealtime();
        if (ms - lastCheckMs < 5000) return;
        lastCheckMs = ms;
        if (fused == null) return;
        try {
            fused.getLastLocation().addOnSuccessListener(l -> {
                if (l == null) return;
                double d = Route.distance(lat, lng, l.getLatitude(), l.getLongitude());
                warning = d > 150
                        ? "  ⚠ fused reports " + Math.round(d) + " m away — real fixes are getting through"
                        : "";
            });
        } catch (SecurityException e) {
            warning = "";   // no runtime location permission — cannot check
        } catch (Throwable ignored) { }
    }

    /** Fill in every field a consumer might read. An "incomplete" Location
     *  is rejected outright on newer releases. */
    private Location build(String provider, double lat, double lng, float bearing, float speed) {
        Location l = new Location(provider);
        l.setLatitude(lat);
        l.setLongitude(lng);
        l.setBearing(bearing);
        // A held position reports speed 0, which is what keeps Roamkeep's
        // movement detector in its "still" profile instead of treating a
        // parked device as travelling.
        l.setSpeed(speed);
        l.setAltitude(30);
        l.setAccuracy(5f);
        l.setTime(System.currentTimeMillis());
        l.setElapsedRealtimeNanos(SystemClock.elapsedRealtimeNanos());
        if (Build.VERSION.SDK_INT >= 26) {
            l.setBearingAccuracyDegrees(1f);
            l.setSpeedAccuracyMetersPerSecond(0.5f);
            l.setVerticalAccuracyMeters(3f);
        }
        return l;
    }

    private void injectPoint(double lat, double lng, float bearing, float speed) {
        lastLat = lat;
        lastLng = lng;

        // The fused client FIRST, because it is the one the app under test
        // actually reads. The LocationManager providers below are kept for
        // consumers that read them directly, but on their own they were not
        // enough — that is what produced the real/mock alternation.
        if (fused != null && fusedMocked) {
            try {
                fused.setMockLocation(build(LocationManager.GPS_PROVIDER, lat, lng, bearing, speed));
            } catch (SecurityException e) {
                fusedMocked = false;
                warning = "  ⚠ fused rejected the mock location — is this still the selected mock app?";
            } catch (Throwable ignored) { }
        }

        for (String provider : providers) {
            try {
                // A fresh Location per provider: the provider name is part of
                // the object and setTestProviderLocation validates it.
                lm.setTestProviderLocation(provider, build(provider, lat, lng, bearing, speed));
            } catch (SecurityException | IllegalArgumentException e) {
                // A provider that stops accepting mid-run should not take the
                // rest of them down with it.
            }
        }
    }

    private Notification notification() {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null && nm.getNotificationChannel(CHANNEL_ID) == null) {
                nm.createNotificationChannel(new NotificationChannel(
                        CHANNEL_ID, "Mock location", NotificationManager.IMPORTANCE_LOW));
            }
        }
        Intent stop = new Intent(this, MockService.class).setAction(ACTION_STOP);
        PendingIntent pi = PendingIntent.getService(this, 0, stop,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Notification.Builder b = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);
        // "fused" first and named explicitly: it is the one that decides
        // whether the app under test sees the mock at all, and its absence is
        // the difference between a working take and a bouncing pin.
        StringBuilder names = new StringBuilder(fusedMocked ? "fused✓" : "fused✗");
        for (String p : providers) names.append(", ").append(p);
        return b.setContentTitle("Mocking location")
                .setContentText(status + "  ·  " + names)
                .setSmallIcon(android.R.drawable.ic_menu_mylocation)
                .setOngoing(true)
                .addAction(android.R.drawable.ic_delete, "Stop", pi)
                .build();
    }

    /** Throttled to ~1 Hz. Injection runs at 4 Hz and the notification does
     *  not need to keep up with it — redrawing it that fast is pure cost. */
    private void notifyAgain() {
        long ms = SystemClock.elapsedRealtime();
        if (ms - lastNotifyMs < 1000) return;
        lastNotifyMs = ms;
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.notify(NOTIF_ID, notification());
    }

    @Override
    public void onDestroy() {
        running = false;
        handler.removeCallbacks(tick);
        // Leaving test providers registered would leave the device lying
        // about where it is after the app is closed. Always unwind.
        for (String p : providers) {
            try { lm.setTestProviderEnabled(p, false); } catch (Exception ignored) { }
            try { lm.removeTestProvider(p); } catch (Exception ignored) { }
        }
        providers.clear();
        // Leaving the fused client in mock mode would leave every app on the
        // phone reading a frozen position until something reset it.
        if (fused != null && fusedMocked) {
            try { fused.setMockMode(false); } catch (Throwable ignored) { }
        }
        fusedMocked = false;
        if (status.startsWith("Playing") || status.startsWith("Holding") || status.startsWith("Arrived")) {
            status = "Stopped — the device is reporting its real location again";
        }
        super.onDestroy();
    }
}
