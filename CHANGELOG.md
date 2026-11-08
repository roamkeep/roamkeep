# Changelog

What changed in each version of Roamkeep, in plain language, newest first.

"Server" means your family's own database. When a version needs it updated,
the app says so, and an owner updates it from **Settings → Family server**.
An older server keeps working; it just goes without the new features that
need it.

## 4.12.1 (in testing)

No server update is needed.

- **Driving past a place no longer announces it.** An arrival is now
  announced once someone has been there for three minutes, so driving
  through a saved place, or waiting at lights inside one, sends nothing, and
  nor does the departure that follows. Every arrival alert therefore comes
  about three minutes late; it shows the time they actually arrived.
  Departures are not delayed.
- **Places side by side are one place at a time.** Where a home and a
  school overlap, someone in the part they share counts as at whichever
  place's middle they are nearer, so the family hears "left Home" and
  "arrived School" once, as they cross the middle, rather than a string of
  arrivals and departures at either edge. A place inside another, like a
  home inside a town, is not affected.
- **A short stop no longer hides inside a drive.** A quick stop at a saved
  place, like a school drop-off, made one long Drive in History, with the
  stop listed after it. It is now two trips with the stop between them, in
  History, on the map and in the trip count. It is worked out from arrivals
  and departures already recorded, so it applies to the past week too.
- **History handles places that overlap.** Someone inside two places at
  once, such as a home next to a school, could be shown at the wrong place,
  or at one "from midnight" they had not been at. Each arrival is now paired
  with the departure from the same place.
- **The place editor says when places overlap.** When a place you put down
  shares ground with another beside it, the editor says how alerts between
  them work, and when a smaller radius would keep them apart, how small.
- **Inside two places, the more fitting one is named.** The Family tab names
  the place whose middle someone is nearer, or the smaller one when it lies
  inside the other, such as a home inside a town. It used to depend on the
  order the places were listed in.
- **Tracking diagnostics can send the whole journal.** The screen shows the
  newest 40 lines of the phone's diagnostic journal, which keeps up to 120.
  **Share journal** sends all of it as text, through the share sheet, so
  someone helping with a problem can see a whole day instead of a
  screenshot. It goes only where you send it.

## 4.12.0 (in testing)

No server update is needed.

- **History shows the walk after a drive.** Someone who drove somewhere and
  then walked on showed as one Drive for the whole outing. A walk of two
  minutes or more at the start or end of a drive is now a trip of its own,
  worked out from the speeds Roamkeep already records, so it applies to the
  past week of history too. A slow stretch in the middle of a drive stays
  part of the drive, because speed alone can't tell traffic from walking.
- **Tap a place on the map to see it.** A balloon shows the place's name and
  the size of its alert area, with Edit place, like Add place here on a
  person. Tapping a place used to centre the map on it; tapping it in the
  Places tab still does.
- **Places are now at least 100 m.** The smallest alert area is now 100 m
  (it was 25 m). That is Android's own guidance: a phone's position can be
  50 m out, and a smaller place can tell the family someone arrived and left
  while they sat still. A smaller place you already have works as before
  until someone edits it. Saving it then makes it 100 m, even if only the
  name changed, and the editor says so before you save.
- **A newly set-up phone no longer brings back older alerts.** After
  installing Roamkeep, or signing out and back in, the first alerts could
  arrive with arrivals and departures from up to half an hour earlier, some
  from before the phone was even set up, as if they had just happened. A
  phone now raises arrivals and departures only from when it is signed in.
  Everything earlier is still in Activity.
- **Setup says you don't need a Supabase project.** After you sign up,
  Supabase asks for an organization and then a project. Setup now says to
  create the organization only: Roamkeep makes the project itself, and an
  extra one takes up one of your free projects.

## 4.11.5 (in testing)

Update your family's server (Settings → Family server). A server made before
30 October 2026 keeps working without it; one set up after that date needs
it.

- **New family servers work after 30 October 2026.** From that date
  Supabase no longer lets the app reach a new table unless the database
  says so, and a new family's server is all new tables. Setting one up with
  an older version of the app gave a server that refused everything the app
  asked of it. The server now grants each table exactly what the app uses,
  nothing more. On a server you already have this changes nothing you will
  notice. If you set up a server after 30 October with an older version and
  the app cannot load your family, update the server with the desktop
  wizard's `--upgrade`, or paste `db/schema.sql` into Supabase's SQL editor.
- **Setting up a new phone no longer closes the app.** On Android 13 and
  later, tapping Allow on Location in the setup steps, before notifications
  had been allowed, could close the app. Sharing still starts only once
  notifications are allowed, as before.
- **The Places tab now shows who you have muted, as soon as it opens.** Each
  saved place has a line saying who it tells you about ("🔔 Everyone", "🔕
  Not Max"). That line was drawn before your choices had loaded, so it could
  say "Everyone" while someone was muted there. It also stayed as it was when
  someone joined, was removed or was renamed, or when you turned all
  notifications off, so it could name a person who was no longer in the
  family. It now keeps up with all of these. The switches themselves were
  always right.

## 4.11.4 (in testing)

No server update is needed.

- **"At Home" no longer sticks after someone leaves.** If a phone lost its
  connection for a moment as its owner left (usually the switch from Wi-Fi to
  mobile data at the front door), the Family tab could go on saying they were
  at home for the whole trip, while Activity showed them leaving. The phone
  now puts it right within a minute or two. Until then, the Family tab shows
  where someone actually is once their position clearly says they have gone.
  Opening the app while out no longer causes the next arrival home to be
  missed.
- **Leaving a place is no longer missed when the phone isn't sure where it
  is.** A departure reported with only a rough position used to be dropped:
  no "left" notification, the person still shown at the place, and History
  showing one long stay. The phone now waits for a few minutes of clear
  readings and then tells the family, with the time they left.
- **"Not sharing" reaches the family.** If notifications were turned off
  while the phone had no signal, the family could go on seeing "Location
  sharing on". The phone now keeps trying until the family sees the right
  status.
- **The privacy policy now lists everything Roamkeep stores.** It adds saved
  places, your notification choices, your role and status in the family, how
  passwords are kept, and the record of who is told about each check-in, which
  is deleted with the check-in after 7 days. This release collects nothing
  new; the policy now covers all of it.

## 4.11.3 (in testing)

Update your family's server (Settings → Family server). The fix is on the
server, so once it is updated it works for every version of the app.

- **Turning notifications back on no longer brings back what you muted.**
  After a long mute, you used to get a burst of the arrivals and departures
  from while they were off, going back as far as a week. Now you hear only
  what happens after you turn them on. This works for all notifications and
  for one person at one place.
- **Old arrivals and departures no longer arrive as new.** If your phone was
  off or out of signal for a while, it no longer shows you arrivals and
  departures from more than an hour ago when it comes back. They are still in
  Activity. Each notification now shows when it happened, and an SOS is always
  shown, however late.
- **Edit panels sit right on the keyboard and show their buttons.** Typing in
  a panel that slides up (your name, the family name, a place) no longer
  leaves a gap above the keyboard, or pushes the top of the panel off the
  screen. Panels now open at their full height, so Save and Update are on
  screen without dragging the panel up.
- **Stronger passwords.** A new password needs at least 8 characters
  everywhere, and can't be one of the most common passwords or contain your
  email's name. Changing your password asks for your current one, and your
  server checks it once updated. Passwords you already have keep working.
- **Supabase's Security Advisor no longer warns "Extension in Public"** on a
  server set up from the app. Nothing was exposed, but it looked alarming.
  Updating your server fixes it.

## 4.11.2 (in testing)

Update your family's server too (Settings → Family server) for the change
to declining.

- **Declining a request deletes the account made to ask**, and changes your
  invite code, as removing someone does. Before, someone you declined kept
  the account and the invite, and could keep asking again until the code ran
  out. The app says both before you decline. The person asking is told and
  signed out, so they can start again if you invite them.
- **The Sign In button works after you sign out.** It used to stay greyed
  out, reading "Please wait", until the app was closed. Create Account, Create
  Keep and Join had the same fault.
- **Cancelling a request to join says what it does.** Since 4.11.1, leaving
  deletes your account, and cancelling a request you're still waiting on
  counts as leaving. The app now says so before you confirm, and signs this
  phone out afterwards, so you can make a new account and ask again. Before,
  it kept going as if the account were still there, and asking again failed
  with an error. An owner declining your request still keeps your account.

## 4.11.1 (in testing)

Fixes from an independent review of the whole app. Update your family's
server too (Settings → Family server): most of the protections are on the
server, and they cover every version of the app.

- **Leaving deletes you.** Leaving a family, being removed by an owner, and
  a child's request being completed now all delete the person's account on
  the family's server, not only their membership and history. In Settings
  that is one button, **Leave and delete my account**. To bring someone back,
  invite them again.
- **No notification, no sharing.** Roamkeep always shows a notification while
  it shares your location. If notifications are turned off for it, it now
  stops sharing, your family sees "Not sharing: notifications are off", and
  the app shows you how to turn them back on. Before, it carried on without
  the notification.
- **Reset codes are checked again when they are used.** A code stops working
  if, before it is used, its member becomes an owner or leaves the family, or
  whoever made it is no longer an owner. The one-day block on deleting an
  account after a reset is gone: removing someone already deletes them.
- **Members waiting for approval can do nothing at all** until an owner lets
  them in, and a child can't be made an owner.
- **Location history is deleted after 7 days even if nobody opens the app**:
  every phone that is sharing now runs the clean-up once a day.
- **Deleted places stop being watched.** If your family deleted its last place
  while your phone was in the background, your phone kept watching it and
  could still say you arrived or left. Fixed, along with a case where a place
  that failed to register on the phone was never tried again.
- **Signing out or disconnecting without signal** now really signs this phone
  out, and tells you if your family couldn't be told.
- **Setup links** that carry the wrong kind of key, or anything odd, are
  refused. Nothing the app keeps for diagnosis is older than 7 days, and
  release builds no longer write place names to the system log.
- **SOS** now says the alert was sent to your family, and to call your local
  emergency number in an emergency, rather than promising they were notified.

## 4.11.0 (in testing)

The launch release.

- **Set up from your phone.** **Set up a new family** creates your family's
  server from the app in about five minutes. No computer needed. If the app
  is closed part way through, it picks up where it left off.
- **Update and repair the server from your phone**, in Settings → Family
  server. When it is already up to date, the same button checks and repairs
  it.
- **Invites that work in person and by message.** Share sends an invite
  through any app, a QR code works for someone in the same room, and someone
  who installs Roamkeep after tapping the invite can paste it on the first
  screen. A device that came in on an invite is offered Join, never Create.
- **Owners approve new members**, so a forwarded invite is a request rather
  than a way in. New families start with this on; an existing family turns it
  on in Settings. Removing someone changes the invite code, so the invite
  they joined with stops working.
- **New accounts close by themselves** 7 days after setup. Open them again in
  Settings → New accounts when someone new joins.
- **Delete my account**, in Settings. A child asks the owners instead, and an
  owner deletes it.
- **Password reset without email.** An owner gives a member a reset code.
  Your phone tells you at once when a code is made for your account and when
  it's used, and an account can't be deleted for a day after a reset. Owners
  recover theirs through the Supabase account that holds the server. Anyone
  can change their password in Settings.
- **No quiet changes.** If an owner changes what you can do, you're told.
- **One family per server.**
- The tracking notification now says what it means: "Roamkeep is sharing
  your location with your family".
- The Roamkeep logo.

The account features need server version 17.

## 4.10.0 (30 September 2026)

- Add a saved place at a family member's location, from their pin on the map.

## 4.9.3 (29 September 2026)

- Each arrival and departure is sent once. Before, a second copy was often
  sent while the first was still on its way: harmless, but it left an
  alarming "duplicate key" error in your server's logs for nearly every one.

## 4.9.2 (26 September 2026)

- An arrival recorded on an imprecise location is held, then announced (with
  its real time) once it is confirmed, or dropped together with its
  departure. The family is never told someone left a place they were never
  told they had reached.

## 4.9.1 (24 September 2026)

- The privacy policy and terms open in the browser again.
- The map follows your finger when you pan it.

## 4.9.0 (23 September 2026)

- Security fixes from a full review of the code and database (server
  version 16).
- Arrivals and departures are deleted after 7 days, like location history.
- The tracking notification comes back at once if it is swiped away.
- Far fewer writes to your server while moving, which saves battery and data.
- Screens are no longer cut off on small phones.

## 4.8.0 to 4.8.9 (27 August to 15 September 2026)

- **4.8.0:** choose whose arrivals you hear about, place by place. A place
  added or removed on one phone reaches the others within seconds. Pinch to
  zoom the map. (Server version 13.)
- **4.8.1:** the terms are agreed to before anything is collected.
- **4.8.2:** sheets close with an X and drag to expand, the keyboard no longer
  covers what you type, and signing out asks first.
- **4.8.3:** security hardening, and Leave this Keep. (Server version 14.)
- **4.8.4:** a disconnected phone says so in the family list, instead of
  looking broken.
- **4.8.5 and 4.8.6:** a phone sitting still no longer records phantom drives,
  departures are no longer cut short, and short real errands are no longer
  hidden.
- **4.8.7:** each location records how precise it was. (Server version 15.)
- **4.8.8 and 4.8.9:** an arrival that was missed no longer leaves a phone
  believing it is outside a place it is in.

## 4.7.0 (26 August 2026)

- The app checks the server's version, and asks for an update rather than
  failing in odd ways. (Server version 12.)

## 4.6.0 (21 August 2026)

- Edit your own name and avatar. Owners can rename the family. More avatars
  and trail colours.

## 4.5.0 to 4.5.16 (7 to 18 August 2026)

- **4.5.0:** the database says "Keep" everywhere. (Server version 9.)
- **4.5.2:** a place added on another phone starts working on yours without
  the app being reopened.
- **4.5.5:** a dropped connection no longer empties the family list, and a
  deleted place no longer goes on producing alerts.
- **4.5.9:** trails are as detailed as they should be again.
- **4.5.10:** Android backup is off. It was copying sign-in tokens and saved
  places to Google Drive. A new phone now connects from scratch.
- **4.5.11 to 4.5.13:** tablets get a proper layout, and QR scanning falls
  back gracefully where a phone can't scan.
- **4.5.15:** support for Android 16.
- **4.5.16:** map tiles come from OpenStreetMap's main tile server, as its
  policy asks.
