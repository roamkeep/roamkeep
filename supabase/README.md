# Supabase Edge Functions

The two functions a family's Supabase project runs for Roamkeep.

**You don't normally need this file.** Setting up a family from the app
(**Set up a new family**), the app's **Check and repair**, and the desktop
wizard all deploy both functions for you, through Supabase's Management API.
This is for understanding what they do, and for deploying by hand.

## Functions

Both decide **who** to wake, then ask the Roamkeep relay to wake those phones
with an empty message. Neither composes a notification: the woken phone
reads what happened from its own family's database and writes the
notification itself. See "Push is content-free" in
[docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md).

### `notify-checkin`

Runs when a row is inserted into `public.checkins`. It calls
`checkin_recipients(checkin_id)`, so the per-person, per-place mute rule is
written once in SQL and read from both directions (the phone reads the same
rule through the `my_checkin_feed` view). SOS ignores every mute.

### `notify-places`

Runs when a row in `public.keep_places` is inserted, updated or deleted, and
wakes every phone in the family, so each one re-reads the place list and
re-arms its geofences without the app being opened. It ignores the mute
settings on purpose: this is a data sync, not an alert, and muting alerts
must not leave a phone with stale places.

It also carries two things that wait on an owner, and wakes only the
family's owners for them: someone asking to join, and a child asking for
their account to be deleted.

**Both must be deployed.** They are separate on purpose: the rules for who
is woken share nothing, and a bug in place sync must never be able to stop
an SOS.

## Nothing to configure

- **No secrets to set.** `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are
  injected by Supabase. The functions hold no Firebase key: the relay sends
  the wake-ups, and only it has one.
- **The webhook secret makes itself.** The database generates
  `roamkeep_secrets.webhook_secret` on first apply, the triggers send it as
  an `x-roamkeep-webhook` header, and each function checks it. Nobody
  copies it anywhere.
- **The triggers come with the schema.** `db/schema.sql` creates
  `on_checkin_notify`, `on_place_notify`, `on_join_request` and
  `on_deletion_request`. They read the project's own address from
  `roamkeep_meta.project_url`, and do nothing while it is empty.

**Running your own relay?** Set `RELAY_URL` on both functions to its
address. See [relay/README.md](../relay/README.md).

## Deploying by hand

With the [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started),
signed in with `supabase login`:

```bash
supabase functions deploy notify-checkin --no-verify-jwt --project-ref <your-ref>
```

```bash
supabase functions deploy notify-places --no-verify-jwt --project-ref <your-ref>
```

`--no-verify-jwt` is needed because a database trigger has no user session
to present; the webhook secret above is what authenticates the call.
Redeploy whenever `index.ts` changes.

**Don't create the webhooks in the dashboard.** A hook made there sends no
secret, and the functions refuse it. If the triggers are missing, re-run
`db/schema.sql`, or tap **Check and repair** in the app (Settings → Family
server).

## Checking it works

```sql
select schema_version, project_url from roamkeep_meta;
```

`project_url` must be this project's address. Then insert a test check-in
and watch **Edge Functions → notify-checkin → Logs**:

```sql
INSERT INTO checkins (keep_id, member_id, member_name, member_avatar, type, place)
SELECT keep_id, id, name, avatar, 'arrived', '🏠 Test Home'
  FROM keep_members
 LIMIT 1;
```

A healthy call logs a line like `ok recipients=3 sent=3 dead=0`.

## Local development

Create `supabase/.env.local` (gitignored):

```env
SUPABASE_URL=https://<your-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service-role key, from Project Settings → API>
```

Then serve a function and post it a payload shaped like the trigger's:

```bash
supabase functions serve notify-checkin --no-verify-jwt --env-file supabase/.env.local
```

The function listens on `http://localhost:54321/functions/v1/notify-checkin`.
Against a v14 or newer database it expects the `x-roamkeep-webhook` header,
whose value you can read as the service role:
`select webhook_secret from roamkeep_secrets;`.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| No calls in the function logs | `project_url` is empty or wrong, or the triggers are missing. Re-run `db/schema.sql`, or use Check and repair. |
| `403` in the function logs | The call came without the webhook secret: usually a hook made by hand in the dashboard. Delete it; the schema's triggers are the ones to keep. |
| `dead=N` | Phones whose push token went stale. Normal: the function clears them, and each phone registers again the next time its app opens. |
| `relay 429` | The relay is turning calls away for a moment. Push is best-effort: the alerts appear when the app is next opened. |
