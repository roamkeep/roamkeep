# Roamkeep — Android build (Phase 0, Windows)

The PWA at the repo root keeps running unchanged on S3/CloudFront. This
file covers wrapping the same web code in a Capacitor Android shell on
**Windows 10/11** so later phases can use native geofencing, push, etc.

All commands below are intended for **PowerShell** (run from the repo
root, `<repo>`). `cmd.exe` works
too — notes call out the differences where they matter.

## One-time setup

### 1. Install Node.js (LTS)

Download the Windows installer from https://nodejs.org (LTS — currently
Node 20.x or 22.x). Tick "Automatically install the necessary tools"
during setup so `node-gyp` / build-tools are ready. Verify:

```powershell
node --version
npm --version
```

### 2. Install the deps

From the repo root:

```powershell
npm install
```

This pulls `@capacitor/core`, `@capacitor/cli`, `@capacitor/android`.

### 3. Install Android Studio + JDK 17

- **Android Studio** (Electric Eel or newer): https://developer.android.com/studio
  Installer lays down Android Studio + the Android SDK together.
- **JDK 17** is required by Android Gradle Plugin 8.x. Android Studio
  ships an embedded JDK at
  `C:\Program Files\Android\Android Studio\jbr` — using Android Studio
  or its terminal is the least-friction option. If you build from a
  plain PowerShell window, install Temurin 17 from
  https://adoptium.net and set `JAVA_HOME` yourself.

**Environment variables** (System Properties → Environment Variables, or
run `sysdm.cpl` → Advanced → Environment Variables):

| Variable            | Value                                              |
|---------------------|----------------------------------------------------|
| `ANDROID_HOME`      | `C:\Users\<you>\AppData\Local\Android\Sdk`         |
| `ANDROID_SDK_ROOT`  | same as above                                      |
| `JAVA_HOME`         | `C:\Program Files\Android\Android Studio\jbr`      |

Append to `Path`:

```
%ANDROID_HOME%\platform-tools
%ANDROID_HOME%\cmdline-tools\latest\bin
%ANDROID_HOME%\emulator
%JAVA_HOME%\bin
```

Close and reopen PowerShell so the new `Path` takes effect. Verify:

```powershell
adb --version
javac -version      # should report 17.x
sdkmanager --version
```

Accept SDK licences once:

```powershell
sdkmanager --licenses
```

### 4. Add the Android platform

```powershell
npm run build            # stages dist\
npx cap add android      # generates .\android\ — keep this folder
```

### 5. Generate a release keystore (ONCE — back it up somewhere safe)

`keytool.exe` ships with the JDK. In PowerShell:

```powershell
& "$env:JAVA_HOME\bin\keytool.exe" -genkeypair -v `
  -keystore familynest.keystore `
  -alias familynest `
  -keyalg RSA -keysize 2048 -validity 10000
```

> **cmd.exe** equivalent — use `^` line-continuations instead of
> backticks:
> ```cmd
> "%JAVA_HOME%\bin\keytool.exe" -genkeypair -v ^
>   -keystore familynest.keystore ^
>   -alias familynest ^
>   -keyalg RSA -keysize 2048 -validity 10000
> ```

Move `familynest.keystore` **out of the OneDrive-synced repo folder** —
OneDrive will happily replicate it, which is the opposite of what you
want. Put it somewhere like `C:\keys\familynest.keystore` and back it up
to a password manager or offline drive. Losing this file means existing
installs cannot receive updates.

### 6. Wire the keystore into the Gradle release build

Create `android\keystore.properties` (gitignored):

```
storeFile=C:/keys/familynest.keystore
storePassword=<yours>
keyAlias=familynest
keyPassword=<yours>
```

> Use **forward slashes** in `storeFile`, even on Windows — Gradle
> parses this as a plain string and backslashes would be read as escape
> sequences.

Then in `android\app\build.gradle`, add inside the existing `android { }`
block:

```gradle
def ksProps = new Properties()
def ksFile = rootProject.file("keystore.properties")
if (ksFile.exists()) { ksProps.load(new FileInputStream(ksFile)) }

signingConfigs {
  release {
    if (ksProps['storeFile']) {
      storeFile     file(ksProps['storeFile'])
      storePassword ksProps['storePassword']
      keyAlias      ksProps['keyAlias']
      keyPassword   ksProps['keyPassword']
    }
  }
}

buildTypes {
  release {
    signingConfig signingConfigs.release
    minifyEnabled false
  }
}
```

Add `keystore.properties` and `*.keystore` to `.gitignore`.

## Day-to-day commands (PowerShell)

| Task                              | Command                         |
|-----------------------------------|---------------------------------|
| Stage web files into `dist\`      | `npm run build`                 |
| Sync web changes into Android     | `npm run sync`                  |
| Open Android Studio               | `npm run android:open`          |
| Run on connected device           | `npm run android:run`           |
| Build signed release APK          | `npm run android:release`       |
| Build signed release AAB (Play)   | `npm run android:bundle`        |

The `android:release` script shells out to `gradlew.bat assembleRelease`
inside the `android\` folder, so it works from a plain PowerShell window
as long as `JAVA_HOME` is set.

Release APK lands at:

```
android\app\build\outputs\apk\release\app-release.apk
```

### APK vs AAB — which to build

- **APK** (`android:release`) — sideloading. This is what you hand to a
  family member directly, or `adb install -r`.
- **AAB** (`android:bundle`) — the *only* format Google Play accepts.
  Lands at:

```
android\app\build\outputs\bundle\release\app-release.aab
```

Both use the same `signingConfig`, so the AAB is signed with the existing
keystore. Under **Play App Signing** that keystore is your **upload key**:
you sign the AAB with it, Play verifies it, then re-signs with an app
signing key Google holds. Consequences worth knowing:

- The APK Play serves is **not** byte-identical to anything you build, and
  its signature differs from your sideloaded APKs. A device can't upgrade
  between the two channels — pick one per device.
- Losing the upload keystore is recoverable (Play can reset it); losing it
  *before* enrolling in Play App Signing is not. Back it up now.
- You may keep using the same keystore for sideloads. There's no need for
  a separate upload key unless you want the two channels isolated.

## Connecting a real device (USB debugging)

1. On the phone: Settings → About phone → tap **Build number** 7 times
   to unlock Developer Options.
2. Settings → Developer options → enable **USB debugging**.
3. Plug the phone into the PC. Accept the RSA fingerprint prompt on the
   phone.
4. Confirm Windows sees it:
   ```powershell
   adb devices
   ```
   Should list one device as `device` (not `unauthorized` or `offline`).
5. `npm run android:run` installs and launches the debug build.

If `adb devices` is empty, install the phone vendor's USB driver
(Samsung, Pixel, OnePlus each have their own) or Google's "Universal
ADB Driver" via Device Manager.

## Installing the signed APK on a phone

1. On the phone: Settings → Apps → Special access → **Install unknown
   apps** → allow your browser / file manager.
2. Host the APK somewhere accessible (e.g. your existing S3 bucket
   under `/download/familynest.apk`, or email it / drop it on a USB
   stick).
3. Open the URL on the phone → install.
4. Future updates: bump `versionCode` / `versionName` in
   `android\app\build.gradle` before each rebuild. Installing a new
   signed APK with the **same keystore** upgrades the app in place.

## Windows-specific gotchas

- **Long paths.** Gradle + Android builds occasionally trip over
  Windows' default 260-char path limit. If you see `CreateProcess`
  failures or mysterious `FileNotFoundException`s, enable long paths:
  ```powershell
  reg add HKLM\SYSTEM\CurrentControlSet\Control\FileSystem `
    /v LongPathsEnabled /t REG_DWORD /d 1 /f
  ```
  (Requires an elevated PowerShell; reboot afterwards.)
- **OneDrive syncing the build.** The repo lives under
  `<repo>`, so `android\.gradle\`,
  `android\app\build\`, `dist\`, and `node_modules\` will all be
  uploaded unless excluded. Right-click each of those folders in
  Explorer → **Free up space** won't help (they regenerate). Better:
  right-click → **Always keep on this device** off, or exclude them via
  OneDrive settings → Sync and back up → Manage backup. Cleanest fix
  is moving the project out of OneDrive entirely before real build
  work begins.
- **Antivirus scanning.** Windows Defender (or third-party AV) scanning
  every file Gradle writes can 3-5× a clean build. Consider adding
  `android\`, `node_modules\`, and `dist\` to the Defender exclusion
  list (Settings → Privacy & Security → Windows Security → Virus &
  threat protection → Exclusions).
- **Line endings.** Git on Windows defaults to CRLF conversion. For
  `gradlew` (the Unix shell script) this is fine — you'll only use
  `gradlew.bat` on Windows — but if you later touch files that end up
  on a build server, set `core.autocrlf=input` or add a `.gitattributes`.

## Verifying Phase 0 is done

The APK launches, reaches the auth screen, and lets you:

- create an account, create a Keep, join a Keep
- see your live map pin and tiles
- send an SOS visible to a second signed-in install

All behaviour identical to the PWA — this phase adds zero new features,
it just gives later phases access to native plugins.

## Phase 0.5 — rebuild after location / icon / status-bar fixes

Two Capacitor plugins were added (`@capacitor/geolocation`,
`@capacitor/status-bar`), location permissions were appended to
`AndroidManifest.xml`, and a 1024-px source icon is ready at
`assets\icon.png`. Icons are generated via **Android Studio's Image
Asset Studio** — not an npm tool — because every third-party icon
generator on npm drags in a maintenance-abandoned tree with high-
severity CVEs. Image Asset Studio ships with Android Studio, produces
better adaptive icons, and needs no dependencies.

### 1. Install the new plugins

```powershell
npm install
```

### 2. Regenerate launcher icons via Image Asset Studio (one-time)

1. Open Android Studio → **File → Open…** → select the `android\`
   folder in the repo.
2. In the Project panel, right-click **`app`** → **New → Image Asset**.
3. In the wizard:
   - **Icon Type:** Launcher Icons (Adaptive and Legacy)
   - **Name:** `ic_launcher`
   - **Foreground Layer → Asset Type:** Image
   - **Path:** `..\assets\icon.png`
   - **Resize:** drag the slider to roughly **72–78%** so the 🏡 sits
     inside the adaptive-icon safe zone (Android crops the outer ~18%
     into different shapes across OEMs).
   - **Background Layer → Asset Type:** Color → **#2e1f0a** (matches
     the PWA `theme-color` meta tag so the icon blends with the
     status bar).
   - **Legacy tab:** leave "Legacy", "Round", and "Google Play Store"
     all enabled so older Androids render correctly.
4. **Next → Finish.** The wizard overwrites every `mipmap-*` bucket +
   the adaptive-icon XMLs under `android\app\src\main\res\`.
5. Close Android Studio. You only need to re-run this if the source
   icon changes.

### 3. Sync + rebuild + install

```powershell
# Sync JS + plugins + manifest changes into android/
npm run sync

# Build a new signed release APK
npm run android:release

# Install on a connected phone
adb install -r android\app\build\outputs\apk\release\app-release.apk
```

### What to expect on first launch

- Android shows a **native location-permission dialog**. Tap "While
  using the app" — background-only is not needed yet (Enhancement 1
  will add it).
- The **status bar** renders as a solid dark-brown strip with light
  system icons, fully above the Roamkeep header.
- The **home-screen icon** shows the Roamkeep keep graphic (not the
  Capacitor "CAP" default).
- The **live map pin** moves to your real position within a few
  seconds of granting permission.

If the status bar still overlaps or the icon is still the default,
you probably skipped `npm run sync` — it re-runs `npx cap sync android`
which copies plugin native code into `android\app\src\main\java\`.

## Phase 1 — Saved places + background geofence

Enhancement 1 adds per-Keep "saved places" (Home, School, etc.) and
fires auto check-ins when a family member crosses the radius — even
with the app closed.

### 1. Apply the Supabase migrations

Run these **once** in Supabase → SQL Editor, in order. Both are
idempotent — safe to re-run.

> **Fresh project?** Skip the numbered migrations and just run
> [`db/schema.sql`](db/schema.sql) — it folds in everything below and is
> idempotent. The numbered files in `db/migrations/` are for upgrading a
> database that's already on an older version.

> **Naming:** everything below names the schema as it is *today* —
> `keeps`, `keep_members`, `keep_places`, `keep_id`. Migration files
> older than v9 still say `nest*` inside, because they are a record of
> what was applied; the v9 migration is what renames them.

1. **`db/migrations/familynest-schema-v4-places.sql`** — creates
   `keep_places` + RLS, adds `keep_members.last_place_id`, extends
   `checkins.type` to include `'left'`, and adds `keep_places` to the
   realtime publication.
2. **`db/migrations/familynest-schema-v4_1-replica-identity.sql`** —
   `ALTER TABLE keep_places REPLICA IDENTITY FULL`. Without this,
   Postgres only ships the primary key in DELETE WAL records, so the
   client's filtered subscription (`keep_id=eq.<keepId>`) drops the
   event and deleted places linger in the UI until reload. Verify with:
   ```sql
   SELECT relreplident FROM pg_class WHERE relname = 'keep_places';
   -- expect 'f' (full)
   ```

> **Ship order matters:** apply v4.1 *before* rolling out the v6 PWA /
> APK to other family members. Otherwise their existing client (v5) and
> the new one will both run fine, but cross-device delete propagation
> won't work until v4.1 is applied.

### 2. Install the geofence plugins

```powershell
npm install
```

This pulls two complementary pieces:

1. **The in-repo `NativeGeofence` plugin** (Java, under
   `android\app\src\main\java\com\roamkeep\app\geofence\`) is the
   **primary** mechanism for arrived/left check-ins. It registers
   circular geofences with Google Play Services, and a
   `BroadcastReceiver` in our APK receives ENTER/EXIT intents from
   the OS — **even when the app process is dead**. The receiver
   POSTs the check-in straight to Supabase via `HttpURLConnection`;
   no WebView, no JS runtime, nothing that Android's background
   throttling can pause. A `BootReceiver` re-registers every stored
   geofence on `BOOT_COMPLETED` (Android clears them on reboot).
2. **`@capacitor-community/background-geolocation`** (npm) keeps a
   persistent-notification foreground service running so the live
   map pin (`keep_members.lat`/`lng`) stays fresh for other family
   members while you're backgrounded. This is **continuous
   tracking**, not transition detection — geofence ENTER/EXIT are
   handled natively regardless of whether this service is alive.

Together: native plugin handles "Alice arrived at school" reliably,
BG-geolocation keeps Alice's map dot moving while she's on the way.

### 3. New Android permissions

`AndroidManifest.xml` declares the following extra permissions:

- `ACCESS_FINE_LOCATION` + `ACCESS_COARSE_LOCATION` — GPS fixes for
  both the foreground map and the geofence registration call.
- `ACCESS_BACKGROUND_LOCATION` — **required on Android 10+** so
  Google Play Services will deliver geofence ENTER/EXIT broadcasts
  to our receiver when the app is backgrounded. Without it the
  geofence registration succeeds but transitions only fire while
  the app is in the foreground.
- `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_LOCATION` — needed by
  `background-geolocation` on Android 14+ for the live-tracking
  foreground service.
- `POST_NOTIFICATIONS` — Android 13+ asks the user before the
  foreground service's tracking notification can be shown.
- `WAKE_LOCK` — lets the tracking service keep GPS alive between
  samples.
- `RECEIVE_BOOT_COMPLETED` — lets the native plugin's
  `BootReceiver` re-register geofences after a device reboot
  (Android clears them otherwise).

The geofence receivers themselves are declared in the `<application>`
block of the manifest: `GeofenceReceiver` (target of the geofence
PendingIntent, `exported="false"`) and `BootReceiver` (target of the
boot broadcast, `exported="true"` with an intent-filter).

### 4. Runtime permission flow (what the user sees)

On the first launch after upgrading:

1. **"Allow Roamkeep to access this device's location?"** — choose
   **Precise** + **While using the app** first. The app starts
   working in foreground mode immediately.
2. **"Allow Roamkeep to send you notifications?"** (Android 13+) —
   required for the persistent tracking notification. Deny and
   background tracking falls back to foreground-only.
3. When the user opens the Places tab and saves their first place,
   the plugin will prompt **"Change to Allow all the time?"**. This
   is the `ACCESS_BACKGROUND_LOCATION` gate — Android deliberately
   makes it a separate settings screen on API 30+. Tap the app →
   Permissions → Location → **Allow all the time**.

Without step 3 the app still works, but geofence transitions only
fire while the app is open. The Places list will show a persistent
banner prompting re-grant if detected missing.

### 5. Sync + rebuild

```powershell
npm run sync
npm run android:release
adb install -r android\app\build\outputs\apk\release\app-release.apk
```

### 6. Verification

- Open the Places tab → tap **Add place at my location** → name it
  "Test", radius 50m, save. Place appears on map as green circle.
- Walk 100m away from the point. Within ~30s a **'left Test'**
  check-in appears in the Activity tab, stamped with the actual
  crossing time (not "now").
- Walk back. An **'arrived Test'** check-in appears.
- **Force-quit the app** from the recents screen. Walk 100m away,
  wait a minute, walk back — *without reopening the app*. Now open
  the app: both the 'left' and 'arrived' check-ins should be
  present, each stamped at the real crossing moment. This proves
  the native plugin's `BroadcastReceiver` is receiving transitions
  while our process is dead.
- **Reboot the device** with one place registered. Cross the
  boundary without opening the app first. The transition should
  still fire — proves `BootReceiver` re-registered the geofence.
- The persistent "🏰 Roamkeep — tracking…" notification (from the
  BG-geolocation foreground service) should be visible in the
  shade whenever the app has recently been open. This is for the
  live map pin, **not** for geofence transitions — geofence ENTER/
  EXIT fire independently of this notification.
- A second family member's phone receives the arrived/left events
  in real time (Supabase realtime + `keep_places` in the publication).
- PWA regression: open the CloudFront URL in desktop Chrome. Places
  work foreground-only (the native plugin is Android-only; browsers
  fall back to the JS `checkGeofenceTransitions` path on each GPS
  tick). No background service (web can't create one). All other
  features unchanged.

### Known quirks

- **Location permission must be set to "Allow all the time".**
  This is the one non-negotiable setting. Google Play Services
  will deliver geofence ENTER/EXIT broadcasts to our receiver only
  if the app holds `ACCESS_BACKGROUND_LOCATION`, which on Android
  11+ requires the user to visit a separate settings screen:
  Settings → Apps → Roamkeep → **Permissions → Location → Allow
  all the time**. The runtime prompt surfaces this as "Change to
  Allow all the time?" the first time the app tries to register a
  geofence. If the user declines, geofence transitions only fire
  while the app is in the foreground.
- **OEM battery optimisation — critical for the breadcrumb *trail*, not
  for check-ins.** Arrived/left check-ins go through Google Play Services
  geofencing, which is exempt from background throttling and keeps working
  even on aggressively-managed devices. The **breadcrumb trail** is
  different: frequent background location needs a live foreground service
  (`LocationForegroundService`) to stay out of the App Standby throttle.
  On idle devices (e.g. a child's phone left charging overnight) Android
  demotes rarely-opened apps to a restricted bucket and throttles their
  background location to a few fixes/hour — so the trail goes sparse even
  though geofences fire. The service is `START_STICKY` and restarts on
  boot + geofence transitions, which handles ordinary kills, but two OEM
  settings still matter:
  1. Settings → Apps → Roamkeep → **Battery → Unrestricted**.
  2. **Samsung:** Settings → Battery → **Background usage limits** →
     **Never sleeping apps** → add Roamkeep, and make sure it is **not**
     in **Deep sleeping apps** (a hard force-stop there cancels even the
     foreground service and geofences). **Xiaomi/MIUI:** enable
     **Autostart** + set battery to **No restrictions**. Stock Android:
     Unrestricted is usually enough.
  The in-app **Family → Settings → Tracking diagnostics** readout reports
  whether the service is running and whether background fixes are landing,
  so you can tell throttling from a real fault on a specific device.
- **Plugin version mismatch.** If `npm install` complains about
  peer-dep conflicts between `@capacitor/core@7` and
  `@capacitor-community/background-geolocation`, try the latest
  beta: `npm install @capacitor-community/background-geolocation@next`.
  The community plugin's v7-compat track was still stabilising at
  time of writing.
- **`Java compiler version 21 has deprecated support for compiling
  with source/target version 8`.** JDK 21 refuses to emit Java 8
  bytecode, and some third-party Capacitor plugins still ship a
  `build.gradle` without `compileOptions`, which defaults them to
  `VERSION_1_8`. The project-level `android\build.gradle` already
  contains a `subprojects { afterEvaluate { ... } }` block that
  forces every submodule (including plugins) to Java 17 — this is
  what Android Gradle Plugin 8.x expects anyway. If you still see
  the error after a fresh build, stop the Gradle daemon so it
  re-reads the config:
  ```powershell
  cd android ; .\gradlew.bat --stop ; cd ..
  npm run android:release
  ```

---

## Phase 2 — Push notifications (FCM + Supabase Edge Function)

Phase 1 gives us reliable arrived/left **check-in rows** via the native
geofence plugin, but only members who have the app open see them surface
in real time. Phase 2 adds OS-level push notifications so a backgrounded
or killed app still wakes its phone when a family member arrives at
school or leaves the park.

Architecture:

```
checkins INSERT (JS path or native receiver)
        ↓
Supabase Database Webhook
        ↓
Supabase Edge Function `notify-checkin` (Deno / TypeScript)
        ↓
FCM HTTP v1 API (oauth2 service-account JWT)
        ↓
Android device → notification tray
```

Firebase Cloud Messaging is the only path Android exposes for push
delivery to a backgrounded or killed app — there is no alternative on
the OS level, even third-party services like OneSignal wrap FCM
internally. The rest of the stack stays on Supabase. Firebase is used
purely as the post office.

### 1. Firebase project (one-time)

1. https://console.firebase.google.com → Add project → name "Roamkeep".
   No Analytics needed.
2. Add Android app, package `com.roamkeep.app`. Skip the SHA-1 step
   (only needed for App Check / Dynamic Links — neither is in scope).
3. Download `google-services.json` and drop it into `android/app/`.
   The file is gitignored; each developer / build host gets their own.
   The project-level `android/build.gradle` already declares the
   `com.google.gms:google-services` classpath (4.4.2) and the app-level
   `android/app/build.gradle` applies the plugin conditionally — it
   activates automatically once the JSON file is present.
4. Project Settings → **Service accounts** → **Generate new private key**.
   Save as `firebase-service-account.json` somewhere outside the repo.
   This is what the edge function authenticates with.

Cloud Messaging API (V1) is enabled by default on new projects.

### 2. Database migration

Apply [`db/migrations/familynest-schema-v5-push.sql`](db/migrations/familynest-schema-v5-push.sql)
in the Supabase SQL editor (or, for a fresh project, just run
[`db/schema.sql`](db/schema.sql), which already includes it). Adds:

- `keep_members.fcm_token text` — populated by the Capacitor plugin's
  registration listener.
- `keep_members.notify_on_checkin bool default true` — per-recipient
  mute switch, surfaced as a toggle in the app's Family tab.
- A partial index on `(keep_id) where fcm_token is not null` so the
  edge function's per-INSERT recipient lookup stays cheap.

Idempotent; safe to re-run.

### 3. Capacitor plugin

```powershell
npm install @capacitor/push-notifications@^7.0.6
npm run sync
```

`POST_NOTIFICATIONS` is already declared in the manifest (originally
added for the BG-geolocation foreground service). Android 13+ surfaces
a runtime prompt the first time `Push.requestPermissions()` is called
on launch.

### 4. Edge function

The function source lives at
[`supabase/functions/notify-checkin/`](supabase/functions/notify-checkin/).
See [`supabase/README.md`](supabase/README.md) for the deploy commands.
TL;DR:

```powershell
# One-time
supabase link
supabase secrets set FCM_SERVICE_ACCOUNT="$(cat ../firebase-service-account.json)"

# Deploy / re-deploy
supabase functions deploy notify-checkin --no-verify-jwt
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are auto-injected by
Supabase — do not set them yourself.

### 5. Database webhook

Supabase Dashboard → Database → Webhooks → **Create**:

- Name: `notify-checkin`
- Table: `checkins`
- Events: ☑ Insert (only)
- Type: **Supabase Edge Functions** → `notify-checkin`
- Method: POST

This is the wire connecting `checkins INSERT` → edge function. The
function returns `200 ok` synchronously without blocking the insert.

### Verifying push end-to-end

1. Build & install: `npm run android:release`. APK lands at
   `android/app/build/outputs/apk/release/app-release.apk`. Install on
   top of v1.3 — must upgrade in place without uninstall.
2. First launch on Android 13+ surfaces the notification permission
   prompt. Grant.
3. Sign in. Open Supabase table editor → `keep_members` → confirm your
   row's `fcm_token` got populated.
4. With two devices logged in as different members of the same Keep:
   walk into a saved place on device A. Within ~2 s, device B's
   notification tray gets `📍 Alice arrived at Home`. Device A does
   **not** get its own notification.
5. Walk out: device B gets `📍 Alice left Home`. Force-quit the app on
   device B first to confirm push arrives even when the app is dead.
6. Tap the notification on device B: app opens, map focuses on Alice's
   pin (the function ships `member_id` in the data payload).
7. Toggle **🔔 Notify me when family arrive or leave a place** off in
   the Family tab on device B → verify B receives nothing on subsequent
   transitions; re-enable → notifications resume.
8. Sign out on device A → confirm `fcm_token` is cleared.
9. Edge-function logs: Supabase Dashboard → Functions → notify-checkin
   → Logs. One invocation per check-in INSERT, body `ok recipients=N
   dead=0`.

### Phase 2 known quirks

- **`google-services.json` missing** → the build still succeeds (the
  apply-plugin block is wrapped in try/catch with a log line) but
  `Push.register()` fails at runtime with a `MISSING_INSTANCE_ID_SERVICE`
  error. The fix is to drop the file in and rebuild.
- **Service-account JWT signing inside the edge function** uses
  `jose@5` from `esm.sh`. If you see a `failed to import PKCS8` error
  in the function logs, the most common cause is that the
  `FCM_SERVICE_ACCOUNT` secret had its newlines stripped — make sure
  you set it via `cat firebase-service-account.json` (or the equivalent
  PowerShell cmd) which preserves the `\n` inside `private_key`.
- **Stale tokens.** When a user uninstalls or reinstalls, FCM rotates
  the token. Sends to the old token return `UNREGISTERED` /
  `INVALID_ARGUMENT`; the function detects this and nulls the column
  so we stop trying. The next time the affected device opens the app,
  the registration listener re-populates with a fresh token.
- **Airplane-mode at the moment of crossing.** Same recovery story as
  the geofence receiver itself (see PR #11): the check-in row simply
  doesn't get inserted, so no webhook fires, so no push. Acceptable —
  the push reflects the activity feed, not the underlying movement.
