# Roamkeep MockGPS

A ~400-line Android app that replays a GPX or KML route into the OS test
location provider, so Roamkeep can be filmed moving through a **synthetic**
place instead of a real one.

Debug build only. Never published, never signed for release.

## Why this exists rather than an app from the store

Recording the Play submission videos needs a device that appears to move.
Doing that on a personal phone in a personal street puts a real home and a
real route into a file that gets uploaded to Google and linked from a public
store listing — the same objection that stops the demo backend being seeded
from real devices.

Every off-the-shelf mock-location app solves that, and introduces a
different problem: it is closed-source code that you grant the
mock-location privilege on a phone. None of the common ones could be
audited here, and several carry ad or analytics SDKs.

This app's own code is four source files and plain `android.app.Activity` —
no AndroidX, no support library, no analytics. It has **one** dependency,
`play-services-location`, and it took a device to justify it: see
"Mocking the fused provider" below.

**The security property that matters is not the dependency count, it is
that the app cannot reach the network** — and that one is enforced by the
OS, not asserted in a README.

### It cannot reach the network

There is no `INTERNET` permission, so Android denies this process every
socket. Replaying a route is entirely offline; a mock-location app that can
reach the network can also report where it is pretending to be.

**This took an explicit fix, and the fix is load-bearing.** AGP *adds*
`android.permission.INTERNET` to debug builds by itself, for Android
Studio's deploy and profiler channels — the first build of this app shipped
with full network access despite the manifest never asking for it. The
manifest now removes it with `tools:node="remove"`, and `verifyNoInternet`
fails the build if it ever comes back.

Verify the claim yourself against the artifact, not the source:

```bash
aapt2 dump permissions app/build/outputs/apk/debug/app-debug.apk
```

Expect exactly five, and no `INTERNET`:

```
uses-permission: name='android.permission.ACCESS_MOCK_LOCATION'
uses-permission: name='android.permission.ACCESS_FINE_LOCATION'
uses-permission: name='android.permission.FOREGROUND_SERVICE'
uses-permission: name='android.permission.FOREGROUND_SERVICE_SPECIAL_USE'
uses-permission: name='android.permission.POST_NOTIFICATIONS'
```

`ACCESS_MOCK_LOCATION` is not a granted permission — declaring it is what
makes the app appear in Developer options. The real gate is the appop you
set there, and clearing it disables this app completely.

## Build and install

```bash
cd tools/mockgps && ./gradlew assembleDebug
```

```bash
adb install -r tools/mockgps/app/build/outputs/apk/debug/app-debug.apk
```

The APK is about 2.3 MB — nearly all of it play-services-location. The
app's own code is under 40 KB of it.

## Use

1. Generate the routes if you have not already:

   ```bash
   node tools/seed-demo.mjs --ref <demo-ref> --dry-run
   ```

   That writes `store/demo-drive.gpx|kml` and `store/demo-walk.gpx|kml`
   without touching the database.

2. Push one onto the device:

   ```bash
   adb push store/demo-drive.gpx /sdcard/Download/
   ```

3. On the device: **Settings → Developer options → Select mock location
   app → Roamkeep MockGPS**. The app's first button opens that screen.

4. Open MockGPS and pick the route. The hold fields fill with its first
   point automatically.

5. **Press "Hold this position" BEFORE you open Roamkeep.** See below — this
   is the step that matters.

6. Open Roamkeep, connect it to the demo backend, sign in, and start
   recording.

7. Back in MockGPS, set the speed and press **Start the route**. The service
   swaps from holding to playing in place; nothing needs stopping first.

Press **Stop** (in the app or from the notification) when done. Test
providers are removed on stop, so the device stops lying about its position
immediately.

### Hold the position first, or you leak a real one

Until something is being injected, **the phone reports where it actually
is.** Connect it to the demo backend and sign in without holding first, and
Roamkeep does exactly its job: it writes your real coordinates — your home —
into a database whose credentials are handed to Google and printed in a
public store listing. That is the same thing the demo backend exists to
avoid, arriving through the back door.

So holding is not a convenience for framing the opening shot. It is the
thing that makes the rest of it safe. Hold first, then open Roamkeep.

Two related behaviours follow from the same reasoning:

- **A finished route holds at its destination** rather than stopping.
  Stopping tears down the test providers, so the device would revert to its
  real position the moment playback ended — mid-recording, the pin would
  teleport home.
- **Stop says so plainly.** The status reads "Stopped — the device is
  reporting its real location again", because the dangerous state is the one
  that looks like nothing is happening.

You can also type any coordinate into the hold fields. Useful for putting a
device inside a saved place before a take without playing anything at all.

### Speed is the setting that matters

The replay is paced from the speed you set, not from timestamps in the file,
and that speed is written into `Location.setSpeed()`. Roamkeep's History
timeline classifies a trip walk / ride / drive from exactly that field
(`DRIVE_AVG_MS` 8 m/s, `RIDE_AVG_MS` 2.2 m/s), so:

| For | Set |
|---|---|
| A walk | 5 km/h |
| A cycle | 15 km/h |
| A drive | 45 km/h |

Because the position is interpolated along the path four times a second, the
sampling in the file is irrelevant — a 110 m-per-point route still produces
a dense trail at walking pace.

### Three things that look like bugs

**No trail for the first stretch.** Roamkeep suppresses breadcrumbs inside a
saved place, and `demo-drive.gpx` starts at Home, which has a 150 m radius.
The trail begins once playback leaves it. Let the route run a few seconds
before starting a recording.

**The pin does not move at all.** Read the MockGPS notification — it lists
the providers the OS accepted. If it lists none, the app is not selected in
Developer options. If it lists providers and Roamkeep still does not move,
Play Services' `FusedLocationProvider` is not honouring them on that device;
try an emulator instead.

**The pin bounces between the route and where you really are.** See below —
this is the failure that shaped the current design.

## Mocking the fused provider

The obvious way to mock location is `LocationManager.addTestProvider` +
`setTestProviderLocation`. That is what the first two versions did, and on a
handset it produced a trail alternating between the replayed route and the
device's real position: long spikes out and back, several a minute.

Mocking *more* LocationManager providers did not fix it. Neither did
injecting more often. **Because they are two different systems.**

Roamkeep — like most apps — reads Play Services'
`FusedLocationProviderClient`. That client runs its own location engine and
can take GNSS straight from the platform; it is under no obligation to
consult LocationManager's providers at all. Writing test providers and
expecting the fused client to notice is writing to the wrong system.

The API that actually controls it is
`FusedLocationProviderClient.setMockMode(true)` followed by
`setMockLocation()` for each fix. That is the one dependency this app has,
and it is why it has one.

Both paths are now driven: fused first, then the LocationManager providers
for anything reading those directly.

### The status line

Bottom of the MockGPS screen, and the same text in the ongoing notification.
It names the providers being mocked, and the first entry is the one to read:

```
Playing — 34% of 3.10 km at 45 km/h   ·   fused✓, gps, network, fused
                                          ^^^^^^
```

`fused✓` means Play Services accepted mock mode and the app under test will
see the route. **`fused✗` means it did not, and the pin will bounce** — the
LocationManager providers alone are not enough.

Every five seconds MockGPS also asks the fused client where it thinks it is,
and appends a warning if the answer is more than 150 m from what was just
injected:

```
⚠ fused reports 11482 m away — real fixes are getting through
```

That read-back is the only reason the app requests location permission.
Denying it loses the warning, not the playback.

An earlier version of this check asked *LocationManager* for the last known
location of a provider it had just written to — so it read back its own
injection and could never have detected this. Worth knowing if you see that
check in the history and wonder why it never fired.

## Test

The parser is pure Java and imports nothing from Android, so it runs under
plain `javac` with no framework:

```bash
javac -d /tmp/rt tools/mockgps/app/src/main/java/com/roamkeep/mockgps/Route.java tools/mockgps/RouteTest.java && java -cp /tmp/rt RouteTest
```

14 checks, including that KML's `lng,lat` ordering is not silently swapped
(which produces a valid route in the Gulf of Guinea), that interpolation
reconstructs the route's length to within 1%, and that no step between
consecutive fixes exceeds one pace.

Two of these assertions had to be rewritten when the demo routes moved from
hand-drawn lines to road geometry: one hardcoded a latitude range from the
old route, and one asserted that distance-from-start always increases —
which is false for any real road that curves back on itself. Both were
tests of the old geography rather than of the code.

## Files

| | |
|---|---|
| `Route.java` | GPX/KML parsing, distance, bearing, interpolation. No Android imports |
| `MockService.java` | Foreground service; injects 4 fixes/second into the fused client and every LocationManager provider |
| `MainActivity.java` | File picker, speed, start/stop |
| `RouteTest.java` | Standalone parser test |
