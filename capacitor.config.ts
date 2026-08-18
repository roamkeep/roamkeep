import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.roamkeep.app',
  appName: 'Roamkeep',
  webDir: 'dist',
  server: {
    androidScheme: 'https'
  },
  android: {
    allowMixedContent: false,
    // Required by the move to targetSdk 36 (Android 16).
    //
    // Android 15 began enforcing edge-to-edge for apps targeting 35, and
    // styles.xml opts out via windowOptOutEdgeToEdgeEnforcement. Android 16
    // IGNORES that flag for apps targeting 36 — so without this the status
    // bar overlays the header and the navigation bar overlays the tab bar.
    // CSS cannot compensate: there is no viewport-fit=cover, and on Android
    // env(safe-area-inset-*) reflects display cutouts, not system bars.
    //
    // 'force', not 'auto'. 'auto' only adjusts when the opt-out attribute is
    // absent or false, and ours is true — so 'auto' would do nothing on
    // exactly the platform that needs it.
    //
    // 'force' installs an inset listener on every API level, but the margins
    // it applies come from the insets that actually arrive: where the decor
    // still fits system windows (API <= 34, and API 35 where the opt-out is
    // still honoured) those are already consumed and therefore zero, so no
    // margin is added. It corrects Android 16 without touching the versions
    // that behave today.
    adjustMarginsForEdgeToEdge: 'force'
  },
  plugins: {
    // Display the system tray banner for arrived/left pushes when the
    // app is foreground too (default 'none' would suppress them, but
    // we want a quick glance even with the app open). The realtime
    // toast still shows; OS dedupe is fine in practice because both
    // the toast and the banner come from the same checkins INSERT.
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert']
    }
  }
};

export default config;
