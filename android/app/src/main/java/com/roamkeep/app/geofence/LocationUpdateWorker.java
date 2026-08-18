package com.roamkeep.app.geofence;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.location.Location;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.core.content.ContextCompat;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import com.google.android.gms.location.LocationServices;
import com.google.android.gms.tasks.Tasks;

import org.json.JSONException;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;
import java.util.concurrent.TimeUnit;

/**
 * Keeps keep_members.lat/lng moving while the app process is not
 * running — most importantly the window between device reboot and the
 * user opening the app. The geofence receiver already wakes for
 * boundary crossings independently of any service, so check-ins keep
 * working post-boot; but the live map pin would freeze at the
 * pre-reboot position until the user opened the app and let the
 * BackgroundGeolocation foreground service spin up again.
 *
 * Lifecycle:
 *   - BootReceiver enqueues a 15-minute periodic WorkRequest (the
 *     minimum WorkManager allows). Constraint: network connected.
 *   - MainActivity.onCreate cancels the work — the BG-geolocation
 *     plugin's continuous tracking takes over once the app is open,
 *     and we don't want two location-pushing systems racing.
 *
 * Why WorkManager rather than another foreground service:
 *   - No extra persistent notification.
 *   - System batches with other deferrable work for battery efficiency.
 *   - Survives reboot natively (with ExistingPeriodicWorkPolicy.KEEP).
 *
 * Trade-off: granularity is 15 minutes — coarser than the BG-geo
 * plugin's seconds-level fixes. Good enough for "post-reboot, before
 * the user opens the app" which is the only window this targets.
 */
public class LocationUpdateWorker extends Worker {
    private static final String TAG = "RoamkeepGeo";

    public LocationUpdateWorker(@NonNull Context ctx, @NonNull WorkerParameters params) {
        super(ctx, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context ctx = getApplicationContext();
        PrefsStore prefs = new PrefsStore(ctx);
        if (!prefs.hasContext()) {
            // Not signed in — nothing to push. Don't fail (would
            // trigger exponential backoff); just succeed-noop.
            return Result.success();
        }
        if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.ACCESS_FINE_LOCATION)
                != PackageManager.PERMISSION_GRANTED) {
            return Result.success();
        }

        try {
            Location loc = Tasks.await(
                    LocationServices.getFusedLocationProviderClient(ctx).getLastLocation(),
                    10, TimeUnit.SECONDS);
            if (loc == null) {
                // No cached fix available. Retry — WorkManager applies
                // exponential backoff so we don't spin.
                return Result.retry();
            }

            SupabaseRest rest = new SupabaseRest(ctx);
            JSONObject upd = new JSONObject();
            upd.put("lat", loc.getLatitude());
            upd.put("lng", loc.getLongitude());
            upd.put("last_seen", toIso8601Utc(loc.getTime()));
            upd.put("online", true);
            boolean ok = rest.updateMember(prefs.getMemberId(), upd);
            if (!ok) {
                Log.w(TAG, "boot-poll updateMember failed");
                return Result.retry();
            }
            return Result.success();
        } catch (SecurityException e) {
            Log.w(TAG, "boot-poll missing FINE_LOCATION", e);
            return Result.success();
        } catch (JSONException e) {
            Log.w(TAG, "boot-poll payload build failed", e);
            return Result.success();
        } catch (Exception e) {
            // Tasks.await throws TimeoutException / InterruptedException
            // / ExecutionException. Any of those means "not now" and
            // we want WorkManager to retry on its backoff schedule.
            Log.w(TAG, "boot-poll error", e);
            return Result.retry();
        }
    }

    private static String toIso8601Utc(long ms) {
        SimpleDateFormat fmt = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        fmt.setTimeZone(TimeZone.getTimeZone("UTC"));
        return fmt.format(new Date(ms));
    }
}
