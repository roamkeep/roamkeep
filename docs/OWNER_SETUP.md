# Setting up Roamkeep for your family

**Windows walkthrough. About 20 minutes, once.**

Roamkeep has no servers. Your family gets its own private database that you
create and control — your location goes there and nowhere else, and the
people who wrote Roamkeep have no way to see it.

This guide sets that database up. One person in the family does it once,
then everyone else just scans a code.

**You do not need to be a developer.** You will copy and paste a few
commands. Nothing here writes to your PC outside one folder.

---

## What you will end up with

- A private Supabase project that only your family can read
- A **setup link and QR code** that connects each phone to it
- Roamkeep installed from Google Play on everyone's phone

## What you need

| | |
|---|---|
| A Windows PC | Only for this setup. You never need it again afterwards. |
| An email address | For the Supabase account |
| ~20 minutes | Most of it waiting for the database to start |
| Android phones | One per family member. Roamkeep is Android-only for now. |

**Cost: nothing.** Supabase's free tier is far more than a family uses.

---

## Step 1 — Install Node.js

Node.js is the tool that runs the setup wizard.

Go to **<https://nodejs.org>** and download the **LTS** version. Run the
installer and accept the defaults.

To check it worked, open **PowerShell** (press Start, type `powershell`,
press Enter) and run:

```bash
node --version
```

You should see something like `v22.14.0`. Any version 18 or higher is fine.

> If PowerShell says `node` is not recognised, close it and open a new
> PowerShell window — the installer only updates new windows.

---

## Step 2 — Download Roamkeep

Go to **<https://github.com/roamkeep/roamkeep>**, click the green **Code**
button, then **Download ZIP**.

Right-click the downloaded file → **Extract All** → extract it somewhere
simple like `C:\roamkeep`.

Then in PowerShell, move into that folder:

```bash
cd C:\roamkeep\roamkeep-main
```

> The folder name usually ends in `-main`. If `cd` complains, run `dir` in
> `C:\roamkeep` to see the actual name.

---

## Step 3 — Create a Supabase account

Supabase is the company that will host your family's database. They are the
only third party involved, and you choose which country your data sits in.

1. Go to **<https://supabase.com>** and click **Start your project**
2. Sign up (signing in with GitHub or Google is fine)
3. You do **not** need to create a project — the wizard does that

Now get an access token so the wizard can act on your behalf:

1. Go to **<https://supabase.com/dashboard/account/tokens>**
2. Click **Generate new token**, name it `roamkeep-setup`
3. **Copy it now** — Supabase only shows it once

This token is used on your PC only, to create your own project. You can
delete it from that page as soon as setup is finished.

---

## Step 4 — Run the wizard

In PowerShell, in the folder from Step 2:

```bash
cd cli; npm install; npm start
```

The wizard will ask you a few questions:

| It asks | What to do |
|---|---|
| Paste your access token | Paste the token from Step 3 |
| Which project? | Choose **Create a new project** |
| Name it | `roamkeep` is fine |
| Where should the data live? | Pick the country closest to you |

Then it works on its own for 2–3 minutes while the database starts. Leave
it running.

**It will show you a database password.** Save it somewhere safe. You will
almost certainly never need it, but nobody else has a copy.

---

## Step 5 — One manual step: notifications

The wizard will stop and tell you that arrive/leave notifications need one
more piece deployed, and give you three commands. This part cannot be
automated — it needs Supabase's own tool to package the code.

Go back to the **main** folder first:

```bash
cd ..
```

Then run the three commands the wizard printed. They look like this, with
your own project code in place of `abcdefgh…`:

```bash
npx supabase login
```

```bash
npx supabase link --project-ref abcdefgh12345678
```

```bash
npx supabase functions deploy notify-checkin --no-verify-jwt
```

> **If PowerShell opens a file in your text editor instead of running the
> command**, that is Windows finding the `supabase.js` file in this folder
> instead of the tool. Run this once and try again:
>
> ```bash
> $env:PATHEXT = $env:PATHEXT -replace ';\.JS',''
> ```

Then re-run the wizard to finish, using the command it gave you:

```bash
cd cli; npm start -- --project abcdefgh12345678 --from 9
```

> **Skipping this is allowed.** Everything works without it except push
> notifications — arrivals still appear in the app when you open it. You can
> come back and do this later.

---

## Step 6 — Your setup link

The wizard finishes by printing a **QR code** and saving two files into the
folder you ran it from:

- `roamkeep-setup-<yourproject>.txt` — the setup link and instructions
- `roamkeep-setup-<yourproject>.png` — the QR code as an image

**Keep these.** They are the only way onto your family's server.

The link contains your project address and its public key. That key is
public by design — the database is protected by its own security rules, not
by hiding the key — but anyone with the link can reach your family's sign-up
screen. **Share it like your home address, not like a password.**

---

## Step 7 — Set up the first phone

1. Install **Roamkeep** from Google Play
2. Open it — it asks which family server to use
3. Tap **Scan setup QR code** and scan the code on your PC screen
   (or tap **Paste setup link** and paste the line from the `.txt` file)
4. Create your account
5. Read the permissions screen and tap **Allow** on each item

**The first person to connect creates the Keep and becomes its owner** —
that should be you.

### About the permissions

Roamkeep asks for **Allow all the time** for location. It needs this because
arrive/leave alerts happen while the phone is in a pocket and the app is
closed. Android will show a permanent notification whenever Roamkeep is
recording, so nobody is ever tracked without knowing.

It also asks for **unrestricted battery**. Without it Android eventually
suspends tracking, and alerts silently stop.

---

## Step 8 — Add the rest of the family

On your phone: **Family** tab → **Invite**. That produces a link and QR that
carries both the server address and a join code.

Each family member:

1. Installs Roamkeep from Google Play
2. Scans your invite QR
3. Creates their own account
4. Grants the same permissions

Mark children as **Child** in the Family tab — adults can pause their own
tracking, children cannot.

---

## Step 9 — Check it works

Add a saved place (**Places** → tap the map → name it "Home"), then walk or
drive out of it and back.

Within a minute or two, other family members should get an arrive/leave
notification. If they do not, open **Settings → Diagnostics** on the phone
that moved — it shows exactly which permissions are missing and what the
tracking service has been doing.

---

## Keeping your server up to date

Roamkeep updates itself on everyone's phone through the Play Store. The
**database** does not — it is yours, and only you can update it. Every so
often a new version of the app needs something new in the database, and
until you run the update those phones will show:

> **Your family's server needs updating**

That screen is deliberate. The alternative was the app quietly half-working
— arrive/leave alerts and trails simply stopping, with nothing on any screen
to say why.

To update, from the Roamkeep folder:

```bash
cd cli; npm start -- --upgrade abcdefgh12345678
```

Use your own project ref (the `abcdefgh12345678` part of your Supabase URL).
It prints the version it moved you from and to. It is additive and safe to
run more than once — **nothing your family has recorded is touched**.

If you would rather do it by hand: open your project's SQL editor, paste in
`db/schema.sql` from the Roamkeep folder, and run it. Then run this once, so
the database knows its own address and can send notifications:

```sql
update roamkeep_meta set project_url = 'https://abcdefgh12345678.supabase.co';
```

The wizard does that step for you, which is the main reason to prefer it.

Once the update is done, anyone stuck on that screen just needs to open the
app again — no reinstall, nothing lost.

---

## If something goes wrong

**The wizard failed partway.** Every step is safe to repeat. Re-run it with
the step number it told you:

```bash
cd cli; npm start -- --project abcdefgh12345678 --from 4
```

**You lost the setup link.** Get your project's `anon` `public` key from
Supabase Dashboard → Project Settings → API, then from the main folder:

```bash
node tools/setup-link.js --url https://abcdefgh12345678.supabase.co --key YOUR_ANON_KEY
```

**A phone shows the wrong family, or nobody at all.** Open the app again —
it refetches on every open. If it still looks wrong, Settings → Diagnostics
shows whether the phone can reach your server.

**You want to start over.** Delete the project in the Supabase dashboard and
run the wizard again. That erases everything your family ever recorded,
immediately and permanently.

---

## Your data, plainly

- It lives in **your** Supabase project, in the country you chose
- Only members of your Keep can read it — enforced by the database itself,
  not just by the app
- Location history is deleted automatically after **7 days**
- Deleting the Supabase project destroys everything at once
- Nothing is ever sent to the people who wrote Roamkeep

The one exception is notification delivery. Waking up an Android phone has
to go through Google, so Roamkeep sends a **content-free** signal — no
names, no places, no coordinates. Your phone then reads the actual details
from your own database and writes the notification itself. See the
[privacy policy](https://get.roamkeep.app/privacy) for the full picture.
