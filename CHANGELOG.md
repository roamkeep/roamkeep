# Changelog

What changed in each version of Roamkeep, in plain language, newest first.

"Server" means your family's own database. When a version needs it updated,
the app says so, and an owner updates it from **Settings → Family server**.
An older server keeps working; it just goes without the new features that
need it.

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
