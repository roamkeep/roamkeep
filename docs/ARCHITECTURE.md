# How Roamkeep works

This is the design of Roamkeep for people who want to understand it, run it
for their own family, or change it: what each part does, why it is built the
way it is, and the rules that keep it correct. The code is the final word;
this explains it.

Some operational details, such as the push relay's rate-limit values, are
deliberately not published. Where that is the case, this document says so.

## The system in one paragraph

Roamkeep is one web bundle that runs two ways. As a **PWA** it is served as
static files and uses the browser's geolocation. As an **Android app** it is
wrapped in Capacitor and gains three things a browser cannot do: geofences
that the operating system watches even when the app is not running, a
foreground service that records location in the background, and push
notifications. Each family runs **their own Supabase project** as the
backend: Postgres with row-level security, realtime, auth, and two Edge
Functions. The one server Roamkeep itself runs is a small **push relay**
that wakes phones with an empty message and never sees family data.

## Where things are

```
index.html, styles.css, app.js   the app (flat at the root so it can be served as is)
supabase.js                      the vendored supabase-js bundle (not our code)
sw.js                            the service worker; its cache name changes every release
build.js                         stages the web files into dist/, minified, plus bundled helpers
android/                         the Capacitor Android project
  app/src/main/java/com/roamkeep/app/geofence/   the native geofencing, location and push code
db/schema.sql                    the complete schema: run it on a fresh project or to update one
db/migrations/README.md          the schema versions and what each one changes
db/tests/                        verify scripts for a real project, and a local PGlite harness
supabase/functions/              the two Edge Functions, notify-checkin and notify-places
relay/                           the push relay (see relay/README.md)
cli/                             the setup wizard, sharing its engine with the app's phone setup
landing/                         the invite pages, privacy policy and terms
site/                            the public website (static, no script)
tools/                           helpers: setup links, the demo seeder, brand checks, mock GPS
```

## The app

`app.js` is a single file with no framework. State lives in one object,
`S`. Event handling is delegated: an element carries
`data-action="name"` and the `ACTIONS` table dispatches to the handler, so
adding a behaviour means adding a handler and an attribute.

Nothing inside it is exported, so tests that need its real code cut the
function out of the source and run it (`cli/test.mjs` does this for the
setup-link parser, the geofence re-arm and sign-out), and a browser harness
drives the whole app with Capacitor and supabase-js stubbed. The rule is to
**test the real code, never a copy of it**: a copied function stays green
while the real one changes.

Every bottom sheet opens through one function at its full height, and moves
up by exactly the part of the screen the keyboard covers, measured natively,
so nothing a person needs to press is hidden behind the keyboard.

## Location: two mechanisms

There are two separate ways the app learns where someone is, and they do
different jobs.

### Geofences, for arrived and left

Each saved place is registered with Google Play services as a geofence.
Play services delivers the crossing to `GeofenceReceiver` even when the app
is not running, and the receiver files the check-in straight to the
family's database from Java, with no web view involved. What it needs to do
that (the session and the list of places) is kept in the app's private
storage (`PrefsStore`).

Geofences need **"Allow all the time"** location access. With only "While
using the app", Play services accepts the registration and then never
delivers a crossing unless the app is open, which looks like a geofence bug
and is not one. Fences registered before the permission was granted stay
inert even after it is, so the app checks the permission every time it
comes to the front and re-registers everything when it changes. The
first-run setup sheet asks for this permission, for notifications (see
below) and for the battery exemption.

When the native path is active, the web code still tracks which places
someone is inside for the screen, but never files check-ins itself, which
would duplicate them.

### The foreground service, for the live pin and the trail

`LocationForegroundService` holds a live location callback, which Android
honours far more faithfully than deferred delivery. Each batch of fixes is
written as the person's trail (`location_history`) in one request, and the
live pin on the map (`keep_members`) is updated only when it is due, so a
moving phone does not make a request for every fix. In automatic mode the
rate follows real GPS movement: frequent while moving, low power after a few
minutes still. The service restarts after a reboot and re-arms itself
periodically so a long session does not go stale.

**No notification, no recording.** The notification is the person's proof
that their location is being shared, so every recording path first checks
that it can be shown: the app's notifications are on and the tracking
channel is not blocked. If not, sharing stops, the way a pause does, and the
app explains why and offers to fix it. From Android 14 the notification can
be swiped away, and no app can prevent that, so the app puts it straight
back. Do not add a recording path without this check.

### Trusting a fix

A GPS fix comes with an error radius, and a phone sitting still produces
fixes that wander. The judgement of whether a fix can be trusted belongs to
the fix, not to whichever feature needed it first, so the same constants are
shared by every consumer: the geofence receiver, the motion detector and the
trail writer.

Drift is stopped **where the trail is written, not where it is drawn**.
Whether the device has moved is decided from an average of recent fixes,
since a single sample cannot tell, and while that average says still,
nothing is written. A separate test spaces the points that are written.
Both distrust only imprecise fixes, so a good fix is never dropped and the
start of a trip is never lost. The History tab then shows stays (from
arrived and left pairs) and trips (from the trail), and the only test a trip
must pass to be shown is the distance it covered: a filter applied at that
point cannot tell a short real trip from noise.

### Held arrivals and departures

A crossing reported with a fuzzy fix near the boundary is not announced at
once, because it may be drift. It is not thrown away either. The phone
records that it is inside (that state must follow what Play services
believes, or later crossings stop pairing up) and **holds** the arrival. A
held arrival is announced, with its original time, when a precise fix
confirms it, when a precise crossing does, or when the person arrived from
travel and stayed. It is discarded at the matching departure, which is then
not announced either, so the family is never told someone left a place they
were never told they had reached.

Departures are held the same way. Play services reports a crossing once, so
a fuzzy departure that turns out to be real will not be reported again, and
dropping it would leave the person "at" the place for the whole trip. While
a departure is held the phone still counts itself inside, which keeps a
phone parked near the edge from flapping between arrived and left all night.
The departure is announced when precise fixes have placed the phone clearly
outside for a few minutes, and dated by the last fix that still put it
there. Only Play services' next arrival for the place discards it: a fix
inside shows the person has not left yet, not that they never will.

The general rule: before suppressing an announcement, ask what will announce
it once the doubt is resolved, and before discarding an event, ask what will
send it again. Every path that files a check-in goes through one function,
and every accepted departure through another.

### Delivery

Check-ins filed by the native code go through a write-ahead queue: written
to the queue before the request, removed once it lands, so a phone that
loses signal at the boundary or a process that is killed mid-request loses
nothing. Each sender claims a row before sending it, so the several threads
that drain the queue never send the same row twice. A rejection that
retrying cannot fix is dropped and logged rather than blocking the queue.

A phone whose membership has been removed stops recording and removes its
geofences after repeated rejections from the database, rather than retrying
for ever. It starts again only when someone opens the app and signs in.

## Keeping the phone in step with the database

Three things on each phone hold a copy of the family's saved places: Play
services' geofence registry, the place details the receivers use, and the
record of which places the phone is inside. They exist so the native code
works with the app closed, which means every change to a place has to reach
all three, on every phone.

Realtime updates do not achieve that. Android suspends the web view's
connection while the app is in the background, and missed events are not
replayed, so an update reaches only the phones that happen to be open at
that moment. A phone that misses one looks perfectly healthy: the database
is right and the screen shows the database, while the wrong behaviour
happens in a receiver that has no screen.

So the rule is that **a realtime handler is an optimisation, never the only
path.** Anything that mirrors database rows into the operating system also
needs a reconcile against the authoritative list:

- **Pass the whole list, and prune anything absent.** Every caller
  (opening the app, a push after a place changes, and a reboot) goes through
  one function, `GeofenceArmer.arm()`, and it treats its argument as the
  complete set.
- **An empty list is a real state.** "Every place was deleted" has to reach
  the phone, or the prune never runs when it matters most.
- **A failed fetch is never an empty list.** Passing one would remove every
  geofence on the phone from a receiver with no screen. The callers treat
  "could not read" and "read, and empty" as the opposite cases they are.
- **The comparison includes the name and icon**, not just the geometry, so a
  renamed place is re-armed and its check-ins carry the new name.
- **Armed means accepted.** The list is recorded as armed only once Play
  services has accepted it, so a refused registration is retried. A list
  with one malformed row is refused as a whole, because arming the rest as
  "complete" would prune that place as if it had been deleted.

The same holds in the other direction, from the phone to the database. The
member row says which place the person is at (`last_place_id`), and the
phone writes it after each arrival and departure. That single request is
the one most likely to fail, since leaving home is when a phone hands over
from Wi-Fi to mobile data. So the phone also compares the row with its own
state on every regular update of the live pin, and sends the place again
whenever they differ. On screen, a recorded place never outranks a position
clearly outside it, and the app does not seed the phone's own state from a
place its position contradicts. A status the phone owes the family, such as
"not sharing" when notifications are off, is kept until it lands, for the
same reason.

The same reflex applies in the web code: **a failed read never overwrites
good state.** The app checks the error, keeps the last known value, and says
so if there is nothing to show.

These failures produce no error and no wrong-looking screen, so the native
code keeps a journal (Settings, Tracking diagnostics). Anything that writes native
state records it there, and anything that drops or prunes says how much.

## The backend is chosen at run time

There is no Supabase address or key compiled into the app. Every family runs
their own project, so a fresh install shows a Connect screen, and the app is
pointed at a project by a **setup link**:

```
https://get.roamkeep.app/s#v=1&u=<base64url(projectUrl)>&k=<anonKey>&c=<inviteCode>
```

Everything is in the fragment, which browsers never send to a server, so a
family's project address and key never reach the landing site's logs. The
link format is implemented three times (`app.js`, `tools/setup-link.js` and
`cli/src/link.js`), and `cli/test.mjs` runs all three and requires
byte-identical results. All three refuse a link that is not https, carries a
query or user information, has an unknown version, or carries a key that
bypasses row-level security: a setup link is shared with a whole family, so
such a key in one would be the whole database.

Android backup is **off** and must stay off. The app's private storage holds
the family's places and the session tokens, and Android's default would copy
them to the person's cloud backup. The cost is linking again after changing
phones.

**Disconnect this device** clears the stored server, the native state and
the geofences. It and sign-out end only this device's session; ending every
session would quietly sign out the person's other phones.

### Setting up and updating a family's server

The first phone can create the family's Supabase project itself (Connect,
then "Set up a new family"), running the same engine as the setup wizard in
`cli/`. Owners update or repair the server the same way, from Settings,
Family server; every step is safe to repeat.

These steps need a Supabase access token, the most powerful secret the app
ever holds. It is kept in memory only, never stored or logged, sent to no
host but Supabase's management API, and dropped when setup finishes, is
left, or is interrupted between steps. Never set up a real family from a
debug build, which logs request headers.

### Invites

An owner can share an invite through the phone's share sheet, show it as a
QR code (drawn on the phone, never by a web service, which would see every
family's server address), or let someone install first: the landing page
copies the invite, and the app reads the clipboard only when the person taps
**Paste invite link**. A link with a join code opens sign-up ready to create
an account.

Links tapped on a phone with the app installed open the app through Android
App Links. The app claims **only** the `/s` path on `get.roamkeep.app`, so
every other page there, including the privacy policy and terms, opens in the
browser as it should.

## The database

`db/schema.sql` is the complete schema. It is safe to run on a fresh project
and safe to run again to update one, and it creates everything the app
needs, triggers included, because most owners update by running that one
file. There are no separate migration files; `db/migrations/README.md`
lists the versions and what each one changes.

### Row-level security is the boundary

The anon key is public by design; every table is protected by row-level
security, and the client is not trusted.

- What each role may do to each table is granted in the schema, line by
  line, and matches what the app does: a phone can add a check-in but has no
  right to change one. Row-level security then picks the rows. Supabase used
  to grant every new table to the API by itself; from 30 October 2026 it
  grants nothing, so a table the schema does not grant cannot be reached at
  all, whatever its policies say.

- Membership is answered by one function that returns **approved**
  memberships only, so a person waiting for approval can read or write
  nothing, their own row included.
- Wherever a row names both a member and a family, the pair is checked
  together, never each half on its own.
- A policy can only see the new version of a row, never the old one, so it
  cannot say "this column must not change". Columns that must never change
  (a member's family, role and identity; who created a place) are protected
  by triggers instead.
- A field the server acts on is set by the server. A trigger on check-ins
  stamps the time the server received it, limits how far ahead the stated
  time may be, fills in the member's name and avatar from their own row, and
  drops a place from another family.
- A family can have at most 90 places, because Play services refuses a
  registration of more than 100 geofences entirely.

### Accounts and joining

- **Sign-ups close themselves.** A trigger in the database refuses new
  accounts unless an owner has opened sign-ups, and setup opens them for
  seven days. Sign-in is unaffected, so existing members never notice.
- **Owners approve joins.** Someone using an invite waits on a pending
  screen until an owner accepts or declines them. Declining deletes the
  account they made to ask, and changes the join code.
- **One family per server.** Once a family exists, no second one can be
  created on the same project.
- **Removing someone changes the join code**, so the invite they joined
  with stops working, as do any unused invites.
- **Leaving deletes the account.** Leaving, being removed and deleting your
  account all remove the person's history, membership and sign-in. A child
  cannot leave or delete their own account; they ask, and an owner
  completes it. The last owner of a family with other members in it must
  hand over first.
- A session can outlive the account it belongs to, so the app checks with
  the auth server and signs out when the account is gone.

### Passwords and resets

Passwords must be at least 8 characters, must not contain the email's name
or the app's name, and must not be one of the 5,000 most common
(`data/common-passwords.txt`, from the UK National Cyber Security Centre's
list). There are no character-mixing rules, following NIST SP 800-63B.
Changing a password needs the current one, and an updated server checks it.

Supabase's built-in email reaches only a project's own team, so resets do
not use email. An owner makes a code that works for 15 minutes and 5
attempts. Redeeming it gives the same answer for an unknown email, a wrong
code and an expired one, so nothing can be learned from it, and both
people's roles are checked again when it is used, not only when it was made.
The member is told, on their own phones, when a code is made for them and
when it is used. Owners recover their own account through their Supabase
access token.

### Retention

Trails and check-ins are kept for 7 days. Every member's app deletes expired
rows for its family, at launch and once a day from the background service,
and a scheduled job in the database does the same as a backstop.

### Notifications are decided when the event happens

A person can mute notifications about someone, everywhere or at one place.
Who is to be told about a check-in is worked out **when the check-in is
written**, and recorded (`checkin_notices`), so changing a mute later
changes nothing already decided. An SOS ignores every mute.

The rule is applied in two places that ask opposite questions: the Edge
Function asks "whose phones should be woken?", and each phone asks "which of
these should I show?". Both are needed, because a wake-up carries no content
and is not targeted, so a phone woken for one event fetches everything new.

### Webhooks

Triggers in the database call the two Edge Functions: `notify-checkin` for
each new check-in, and `notify-places` when a place changes, someone asks to
join or to have their account deleted, or a password-reset code is made or
used. The project address they call is recorded once, from the owner's
own sign-in, and cannot be pointed elsewhere afterwards. A shared secret,
generated by the schema itself, proves to the functions that a call came
from the database, and on a current schema they refuse any call when they
cannot read it.

## Schema versions

Every family runs their own database, so a schema change reaches each one
when its owner updates, while members' apps update on Google's schedule.
There are always several app versions talking to one database, for days.

- **Expand, then migrate, then contract.** New tables, columns and functions
  are added alongside the old ones; the app that uses them ships next; the
  old ones are removed only once nothing calls them, which in practice is
  months or never.
- **The database states its version** (`roamkeep_schema_version()`), as a
  number and never as a verdict, so the app's policy stays in the app. The
  app refuses to run against a database older than it can work with, and
  otherwise degrades feature by feature (`if (S.schemaVersion >= N)`).
- **Every migration sets the version as its last statement**, so a
  half-applied one reports the old number.
- **A version is frozen once it has been applied anywhere.** Changing what
  an applied version contains is the one mistake the number cannot reveal;
  ship the next version instead.
- **Verify objects, not the number.** `docs/OWNER_SETUP.md` has the query.
  `npm run test:db` applies the schema in PGlite fresh, again, and as an
  upgrade from the last release, and runs every verify script;
  `npm run test:db:mutate` weakens one rule at a time and expects a test to
  catch each.
- The app's minimum build that a database asks for is advisory only: a
  banner, never a block.
- The public repository is published **before** a release reaches Google
  Play, so a new owner never downloads a schema older than their app needs.

## Push is content-free

There is one Roamkeep on Google Play, and push can only be sent with the key
that belongs to it. A family's own Edge Function cannot hold that key, so
delivery is split in three:

1. **The family's Edge Function** decides whose phones to wake (mutes are
   applied here, and an SOS ignores them) and sends only their device tokens
   to the relay.
2. **The relay** (`relay/`) sends each token the same fixed message,
   `{"t":"sync"}`, at the same high priority, so it is never told what kind of
   event occurred or how urgent it is. It sees tokens, how many, and when;
   it stores nothing and logs nothing. Stale tokens come back as positions in
   the list, never as the tokens themselves. Its rate limiting is described
   in `relay/README.md`.
3. **The phone** wakes, reads what happened from its own family's database,
   and writes the notification itself.

So notification content never passes through anything Roamkeep runs.

A few details:

- A phone remembers how far it has read using the time the **server
  received** each check-in, never the sender's clock, so a late or
  wrongly-dated check-in can neither be skipped nor hold back later ones.
- Arrivals and departures the server received more than an hour before the
  phone hears of them, for example because it was off, are not raised as
  notifications; they stay in Activity. An SOS is always raised. Each notification shows the time the
  event happened.
- A new device token is saved by the native code at once, even with the app
  closed.
- Push is best-effort. If the relay is unreachable, the check-in is still
  saved and appears in the app when it is next opened.

## Building and releasing

```
npm run sync              build.js into dist/, then copy into the Android project
npm run android:release   a signed APK, for installing directly
npm run android:bundle    a signed AAB, the format Google Play takes
```

Build both for any release that goes to testers, from the same `dist/`.
Google Play re-signs the AAB, so its signature differs from a build you make
yourself, but `assets/public/app.js` inside it is byte-identical to
`dist/app.js`, which is how you can check an installed app against a release
(`SECURITY.md`, "Checking the app you installed").

`build.js` minifies, and the Android release build runs R8. That makes the
app smaller and protects nothing: every security decision is enforced by the
database. The default build has no server address in it; only an explicit
`npm run build:pwa` with a local config file bakes one in, for a family's
own web deployment.

Every behavioural change raises `versionCode` and `versionName` in
`android/app/build.gradle` and the cache name in `sw.js`, so installed apps
and the PWA both pick it up.

## Known limitations

- Check-ins from the PWA have no retry queue; only the Android app's native
  path does.
- Push notifications are Android only. There is no web push.
