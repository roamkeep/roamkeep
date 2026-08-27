# Roamkeep — project guide

Private family location-sharing app. A vanilla-JS PWA, wrapped in a
Capacitor Android shell, backed by Supabase, with native OS geofencing
and FCM push.

## The one-paragraph mental model

The same web bundle runs two ways. As a **PWA** it's served straight off
S3/CloudFront and uses browser geolocation. As an **Android app** it's
wrapped by Capacitor and gains three native capabilities the browser
can't offer: OS-level geofencing that fires even when the app is dead, a
background-location foreground service for the live map pin, and FCM push
notifications. Supabase is the shared backend for both — Postgres + RLS +
Realtime + Auth + one Edge Function. There is no custom server.

## Layout

```
index.html, styles.css, app.js   PWA source (flat at root so S3 serves it directly)
supabase.js                      vendored supabase-js SDK bundle (not our code)
sw.js                            service worker; cache name bumped every release
manifest.json, icon-*.png        PWA manifest + icons
build.js                         stages the 8 web files into dist/, minifying app.js/sw.js/styles.css (esbuild)
capacitor.config.ts              Capacitor config (appId com.roamkeep.app)
android/                         Capacitor Android project
  app/src/main/java/com/roamkeep/app/
    MainActivity.java            registers the geofence plugin; cancels boot worker
    geofence/                    the native plugin + its supporting classes
db/
  schema.sql                     CONSOLIDATED canonical schema — run this for a fresh project
  migrations/                    historical numbered migrations (applied in order to the live DB)
supabase/functions/notify-checkin/   Edge Function: fans out arrived/left pushes via FCM
ANDROID_BUILD.md                 long-form Android + Firebase + push setup walkthrough
cloudfront-static-site.yaml      CloudFormation for the PWA's S3/CloudFront hosting
firebase-service-account.json    FCM service-account key (gitignored, never commit)
```

`app.js` is a single ~1800-line IIFE with no build step or framework.
State lives in one object `S`. Event handling is delegated: elements
carry `data-action="..."` and `ACTIONS[name]` dispatches. Adding a
behaviour = add a handler to `ACTIONS` + a `data-action` attribute.

### Naming: "keep" everywhere (the v9 rename)

The app was renamed FamilyNest → **Roamkeep** (appId `com.roamkeep.app`),
and as of **v9 / app 4.5.0 the database says "keep" too**: `keeps`,
`keep_members`, `keep_places`, `keep_join_attempts`, the `keep_id` column
on all four tables that carry it, `create_keep`, `join_keep_by_code`,
`rotate_keep_code`, `private_user_keep_ids`, `_roamkeep_gen_code()`,
`_roamkeep_guard_member_cols()`, the `roamkeep.priv` guard flag and the
`roamkeep-prune-location-history` cron job. Client-side, `S.keepId`,
`data-action="join-keep"` and the `s-keep` screen match.

This was deliberately deferred until the author was still the only
deployment — it is a breaking lockstep client+DB cutover, and after other
families provision their own Supabase it stops being one person's
migration and becomes everybody's.

**Upgrading an existing database takes TWO files, in order:**
`db/migrations/familynest-schema-v9-keeps-rename.sql` then
`db/schema.sql`. The first renames objects; the second restates the
function bodies, which are stored as text and so do **not** follow a
table rename. Between the two, every RPC is broken.

The one non-obvious part: RLS policies and the guard trigger reference
functions **by OID**, so `private_user_keep_ids` and
`_roamkeep_guard_member_cols` are `ALTER FUNCTION … RENAME`d rather than
dropped. Dropping them would fail on the dependency — or with `CASCADE`
would take the membership policies with it, leaving the tables readable
by anyone.

Historical migration **filenames** (`db/migrations/familynest-schema-*.sql`)
stay as-is permanently — they are a record of what was applied. The repo
folder is likewise still `FamilyNest` on disk, so doc paths referencing
it are correct.

## Two location mechanisms (don't conflate them)

1. **Native geofencing** (`geofence/NativeGeofencePlugin` + `GeofenceReceiver`)
   — the primary path for arrived/left check-ins. Google Play Services
   delivers ENTER/EXIT broadcasts to `GeofenceReceiver` even when the app
   process is dead; the receiver POSTs the check-in straight to Supabase
   from Java (no WebView involved). Auth context + place metadata live in
   `SharedPreferences` via `PrefsStore` so this works headless.
2. **Native location updates** (`LocationForegroundService`) — a
   `START_STICKY` foreground service that holds a live, in-process
   `FusedLocationProvider` `LocationCallback` (the OS honours a foreground
   callback faithfully — dense trails — where the old PendingIntent
   delivery was batched/throttled). Each batch goes to
   `LocationUpdateReceiver.processLocations`, which writes the breadcrumb
   trail (`location_history`) + refreshes the live pin
   (`keep_members.lat/lng` + battery), headless via `SupabaseRest`. The
   FGS keeps the app out of the App Standby throttle so background
   recording survives idle devices; restarted on boot (`BootReceiver`)
   and kicked by geofence transitions. For **auto** mode the rate adapts
   to **real GPS movement** decided in the service (dense while moving,
   low-power after 3 min still) — NOT the Activity Recognition sensor,
   which proved unreliable and got auto stuck both ways. A periodic
   re-arm heals a stale callback on long sessions. **From Android 13 the
   user can swipe the foreground-service notification away** —
   `setOngoing(true)` never prevented that, it only blocked a clear-all —
   and since it is posted once by `startForeground()` in `onStartCommand`,
   which does not fire again while the service lives, it stayed gone for
   the rest of the session. That silently falsified the "permanent
   notification" claim in `landing/privacy`. `restoreNotificationIfDismissed()`
   checks `getActiveNotifications()` on each fix and each re-arm and puts
   it back — silently, because the channel is `IMPORTANCE_LOW`. It is
   deliberately not restored instantly via a `deleteIntent`: that reads as
   the app fighting the swipe, where returning at the next fix is the
   disclosure simply falling due again. Replaced the old
   `@capacitor-community/background-geolocation` plugin. NOT used for
   check-ins. Foreground map smoothness uses a plain
   `@capacitor/geolocation` `watchPosition` while the app is open.

When the native plugin is active (`S._nativeGeoReady`), the JS-path
`checkGeofenceTransitions` still maintains the `insidePlaces` Set for UI
but must NOT write check-ins (the receiver owns that) — otherwise you get
duplicates.

### Geofencing needs ACCESS_BACKGROUND_LOCATION — and re-arming

Play Services **accepts** a geofence registration when the app holds only
foreground location and then simply never delivers transitions unless the
app is open. So a device granted "While using the app" logs breadcrumbs
perfectly (a foreground service is allowed under while-using) but never
fires arrived/left — which looks like a geofence bug and isn't. Worse,
fences registered under foreground-only permission stay inert *even after*
"Allow all the time" is granted later; they must be **re-registered**.
That is why rebooting appeared to fix affected devices — `BootReceiver`
re-registers from scratch.

The first-run setup sheet (`openSetup` in `app.js`, `SETUP_ITEMS`) asks for
background location and battery-optimisation exemption, and
`reconcileSetup()` runs on every resume to catch grants made in system
settings (from API 30 "Allow all the time" can only be set there, so no
in-app permission callback ever fires) and calls
`NativeGeofence.reArmGeofences()` on the transition to granted.

### The recurring bug: native state silently diverging from the database

**Read this before touching anything that mirrors DB rows into the OS.**
Four of the bugs found so far are one architectural gap wearing different
clothes, and it will keep producing them.

Three stores hold a copy of what `keep_places` says, and none of them is
the database: the **Play Services fence registry**, `PrefsStore`'s **place
metadata**, and `PrefsStore`'s **inside-place set**. They exist so the
receivers work headless — that is the whole point — but it means every
change to a place has to reach three places, on every device, or they
drift apart.

The realtime subscription looks like it handles this. It does not, because
**Android suspends the WebView's realtime socket while the app is
backgrounded and Supabase does not replay missed events.** A `keep_places`
event only lands on a device that happens to be in the foreground at that
moment. Every other device learns about it, if at all, from the next
`loadPlaces()` refetch — which updates `S.places` and the UI and tells the
OS nothing.

What makes these bugs expensive is that **a diverged device looks
healthy**. The database is consistent, the UI renders the database, and the
wrong behaviour happens in a receiver with no screen. Both instances so far
were invisible until someone read the black-box journal:

- **PR #40** — a place added on another device was never armed, so
  breadcrumbs recorded straight through it and no arrived/left ever fired,
  while places armed at launch kept working perfectly.
- **PR #42** — a place *deleted* on another device was never pruned, so a
  phone went on filing check-ins for a place that no longer existed, under
  its old name and icon, with nothing left on any screen to explain them.

**The rule:** a realtime handler is an optimisation, never the only path. A
change mirrored into native state also needs a **reconcile against the
authoritative list on resume** — compare, then push the whole desired
state, don't apply a delta. `rearmGeofencesFromPlaces` + `placesSignature()`
is that path; `armPlaces` treats its argument as the complete set and
prunes anything else. Keep it that way: if you add a fourth thing that
mirrors DB state, give it a reconcile before you give it a delta handler.

Since v13 there is a **second** reconcile that doesn't wait for someone to
open the app: `notify-places` wakes every device on a `keep_places`
change, and `RoamkeepMessagingService.reconcilePlaces` refetches the whole
list and re-arms. Both paths — and `BootReceiver` — go through the one
`GeofenceArmer.arm()`, which was extracted from the plugin precisely so
that callers without a Capacitor bridge could run the identical
arm-and-prune. Its contract is the rule above: **the caller passes the
complete list, and anything absent is pruned.**

Two things that fall out of that and have to stay explicit at every call
site:

- **An empty list is a meaningful state, not a no-op** (as below).
- **A caller must never pass an empty list because a fetch failed.** That
  is indistinguishable from "everything was deleted" and would
  unregister every fence on the device, from a receiver with no screen.
  `reconcilePlaces` bails on a null or unparseable body and only then
  trusts an empty array — the two cases are one `if` apart and demand
  opposite actions.

`placesSignature()` (JS) and `GeofenceArmer.signature()` (native) both
include **name and icon**, not just geometry. With geometry alone a
*rename* never re-armed, and since `GeofenceReceiver` composes its
check-in text from the name in `PrefsStore`, a renamed place went on
filing check-ins under its old name indefinitely — the same bug as #40 and
#42, one field narrower.

Two corollaries worth keeping:

- **An empty list is a meaningful state, not a no-op.** "Every place was
  deleted" has to reach the native side, or the prune never runs in the
  case that needs it most.
- **The journal is the only witness.** These failures produce no error, no
  toast and no wrong-looking screen. Anything that writes native state
  should journal it, and anything that drops or prunes should say how much.

The same reflex applies on the JS side, where the equivalent is a swallowed
error: `S.members = data || []` replaced a whole family with `[]` on any
failed request, and the realtime handler then refilled it one member at a
time, so the app showed a plausible but wrong household that healed itself
over minutes. **Never let a failed read overwrite good state** — check
`error`, leave the last known value alone, and say so if there is nothing
to show.

## Build & release pipeline

```powershell
npm run sync            # build.js → dist/, then `cap sync android`
npm run android:release # sync + gradlew assembleRelease → signed APK
npm run android:bundle  # sync + gradlew bundleRelease   → signed AAB
```

- APK → `android/app/build/outputs/apk/release/app-release.apk` — sideload
  onto the author's own devices, signed with the local keystore.
- AAB → `android/app/build/outputs/bundle/release/app-release.aab` — the
  only format Play accepts. Play App Signing **re-signs** it, so the
  fingerprint testers get differs from the sideload one (which is why
  `landing/.well-known/assetlinks.json` lists both).

**Build both on any release that goes to testers.** They come from the
same `dist/`, but nothing checks that the AAB you upload matches the APK
you tested — they are separate Gradle tasks over separate outputs, and a
stale AAB from an earlier `versionCode` is accepted silently by nothing
except your own memory.

Verifying an AAB is worth doing, because R8 mangles names and greps for
identifiers lie. Read `base/assets/public/app.js` out of the AAB (it is a
zip) and compare it byte-for-byte with `dist/app.js`; `versionName` is
findable as a raw string in `base/manifest/AndroidManifest.xml`.

Client hardening (obfuscation, not security — RLS is the security):
`build.js` minifies `app.js`/`sw.js`/`styles.css` into `dist/`, so
**deploy the PWA to S3 from `dist/`, not the repo root** — root files
are the readable source. The Android release build runs R8
(`minifyEnabled true`); the Capacitor bridge survives via keep rules in
`android/app/proguard-rules.pro`. R8 writes
`app/build/outputs/mapping/release/mapping.txt` — keep it per release
if you want to de-obfuscate a crash trace.

### Schema changes: expand → migrate → contract, never skip to contract

Other families now run their own Supabase, so a database change is no
longer one person's migration. The owner updates the database; every
member's app updates on Google's schedule. You therefore never get "old
app + old DB" cleanly followed by "new app + new DB" — you get **a mix of
app versions against one database, for days**. Ordering the owner's
migration correctly does not save you.

- **Expand.** New tables, columns and RPCs are added *additively*. Nothing
  renamed, dropped, or signature-changed. Old apps keep working untouched.
- **Migrate.** Ship the app version that uses the new things.
- **Contract.** Remove the old thing only when nothing still calls it. In
  this model that is months, or never.

The v9 `nests`→`keeps` rename was a contract done as a big bang, and was
only safe because the author was the sole deployment. That precedent is
the one **not** to repeat.

Since **v12** the database publishes its own version (`roamkeep_meta`,
read via `roamkeep_schema_version()`), and the client refuses to start
against a database older than `NEEDS_SCHEMA` in `app.js` — showing the
`s-outdated` screen instead of failing at whichever call site happens to
need the missing thing. On the native path that failure mode is invisible
(`SupabaseRest` has no screen; a rejected write is a `Log.w`), which is
exactly why the gate exists.

Rules that follow from it:

- Every migration sets `schema_version` **as its last statement**, so a
  half-applied migration reports the old number.
- **A version freezes the moment it is applied anywhere off your own
  machine** — merged or not, released or not. From then on it is a
  contract: `13` must mean one exact set of objects, for everybody.
  Changing what an already-applied version *contains* is the one failure
  this marker cannot catch, because the number does not move and every
  check that trusts it reports healthy.

  This has already happened once. `checkins.lat/lng` were added to v13
  after an earlier v13 had been pasted into live databases, so those
  reported `13` while missing the columns the SOS position feature reads
  — and since the app treats a missing position as normal, nothing
  errored anywhere. The repair was a one-line `ALTER`; finding it was the
  expensive part. If a version is out in the world, add v+1 instead,
  however unfinished the release still feels.

  Corollary: **verify OBJECTS, not the number** — count the columns,
  tables, functions and triggers you expect. `docs/OWNER_SETUP.md` has
  the query.
- Every release that starts using something new raises `NEEDS_SCHEMA` in
  the same commit, and `SCHEMA_VERSION` in `cli/src/steps.js` tracks what
  `db/schema.sql` stamps.
- `roamkeep_schema_version()` returns a **number, never a verdict**. A
  database that answered "compatible: yes/no" would bake one client's
  policy into every family's server, and changing that policy later would
  become a migration for all of them. The number is also what a future
  per-feature fallback would read (`if (S.schemaVersion >= N) … else …`)
  if the app ever switches from refusing to degrading.
- `min_app_build` (the other direction) stays **advisory** — a banner,
  never a block. An installed app that refuses can never be talked out of
  refusing by a later database change, and unlike the schema direction
  there is nothing the owner can do about a member whose Play update has
  not rolled out.
- A new webhook or trigger is **not** done when the CLI creates it. Most
  owners upgrade by re-pasting `db/schema.sql`, so anything they need must
  live in that file too — which is what `roamkeep_meta.project_url` is
  for, since a pasted SQL file cannot know its own project URL.
- **Publish the public repo BEFORE the Play rollout.** A brand-new owner
  gets their schema from a ZIP of `roamkeep/roamkeep` and their app from
  Play. If Play is ahead, they provision, are immediately told the server
  needs updating, and re-running the wizard from the tree they just
  downloaded stamps the same old version — a dead end on a five-minute-old
  project. See `docs/PUBLIC_RELEASE.md` §0.

**Every behavioural change bumps three things together** (the convention
across all prior PRs):
- `android/app/build.gradle` → `versionCode` (+1) and `versionName`
- `sw.js` → `CACHE` constant (`roamkeep-vN` → `vN+1`) so PWA users
  pick up the new bundle instead of a stale cached one

Android in-place upgrades are rejected if `versionCode` doesn't increase.

### OneDrive + Gradle gotcha

The repo lives under OneDrive. OneDrive's online-only placeholders
occasionally corrupt Gradle's incremental cache (`Cannot snapshot …
zip-cache/javaResources0: not a regular file`). Fix: stop the daemon and
remove the build dir, then rebuild.

```bash
cd android && ./gradlew --stop
rm -rf "android/app/build"
npm run android:release
```

## Backend is chosen at RUNTIME, not compiled in

There is deliberately **no Supabase URL or anon key in `app.js`**. Every
family runs their own project, so the app is *pointed at* one on first
run. Resolution order in `loadBackendConfig()`:

1. Stored config — Capacitor Preferences (native) / localStorage (PWA),
   key `rk_backend`, written when a setup link is accepted.
2. `BAKED_BACKEND`, substituted by `build.js` **only** when `--bake` is
   passed and a gitignored `deploy.config.json` exists.
3. Nothing → the **Connect screen** (`s-connect`).

**Android backup is off (`allowBackup="false"`), and must stay off.**
Capacitor's default is `true`, and Auto Backup includes SharedPreferences —
which is where both `rk_backend` and all of `PrefsStore` live, meaning a
family's saved places and their live Supabase `access_token`/`refresh_token`
were being copied to Google Drive. The symptom that exposed it: a
**reinstall silently restored `rk_backend`**, so the app booted
already-connected and went to the sign-in screen, and a genuinely fresh
install appeared never to show the Connect screen. `dataExtractionRules`
covers the same ground for API 31+, where `allowBackup` alone does not
disable device-to-device transfer. The cost is re-linking after a phone
swap. See 4.5.10.

`npm run build` (and therefore `npm run sync` → the Android build) is
**unbaked** — that is what ships to Play. `npm run build:pwa` bakes, for
the owner's own pre-connected S3/CloudFront deployment. The default is
unbaked on purpose: a default-on bake would quietly ship one family's
project inside the store APK.

**Setup link format** — everything rides in the URL *fragment*, never the
query string, so a family's project URL and key can never appear in the
landing host's access logs:

```
https://get.roamkeep.app/s#v=1&u=<base64url(projectUrl)>&k=<anonKey>&c=<inviteCode>
```

`parseSetupLink` also accepts the custom scheme and a bare fragment, and
rejects anything not `https`. `buildSetupLink` is the inverse and powers
the invite share — one link now carries **both** the server and the join
code, which is what makes a cross-device invite possible at all when the
app isn't compiled against a fixed backend.

⚠ **The link format lives in THREE places** — `app.js`
(`buildSetupLink`/`parseSetupLink`), `tools/setup-link.js`, and
`cli/src/link.js`. `cli/test.mjs` asserts they emit byte-identical output;
drift would otherwise produce links the app silently rejects.

**Where setup links come from.** Two sources, and the second exists to
close a chicken-and-egg: an owner's in-app Invite share covers *joining*,
but the FIRST device on a brand-new project has no owner to ask — so
`cli/` (the provisioning wizard) prints the first link at the end of
setup, and `npm run link` does the same from `deploy.config.json` for an
existing project.

`landing/` is the static site behind `get.roamkeep.app`, for links tapped
on a device without the app. **Android App Links** (`autoVerify` on the
MainActivity intent-filter + `landing/.well-known/assetlinks.json`) make
an installed app intercept them instead. Play App Signing re-signs with
Google's key, so the Play build's fingerprint differs from the sideload
one and **both must be listed in assetlinks.json** — see
`landing/README.md`.

QR scanning uses `@capacitor-mlkit/barcode-scanning`'s `scan()`, which
hands off to Google's on-demand code-scanner activity (it owns the camera
permission — don't gate on our own check). `android/build.gradle`
substitutes `com.google.mlkit:barcode-scanning` for the Play-Services
variant; without that the bundled detection model takes the APK from
2.6 MB to 23 MB.

Settings → **Disconnect this device** clears the stored config, native
context and geofences, then reloads to the Connect screen.

## Backend (Supabase)

- The owner's own project ref is `<your-project-ref>`, kept in the
  gitignored `deploy.config.json` rather than in source. Any anon key is
  public by design — every table is protected by RLS.
- Schema: run `db/schema.sql` against a fresh project (idempotent,
  non-destructive). The numbered files in `db/migrations/` are the
  historical record and the per-delta upgrade path for an existing DB.
- Auth: email/password with confirmations OFF. Keep create/join go
  through `SECURITY DEFINER` RPCs (`create_keep`, `join_keep_by_code`)
  so the insert-then-membership-check race is atomic.
- Realtime: `keep_members`, `checkins`, `keep_places`, `location_history`
  are in the `supabase_realtime` publication. `keep_places` needs
  `REPLICA IDENTITY FULL` so DELETE events carry `keep_id` past the
  client-side filter.
- `location_history` is the per-member breadcrumb trail (7 days:
  client-pruned on launch, plus a pg_cron sweep from the v7 migration if
  the extension is enabled). Rows carry the GPS `speed` (m/s, nullable).
  On the **Android app** it's written natively by
  `LocationUpdateReceiver` — a `FusedLocationProvider` PendingIntent
  target that records points even while the WebView is suspended, so a
  whole walk is captured. The OS distance-gates via
  `setMinUpdateDistanceMeters`. On the **PWA** the JS path writes it
  (distance-gated in `pushLocation`). The trail extends live via a
  `location_history` realtime subscription (one source for both paths).
  Tap a member to load+draw their trail (last 24h). Tracking modes
  (auto/live/balanced/saver) live in Capacitor Preferences (and
  `PrefsStore`, so `BootReceiver` can re-arm updates after a reboot) and
  tune the native `LocationRequest` priority/interval/displacement + the
  live-pin cadence — the battery lever.
- The **History timeline** (History tab) is a per-member, per-day
  journal over the 7-day window: stays at saved places (reconstructed
  from arrived/left check-in pairs — breadcrumbs are suppressed inside
  places, so check-ins are the only stay signal) interleaved with trips
  (`segmentTrips` over that day's breadcrumbs, classified walk/drive
  from GPS speed with a distance/time fallback). Queries run on demand
  when the tab opens; tapping a trip draws it via the trail machinery.
- **Per-place notifications (v13).** `keep_notify_prefs` holds *exception
  rows only* — a row means "don't tell me about this person at this
  place", no row means notify — so an empty table is exactly pre-v13
  behaviour. The rule is written once in SQL and read from both
  directions, because the two consumers ask opposite questions:
  `checkin_recipients(id)` answers "who to wake for this check-in" (the
  Edge Function), and the `my_checkin_feed` view answers "which check-ins
  should *I* raise" (the device). SOS ignores every mute, and so does a
  check-in with a NULL `place_id` (manual, or pre-v13).
  **Both filters are needed.** The wake-up is content-free and
  untargeted, so an SOS — or an unmuted event about someone else — wakes
  every phone, and the woken device then fetches everything newer than
  its watermark; filtering only in the Edge Function leaks muted
  notifications through unrelated wakes. Doing the device side as a
  *view* rather than a `PrefsStore` cache is deliberate: a mirrored mute
  set would be a fourth instance of the divergence bug below.
- Edge Functions `notify-checkin` and `notify-places` (see
  `supabase/README.md` for deploy). Database Webhooks trigger them —
  `checkins` INSERT and `keep_places` INSERT/UPDATE/DELETE. Both decide
  *who* should be woken and then call the relay; neither composes a
  notification. See "Push is content-free" below. **Both triggers are
  created by `db/schema.sql`** (`on_checkin_notify`, `on_place_notify`),
  not only by the wizard, because most owners upgrade by re-pasting that
  file — a trigger only the wizard creates is one half the deployments
  never get. They read the project's own URL from
  `roamkeep_meta.project_url` and no-op while it is NULL. `schema.sql`
  will **not** replace an existing `roamkeep_notify_checkin`: a live
  family's copy has its URL baked into the body by the wizard and works,
  and overwriting it would kill their push until `project_url` was set.
- **Place changes reach devices by push, not only realtime (v13).** A
  `keep_places` change wakes every device via `notify-places`;
  `RoamkeepMessagingService.reconcilePlaces` refetches the whole list and
  re-arms through `GeofenceArmer`. `notify-places` deliberately ignores
  `notify_on_checkin` — this is a data sync, not a notification, and
  muting alerts must not leave a phone holding stale geofences.

## Push is content-free (the relay)

There is one Roamkeep in the Play Store and its `google-services.json` is
baked in at build time, so a family's own Edge Function **cannot** send
them a push — that would need the Roamkeep Firebase service-account key.

So the chain is split in three:

1. `notify-checkin` (the family's Supabase) picks recipients — this is
   where the `notify_on_checkin` mute lives, and where SOS deliberately
   ignores it — then POSTs **just their FCM tokens** to the relay.
2. `relay/` (one Cloudflare Worker, author-run) holds the FCM key and
   sends the fixed literal `{"t":"sync"}` at HIGH priority. It sees
   tokens, counts and timing — never names, places, coordinates, or even
   the event type. **Nothing is stored and nothing is logged**;
   `[observability]` is off and must stay off — the retention claim in
   `relay/README.md` is only true while it is. The relay is therefore
   blind to its own health by design; diagnose from the family side,
   where `notify-checkin` logs `sent/dead/limited` on their own Supabase.
   Stale tokens come back as **indices**, never echoed values. Rate
   limiting is a single **global** counter keyed on a constant — a fact
   about the service, never about a caller, which is what keeps the
   retention claim unqualified. It is a quota guard, not an abuse guard.
   Per-IP was rejected (shared Supabase egress throttles unrelated
   families at school-run times) and so was per-device-hash (puts a
   counter about a device into Cloudflare's store). **Raise the ceiling as
   families are added**, or it recreates the per-IP bug at a larger scale.

   **Any change to what the relay retains or logs is a change to a public
   privacy claim — raise it before implementing, never after.**
3. `RoamkeepMessagingService` (on the device) receives the wake-up, reads
   the check-in back out of the **family's own** Supabase via
   `PrefsStore`/`SupabaseRest`, and composes the notification locally.

Net effect: notification content never passes through anything the author
operates. Every wake-up is HIGH priority precisely so the relay isn't told
which events are urgent.

Details that bite:
- The service **extends** Capacitor's `MessagingService` so `onNewToken`
  still reaches the JS registration listener, and the plugin's own
  `<service>` is `tools:node="remove"`d — two services sharing the
  `MESSAGING_EVENT` filter leaves delivery undefined.
- `:app` needs its own `firebase-messaging` dependency (the plugin
  declares it `implementation`, so it doesn't reach our classpath);
  version pinned in `variables.gradle` to match.
- `PrefsStore.lastPushSeen` is the watermark that stops a wake-up
  re-notifying old rows; a cold start only looks back 10 minutes.
- Push is best-effort: `notify-checkin` always returns 200, so a relay
  outage never fails the webhook — the notification simply appears when
  the app is next opened.


## Known constraints & deferred work

- JS-path check-ins (PWA / no native plugin) have no retry queue — only
  the native receiver does (`PrefsStore` pending queue, drained on
  resume, every receiver fire, and any breadcrumb fire with a non-empty
  queue — the breadcrumb path is the earliest proof the network is back
  after the classic WiFi→cellular handoff failure at a boundary).
- The boot-time `LocationUpdateWorker` polls at WorkManager's 15-minute
  minimum; it only covers the window between reboot and first app open,
  then `MainActivity` cancels it and `LocationForegroundService` takes over.
- Push notifications are Android-only (FCM). No web-push path yet.
