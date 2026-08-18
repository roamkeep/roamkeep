package com.roamkeep.app;

import android.os.Bundle;
import androidx.core.view.WindowCompat;
import androidx.work.WorkManager;
import com.roamkeep.app.geofence.BootReceiver;
import com.roamkeep.app.geofence.NativeGeofencePlugin;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NativeGeofencePlugin.class);
        super.onCreate(savedInstanceState);
        // Opt out of Android 15+ edge-to-edge enforcement.
        // Capacitor's BridgeActivity sets decorFitsSystemWindows=false,
        // which lets the status bar overlay the WebView. We want the
        // bar above the WebView so the @capacitor/status-bar plugin's
        // setBackgroundColor('#2e1f0a') paints a readable strip above
        // the Roamkeep header.
        WindowCompat.setDecorFitsSystemWindows(getWindow(), true);

        // The BootReceiver schedules a 15-minute periodic location
        // poll for the window between device reboot and the user
        // opening the app. Now that the app IS open, the
        // BackgroundGeolocation plugin's continuous foreground service
        // will take over with seconds-level fixes — cancel the
        // periodic worker so we don't have two systems racing.
        try {
            WorkManager.getInstance(getApplicationContext())
                    .cancelUniqueWork(BootReceiver.LOCATION_WORK_NAME);
        } catch (Exception ignored) {}
    }
}
