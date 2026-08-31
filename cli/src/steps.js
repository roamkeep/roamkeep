// The provisioning steps, in order.
//
// Every step is IDEMPOTENT and individually re-runnable (`--from <n>`).
// That matters more than it sounds: the Management API's shapes drift,
// families run this once on an unfamiliar machine, and a half-provisioned
// project that can't be resumed is worse than one that never started.
//
// A step that fails reports what to do by hand instead of aborting the
// run, so a drifted endpoint costs a manual dashboard click rather than
// the whole setup.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiError } from './api.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..', '..');

export const readSchema = () =>
  fs.readFileSync(path.join(REPO, 'db', 'schema.sql'), 'utf8');

export const readFunction = () =>
  fs.readFileSync(path.join(REPO, 'supabase', 'functions', 'notify-checkin', 'index.ts'), 'utf8');

/**
 * Extensions the schema depends on.
 *
 * pgcrypto backs gen_random_bytes for invite codes; pg_cron runs the
 * 7-day breadcrumb sweep. schema.sql degrades gracefully without pg_cron
 * (it RAISEs a NOTICE and skips the job) so this is best-effort — some
 * plans don't allow it.
 */
export async function enableExtensions(api, ref) {
  const out = { pgcrypto: false, pg_cron: false };
  for (const ext of ['pgcrypto', 'pg_cron']) {
    try {
      await api.query(ref, `CREATE EXTENSION IF NOT EXISTS ${ext};`);
      out[ext] = true;
    } catch {
      out[ext] = false;
    }
  }
  return out;
}

/**
 * Apply the consolidated schema. It is idempotent and non-destructive by
 * design, so re-running is safe and is the supported upgrade path.
 */
export async function applySchema(api, ref) {
  await api.query(ref, readSchema());
}

/**
 * The schema_version that ../db/schema.sql stamps as its last statement.
 *
 * Keep this in step with that file. It is the only number the wizard
 * needs: asserting it is strictly stronger than counting tables, because
 * the stamp only lands if everything before it in the file succeeded.
 */
export const SCHEMA_VERSION = 14;

/**
 * The database's own schema version, or null if it predates the marker.
 *
 * Two queries rather than one, because a `select … from roamkeep_meta`
 * fails at PARSE time when the table is absent — CASE and COALESCE do not
 * save you, since the planner resolves the relation before any of that
 * runs. So: ask whether it exists, then read it.
 */
export async function readSchemaVersion(api, ref) {
  const t = await api.query(ref,
    `select to_regclass('public.roamkeep_meta') is not null as present;`);
  const present = (Array.isArray(t) ? t[0] : t)?.present;
  if (!present) return null;
  const rows = await api.query(ref, `select schema_version from roamkeep_meta limit 1;`);
  const r = Array.isArray(rows) ? rows[0] : rows;
  const v = Number(r?.schema_version);
  return Number.isFinite(v) ? v : null;
}

/**
 * Confirm the schema actually took, rather than trusting a 200.
 *
 * Asserts the version stamp as well as the tables and RPCs the app cannot
 * work without. The stamp is the load-bearing check — schema.sql sets it
 * last, so seeing the expected number proves the whole file ran, and it
 * does not need editing every time a table is added.
 */
export async function verifySchema(api, ref) {
  const sql = `
    select
      (select count(*) from information_schema.tables
        where table_schema='public'
          and table_name in ('keeps','keep_members','checkins','keep_places',
                             'location_history','roamkeep_meta')) as tables,
      (select count(*) from information_schema.routines
        where routine_schema='public'
          and routine_name in ('create_keep','join_keep_by_code','rotate_keep_code',
                               'remove_member','roamkeep_schema_version')) as rpcs;`;
  const rows = await api.query(ref, sql);
  const r = Array.isArray(rows) ? rows[0] : rows;
  const tables = Number(r?.tables ?? 0);
  const rpcs = Number(r?.rpcs ?? 0);
  if (tables < 6 || rpcs < 5) {
    throw new Error(`schema incomplete — ${tables}/6 tables, ${rpcs}/5 RPCs`);
  }
  const version = await readSchemaVersion(api, ref);
  if (version !== SCHEMA_VERSION) {
    throw new Error(
      `schema version is ${version === null ? 'unset' : version}, expected ${SCHEMA_VERSION} ` +
      `— the schema file may not have run to completion`);
  }
  return { tables, rpcs, version };
}

/**
 * Tell the database its own URL.
 *
 * The webhook trigger functions POST to their Edge Functions and cannot
 * know the project ref from inside Postgres, so it is stored in
 * roamkeep_meta. The app's set_project_url() RPC is write-once and
 * owner-only; the wizard writes directly and is therefore authoritative —
 * if a client guessed wrong, re-running the wizard corrects it.
 *
 * `ref` reaches here from CLI input and is interpolated into SQL, so it is
 * checked against the shape Supabase actually issues rather than trusted.
 */
export async function setProjectUrl(api, ref) {
  if (!/^[a-z0-9]+$/.test(ref)) throw new Error(`refusing to use an odd project ref: ${ref}`);
  const url = `https://${ref}.supabase.co`;
  await api.query(ref, `update roamkeep_meta set project_url = '${url}', updated_at = now();`);
  return url;
}

/**
 * Turn OFF email confirmation.
 *
 * The app signs people straight in after sign-up; with confirmations on,
 * a family member creates an account and then sits at a screen waiting
 * for an email that the project has no SMTP configured to send. This is
 * the one setting with no SQL representation.
 */
export async function configureAuth(api, ref) {
  await api.updateAuthConfig(ref, { mailer_autoconfirm: true });
  const cfg = await api.getAuthConfig(ref);
  if (cfg && cfg.mailer_autoconfirm === false) {
    throw new Error('mailer_autoconfirm did not stick');
  }
  return true;
}

/**
 * Wire the checkins → notify-checkin webhook.
 *
 * Deliberately NOT `supabase_functions.http_request`, which is what the
 * dashboard's Webhooks UI generates. That helper lives in a
 * `supabase_functions` schema which only exists once someone has used
 * that UI — on a brand-new project it is absent and the trigger fails
 * with `schema "supabase_functions" does not exist`. Depending on it
 * would mean depending on the manual step this wizard exists to remove.
 *
 * So we own the trigger function and call pg_net directly. The payload is
 * built to match the shape notify-checkin already parses, so the edge
 * function is identical whether it was wired by the wizard or by hand in
 * the dashboard.
 *
 * No Authorization header: the function is deployed --no-verify-jwt (the
 * dashboard's own webhooks are called the same way), so it needs none —
 * and this avoids writing a service-role key into a function body that
 * any sufficiently privileged role could read back.
 */
export async function createWebhook(api, ref) {
  const url = `https://${ref}.supabase.co/functions/v1/notify-checkin`;
  const sql = `
    create extension if not exists pg_net;

    create or replace function public.roamkeep_notify_checkin()
      returns trigger
      language plpgsql
      security definer
      set search_path = public, net
    as $fn$
    begin
      perform net.http_post(
        url     := '${url}',
        headers := jsonb_build_object('Content-Type', 'application/json'),
        body    := jsonb_build_object(
                     'type',       'INSERT',
                     'table',      'checkins',
                     'schema',     'public',
                     'record',     to_jsonb(new),
                     'old_record', null
                   ),
        timeout_milliseconds := 5000
      );
      return new;
    exception when others then
      -- Push is best-effort: a webhook problem must never block the
      -- check-in itself from being written.
      return new;
    end;
    $fn$;

    -- Trigger-only: fires from the trigger below, never as an RPC. Supabase's
    -- default privileges grant EXECUTE on every new public function to anon and
    -- authenticated by name, so revoking PUBLIC alone leaves it exposed at
    -- /rest/v1/rpc/roamkeep_notify_checkin (Supabase advisor 0028/0029). Revoke
    -- the client roles explicitly. Not exploitable either way — Postgres
    -- refuses to run a trigger function called directly — but this keeps a
    -- provisioned family's advisor clean.
    revoke all on function public.roamkeep_notify_checkin() from public, anon, authenticated;

    drop trigger if exists on_checkin_notify on public.checkins;
    create trigger on_checkin_notify
      after insert on public.checkins
      for each row
      execute function public.roamkeep_notify_checkin();`;
  await api.query(ref, sql);
}

/**
 * Both webhook triggers must exist.
 *
 * on_checkin_notify is created above (or by db/schema.sql on a project
 * that has never had one). on_place_notify comes from db/schema.sql only,
 * because place sync has to reach owners who upgrade by pasting that file
 * into the SQL editor rather than running this wizard.
 *
 * Checked together so a missing one is named rather than the pair being
 * reported as a single vague failure.
 */
export async function verifyWebhook(api, ref) {
  const rows = await api.query(ref, `
    select tgname from pg_trigger
    where tgname in ('on_checkin_notify', 'on_place_notify')
      and not tgisinternal;`);
  const found = new Set((Array.isArray(rows) ? rows : [rows]).map((r) => r?.tgname));
  const missing = ['on_checkin_notify', 'on_place_notify'].filter((t) => !found.has(t));
  if (missing.length) {
    throw new Error(`webhook trigger(s) missing: ${missing.join(', ')}`);
  }
  return true;
}

/**
 * Does the edge function exist yet?
 *
 * Deploying one needs an eszip bundle, which is the supabase CLI's job —
 * reimplementing it here would be fragile and is the one place shelling
 * out is genuinely simpler. The wizard checks, and tells the user the
 * exact command if it's missing, rather than pretending to do it.
 */
export const FUNCTIONS = ['notify-checkin', 'notify-places'];

export async function checkFunction(api, ref) {
  try {
    const fns = await api.listFunctions(ref);
    const have = new Set(Array.isArray(fns) ? fns.map((f) => f.slug) : []);
    const missing = FUNCTIONS.filter((s) => !have.has(s));
    return { ok: missing.length === 0, missing };
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return { ok: false, missing: [...FUNCTIONS] };
    throw e;
  }
}

/** Pull the anon key so the wizard can print a setup link. */
export async function getAnonKey(api, ref) {
  const keys = await api.getApiKeys(ref);
  if (!Array.isArray(keys)) throw new Error('unexpected api-keys response');
  const anon = keys.find((k) => k.name === 'anon' || k.name === 'anon key');
  if (!anon?.api_key) throw new Error('anon key not present in response');
  return anon.api_key;
}

/**
 * End-to-end proof, not just "the API returned 200".
 *
 * Inserts nothing and sends no push: it calls the deployed function with
 * a synthetic webhook payload for a keep id that cannot exist, so the
 * recipient query returns empty and the function short-circuits. A 200
 * with "no recipients" proves the function is deployed, reachable,
 * parsing the payload and able to query the database.
 */
const PROBE_PAYLOAD = {
  'notify-checkin': {
    type: 'INSERT', table: 'checkins', schema: 'public', old_record: null,
    record: {
      id: '00000000-0000-0000-0000-000000000001',
      keep_id: '00000000-0000-0000-0000-0000000000ff',
      member_id: '00000000-0000-0000-0000-000000000002',
      member_name: 'setup-probe', member_avatar: '🧪',
      type: 'arrived', place: 'setup-probe', place_id: null,
    },
  },
  'notify-places': {
    type: 'INSERT', table: 'keep_places', schema: 'public', old_record: null,
    record: {
      id: '00000000-0000-0000-0000-000000000003',
      keep_id: '00000000-0000-0000-0000-0000000000ff',
      name: 'setup-probe', icon: '🧪',
      lat: 0, lng: 0, radius_m: 100,
    },
  },
};

export async function probeFunction(ref, slug = 'notify-checkin') {
  const body = { ...PROBE_PAYLOAD[slug] };
  if (body.record) body.record = { ...body.record, created_at: new Date().toISOString() };
  const res = await fetch(`https://${ref}.supabase.co/functions/v1/${slug}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, body: text.slice(0, 200) };
}
