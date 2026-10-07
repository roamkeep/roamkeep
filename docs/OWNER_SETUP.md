# Setting up Roamkeep for your family

**About five minutes, once, on your phone.** A computer works too: see
[Setting up from a computer](#setting-up-from-a-computer).

No server of ours holds your family's data. Your family gets its own private
database that you create and control. Your location goes there and nowhere
else, and the people who wrote Roamkeep have no way to see it. The only
service we operate is a small relay that wakes phones with an empty message;
it never sees names, places or locations.

One person in the family does this once. Everyone else just taps an invite.

**You do not need to be a developer.** The app does the technical part.

---

## What you will end up with

- A private Supabase project that only your family can read
- Roamkeep on everyone's phone, connected to it
- You as the first owner of your family's Keep

## What you need

| | |
|---|---|
| Android phones | One for everyone who shares their location. Roamkeep is Android only. |
| An email address | For a free Supabase account. Supabase runs your family's database, on your own account. |
| About five minutes | Most of it waiting while the server is made |

**Cost: nothing.** Supabase's free plan is far more than a family uses. It
pauses a free project that nobody has used for a week, and a family using
Roamkeep every day keeps it awake. A free Supabase account can have two
active projects.

---

## Step 1: Set up your family's server

On your phone:

1. Install **Roamkeep** from Google Play and open it.
2. Tap **Set up a new family**.
3. Tap **Create a free Supabase account** and sign up, or tap **I have an
   account**.
4. **Give Roamkeep a temporary key.** Tap **Open the token page** and
   generate a new token:
   - **Name** it `Roamkeep`; **Expires in**: the shortest offered.
   - **Resource access**: **Organization**, then select yours. Creating a
     project needs the organization; a Project token can't do it.
   - **Permissions**: **Full access**.
   - **Review access**, generate it, and copy it.

   Paste it into the app. It is used only on your phone, only to talk to
   Supabase, and it is never saved. If you have only just signed up,
   Supabase asks you to create an organization first: any name, on the free
   plan.
5. **Choose where your data lives.** Roamkeep suggests the region nearest
   you, from your phone's time zone. Tap **Create the family server** and
   keep the app open for about three minutes; the screen stays on.
6. **Delete the token** in Supabase when it's done (the app opens the page).
   Roamkeep has already forgotten it.
7. **Create your account and your Keep.** Sign up with your email and a
   password, then give your family a name. You are its owner.

If Roamkeep is interrupted along the way, open it again: it offers to finish,
and asks for a token again. Every step is safe to repeat.

---

## Step 2: Allow the permissions

Roamkeep explains each permission before Android asks for it.

- **Location, "Allow all the time".** Arrive and leave alerts happen while
  the phone is in a pocket and the app is closed. Android shows a permanent
  notification whenever Roamkeep is recording, so nobody is tracked without
  knowing.
- **Unrestricted battery.** Without it Android eventually suspends tracking,
  and alerts silently stop.
- **Notifications**, so alerts reach you.

On Android 11 and later, "Allow all the time" can only be chosen in the
phone's settings; Roamkeep takes you there. You can check everything later
in **Settings → Check setup**.

---

## Step 3: Add the rest of the family

Tap the **share button** at the top of the app. **Share invite** sends a link
that carries both your family's server and the join code; someone in the same
room can scan the invite's QR code instead.

Each family member:

1. Installs Roamkeep from Google Play
2. Taps the invite link, or opens Roamkeep and scans the QR code. If they
   installed the app after tapping the link, **Paste invite link** on the
   first screen picks it up.
3. Creates their own account
4. Waits for you to approve them
5. Allows the same permissions

A new Keep asks an owner to approve each person who joins, so an invite that
gets forwarded is a request rather than a way in. When someone joins, owners
get a "wants to join" notification and the person appears under **Waiting for
approval** at the top of the Family tab. Until an owner taps **Approve** they
can't see anyone, and nothing is shared from their phone. If you don't
recognise them, tap **Decline**, then rotate your invite code (**Rotate code**,
in the invite) so the invite they used stops working. A Keep created before
Roamkeep 4.11.0 lets people straight in until an owner turns on **Settings →
Approve new members**.

**What an invite link gives away.** Two things: your server's address and
the join code. The address never changes, but on its own it only gets someone
to the front door. It shows them nothing, and lets them make an account only
while new accounts are open (Step 5). The code is what lets someone ask to
join, and it stops working after 72 hours or when you rotate it. So a link
you shared months ago gets nobody in, and with approval on, a forwarded one is
a request you can decline. Removing someone from the Family tab changes the
code for you, so the invite they joined with stops working. Any invite you've
sent that hasn't been used yet stops too, so share a fresh one.

Mark children as **Child** in the Family tab. Adults can pause their own
tracking, children cannot. Children also can't leave the Keep or delete
their own account. They can ask, from **Settings → Delete my account**:
owners get a notification, and an owner deletes the account from the Family
tab. A child can always disconnect their phone, and the family sees that
they did.

New accounts can be made for 7 days after setup. If they're closed when you
share an invite, the app says so and offers to open them for 3 days (see
Step 5).

---

## Step 4: Check it works

On one phone, in the **Places** tab, tap **Add place at my location** and name
it "Home". Then walk or drive out of it and back.

Within a minute or two, the rest of the family should get an arrive or leave
notification. If they don't, open the **Family** tab on the phone that moved
and turn on **Tracking diagnostics**. It shows which permissions are missing
and what the tracking service has been doing.

---

## Step 5: New accounts: closed unless you open them

Your family's invite reaches its sign-up screen, and invites travel over text
messages. Once everyone has an account, nobody else needs to be able to
create one. Roamkeep handles this for you: after setup, new accounts can be
made for 7 days, and then the door closes by itself.

**To let someone new join later:** **Settings → New accounts → Open for 3
days**, or just share an invite and say yes when the app offers. Only the
owner of the first family on your server can change this.

**Closing it never locks your family out.** Signing in is separate from
signing up, so everyone keeps working normally, including on a brand-new
phone after a reinstall. That matters, because Roamkeep deliberately keeps
nothing in Google's backup, and a replacement phone always connects again
from scratch.

> **If you followed older advice** and turned off **Allow new users to sign
> up** in the Supabase dashboard, updating your server from the app
> (**Settings → Family server**) hands that switch to the app, still closed.
> From then on, use **Settings → New accounts**.

> **Don't turn on CAPTCHA protection** in Supabase. The app can't answer a
> CAPTCHA, so it would stop your family signing in.

---

## Setting up from a computer

The desktop wizard does the same job as Step 1. It has been tested on
Windows, and the commands below are for PowerShell. It is plain Node.js with
nothing Windows-specific, so on macOS or Linux the same commands in Terminal
should work.

### Install Node.js

Go to **<https://nodejs.org>**, download the **LTS** version and install it
with the defaults. To check, open PowerShell (press Start, type
`powershell`, press Enter) and run:

```bash
node --version
```

You need version 20 or higher.

> If PowerShell says `node` is not recognised, close it and open a new
> PowerShell window. The installer only updates new windows.

### Download Roamkeep

Go to **<https://github.com/roamkeep/roamkeep>**, click the green **Code**
button, then **Download ZIP**. Right-click the downloaded file → **Extract
All** → extract it somewhere simple like `C:\roamkeep`. Then:

```bash
cd C:\roamkeep\roamkeep-main
```

> The folder name usually ends in `-main`. If `cd` complains, run `dir` in
> `C:\roamkeep` to see the actual name.

### Get a Supabase access token

Sign up at **<https://supabase.com>** if you haven't (Supabase asks a new
account to create an organization first; the free plan is fine). Then go to
**<https://supabase.com/dashboard/account/tokens>** and generate a new token:

| Field | Choose |
|---|---|
| Name | `roamkeep-setup` |
| Expires in | the shortest offered |
| Resource access | **Organization**, then select yours |
| Permissions | **Full access** |

Then **Review access**, generate it and copy it: Supabase only shows it
once. It is used on your computer only, to create your project. Delete it as
soon as setup is finished.

For `--upgrade` the token only needs the one project: **Resource access →
Project**, select your family's, **Full access**.

### Run the wizard

```bash
cd cli; npm install; npm start
```

| It asks | What to do |
|---|---|
| Your access token | Paste the token |
| Which project? | Choose **Create a new project** |
| Name it | `roamkeep` is fine |
| Under which organization? | Only asked if you have more than one |
| Where should the data live? | Pick the region closest to you |

Then it works on its own for about three minutes. It installs the database,
the notification functions and the security rules, opens new accounts for 7
days, and checks each part answers.

**It shows you a database password.** Save it somewhere safe. You will almost
certainly never need it, but nobody else has a copy.

### Your setup link

The wizard finishes by printing a **QR code** and saving two files into the
folder you ran it from:

- `roamkeep-setup-<yourproject>.txt`: the setup link and instructions
- `roamkeep-setup-<yourproject>.png`: the QR code as an image

The link contains your project address and its public key. That key is
public by design: the database is protected by its own security rules, not
by hiding the key. But anyone with the link can reach your family's sign-up
screen while it's open. **Share it like your home address, not like a
password.**

### Connect the first phone

1. Install **Roamkeep** from Google Play and open it
2. Tap **Scan setup QR code** and scan the code on your screen, or paste the
   line from the `.txt` file into the **Setup link** box and tap **Connect**
3. Create your account and your Keep. **The first person to connect creates
   the Keep and becomes its owner**, and that should be you.

Then carry on from [Step 2](#step-2-allow-the-permissions).

---

## Keeping your server up to date

Roamkeep updates itself on everyone's phone through the Play Store. The
**database** does not: it is yours, and only you can update it. Every so
often a new version of the app needs something new in the database, and
until you run the update those phones will show:

> **Your family's server needs updating**

That screen is deliberate. The alternative was the app quietly half-working,
with arrive/leave alerts and trails simply stopping, with nothing on any screen
to say why.

Newer features can also need an update without anything stopping: an owner
sees **Settings → Family server → "an update is available"**.

**The easiest way is from your phone** (Roamkeep 4.11.0 or later, on
Android). Tap **Update the family server** on that screen, or **Update your family
server** in Settings. The app asks for an access token from your Supabase
account, updates the database and the notification functions, and shows the
version it moved you from and to. The token only needs your family's
project: generate it as for setup, but with **Resource access → Project**
and your family's project selected (phone setup names it `roamkeep`), with
**Full access**. Delete the token afterwards; the app forgets it on its
own.

If sign-ups had been switched off in the Supabase dashboard (older advice),
the update hands that switch to the app, still closed: from then on new
accounts are opened and closed in **Settings → New accounts**.

When the server is already up to date, the same button reads **Check and
repair**. It runs the same steps (all safe to repeat) and re-installs
anything that has gone missing, such as a notification function or a
database trigger. It is the first thing to try if notifications or saved
places stop reaching phones.

To update from a computer instead, from the Roamkeep folder:

```bash
cd cli; npm start -- --upgrade abcdefgh12345678
```

Use your own project ref (the `abcdefgh12345678` part of your Supabase URL).
It prints the version it moved you from and to. It is additive and safe to
run more than once: **nothing your family has recorded is touched**.

If you would rather do it by hand: open your project's SQL editor, paste in
`db/schema.sql` from the Roamkeep folder, and run it. Then run this once, so
the database knows its own address and can send notifications:

```sql
update roamkeep_meta set project_url = 'https://abcdefgh12345678.supabase.co';
```

The wizard does that step for you, which is the main reason to prefer it.

Once the update is done, anyone stuck on that screen just needs to open the
app again. No reinstall, nothing lost.

### Checking it actually took

Paste this into the SQL editor after an update:

```sql
select (select schema_version from roamkeep_meta)                    as version,
       (select project_url    from roamkeep_meta)                    as url,
       (select count(*) from information_schema.columns
         where table_name = 'checkins'
           and column_name in ('place_id','lat','lng','inserted_at')) as checkin_cols,
       (select count(*) from information_schema.tables
         where table_name = 'keep_notify_prefs')                     as prefs_table,
       (select count(*) from information_schema.routines
         where routine_name = 'checkin_recipients')                  as recipients_fn,
       (select count(*) from information_schema.views
         where table_name = 'my_checkin_feed')                       as feed_view,
       (select count(*) from information_schema.routines
         where routine_name in ('get_invite','prune_keep_history'))  as v16_fns,
       (select count(*) from information_schema.columns
         where (table_name, column_name) in
               (('keep_members','approved'), ('keeps','require_approval'),
                ('roamkeep_meta','signups_closed'),
                ('roamkeep_meta','signups_open_until'),
                ('keep_members','deletion_requested_at')))           as v17_cols,
       (select count(*) from information_schema.tables
         where table_name = 'password_reset_codes')                  as reset_table,
       (select count(*) from information_schema.routines
         where routine_name in ('my_membership','set_require_approval',
                                'approve_member','decline_member','set_signups',
                                'delete_my_account','issue_password_reset',
                                'redeem_password_reset',
                                'keep_owner_push_recipients',
                                'request_account_deletion',
                                'delete_child_account',
                                'reset_notice_recipients'))          as v17_fns,
       (select count(*) from pg_trigger
         where tgname in ('on_checkin_notify','on_place_notify',
                          'trg_checkin_normalise','trg_place_cap',
                          'on_join_request','roamkeep_signup_gate',
                          'on_deletion_request','on_reset_notice')
           and not tgisinternal)                                     as triggers,
       (select bool_and(prosrc like '%x-roamkeep-webhook%') from pg_proc
         where proname = 'roamkeep_notify_checkin')                  as sends_secret;
```

A finished v17 reads `version 17`, `url` set to **this** project,
`checkin_cols 4`, `prefs_table 1`, `recipients_fn 1`, `feed_view 1`,
`v16_fns 2`, `v17_cols 5`, `reset_table 1`, `v17_fns 12`, `triggers 8`,
`sends_secret true`.

(A finished v16 reads `v17_cols 0`, `reset_table 0`, `v17_fns 0`,
`triggers 4` and the rest the same. A finished v13–v15 also reads
`checkin_cols 3`, `v16_fns 0` and `triggers 2`.) If `sends_secret` is **false**, check-in notifications
are being refused: re-run `db/schema.sql` once `url` is set. It replaces a
notification trigger that doesn't send the secret. If it is empty, there is
no check-in trigger at all; set `url` and re-run `db/schema.sql`.

It counts objects rather than trusting `version` on purpose. The version
number tells you which migration *last ran to completion*. It cannot
tell you that the file which ran contained everything that version is
supposed to contain. Re-running `db/schema.sql` fixes any shortfall; it
is idempotent and touches no data.

---

## If something goes wrong

**The app's setup stopped partway.** Open Roamkeep again; it offers to finish
the server it started. Every step is safe to repeat.

**The desktop wizard failed partway.** Re-run it with the step number it told
you:

```bash
cd cli; npm start -- --project abcdefgh12345678 --from 4
```

**Notifications or saved places stopped reaching phones.** An owner taps
**Settings → Family server → Check and repair**. It re-installs anything that
has gone missing.

**A phone needs connecting again.** Any owner can share an invite from the app
(the share button at the top); it carries your server as well as the code.
If nobody can, get your project's `anon` `public` key from the Supabase
Dashboard → Project Settings → API, then from the main folder:

```bash
node tools/setup-link.js --url https://abcdefgh12345678.supabase.co --key YOUR_ANON_KEY
```

**Someone forgot their password.** Your family's server cannot send email,
so there is no "reset link". Instead:

- **A member:** an owner opens the Family tab, taps **Reset password** on
  their card and gives them the code. It works for 15 minutes. On the
  sign-in screen they tap **Forgot password?** and enter their email, the
  code and a new password. Their phone will later say that a code was made
  and used, so nobody's password changes without them hearing of it.
- **An owner** (codes are never made for owners): on the sign-in screen,
  **Forgot password? → I'm an owner of this Keep**. It asks
  for an access token from the Supabase account that holds your server:
  **Resource access → Project**, your family's project, **Full access**.
  Delete the token afterwards.

Codes need Roamkeep 4.11.0 and a server on version 17; the owner route
works on any version.

**A phone shows the wrong family, or nobody at all.** Open the app again:
it refetches on every open. If it still looks wrong, **Tracking
diagnostics** in the Family tab shows whether the phone can reach your
server.

**You want to start over.** Delete the project in the Supabase dashboard and
set up again. That erases everything your family ever recorded,
immediately and permanently.

---

## Your data, plainly

- It lives in **your** Supabase project, in the region you chose
- Only members of your Keep can read it, enforced by the database itself,
  not just by the app
- Location history and check-ins are deleted automatically after **7 days**
- Deleting the Supabase project destroys everything at once
- Nothing is ever sent to the people who wrote Roamkeep

The one exception is notification delivery. Waking up an Android phone has
to go through Google, so Roamkeep sends a **content-free** signal: no
names, no places, no coordinates. Your phone then reads the actual details
from your own database and writes the notification itself. See the
[privacy policy](https://get.roamkeep.app/privacy) for the full picture.
