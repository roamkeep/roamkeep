package com.roamkeep.mockgps;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.view.View;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.TextView;

import java.io.InputStream;

/**
 * Pick a route file, set a speed, press play.
 *
 * Everything is deliberately plain: android.app.Activity, no AppCompat, no
 * androidx, no libraries at all. The safety argument for building this
 * instead of installing a mock-location app off the store is that there is
 * nothing in it to audit — that argument only survives while the dependency
 * list stays empty.
 *
 * The file is read through the Storage Access Framework, so the app holds no
 * storage permission: the user picks one file and only that file is
 * readable, for one session.
 */
public class MainActivity extends Activity {

    private static final int REQ_PICK = 1;
    private static final int REQ_NOTIF = 2;

    private TextView status, routeInfo;
    private EditText speed, holdLat, holdLng;
    private CheckBox loop;
    private Button start;

    private double[] lat, lng;
    private String routeName;

    private final Handler ui = new Handler(Looper.getMainLooper());
    private final Runnable refresh = new Runnable() {
        @Override public void run() {
            status.setText(MockService.status);
            // Enabled while the service runs, on purpose: hold -> play is
            // the normal sequence, and the service swaps mode in place.
            start.setEnabled(lat != null);
            ui.postDelayed(this, 500);
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        status = findViewById(R.id.status);
        routeInfo = findViewById(R.id.routeInfo);
        speed = findViewById(R.id.speed);
        holdLat = findViewById(R.id.holdLat);
        holdLng = findViewById(R.id.holdLng);
        loop = findViewById(R.id.loop);
        start = findViewById(R.id.start);

        findViewById(R.id.pick).setOnClickListener(v -> pickRoute());
        findViewById(R.id.devOptions).setOnClickListener(v -> openDevOptions());
        findViewById(R.id.useRouteStart).setOnClickListener(v -> useRouteStart());
        findViewById(R.id.hold).setOnClickListener(v -> holdPosition());
        findViewById(R.id.stop).setOnClickListener(v -> {
            startService(new Intent(this, MockService.class).setAction(MockService.ACTION_STOP));
        });
        start.setOnClickListener(v -> startPlayback());
        start.setEnabled(false);

        // Two permissions, neither of which the injection itself needs.
        //
        // POST_NOTIFICATIONS is so the ongoing notification and its Stop
        // button are visible. ACCESS_FINE_LOCATION is only so the service can
        // READ BACK what the OS thinks the location is and warn when that is
        // not what was injected — the check that turns "the pin is bouncing"
        // into a message. Denying either leaves playback working.
        if (Build.VERSION.SDK_INT >= 23) {
            java.util.List<String> ask = new java.util.ArrayList<>();
            if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
                ask.add(Manifest.permission.ACCESS_FINE_LOCATION);
            }
            if (Build.VERSION.SDK_INT >= 33
                    && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                ask.add(Manifest.permission.POST_NOTIFICATIONS);
            }
            if (!ask.isEmpty()) requestPermissions(ask.toArray(new String[0]), REQ_NOTIF);
        }
    }

    @Override protected void onResume() { super.onResume(); ui.post(refresh); }
    @Override protected void onPause() { super.onPause(); ui.removeCallbacks(refresh); }

    private void pickRoute() {
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT)
                .addCategory(Intent.CATEGORY_OPENABLE)
                // Route files are commonly served as octet-stream or XML, so
                // filtering on extension would hide them in the picker.
                .setType("*/*");
        startActivityForResult(i, REQ_PICK);
    }

    private void openDevOptions() {
        try {
            startActivity(new Intent(Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS));
        } catch (Exception e) {
            status.setText("Open Settings → Developer options → Select mock location app.");
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_PICK || resultCode != RESULT_OK || data == null || data.getData() == null) return;
        Uri uri = data.getData();
        try (InputStream in = getContentResolver().openInputStream(uri)) {
            Route r = Route.parse(in);
            lat = r.lat;
            lng = r.lng;
            routeName = uri.getLastPathSegment();
            routeInfo.setText(String.format("%s\n%s · %d points · %.2f km",
                    routeName, r.format, r.size(), r.lengthM() / 1000));
            // Prefilled, because holding at the route's start is what you
            // want nine times out of ten and forgetting it leaks a real fix.
            useRouteStart();
            status.setText("Route loaded. Hold the start position before opening Roamkeep.");
        } catch (Exception e) {
            lat = null;
            routeInfo.setText("");
            status.setText("Could not read that file: " + e.getMessage());
        }
    }

    /** Prefill the hold fields with the route's first point — the common
     *  case, since a recording should open at the place the route leaves. */
    private void useRouteStart() {
        if (lat == null) {
            status.setText("Pick a route first, or type a coordinate.");
            return;
        }
        holdLat.setText(String.format("%.6f", lat[0]));
        holdLng.setText(String.format("%.6f", lng[0]));
    }

    private void holdPosition() {
        double la, lo;
        try {
            la = Double.parseDouble(holdLat.getText().toString().trim());
            lo = Double.parseDouble(holdLng.getText().toString().trim());
        } catch (NumberFormatException e) {
            status.setText("Latitude and longitude must be decimal numbers.");
            return;
        }
        if (la < -90 || la > 90 || lo < -180 || lo > 180) {
            status.setText("Latitude is -90..90 and longitude is -180..180. Did they get swapped?");
            return;
        }
        Intent i = new Intent(this, MockService.class)
                .setAction(MockService.ACTION_HOLD)
                .putExtra(MockService.EXTRA_HOLD_LAT, la)
                .putExtra(MockService.EXTRA_HOLD_LNG, lo);
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(i); else startService(i);
        status.setText("Holding…");
    }

    private void startPlayback() {
        if (lat == null) return;
        float kmh;
        try {
            kmh = Float.parseFloat(speed.getText().toString().trim());
        } catch (NumberFormatException e) {
            status.setText("Speed must be a number, in km/h.");
            return;
        }
        if (kmh <= 0 || kmh > 300) {
            status.setText("Speed must be between 0 and 300 km/h.");
            return;
        }
        Intent i = new Intent(this, MockService.class)
                .setAction(MockService.ACTION_START)
                .putExtra(MockService.EXTRA_LAT, lat)
                .putExtra(MockService.EXTRA_LNG, lng)
                .putExtra(MockService.EXTRA_KMH, kmh)
                .putExtra(MockService.EXTRA_LOOP, loop.isChecked());
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(i); else startService(i);
        status.setText("Starting…");
    }
}
