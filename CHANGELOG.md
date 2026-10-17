# Changelog

What changed in each version of Roamkeep, in plain language, newest first.

"Server" means your family's own database. When a version needs it updated,
the app says so, and an owner updates it from **Settings → Family server**.
An older server keeps working; it just goes without the new features that
need it.

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
