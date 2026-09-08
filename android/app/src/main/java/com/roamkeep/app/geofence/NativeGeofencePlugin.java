package com.roamkeep.app.geofence;

import android.app.ActivityManager;
import android.app.ApplicationExitInfo;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.PowerManager;
import android.util.Log;

import android.Manifest;
import android.net.Uri;
import android.provider.Settings;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.google.android.gms.common.ConnectionResult;
import com.google.android.gms.common.GoogleApiAvailability;
import com.google.android.gms.location.Geofence;
import com.google.android.gms.location.GeofencingClient;
import com.google.android.gms.location.GeofencingRequest;
import com.google.android.gms.location.LocationRequest;
import com.google.android.gms.location.LocationServices;
import com.google.android.gms.location.Priority;

import com.getcapacitor.JSArray;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Capacitor plugin exposing native OS-level geofencing to the JS
 * app. This replaces the JS-polling approach that was unreliable
 * when the WebView was paused in the background — ENTER/EXIT
 * callbacks now go through Google Play Services' GeofencingClient,
 * which delivers broadcast intents to our GeofenceReceiver even
 * when the app process is dead.
 *
 * JS contract:
 *   Roamkeep.NativeGeofence.isAvailable()                 → { available }
 *   Roamkeep.NativeGeofence.initialize({ supabaseUrl, anonKey,
 *       accessToken, refreshToken, userId, keepId, memberId,
 *       memberName, memberAvatar })                         → persist auth ctx
 *   Roamkeep.NativeGeofence.setTokens({ accessToken, refreshToken })
 *   Roamkeep.NativeGeofence.addGeofence({ id, name, icon, lat, lng, radius })
 *   Roamkeep.NativeGeofence.removeGeofence({ id })
 *   Roamkeep.NativeGeofence.clearAll()
 *   Roamkeep.NativeGeofence.flushPending()        → drain queued retries
 *   Roamkeep.NativeGeofence.startLocationUpdates({ mode })  → breadcrumbs
 *   Roamkeep.NativeGeofence.stopLocationUpdates()
 *   Roamkeep.NativeGeofence.setPaused({ pausedUntil })  → adult self-pause
 *   Roamkeep.NativeGeofence.getReliabilityStatus()  → diagnostics
 */
@CapacitorPlugin(
        name = "NativeGeofence",
        permissions = {
                @Permission(
                        alias = NativeGeofencePlugin.BG_LOCATION,
                        strings = { Manifest.permission.ACCESS_BACKGROUND_LOCATION })
        })
public class NativeGeofencePlugin extends Plugin {

    static final String BG_LOCATION = "backgroundLocation";
    private static final String TAG = "RoamkeepGeo";
    private static final int PI_REQUEST_CODE = 0;
    private static final int LOC_PI_REQUEST_CODE = 1;

    private GeofencingClient client() {
        return LocationServices.getGeofencingClient(getContext().getApplicationContext());
    }

    private PendingIntent pendingIntent() {
        Intent intent = new Intent(getContext().getApplicationContext(), GeofenceReceiver.class);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE;
        return PendingIntent.getBroadcast(getContext().getApplicationContext(),
                PI_REQUEST_CODE, intent, flags);
    }

    private boolean haveFineLocation() {
        return ContextCompat.checkSelfPermission(getContext(),
                android.Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    /** Below API 29 there is no separate background permission — fine
     *  location covers it. */
    private boolean haveBackgroundLocation() {
        return Build.VERSION.SDK_INT < 29 || ContextCompat.checkSelfPermission(getContext(),
                Manifest.permission.ACCESS_BACKGROUND_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    /**
     * Ask for "Allow all the time".
     *
     * THIS IS WHAT MAKES GEOFENCING WORK WITH THE APP CLOSED. Play
     * Services happily *accepts* a geofence registration when the app only
     * holds foreground location — it just never delivers the transitions
     * unless the app happens to be open. So arrived/left silently did
     * nothing on devices that were only granted "While using the app",
     * while breadcrumbs kept working (the foreground service is allowed
     * under while-using). It looked like a geofence bug; it was a
     * permission gap.
     *
     * Must be requested on its own, after fine location is already
     * granted — Android rejects a combined request. On API 30+ the system
     * may decline to show a dialog at all, in which case the caller falls
     * back to openAppSettings().
     */
    @PluginMethod
    public void requestBackgroundLocation(PluginCall call) {
        JSObject res = new JSObject();
        if (haveBackgroundLocation()) {
            res.put("status", "granted");
            call.resolve(res);
            return;
        }
        if (!haveFineLocation()) {
            // Requesting background before foreground is an automatic deny.
            res.put("status", "needsForeground");
            call.resolve(res);
            return;
        }
        requestPermissionForAlias(BG_LOCATION, call, "backgroundLocationResult");
    }

    @PermissionCallback
    private void backgroundLocationResult(PluginCall call) {
        boolean granted = haveBackgroundLocation();
        if (granted) reArmFences("background-permission-granted");
        JSObject res = new JSObject();
        res.put("status", granted ? "granted" : "denied");
        call.resolve(res);
    }

    /**
     * Re-register every stored place.
     *
     * Fences registered while the app held foreground-only permission stay
     * inert even after "Allow all the time" is later granted — which is
     * why a reboot appeared to "fix" affected devices: BootReceiver
     * re-registered them from scratch. JS calls this after any grant (or
     * after returning from the settings screen, where no permission
     * callback fires) so a reboot is never needed.
     */
    @PluginMethod
    public void reArmGeofences(PluginCall call) {
        JSObject res = new JSObject();
        if (!haveFineLocation()) {
            res.put("armed", false);
            res.put("reason", "no-fine-location");
            call.resolve(res);
            return;
        }
        int n = reArmFences("js-request");
        res.put("armed", true);
        res.put("count", n);
        res.put("backgroundLocation", haveBackgroundLocation());
        call.resolve(res);
    }

    /** Shared re-registration. Returns how many places were re-seeded. */
    private int reArmFences(String why) {
        PrefsStore prefs = new PrefsStore(getContext());
        int n = prefs.getPlaces().size();
        if (n == 0) return 0;
        BootReceiver.reRegisterGeofences(getContext().getApplicationContext(), prefs, why);
        return n;
    }

    /** Deep-link to this app's system settings page. The reliable path to
     *  "Allow all the time" on API 30+, where the runtime dialog no longer
     *  offers it. */
    @PluginMethod
    public void openAppSettings(PluginCall call) {
        try {
            Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
            i.setData(Uri.fromParts("package", getContext().getPackageName(), null));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject("Could not open app settings", e);
        }
    }

    /**
     * Ask to be exempted from battery optimisation. Without this, Doze
     * suspends the foreground service and (per the earlier Doze
     * investigation) can turn GPS off device-wide, stalling both
     * breadcrumbs and geofence delivery on an idle phone.
     */
    @PluginMethod
    public void requestIgnoreBatteryOptimizations(PluginCall call) {
        JSObject res = new JSObject();
        String pkg = getContext().getPackageName();
        PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        if (pm != null && pm.isIgnoringBatteryOptimizations(pkg)) {
            res.put("status", "granted");
            call.resolve(res);
            return;
        }
        try {
            Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
            i.setData(Uri.parse("package:" + pkg));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            res.put("status", "prompted");
            call.resolve(res);
        } catch (Exception e) {
            // Some OEMs block the direct request; fall back to the list.
            try {
                Intent i = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(i);
                res.put("status", "prompted");
                call.resolve(res);
            } catch (Exception e2) {
                call.reject("Could not open battery settings", e2);
            }
        }
    }

    @PluginMethod
    public void isAvailable(PluginCall call) {
        int status = GoogleApiAvailability.getInstance()
                .isGooglePlayServicesAvailable(getContext());
        JSObject res = new JSObject();
        res.put("available", status == ConnectionResult.SUCCESS);
        res.put("playServicesStatus", status);
        call.resolve(res);
    }

    /**
     * Self-diagnosis for the breadcrumb pipeline. Reports the permission /
     * power state that governs whether native location updates can run in
     * the background, plus the receiver's last-fire stamp and counters so
     * we can see whether it's actually firing on this device.
     */
    @PluginMethod
    public void getReliabilityStatus(PluginCall call) {
        Context ctx = getContext();
        boolean fine = ContextCompat.checkSelfPermission(ctx,
                android.Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
        boolean background = Build.VERSION.SDK_INT < 29 || ContextCompat.checkSelfPermission(ctx,
                android.Manifest.permission.ACCESS_BACKGROUND_LOCATION) == PackageManager.PERMISSION_GRANTED;
        boolean notifications = Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(ctx,
                android.Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;

        boolean ignoringBattery = true;
        PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
        if (pm != null) ignoringBattery = pm.isIgnoringBatteryOptimizations(ctx.getPackageName());

        boolean autoRevokeWhitelisted = true;
        if (Build.VERSION.SDK_INT >= 30) {
            try {
                autoRevokeWhitelisted = ctx.getPackageManager().isAutoRevokeWhitelisted();
            } catch (Throwable ignored) {}
        }

        PrefsStore prefs = new PrefsStore(ctx);
        JSObject res = new JSObject();
        res.put("fineLocation", fine);
        res.put("backgroundLocation", background);
        res.put("notifications", notifications);
        res.put("ignoringBatteryOptimizations", ignoringBattery);
        res.put("autoRevokeWhitelisted", autoRevokeWhitelisted);
        res.put("trackMode", prefs.getTrackMode());
        res.put("serviceRunning", LocationForegroundService.running);
        res.put("lastLocationFireMs", prefs.getLastLocationFire());
        res.put("locationFireCount", prefs.getLocationFireCount());
        res.put("breadcrumbCount", prefs.getBreadcrumbCount());
        res.put("suppressedCount", prefs.getSuppressedCount());
        res.put("rejectedCount", prefs.getRejectedCount());
        call.resolve(res);
    }

    /**
     * The black-box journal + the OS's record of why our process last
     * died (ApplicationExitInfo, Android 11+). Together they answer
     * "what was the tracking pipeline doing while nobody was looking"
     * from the phone screen — the doze-stall investigation needed a USB
     * cable and a still-unrotated logcat buffer to establish the same
     * facts.
     */
    @PluginMethod
    public void getJournal(PluginCall call) {
        PrefsStore prefs = new PrefsStore(getContext());
        JSObject res = new JSObject();
        try {
            res.put("entries", new JSONArray(prefs.getJournalRaw()));
        } catch (JSONException e) {
            res.put("entries", new JSONArray());
        }

        JSONArray exits = new JSONArray();
        if (Build.VERSION.SDK_INT >= 30) {
            try {
                ActivityManager am = (ActivityManager) getContext().getSystemService(Context.ACTIVITY_SERVICE);
                String pkg = getContext().getPackageName();
                List<ApplicationExitInfo> infos = am.getHistoricalProcessExitReasons(pkg, 0, 15);
                for (ApplicationExitInfo info : infos) {
                    // Skip the sandboxed WebView renderer processes — only the
                    // main process hosts the tracking pipeline.
                    if (!pkg.equals(info.getProcessName())) continue;
                    JSONObject o = new JSONObject();
                    o.put("t", info.getTimestamp());
                    o.put("reason", exitReasonName(info.getReason()));
                    String desc = info.getDescription();
                    if (desc != null && !desc.isEmpty()) o.put("desc", desc);
                    exits.put(o);
                }
            } catch (Exception e) {
                Log.w(TAG, "getHistoricalProcessExitReasons failed", e);
            }
        }
        res.put("exits", exits);
        call.resolve(res);
    }

    private static String exitReasonName(int reason) {
        switch (reason) {
            case ApplicationExitInfo.REASON_EXIT_SELF:                return "exited itself";
            case ApplicationExitInfo.REASON_SIGNALED:                 return "killed by signal";
            case ApplicationExitInfo.REASON_LOW_MEMORY:               return "low memory";
            case ApplicationExitInfo.REASON_CRASH:                    return "crash";
            case ApplicationExitInfo.REASON_CRASH_NATIVE:             return "native crash";
            case ApplicationExitInfo.REASON_ANR:                      return "ANR";
            case ApplicationExitInfo.REASON_INITIALIZATION_FAILURE:   return "init failure";
            case ApplicationExitInfo.REASON_PERMISSION_CHANGE:        return "permission change";
            case ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE: return "excessive resource use";
            case ApplicationExitInfo.REASON_USER_REQUESTED:           return "force stopped by user";
            case ApplicationExitInfo.REASON_USER_STOPPED:             return "user stopped";
            case ApplicationExitInfo.REASON_DEPENDENCY_DIED:          return "dependency died";
            case ApplicationExitInfo.REASON_OTHER:                    return "killed by system";
            case ApplicationExitInfo.REASON_FREEZER:                  return "freezer";
            case ApplicationExitInfo.REASON_PACKAGE_STATE_CHANGE:     return "package state change";
            case ApplicationExitInfo.REASON_PACKAGE_UPDATED:          return "package updated";
            default:                                                  return "unknown (" + reason + ")";
        }
    }

    @PluginMethod
    public void initialize(PluginCall call) {
        String supabaseUrl  = call.getString("supabaseUrl");
        String anonKey      = call.getString("anonKey");
        String accessToken  = call.getString("accessToken");
        String refreshToken = call.getString("refreshToken");
        String userId       = call.getString("userId");
        String keepId       = call.getString("keepId");
        String memberId     = call.getString("memberId");
        String memberName   = call.getString("memberName", "Someone");
        String memberAvatar = call.getString("memberAvatar", "📍");

        if (supabaseUrl == null || anonKey == null || accessToken == null
                || keepId == null || memberId == null) {
            call.reject("Missing required context field");
            return;
        }

        PrefsStore prefs = new PrefsStore(getContext());
        prefs.setContext(supabaseUrl, anonKey, userId, keepId, memberId, memberName, memberAvatar);
        prefs.setTokens(accessToken, refreshToken);

        // Seed the receiver's "currently inside" set from what JS
        // knows. Merge rather than overwrite so any unmatched ENTERs
        // the receiver captured while the app was closed survive
        // — JS only tracks last_place_id (single value), which would
        // otherwise narrow a multi-place state down to one.
        JSArray insideArr = call.getArray("insidePlaceIds");
        if (insideArr != null) {
            List<String> seed = new ArrayList<>();
            for (int i = 0; i < insideArr.length(); i++) {
                String id = insideArr.optString(i, null);
                if (id != null && !id.isEmpty()) seed.add(id);
            }
            prefs.mergeInsidePlaceIds(seed);
        }

        // Journal anchor: everything between two of these happened with
        // the app closed — the exact window earlier anomalies hid in.
        prefs.journal("app: opened + initialized");

        call.resolve();
    }

    @PluginMethod
    public void setTokens(PluginCall call) {
        String accessToken  = call.getString("accessToken");
        String refreshToken = call.getString("refreshToken");
        if (accessToken == null) {
            call.reject("accessToken required");
            return;
        }
        new PrefsStore(getContext()).setTokens(accessToken, refreshToken);
        call.resolve();
    }

    @PluginMethod
    public void addGeofence(PluginCall call) {
        String id     = call.getString("id");
        String name   = call.getString("name");
        String icon   = call.getString("icon", "📍");
        Double lat    = call.getDouble("lat");
        Double lng    = call.getDouble("lng");
        Double radius = call.getDouble("radius");

        if (id == null || name == null || lat == null || lng == null || radius == null) {
            call.reject("Missing required field (id, name, lat, lng, radius)");
            return;
        }
        // Persist the place metadata FIRST, before any permission check.
        //
        // This used to sit below the fine-location guard, which meant a
        // first run (where JS arms geofences before the permission prompt
        // has been answered) stored nothing at all — leaving PrefsStore
        // empty, so the later re-arm paths, which both bail on an empty
        // place list, silently did nothing and the device never fired a
        // single check-in until the app was opened a second time.
        // Storing metadata is harmless without permission and is exactly
        // what lets reArmGeofences() and BootReceiver recover later.
        PrefsStore prefs = new PrefsStore(getContext());
        PrefsStore.Place place = new PrefsStore.Place(
                id, name, icon, lat, lng, radius.floatValue());
        prefs.putPlace(place);

        if (!haveFineLocation()) {
            prefs.journal("geo: '" + name + "' stored but NOT armed (no location permission yet)");
            call.reject("ACCESS_FINE_LOCATION not granted");
            return;
        }
        // Registering without background permission succeeds but the fence
        // only ever fires while the app is open.
        if (!haveBackgroundLocation()) {
            Log.w(TAG, "addGeofence " + id + ": no ACCESS_BACKGROUND_LOCATION — "
                    + "transitions will only fire while the app is open");
        }

        Geofence fence = new Geofence.Builder()
                .setRequestId(id)
                .setCircularRegion(lat, lng, radius.floatValue())
                .setExpirationDuration(Geofence.NEVER_EXPIRE)
                .setTransitionTypes(Geofence.GEOFENCE_TRANSITION_ENTER | Geofence.GEOFENCE_TRANSITION_EXIT)
                .build();
        GeofencingRequest req = new GeofencingRequest.Builder()
                .setInitialTrigger(0)
                .addGeofences(Collections.singletonList(fence))
                .build();

        try {
            final boolean bg = haveBackgroundLocation();
            client().addGeofences(req, pendingIntent())
                    .addOnSuccessListener(unused -> {
                        // Journal the ARM, not just the transition. Without
                        // this there was no way to tell "never registered"
                        // apart from "registered but never fired" — the
                        // difference between an arming bug and a GPS one.
                        prefs.journal("geo: armed '" + name + "'"
                                + (bg ? "" : " (foreground only — no background permission)"));
                        call.resolve();
                    })
                    .addOnFailureListener(e -> {
                        Log.w(TAG, "addGeofence failed " + id, e);
                        prefs.journal("geo: ARM FAILED '" + name + "' — " + e.getMessage());
                        call.reject(e.getMessage(), e);
                    });
        } catch (SecurityException e) {
            call.reject(e.getMessage(), e);
        }
    }

    /**
     * Register every place in one shot.
     *
     * The JS side used to loop addGeofence per place, which meant N bridge
     * round-trips, N separate registrations and — once arming was
     * journalled — N journal lines per arm. With several arm triggers per
     * app open (launch, resume reconcile, a setup-sheet grant) that buried
     * the rest of the journal. One call, one registration, one line.
     */
    @PluginMethod
    public void armPlaces(PluginCall call) {
        JSArray arr = call.getArray("places");
        if (arr == null) { call.reject("places array required"); return; }

        // Parse here; arm in GeofenceArmer. The arming logic moved out so
        // that BootReceiver and RoamkeepMessagingService — neither of
        // which has a Capacitor bridge — can run the identical
        // arm-and-prune. This method is now just the bridge adapter.
        List<PrefsStore.Place> places = new ArrayList<>();
        try {
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.getJSONObject(i);
                String id   = o.optString("id", null);
                String name = o.optString("name", null);
                if (id == null || name == null) continue;
                places.add(new PrefsStore.Place(
                        id, name, o.optString("icon", "📍"),
                        o.optDouble("lat"), o.optDouble("lng"),
                        (float) o.optDouble("radius", 100)));
            }
        } catch (JSONException e) {
            call.reject("bad places payload", e);
            return;
        }

        GeofenceArmer.Result r = GeofenceArmer.arm(getContext(), places, "app");
        // Record what we just armed so a headless reconcile can tell
        // whether anything actually changed since.
        new PrefsStore(getContext()).setPlacesSignature(GeofenceArmer.signature(places));

        JSObject res = new JSObject();
        res.put("armed", r.armed);
        res.put("stored", r.stored);
        res.put("pruned", r.pruned);
        call.resolve(res);
    }

    @PluginMethod
    public void removeGeofence(PluginCall call) {
        String id = call.getString("id");
        if (id == null) { call.reject("id required"); return; }

        new PrefsStore(getContext()).removePlace(id);
        client().removeGeofences(Collections.singletonList(id))
                .addOnSuccessListener(unused -> call.resolve())
                .addOnFailureListener(e -> {
                    Log.w(TAG, "removeGeofence failed " + id, e);
                    // Still resolve — the entry is gone from prefs either way,
                    // and the OS may simply not have had it registered.
                    call.resolve();
                });
    }

    @PluginMethod
    public void clearAll(PluginCall call) {
        PrefsStore prefs = new PrefsStore(getContext());
        prefs.clearAll();
        client().removeGeofences(pendingIntent())
                .addOnSuccessListener(unused -> call.resolve())
                .addOnFailureListener(e -> {
                    Log.w(TAG, "clearAll removeGeofences failed", e);
                    call.resolve();
                });
    }

    /**
     * Drain any check-in payloads that the receiver couldn't deliver
     * earlier (transient network failure at the moment of crossing).
     * Called by the JS side on app launch and on resume — those are
     * the moments we know the network is up and the user is likely
     * watching for the activity feed to populate.
     *
     * Runs the HTTP work on a worker thread so the call doesn't block
     * the WebView. Resolves with { drained, remaining } so the JS can
     * surface a toast if it wants to.
     */
    @PluginMethod
    public void flushPending(PluginCall call) {
        new Thread(() -> {
            PrefsStore prefs = new PrefsStore(getContext());
            if (!prefs.hasContext()) {
                JSObject res = new JSObject();
                res.put("drained", 0);
                res.put("remaining", prefs.pendingCount());
                call.resolve(res);
                return;
            }
            SupabaseRest rest = new SupabaseRest(getContext());
            int drained = GeofenceReceiver.drainPendingCheckins(prefs, rest);
            JSObject res = new JSObject();
            res.put("drained", drained);
            res.put("remaining", prefs.pendingCount());
            call.resolve(res);
        }, "RoamkeepFlushPending").start();
    }

    // ── Native breadcrumb logging (FusedLocationProvider) ───────────
    //
    // Process-independent location updates delivered to
    // LocationUpdateReceiver via a PendingIntent — these keep recording a
    // detailed trail even while the WebView (and the JS breadcrumb path)
    // is suspended in the background. The OS distance-gates via
    // setMinUpdateDistanceMeters, so a point lands every N metres walked.

    @PluginMethod
    public void startLocationUpdates(PluginCall call) {
        String mode = call.getString("mode", "auto");
        if (!haveFineLocation()) {
            call.reject("ACCESS_FINE_LOCATION not granted");
            return;
        }
        PrefsStore prefs = new PrefsStore(getContext());
        prefs.setTrackMode(mode);
        // Respect an active self-pause: a stray arm request (resume
        // self-heal, geofence kick, boot) must not restart tracking while
        // paused. The auto-resume path clears the flag first, then re-arms.
        if (prefs.isPaused()) {
            prefs.journal("startLocationUpdates: skipped (paused)");
            call.resolve();
            return;
        }
        // Start the foreground service — it holds the live location
        // callback (the durable, faithful path) and keeps the app out of
        // the App Standby throttle. onStartCommand re-applies the request,
        // so calling this on every launch / mode change is safe.
        LocationForegroundService.start(getContext(), "app");
        call.resolve();
    }

    /**
     * Apply / clear an adult self-pause. pausedUntil is an epoch-ms instant
     * (0 or in the past = not paused). When pausing we tear down tracking
     * WITHOUT wiping stored context/places (unlike clearAll), so resume can
     * re-arm from prefs: stop the foreground service, disarm location, and
     * unregister the OS geofences (their metadata stays in prefs for
     * re-registration). The persisted flag is what boot / the service /
     * the receivers consult to stay dark until it elapses.
     */
    @PluginMethod
    public void setPaused(PluginCall call) {
        // pausedUntil is a 64-bit epoch-ms value, passed as a STRING. It used
        // to be sent as a JS number, but a value that large arrives over the
        // bridge as a type getDouble reads back as its default (0) — so a
        // real "pause until 6pm" became "pause until 0" (the past), silently
        // taking the cleared branch and leaving background tracking running.
        // Parse the string; fall back to getDouble for any older JS bundle.
        long until = 0;
        String s = call.getString("pausedUntil", null);
        if (s != null) {
            try { until = Long.parseLong(s.trim()); } catch (NumberFormatException ignored) {}
        } else {
            Double d = call.getDouble("pausedUntil", 0.0);
            if (d != null) until = d.longValue();
        }

        PrefsStore prefs = new PrefsStore(getContext());
        prefs.setPausedUntil(until);
        if (until > System.currentTimeMillis()) {
            prefs.journal("pause: on until " + until);
            LocationForegroundService.stop(getContext());
            disarmLocationUpdates(getContext().getApplicationContext());
            try {
                client().removeGeofences(pendingIntent());
            } catch (Exception ignored) {}
            // isPaused() expires on its own, but expiry alone does not
            // restart anything — the service was stopped and the fences
            // removed. Without this alarm the pipeline stayed dead from the
            // expiry instant until the app next happened to be opened
            // (observed: a 6pm pause left tracking off until 9:42pm).
            PauseExpiryReceiver.schedule(getContext().getApplicationContext(), until);
        } else {
            prefs.journal("pause: cleared");
            PauseExpiryReceiver.cancel(getContext().getApplicationContext());
        }
        call.resolve();
    }


    @PluginMethod
    public void stopLocationUpdates(PluginCall call) {
        LocationForegroundService.stop(getContext());
        disarmLocationUpdates(getContext().getApplicationContext());
        call.resolve();
    }

    /** PendingIntent that FusedLocationProvider fires location batches at.
     *  Distinct request code from the geofence PI so they don't collide. */
    static PendingIntent locationPendingIntent(Context ctx) {
        Intent intent = new Intent(ctx, LocationUpdateReceiver.class);
        intent.setAction(LocationUpdateReceiver.ACTION);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE;
        return PendingIntent.getBroadcast(ctx, LOC_PI_REQUEST_CODE, intent, flags);
    }

    /** Build the LocationRequest for a mode.
     *
     *  live/balanced/saver are fixed (the user's explicit override). Only
     *  'auto' adapts, and it adapts to REAL GPS MOVEMENT (decided by the
     *  service), never the activity sensor — which proved unreliable and
     *  got Auto stuck both ways (stranded "Still" on car trips, stuck
     *  "Walking" burning battery at home). Moving → dense HIGH_ACCURACY;
     *  Still → low-power, but still sampling ~every 30 s so the service
     *  notices movement resuming. Density comes from the DISTANCE gate with
     *  a small min-interval, so it stays dense even at speed. */
    static LocationRequest requestFor(String mode, boolean moving) {
        int priority = Priority.PRIORITY_HIGH_ACCURACY;
        long intervalMs, minIntervalMs;
        float distanceMeters;
        switch (mode == null ? "auto" : mode) {
            case "live":
                intervalMs = 2_000;  minIntervalMs = 1_000;  distanceMeters = 8;  break;
            case "saver":
                priority = Priority.PRIORITY_BALANCED_POWER_ACCURACY;
                intervalMs = 60_000; minIntervalMs = 20_000; distanceMeters = 50; break;
            case "balanced":
                intervalMs = 6_000;  minIntervalMs = 2_000;  distanceMeters = 20; break;
            case "auto":
            default:
                if (moving) {
                    intervalMs = 4_000;  minIntervalMs = 1_000;  distanceMeters = 15;
                } else {
                    priority = Priority.PRIORITY_BALANCED_POWER_ACCURACY;
                    intervalMs = 30_000; minIntervalMs = 20_000; distanceMeters = 30;
                }
                break;
        }
        return new LocationRequest.Builder(priority, intervalMs)
                .setMinUpdateIntervalMillis(minIntervalMs)
                .setMinUpdateDistanceMeters(distanceMeters)
                .build();
    }

    /** Cancel any legacy PendingIntent-based location request. The
     *  LocationForegroundService calls this on start so a request left over
     *  from an older app version can't double-deliver alongside the live
     *  callback. */
    static void disarmLocationUpdates(Context ctx) {
        LocationServices.getFusedLocationProviderClient(ctx)
                .removeLocationUpdates(locationPendingIntent(ctx));
    }
}
