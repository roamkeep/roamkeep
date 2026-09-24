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
   re-arm heals a stale callback on long sessions. **From Android 14 the
   user can swipe the foreground-service notification away, and no API
   stops it.** Android 13 made FGS notifications dismissable by default but
   still honoured `setOngoing(true)`; 14 removed that for every app —
   ongoing notifications now hold only on the lock screen and against
   Clear all. The exemptions (CallStyle, media, enterprise DPC) don't fit a
   location app, and faking one would be misrepresentation. Because the
   notification is posted once by `startForeground()` in `onStartCommand`,
   which does not fire again while the service lives, a swipe used to leave
   it gone for the session — silently falsifying the "permanent
   notification" claim in `landing/privacy`. **Since 4.9.0 it carries a
   `deleteIntent`** (`NotificationRestoreReceiver` →
   `onTrackingNotificationDismissed`) that re-posts it at once, silently
   (same id, `IMPORTANCE_LOW`). That reverses the earlier "don't fight the
   swipe" choice (restore at the next fix, up to 5 min later): keeping the
   disclosure continuously on screen was judged to matter more for an app
   recording someone's location. `restoreNotificationIfDismissed()` still
   checks `getActiveNotifications()` on each fix and re-arm as the backstop
   for an undelivered `deleteIntent`. Its small icon is
   `ic_stat_roamkeep` — the mark as an alpha-only glyph, with the window
   punched out — so the system tints it like every other status-bar icon;
   push notifications use the same one. Replaced the old
   `@capacitor-community/background-geolocation` plugin. NOT used for
   check-ins. Foreground map smoothness uses a plain
   `@capacitor/geolocation` `watchPosition` while the app is open.

   **Write cost (4.9.0).** The JS path always throttled the live pin; the
   native path, which is the one that runs in the background, PATCHed
   `keep_members` after every batch and POSTed each breadcrumb separately —
   two requests per fix, one per 1–4 s while driving, each one waking the
   cellular radio and fanning out through Realtime to every open phone. Now
   a batch's breadcrumbs go as **one** array POST, and the pin is written only
   when it is due (`PIN_EVERY_*`, keyed on mode and moving/still, stamped in
   `PrefsStore.getLastPinWriteMs`) and only if no newer batch is already queued
   (`QUEUED`) — a backlog replayed after a slow link would otherwise PATCH a
   stale position as the live pin. A doze exit forces the pin.

   **A removed member stops, not retries.** A phone whose member row was
   deleted kept its FGS running, every write rejected by RLS (42501), and
   each 403 used to trigger a refresh-token rotation. `SupabaseRest` now
   refreshes only on 401, serialises refresh under `REFRESH_LOCK`, and counts
   consecutive 42501s; at `RLS_REJECTIONS_TO_STOP`,
   `LocationUpdateReceiver.stopForServerRejection` stops the service, removes
   the fences and sets `PrefsStore.isServerRejected`, which `BootReceiver`,
   `PauseExpiryReceiver`, the FGS and `GeofenceReceiver` all honour. Only the
   plugin's `initialize` — the app being opened and signed in — clears it.
   JS mirrors it at launch: no membership row → `teardownNative()`.

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

### The sibling bug: one rule, enforced on only one of the paths that need it

A close cousin, found in 4.8.5. Three separate rules about **fix quality**
existed and were correct — `GeofenceReceiver.DRIFT_MIN_ACC_M` (don't act on
an imprecise fix near a boundary), `detectMoving`'s `SPEED_TRUST_ACC_M`
(don't believe a fuzzy fix's speed) and its `max(MOVING_DISP_M, acc × mult)`
(a jump inside the error radius is not travel). Every one lived only where it
was first needed. `LocationUpdateReceiver`, which decides what gets **stored
forever**, applied none of them and never called `getAccuracy()` at all.

The journal caught the two paths reaching opposite verdicts about one fix,
one second apart — `geo: arrived Home fuzzy fix ±66m within 46m of edge —
drift, dropped`, while that same fix was written as a breadcrumb and became
`Drive · 501 m · top 73 km/h` on a phone parked at home.

**The rule:** a judgement about whether a fix is *trustworthy* belongs to the
fix, not to the feature that first needed it. When you add one, apply it at
every consumer, and share the constant rather than copying the number — which
is why `DRIFT_MIN_ACC_M`, `MOVING_DISP_M`, `MOVING_ACC_MULT` and
`SPEED_TRUST_ACC_M` are package-private rather than private.

The tell is the same as ever: it produced no error and no wrong-looking
screen. The diagnostics counters even looked healthy, because
`written + suppressed` summed exactly to the fire count — the sum was perfect
only because nothing was ever rejected. There is now a fourth counter, so
that identity means something.

### A dropped event is not the same as a dropped announcement

Found in 4.8.7. `GeofenceReceiver`'s drift gate refuses to act on a fuzzy fix
near a boundary — correct, and it is what stops a phone by the front gate
spamming arrived/left all night. But it `continue`d **before** the state flip,
so a gated ENTER never reached `addInsidePlace`, and the device recorded itself
*outside* a place it was sitting inside.

Nothing could put it back. **Play Services fires only on a CROSSING**, the phone
never crossed again, and both arm paths use `setInitialTrigger(0)`, so
re-registering synthesises nothing. Only someone opening the app repaired it.
Meanwhile the next genuine departure was discarded as a "spurious EXIT", so the
damage compounded.

Two lessons, and the second is the general one:

- **`insidePlaceIds` exists to pair up Play Services' own event stream, so it
  must track what Play Services believes** — not what we decided to tell the
  family. "Is this fix good enough to announce?" and "where does the OS think we
  are?" are different questions; one `continue` was answering both.
- **Dropping an EXIT is recoverable; dropping an ENTER is not**, because ENTER
  is the only event that re-establishes inside-ness. Before you discard an
  event, ask what re-sends it. If the answer is "a transition that can only
  happen if the user moves, and they haven't", discarding is permanent and the
  filter needs a reconcile behind it — which is the same rule as the divergence
  bug above: **a delta handler is an optimisation, never the only path.**

`GeofenceReceiver.repairMissedArrival` is that reconcile, called from the
breadcrumb pipeline because that path has what the receiver lacks — a position,
several times a minute, whether or not anything crossed a boundary. It is
deliberately ENTER-only (the EXIT direction heals itself when the person really
leaves) and it demands a precise fix inside by its whole error radius, so drift
cannot manufacture the arrivals the gate above exists to suppress.

It also exposed a lock that never locked. Two threads now file arrivals — the
geofence worker and the location worker — and every call site builds its **own**
`PrefsStore`, so the `synchronized` on those methods had only ever guarded an
instance nobody shared. `claimInsidePlace` folds the test and the set into one
step under the class-level `LOCK`; the loser stays quiet. **If two paths can
decide the same thing, they need a shared lock and a compare-and-set, not a
check followed by an act.**

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
- Every release that starts **depending** on something new raises
  `NEEDS_SCHEMA` in the same commit, and `SCHEMA_VERSION` in
  `cli/src/steps.js` tracks what `db/schema.sql` stamps.

  **"Depends on" is the test, not "uses".** A hard gate spends an outage
  on every family whose owner hasn't migrated yet, so it is worth it only
  for something the app genuinely cannot run without. v15's
  `location_history.accuracy` is the first case that isn't: the write
  sites gate on `S.schemaVersion >= SCHEMA_WITH_ACCURACY` (and a mirrored
  copy in `PrefsStore` for the headless path), so a family still on 13 or
  14 keeps working and just records no accuracy. `NEEDS_SCHEMA` stayed at
  13. This is the per-feature fallback the marker was designed for.

  v16 is the same shape, several times over: `get_invite`
  (`SCHEMA_WITH_GET_INVITE`), `prune_keep_history` (`SCHEMA_WITH_PRUNE`) and
  the push watermark on `checkins.inserted_at`
  (`RoamkeepMessagingService.SCHEMA_WITH_INSERTED_AT`) each have a pre-16
  path, and everything else in v16 is enforced server-side with nothing for
  the client to gate. `NEEDS_SCHEMA` is still 13.

  A gate like that needs a **second, object-level check**, because the
  number can be right and the object still missing (the `checkins.lat/lng`
  incident below). PostgREST rejects the WHOLE insert on an unknown
  column, so both write paths retry once without the field on a 400 and
  then stop sending it. Verify objects, not the number — cheaply, at the
  one call site that cares, rather than with a round trip.
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

**The filter claims `/s` and nothing else** (4.9.1). It used to claim the
whole host, which was harmless only because verification kept failing.
Once PR #96 made it succeed, every `get.roamkeep.app` URL came back to the
app — including `/privacy` and `/terms`, which the consent screen and
Settings open in the browser. Capacitor turns any off-origin navigation into
a plain `ACTION_VIEW` intent (`Bridge.launchIntent`), and Android gives a
verified App Link to its owner ahead of any browser, so the policy links
quietly bounced back into an app that only understands setup links. **Never
claim a path the app doesn't handle.** Any new page on the landing site is
automatically a browser page, which is what it should be.

QR scanning uses `@capacitor-mlkit/barcode-scanning`'s `scan()`, which
hands off to Google's on-demand code-scanner activity (it owns the camera
permission — don't gate on our own check). `android/build.gradle`
substitutes `com.google.mlkit:barcode-scanning` for the Play-Services
variant; without that the bundled detection model takes the APK from
2.6 MB to 23 MB.

Settings → **Disconnect this device** clears the stored config, native
context and geofences, then reloads to the Connect screen.

Both it and sign-out call `signOut({ scope: 'local' })`. supabase-js
defaults to `global`, which revokes **every** session the user holds — so
disconnecting an old phone quietly killed the new one at its next token
refresh, headless, with nothing on any screen. Don't drop the argument.

## Backend (Supabase)

- The owner's own project ref is `<your-project-ref>`, kept in the
  gitignored `deploy.config.json` rather than in source. Any anon key is
  public by design — every table is protected by RLS.
- Schema: run `db/schema.sql` against a fresh project (idempotent,
  non-destructive). The numbered files in `db/migrations/` are the
  historical record and the per-delta upgrade path for an existing DB.
- Auth: email/password with confirmations OFF. Keep create/join go
  through `SECURITY DEFINER` RPCs (`create_keep`, `join_keep_by_code`)
  so the insert-then-membership-check race is atomic. Because identities
  are therefore free and unlimited, the per-user join-attempt limiter is
  a speed bump rather than a wall — the 2⁵⁹ code keyspace is what makes
  guessing hopeless. Owners are told (`docs/OWNER_SETUP.md` Step 10) to
  **turn sign-ups off once their family is complete**, which removes the
  vector rather than pricing it; sign-in is a different endpoint, so a
  closed door costs existing members nothing, including after a reinstall.

  **One Keep per account (v16).** `create_keep` raises `already_member` and
  `join_keep_by_code` returns that status when the caller already has a
  membership. The app only ever opened one (the launch query takes one row,
  now `.order('created_at')` so it is at least the same one every time),
  and a second membership was what let a user pair their own `member_id`
  with someone else's `keep_id`.

- **RLS cannot pin a column to its previous value.** An UPDATE policy's
  `WITH CHECK` only ever sees the NEW row, so it can say "user_id must be
  mine" but never "keep_id must be what it already was". That gap let a
  member `create_keep` (seating them as `owner`) and then PATCH their own
  row's `keep_id` into any keep whose uuid they knew. Anything immutable
  needs a **BEFORE UPDATE trigger** — `_roamkeep_guard_member_cols`
  (role/member_type/paused_until/keep_id/user_id) and
  `_roamkeep_guard_place_cols` (created_by/keep_id). Reach for the trigger,
  not a cleverer policy; the policy cannot express it.

- **Check `(member_id, keep_id)` as a pair, never each on its own.** The
  INSERT policies on `checkins` and `location_history`, and the
  `keep_member_push` policy, used to ask "is this member_id mine?" and "is
  this keep_id mine?" separately — both true for a member of two keeps
  writing one keep's member id against the other keep. Since v16 they ask
  `(member_id, keep_id) IN (SELECT id, keep_id FROM keep_members WHERE
  user_id = auth.uid())`.

- **A client-supplied field the server acts on is set by the server (v16).**
  `_roamkeep_checkin_normalise` (BEFORE INSERT on `checkins`) stamps
  `inserted_at := now()`, clamps `created_at` to at most five minutes ahead,
  overwrites `member_name`/`member_avatar` from the member row, and nulls a
  `place_id` from another keep. Each closed a real hole: the push watermark
  trusted the sender's clock, so one future-dated row silenced every phone
  in the keep until that date; and a member could file "🆘 Mum sent an SOS"
  under their own id. Both writers already sent the true values, so the
  trigger is invisible to them. `created_at` stays the *event* time the
  timeline shows; `inserted_at` is *receipt* time, the only one a watermark
  can use. `_roamkeep_place_cap` refuses the 91st place, because Play
  Services refuses a registration of more than 100 fences **entirely** —
  one place too many disarmed the whole family.

- **`set_project_url` takes its answer from the caller's JWT.** It is where
  both triggers POST every check-in and place row, secret header included,
  and it used to accept any `*.supabase.co` from the owner of *any* keep —
  including one an outsider had just created with open sign-ups. It now
  requires `p_url` to equal the token's own issuer
  (`https://<ref>.supabase.co/auth/v1`), which only this project's auth
  server can sign, and falls back to owner-of-the-oldest-keep if a token
  carries some other `iss`. Still write-once.

- **Shared configuration the database issues to itself, not to owners.**
  `roamkeep_secrets.webhook_secret` is generated by `schema.sql` on first
  apply; the trigger sends it as a header and the Edge Functions read the
  same row with their service-role key. Nobody sets anything. The rejected
  design was an Edge Function secret each owner pastes in — which works at
  three projects and silently protects nobody at three thousand, because a
  check most deployments never enable is not a check. Same reasoning as
  `roamkeep_meta.project_url`: if every owner has to do it, assume most
  won't.

  The functions **fail closed**: only a missing table (`42P01`/`PGRST205`,
  a pre-v14 database) means "no secret, stay open"; any other lookup error
  is a 503 and is not cached. The value is cached for `SECRET_TTL_MS`
  (10 min), not for the isolate's life, so rotating it after an incident
  stops breaking push within minutes instead of whenever isolates recycle.
  Compared as SHA-256 digests, constant-time.

  **One body for `roamkeep_notify_checkin`, and schema.sql owns it.** The
  wizard's `createWebhook` used to install its own hand-written copy with no
  secret header, and every check-in push on those projects was a silent 403
  (R1 in the 2026-09 review). `webhookSql()` now extracts the function
  verbatim from `schema.sql`, `cli/test.mjs` asserts it, and the schema's
  own guard replaces an installed body lacking `x-roamkeep-webhook` once
  `project_url` is set — the condition that keeps it from swapping a working
  hardcoded-URL trigger for one that no-ops.

- Push tokens live in **`keep_member_push`** (own-row RLS), not on
  `keep_members`. That table is readable across the whole keep and RLS
  cannot restrict columns, so a token there was a token every relative
  could read.
- Realtime: `keep_members`, `checkins`, `keep_places`, `location_history`
  are in the `supabase_realtime` publication. `keep_places` needs
  `REPLICA IDENTITY FULL` so DELETE events carry `keep_id` past the
  client-side filter. The app handles a `keep_members` DELETE (a removed
  member leaves every open map; a removal of *yourself* tears down native
  tracking and reloads), but `keep_members` deliberately does **not** get
  `REPLICA IDENTITY FULL` — it is the busiest table in the publication and
  every pin update would carry the whole old row through WAL and Realtime.
  If the filtered DELETE doesn't arrive, the next refetch drops the member,
  as before.
  `location_history` is published but **not** on the main `keep:` channel:
  Realtime authorises each change per subscriber, breadcrumbs are the
  highest-volume table, and the old handler discarded almost every row.
  `subscribeTrail` opens a `trail:<member>` channel filtered on
  `member_id` only while that member's 24h trail is on screen.
- **Retention is 7 days for `location_history` AND `checkins` (v16),** and
  does not depend on pg_cron. `prune_keep_history()` (DEFINER) deletes both
  tables' expired rows for the caller's keep, and every member's app calls
  it at launch — it deletes only what the privacy page already says is
  gone, so any member may run it. The pg_cron jobs
  (`roamkeep-prune-location-history`, `roamkeep-prune-checkins`) are the
  backstop for a keep whose apps are never opened. Pre-v16 the app falls
  back to pruning its own history rows. Check-ins used to be kept forever,
  which the privacy page never said and which made the arrive/leave record
  the most revealing thing in the database.
- `location_history` is the per-member breadcrumb trail. Rows carry the
  GPS `speed` (m/s, nullable)
  and, since **v15**, the fix's own `accuracy` (m, nullable). Nothing
  reads `accuracy` — it is an instrument, not a feature. Every drift
  defence on the write path keys on the error radius, and a precise-looking
  fix is written with no further questions asked, so when a stationary
  phone files a journey anyway there are exactly two explanations: the
  fixes were imprecise and cleared the thresholds, or they claimed to be
  precise and were wrong. Without the column those are indistinguishable
  after the fact, which blocked the same diagnosis four times. Note the
  deliberate polarity difference from `speed`, which is withheld from a
  fuzzy fix because an invented speed poisons the classifier: `accuracy`
  is recorded at any value, because the fixes worth interrogating later
  are precisely the confident-looking ones.
  On the **Android app** it's written natively by
  `LocationUpdateReceiver` — a `FusedLocationProvider` PendingIntent
  target that records points even while the WebView is suspended, so a
  whole walk is captured. The OS distance-gates via
  `setMinUpdateDistanceMeters`, but **that gate alone was never enough** —
  every `applyProfile()` re-arm re-registers the request and resets its
  reference point, and the doze-exit one-shot pushes a `getCurrentLocation`
  straight into `processLocations` past the filter entirely, so a
  doze-cycling phone wrote a cold fuzzy fix every few minutes while sitting
  still. `processLocations` therefore gates writes itself. **Two gates
  answering two different questions, and confusing them is what made the
  first attempt at this fall short.** "Has the device MOVED?" cannot be
  answered from one fix — a single sample clears any threshold a fixed
  fraction of the time however good the reference, so a per-fix test does not
  stop a still phone writing, it only filters the writes down to the
  *biggest* jumps, which the timeline then sums into an even longer phantom.
  It takes an **average** (`CENTROID_TAU_MS`, whose noise falls as √N), and
  while that says still, nothing is written at all. "How far apart should
  recorded points be?" is the per-fix question, and that is the anchor gate.
  Alongside them: an accuracy ceiling, `SPEED_TRUST_ACC_M` on the `speed`
  column, and accuracy-padded place suppression. Every one distrusts only
  *imprecise* fixes, a trusted speed reading alone counts as moving, and an
  unknown state is assumed to be moving — so a good fix is never dropped and
  no trip start is lost. On the **PWA** the JS path writes it
  (distance-gated in `pushLocation`). The trail extends live via a
  per-member `location_history` realtime channel (one source for both
  paths; see Realtime above).
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
  `segmentTrips` splits on a **silence** and nothing else, and
  `isRealTrip` — the one definition of a trip worth showing, used by the
  timeline, the map and the trail pill alike, which disagreed before it
  existed — asks only that the trip covered `TRIP_MIN_M`.
  **That is deliberate, and it is the lesson of 4.8.5–4.8.6.** Three
  cleverer read-side filters were added there and all three were removed:
  a doorstep test that deleted two real errands (leaving somewhere and
  coming back is what an errand IS), a stationary split that could not
  tell a parked phone from laps of a small track, and a span test that
  caught none of the phantoms it was measured against while hiding any
  real out-and-back under 240 m. **Drift is stopped where it is written,
  not where it is drawn** — the gates in `LocationUpdateReceiver` are the
  ones that earned their place, on real journeys from two testers. A
  filter here cannot tell a short real trip from noise, because by this
  point the thing that would distinguish them — the fix accuracy — has
  already been thrown away.
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
   `relay/README.md` is only true while it is. Nothing about a *particular
   call* is recorded, so diagnose that from the family side, where
   `notify-checkin` logs `sent/dead/limited` on their own Supabase.
   Stale tokens come back as **indices**, never echoed values.

   **Two limiters, in different places.** In the Worker, a single
   **global** counter keyed on a constant — a fact about the service, never
   about a caller, which is what keeps the retention claim unqualified. It
   is a quota guard, not an abuse guard, and it does **not** protect the
   daily request allowance: `RATE_LIMITER.limit()` runs inside `fetch()`, so
   the request is already counted by the time it says no. **Raise the
   ceiling as families are added.** At the Cloudflare edge, a rate-limiting
   rule keyed on caller address — the abuse guard, and the reason the relay
   answers on `relay.roamkeep.app` rather than `workers.dev`: zone rules
   cannot be attached to a zone Cloudflare owns. A rule there runs *before*
   the Worker, so a rejected flood costs no invocation and no share of the
   global ceiling. Without it any stranger with `curl` could hold that
   ceiling at its limit and take push down for every family at once,
   silently, because push is best-effort. Its threshold is **deliberately
   unpublished** — the mechanism is disclosed, the calibration is not.
   **The `workers.dev` route must stay disabled**; while it answers, the
   rule is decorative and the old URL is in git history.

   Per-device-hash was rejected (puts a counter about a device into
   Cloudflare's store). Per-IP *inside the Worker* was too — shared Supabase
   egress throttles unrelated families at school-run times — and that hazard
   is unchanged at the edge, which is why the edge threshold is a flood
   guard rather than a precise control and must rise with the fleet.

   `[observability]` off disables Workers **Logs** (per-request records),
   not Workers **Metrics** — aggregate request and error counts are visible
   and are the right place to spot a flood. The relay is blind to
   *particular calls*, not to its own throughput.

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
- The watermark that stops a wake-up re-notifying old rows is keyed on
  **server receipt time** (`checkins.inserted_at`, v16), never on
  `created_at`. `created_at` is the sender's clock: a row delivered late
  (a queued check-in, a slow ENTER) sat behind a watermark already moved
  past it and was never notified, and a future-dated one pinned every
  device's watermark in the future. The query re-reads `OVERLAP_MS`
  (30 min) behind the mark and de-duplicates against `PrefsStore`'s seen-id
  set (device-local bookkeeping, not a mirror of DB state). SOS rows are
  fetched by a separate, uncapped query so a burst can't push one out of
  the page, and more than 5 others collapse into one summary notification.
  On a pre-v16 database it falls back to `created_at` with the same
  overlap, plus an upper bound of `FUTURE_SLACK_MS` ahead so a future-dated
  row can't pin the mark. A cold start still looks back only 10 minutes.
- `RoamkeepMessagingService.onNewToken` upserts `keep_member_push`
  natively. A token that rotated while the app was closed used to wait for
  the WebView's registration listener, and `notify-checkin` nulled the
  dead one in the meantime — no push at all until the app was next opened.
- Push is best-effort: `notify-checkin` always returns 200, so a relay
  outage never fails the webhook — the notification simply appears when
  the app is next opened.


## Known constraints & deferred work

- JS-path check-ins (PWA / no native plugin) have no retry queue — only
  the native receiver does (`PrefsStore` pending queue, drained on
  resume, every receiver fire, and any breadcrumb fire with a non-empty
  queue — the breadcrumb path is the earliest proof the network is back
  after the classic WiFi→cellular handoff failure at a boundary). Since
  4.9.0 that queue is **write-ahead**: the payload is appended before the
  POST and removed on success, so a process killed mid-request loses
  nothing. A permanent rejection (`SupabaseRest.Result.REJECTED` — a 4xx
  that retrying cannot fix, or a 409 that isn't 23505) is dropped and
  journalled, not left at the head where it used to block every later
  entry.
  **SOS is the exception on the JS side.** postgrest-js *resolves*
  `{ error }` on every failure, network included, so the old
  `try { await insert } catch {}` confirmed "ALERT SENT" unconditionally.
  `sendPendingSos` now shows sent only once the `checkins` row lands,
  retries on a backoff (`SOS_RETRY_MS`), on `online` and on resume, and
  reuses one client-generated id so a retry is idempotent (23505 = landed).
  Any new write whose success the user is told about needs the same check:
  **a resolved promise is not a successful write.**
- The boot-time `LocationUpdateWorker` polls at WorkManager's 15-minute
  minimum; it only covers the window between reboot and first app open,
  then `MainActivity` cancels it and `LocationForegroundService` takes over.
- Push notifications are Android-only (FCM). No web-push path yet.
