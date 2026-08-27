# Supabase Edge Functions

Edge functions for Roamkeep, deployed to the project's Supabase
instance via the Supabase CLI.

## Functions

### `notify-checkin`

Fans out FCM push notifications when a row is inserted into
`public.checkins` with `type IN ('arrived', 'left', 'sos')`. See the file
header in [`functions/notify-checkin/index.ts`](functions/notify-checkin/index.ts)
for the full contract.

Since **v13** it does not decide recipients itself — it calls
`checkin_recipients(checkin_id)`, so the per-person, per-place mute rule
is stated once in SQL and read from both directions (the device reads the
same rule through the `my_checkin_feed` view).

### `notify-places`

Wakes every device in a keep when a row in `public.keep_places` is
inserted, updated or deleted, so each one re-reads the place list and
re-arms its geofences without the app being opened. See the file header
in [`functions/notify-places/index.ts`](functions/notify-places/index.ts).

Two ways it deliberately differs from `notify-checkin`: it ignores
`notify_on_checkin` (this is a data sync, not a notification — muting
alerts must not leave a phone holding stale geofences), and it includes
the member who made the change, whose other devices need it.

**Both must be deployed.** They are separate functions on purpose: the
recipient rules share nothing, and a bug in place sync must not be able to
stop an SOS being delivered.

---

## Prerequisites — installing the Supabase CLI on Windows / PowerShell

Supabase doesn't publish an official npm package any more (the old
`supabase` npm package is deprecated). On Windows the supported install
paths are **Scoop** (recommended) or a **direct binary download**.

### Option A: Scoop (recommended)

[Scoop](https://scoop.sh/) is a Windows command-line installer. If you
don't have it yet:

```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
Invoke-RestMethod -Uri https://get.scoop.sh | Invoke-Expression
```

Then add the Supabase bucket and install the CLI:

```powershell
scoop bucket add supabase https://github.com/supabase/scoop-bucket.git
scoop install supabase
```

Upgrades later: `scoop update supabase`.

### Option B: Direct binary

1. Grab the latest `supabase_windows_amd64.tar.gz` from
   <https://github.com/supabase/cli/releases>.
2. Extract `supabase.exe`.
3. Move it to a directory on your `PATH`. A common choice is
   `C:\Users\<you>\AppData\Local\Programs\supabase\` — create the
   folder, drop the exe in, then add it to `PATH`:
   ```powershell
   $dest = "$env:LOCALAPPDATA\Programs\supabase"
   New-Item -ItemType Directory -Force -Path $dest | Out-Null
   Move-Item supabase.exe $dest -Force
   [Environment]::SetEnvironmentVariable(
     "Path",
     "$([Environment]::GetEnvironmentVariable('Path','User'));$dest",
     "User"
   )
   ```
   Open a fresh PowerShell window so the new `PATH` is picked up.

### Verify

```powershell
supabase --version
```

You should see something like `1.2xx.x`. If PowerShell can't find
`supabase`, the `PATH` change hasn't taken effect — close the window
and open a new one.

---

## One-time setup

Run all of the following from the **repo root**
(`<repo>`), not from inside
`supabase/`. The CLI looks for a `supabase/` subdirectory next to it.

### 1. Sign in

```powershell
supabase login
```

Opens your browser, asks you to authorise the CLI, drops a token in
`%APPDATA%\supabase\access-token`. One-time per machine.

### 2. Find your project ref

In the Supabase dashboard, open **Project Settings → General**. The
**Reference ID** (a 20-char string like `abcdefghijklmnopqrst`) is your
project ref. You'll pass it to every CLI command via `--project-ref`,
or save typing by linking once (next step).

### 3. Link the project (optional but recommended)

```powershell
supabase link --project-ref <your-project-ref>
```

When asked for the database password, paste the one from **Project
Settings → Database → Connection string** — or skip the prompt with
Enter, the password isn't needed for deploying functions or setting
secrets. Linking writes a small marker into `supabase/.temp/` and lets
you drop `--project-ref` from later commands.

If you'd rather not link, every command below has the explicit
`--project-ref <your-ref>` form too.

### 4. Generate the FCM service-account key

In the Firebase Console, **Project Settings → Service accounts →
Generate new private key**. Save the JSON as
`firebase-service-account.json` in the **repo root**. The file is
gitignored — never commit it.

### 5. Set the FCM secret

PowerShell can't safely pass a multi-line JSON string as a positional
argument to a native exe (the embedded `"` characters confuse the
Windows command-line parser on PS 5.1). Two workarounds — pick one.

**Recommended: minify the JSON to one line, then write a tiny env
file and feed it to the CLI.**

```powershell
# Read the JSON, compact whitespace.
$sa = Get-Content -Raw firebase-service-account.json |
        ConvertFrom-Json |
        ConvertTo-Json -Compress

# Write a UTF-8, no-BOM env file (avoids the BOM that Set-Content
# would add on Windows PowerShell 5.1, which confuses dotenv parsers).
[IO.File]::WriteAllText(
  (Join-Path $PWD '.fcm.env'),
  "FCM_SERVICE_ACCOUNT=$sa",
  [Text.UTF8Encoding]::new($false)
)

# Push to Supabase. Drop --project-ref if you ran `supabase link`.
supabase secrets set --env-file .fcm.env --project-ref <your-ref>

# Clean up — the env file contains the private key.
Remove-Item .fcm.env
```

**Alternative: PowerShell 7+ only.** `pwsh` 7.3+ supports proper
native-arg passing, so you can do it inline:

```powershell
$sa = Get-Content -Raw firebase-service-account.json |
        ConvertFrom-Json | ConvertTo-Json -Compress
supabase secrets set "FCM_SERVICE_ACCOUNT=$sa" --project-ref <your-ref>
```

Verify it landed:

```powershell
supabase secrets list --project-ref <your-ref>
```

You should see `FCM_SERVICE_ACCOUNT` with a hashed digest. (`SUPABASE_URL`
and `SUPABASE_SERVICE_ROLE_KEY` are auto-injected for edge functions;
you do **not** set them yourself.)

---

## Deploy

```powershell
supabase functions deploy notify-checkin --no-verify-jwt --project-ref <your-ref>
supabase functions deploy notify-places  --no-verify-jwt --project-ref <your-ref>
```

(Drop `--project-ref` if you ran `supabase link`.)

`--no-verify-jwt` is required because Database Webhooks call this
function with the webhook's own auth header, not a Supabase user JWT.

Re-deploy any time you change `index.ts` — same command.

---

## Wire up the trigger

In the Supabase Dashboard:

**Normally you don't have to.** Since v13 both triggers are created by
`db/schema.sql` (`on_checkin_notify`, `on_place_notify`), which is what
lets an owner who upgrades by pasting that file into the SQL editor get
working webhooks — a trigger only the setup wizard creates is a trigger
half the deployments never get.

They read the project's own URL from `roamkeep_meta.project_url` and do
nothing while it is NULL, so if push or place sync is silent, check that
first:

```sql
select schema_version, project_url from roamkeep_meta;
```

`db/schema.sql` will **not** overwrite an existing `roamkeep_notify_checkin`
— a live family's copy has its URL baked into the body by the setup wizard
and is working, and replacing it would kill their notifications until
`project_url` was set.

To wire one by hand instead, in the Supabase Dashboard:

1. Database → Webhooks → **Create a new hook**
2. Name: `notify-checkin`
3. Table: `checkins`
4. Events: ☑ Insert (only)
5. Type: **Supabase Edge Functions** → `notify-checkin`
6. Method: POST
7. Save.

And for place sync, a second hook: name `notify-places`, table
`keep_places`, events ☑ Insert ☑ Update ☑ Delete, function
`notify-places`, method POST.

Insert a fake `arrived` row in the SQL editor to verify the function
fires (Functions → notify-checkin → Logs):

```sql
INSERT INTO checkins (keep_id, member_id, member_name, member_avatar, type, place)
SELECT keep_id, id, name, avatar, 'arrived', '🏠 Test Home'
  FROM keep_members
 LIMIT 1;
```

---

## Local dev

You can run the function locally to iterate without a redeploy each
time. Create `supabase/.env.local` (gitignored via the `supabase/.env*`
pattern in the repo `.gitignore`) with the three vars:

```env
FCM_SERVICE_ACCOUNT={"type":"service_account",...}
SUPABASE_URL=https://<your-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service-role-key-from-Project-Settings-API>
```

Then:

```powershell
supabase functions serve notify-checkin --no-verify-jwt --env-file supabase/.env.local
```

The function listens on `http://localhost:54321/functions/v1/notify-checkin`.
Hit it with a payload that mirrors the Database Webhook shape:

```powershell
$body = @{
  type = 'INSERT'
  table = 'checkins'
  schema = 'public'
  record = @{
    id = 'test-id'
    keep_id = '<a-real-keep-id-from-your-db>'
    member_id = '<a-different-member-id>'
    member_name = 'Local Test'
    member_avatar = '🧪'
    type = 'arrived'
    place = '🏠 Test Home'
    created_at = (Get-Date -Format 'o')
  }
} | ConvertTo-Json -Compress

Invoke-RestMethod -Method Post `
  -Uri http://localhost:54321/functions/v1/notify-checkin `
  -ContentType application/json -Body $body
```

You should see the function's stdout in the `serve` window and a real
push land on the recipient's device.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `failed to import PKCS8` in function logs | The `\n` sequences inside `private_key` got stripped. Re-run the secret-set steps using `ConvertTo-Json -Compress` — that preserves the escape sequences correctly. |
| `Permission denied` on `supabase login` | Browser couldn't reach `localhost:54321` for the OAuth callback. Try `supabase login --token <pat>` with a personal access token from <https://supabase.com/dashboard/account/tokens>. |
| `Cannot find project ref` | You haven't linked. Either run `supabase link --project-ref <ref>` or pass `--project-ref <ref>` on every command. |
| Function deploys but no pushes arrive | Check the webhook is wired (Dashboard → Database → Webhooks). Insert the test row above and watch Functions → notify-checkin → Logs for an invocation. |
| `dead=N` in function logs | Stale FCM tokens. Normal — the function nulls them automatically. The next time the affected device opens the app it re-registers. |
