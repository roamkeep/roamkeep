// The provisioning engine: everything it takes to turn an empty Supabase
// project into a family's Roamkeep server, as plain logic.
//
// ONE ENGINE, TWO SHELLS. The desktop wizard (index.js) and the app's
// "Set up a new family" flow both drive this file. Each shell supplies
// what differs between them and nothing else:
//
//   • an `http` function — Node's fetch in the wizard; the app's native
//     HTTP in the phone, because the Management API only accepts browser
//     requests from supabase.com (CORS), and native HTTP is not a browser;
//   • the inputs as TEXT — db/schema.sql and the Edge Function sources,
//     read from disk by the wizard and bundled into the app.
//
// So this file must never import a Node built-in or touch Buffer, process
// or the filesystem: the phone runs it too. cli/test.mjs asserts that.
//
// Every step is idempotent and individually re-runnable — the Management
// API's shapes drift, setup runs once on an unfamiliar machine (or phone),
// and a half-provisioned project that can't be resumed is worse than one
// that never started.

const BASE = 'https://api.supabase.com';

/**
 * The schema_version that db/schema.sql stamps as its last statement.
 * Keep in step with that file; cli/test.mjs checks the two agree.
 */
export const SCHEMA_VERSION = 21;

/** The Edge Functions every family server needs. */
export const FUNCTIONS = ['notify-checkin', 'notify-places'];

export class ApiError extends Error {
  constructor(status, body, path) {
    super(`${status} on ${path}: ${typeof body === 'string' ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300)}`);
    this.status = status;
    this.body = body;
    this.path = path;
  }
}

// ── The Management API client ─────────────────────────────────────

/**
 * @param token  a Supabase access token. Held only in this closure.
 * @param http   ({method, url, headers, body}) → Promise<{status, text}>
 */
export function createClient({ token, http }) {
  async function call(method, path, body, contentType = 'application/json') {
    const res = await http({
      method,
      url: BASE + path,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType },
      body: body === undefined ? undefined
        : contentType === 'application/json' ? JSON.stringify(body) : body,
    });
    let parsed = res.text;
    try { parsed = res.text ? JSON.parse(res.text) : null; } catch { /* keep raw */ }
    if (res.status < 200 || res.status >= 300) throw new ApiError(res.status, parsed, path);
    return parsed;
  }

  return {
    /** The shell's transport, for calls that are not to the Management API. */
    http,

    /** Also serves as the token check — a bad token 401s here. */
    listOrganizations: () => call('GET', '/v1/organizations'),
    /** A brand-new Supabase account can have no organization yet, and a
     *  project needs one. The phone has no dashboard to send them to. */
    createOrganization: (name) => call('POST', '/v1/organizations', { name }),
    listProjects: () => call('GET', '/v1/projects'),
    getProject: (ref) => call('GET', `/v1/projects/${ref}`),

    createProject: ({ name, organization_id, region, db_pass }) =>
      call('POST', '/v1/projects', { name, organization_id, region, db_pass, plan: 'free' }),

    /** Arbitrary SQL. The schema, the extensions and the webhook trigger
     *  all go through here — it is what removes the need for psql. */
    query: (ref, sql) => call('POST', `/v1/projects/${ref}/database/query`, { query: sql }),

    getAuthConfig: (ref) => call('GET', `/v1/projects/${ref}/config/auth`),
    updateAuthConfig: (ref, patch) => call('PATCH', `/v1/projects/${ref}/config/auth`, patch),

    listFunctions: (ref) => call('GET', `/v1/projects/${ref}/functions`),

    /**
     * Deploy (create or replace) one Edge Function from source.
     *
     * Supabase bundles server-side, so this needs no Supabase CLI and no
     * Docker — proven by the 2026-10-01 launch spike against a fresh
     * project, where both functions deployed (201) and booted with the
     * service-role key. The multipart body is built here as a STRING rather
     * than with FormData, so the phone's native HTTP can send it without
     * knowing anything about multipart.
     *
     * @param files      [{ name, content }] — the function's own source files
     * @param importMap  file name of its import map, if it has one
     */
    deployFunction: (ref, slug, files, importMap) => {
      const metadata = { name: slug, entrypoint_path: 'index.ts', verify_jwt: false };
      if (importMap) metadata.import_map_path = importMap;
      const { body, contentType } = multipart([
        { name: 'metadata', content: JSON.stringify(metadata) },
        ...files.map((f) => ({
          name: 'file', filename: f.name, content: f.content, contentType: 'application/typescript',
        })),
      ]);
      return call('POST', `/v1/projects/${ref}/functions/deploy?slug=${encodeURIComponent(slug)}`,
        body, contentType);
    },

    /** The API keys, so a setup link can be built. */
    getApiKeys: (ref) => call('GET', `/v1/projects/${ref}/api-keys`),
  };
}

/**
 * A multipart/form-data body for text parts, as a string.
 *
 * @param parts [{ name, content, filename?, contentType? }]
 */
export function multipart(parts) {
  let boundary;
  do {
    boundary = '----roamkeep' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  } while (parts.some((p) => String(p.content).includes(boundary)));
  const CRLF = '\r\n';
  let body = '';
  for (const p of parts) {
    body += `--${boundary}${CRLF}`;
    body += `Content-Disposition: form-data; name="${p.name}"`
      + (p.filename ? `; filename="${p.filename}"` : '') + CRLF;
    if (p.contentType) body += `Content-Type: ${p.contentType}${CRLF}`;
    body += CRLF + p.content + CRLF;
  }
  body += `--${boundary}--${CRLF}`;
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

/** Poll until a freshly created project is usable. */
export async function waitForProject(api, ref, { onTick, timeoutMs = 600000, sleep = defaultSleep } = {}) {
  const started = Date.now();
  for (;;) {
    let status = 'UNKNOWN';
    try {
      const p = await api.getProject(ref);
      status = p?.status || 'UNKNOWN';
    } catch (e) {
      // A just-created project 404s briefly; keep waiting.
      if (!(e instanceof ApiError) || e.status !== 404) throw e;
      status = 'CREATING';
    }
    if (status === 'ACTIVE_HEALTHY') return status;
    if (status === 'INACTIVE' || status.includes('FAILED')) {
      throw new Error(`Project entered ${status}`);
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Project still ${status} after ${Math.round(timeoutMs / 60000)} min`);
    }
    if (onTick) onTick(status, Math.round((Date.now() - started) / 1000));
    await sleep(5000);
  }
}

function defaultSleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ── The steps, in order ───────────────────────────────────────────

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
      // Leave false; the caller decides whether it matters.
    }
  }
  return out;
}

export async function applySchema(api, ref, schemaSql) {
  await api.query(ref, schemaSql);
}

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
 * owner-only; provisioning writes directly and is therefore authoritative.
 *
 * `ref` reaches here from user input and is interpolated into SQL, so it is
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
  // One write: confirmations off, and the password rules (below).
  const before = await api.getAuthConfig(ref);
  await api.updateAuthConfig(ref, { mailer_autoconfirm: true, ...passwordRulesPatch(before) });
  const cfg = await api.getAuthConfig(ref);
  if (cfg && cfg.mailer_autoconfirm === false) {
    throw new Error('mailer_autoconfirm did not stick');
  }
  return true;
}

/**
 * The server's password rules (4.11.3), run at setup (configureAuth) and on
 * every update and repair (the signups step).
 *
 * - At least PASSWORD_MIN characters. Supabase's default is 6, which is what
 *   the sign-up screen asked for, while every other way of setting a
 *   password asked for 8. Only ever raised: an owner who chose more keeps
 *   it. It applies when a password is set, so no existing one stops working.
 * - Changing a password needs the current one
 *   (security_update_password_require_current_password). Without it, an
 *   unlocked phone or a copied session could change the password and lock
 *   the person out. The app sends current_password since 4.11.3; an older
 *   app gets "Current password required" and the member uses a reset code.
 *   Not the reauthentication setting beside it: that sends an emailed code,
 *   and a family's server sends no email.
 *
 * The common-password check is the app's (passwordProblem): Supabase's own
 * leaked-password check needs a paid plan.
 */
export const PASSWORD_MIN = 8;
function passwordRulesPatch(cfg) {
  const patch = {};
  if (!((Number(cfg && cfg.password_min_length) || 0) >= PASSWORD_MIN)) patch.password_min_length = PASSWORD_MIN;
  if (!(cfg && cfg.security_update_password_require_current_password === true)) {
    patch.security_update_password_require_current_password = true;
  }
  return patch;
}
export async function applyPasswordRules(api, ref) {
  const patch = passwordRulesPatch(await api.getAuthConfig(ref));
  if (Object.keys(patch).length) await api.updateAuthConfig(ref, patch);
  return patch;
}

/**
 * The checkins → notify-checkin trigger, exactly as db/schema.sql defines it.
 *
 * Taken FROM schema.sql rather than written out here, because a second copy
 * is precisely what broke push. Until 4.9.0 this step carried its own
 * hand-written body — hardcoded URL, and no x-roamkeep-webhook header. v14
 * added that header to schema.sql and taught notify-checkin to demand it,
 * but this copy was never updated. Since this step runs AFTER the schema,
 * every provision and every --upgrade replaced the working trigger with the
 * header-less one, notify-checkin answered 403 to every check-in, and — the
 * trigger being async and error-swallowing — arrive, leave and SOS push died
 * in silence on every project the wizard touched.
 *
 * Deliberately NOT `supabase_functions.http_request` (the dashboard Webhooks
 * helper): its schema only exists once someone has used that UI, so on a
 * brand-new project it is absent. pg_net directly, as schema.sql does.
 */
export function webhookSql(schemaSql) {
  const schema = String(schemaSql).replace(/\r\n/g, '\n');
  const start = schema.indexOf('CREATE OR REPLACE FUNCTION public.roamkeep_notify_checkin()');
  const end = start < 0 ? -1 : schema.indexOf('$fn$;', start);
  if (start < 0 || end < 0) {
    throw new Error('could not find roamkeep_notify_checkin() in db/schema.sql');
  }
  const fn = schema.slice(start, end + '$fn$;'.length);
  return [
    // In extensions, as schema.sql does since v20: unnamed, it landed in
    // public and Supabase's Security Advisor flagged it.
    'create extension if not exists pg_net with schema extensions;',
    fn,
    // Trigger-only: never an RPC. Supabase's default privileges grant EXECUTE
    // on every new public function to anon and authenticated by name, so
    // revoking PUBLIC alone leaves it at /rest/v1/rpc/ (advisor 0028/0029).
    'revoke all on function public.roamkeep_notify_checkin() from public, anon, authenticated;',
    'drop trigger if exists on_checkin_notify on public.checkins;',
    'create trigger on_checkin_notify after insert on public.checkins '
      + 'for each row execute function public.roamkeep_notify_checkin();',
  ].join('\n\n');
}

/**
 * Wire the checkins → notify-checkin webhook.
 *
 * The body reads the URL from roamkeep_meta.project_url, so it must run
 * after setProjectUrl — and refuses to install a trigger that would send
 * nothing if that is still unset.
 */
export async function createWebhook(api, ref, schemaSql) {
  const rows = await api.query(ref, `select project_url from roamkeep_meta;`);
  const url = (Array.isArray(rows) ? rows[0] : rows)?.project_url;
  if (!url) {
    throw new Error('roamkeep_meta.project_url is not set — record the project URL first');
  }
  await api.query(ref, webhookSql(schemaSql));
}

/**
 * Both webhook triggers must exist, and the check-in one must send the
 * webhook secret.
 *
 * on_checkin_notify is created above (or by db/schema.sql on a project
 * that has never had one). on_place_notify comes from db/schema.sql only,
 * because place sync has to reach owners who upgrade by pasting that file
 * into the SQL editor rather than running this wizard.
 *
 * The secret check is here because its absence is silent everywhere else:
 * the trigger swallows errors and pg_net is async, so a header-less trigger
 * looks wired and simply never gets a notification delivered.
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
  const src = await api.query(ref, `
    select prosrc like '%x-roamkeep-webhook%' as sends_secret
      from pg_proc where proname = 'roamkeep_notify_checkin';`);
  if (!(Array.isArray(src) ? src[0] : src)?.sends_secret) {
    throw new Error('roamkeep_notify_checkin does not send the webhook secret — notify-checkin will reject every call');
  }
  return true;
}

/**
 * Deploy every Edge Function — create or replace, so an upgrade also
 * brings a family's functions up to the version this build ships.
 *
 * @param functions { [slug]: { files: [{ name, content }], importMap? } }
 */
export async function deployFunctions(api, ref, functions) {
  const out = {};
  for (const slug of FUNCTIONS) {
    const fn = functions[slug];
    if (!fn || !fn.files?.length) throw new Error(`no source supplied for ${slug}`);
    await api.deployFunction(ref, slug, fn.files, fn.importMap);
    out[slug] = 'deployed';
  }
  return out;
}

/** Which of the functions exist on the project. */
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

/**
 * The key a setup link carries: the legacy `anon` key while projects still
 * issue one (they did on 2026-10-01), otherwise the `sb_publishable_` key
 * that replaces it. Both are public by design; RLS is the boundary.
 */
export async function getClientKey(api, ref) {
  const keys = await api.getApiKeys(ref);
  if (!Array.isArray(keys)) throw new Error('unexpected api-keys response');
  const anon = keys.find((k) => (k.name === 'anon' || k.name === 'anon key') && k.api_key);
  if (anon) return anon.api_key;
  const pub = keys.find((k) => String(k.api_key || '').startsWith('sb_publishable_'));
  if (pub) return pub.api_key;
  throw new Error('neither an anon nor a publishable key is present in the response');
}

/**
 * End-to-end proof, not just "the API returned 200".
 *
 * Inserts nothing and sends no push: it calls the deployed function with
 * a synthetic webhook payload for a keep id that cannot exist, so the
 * recipient query returns empty and the function short-circuits. A 200
 * with "no recipients" proves the function is deployed, reachable,
 * parsing the payload and able to query the database.
 *
 * Sends the webhook secret, as the real trigger does. Since v14 both
 * functions answer 403 to a caller without it.
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

export async function probeFunction(api, ref, slug = 'notify-checkin') {
  const body = { ...PROBE_PAYLOAD[slug] };
  if (body.record) body.record = { ...body.record, created_at: new Date().toISOString() };
  const rows = await api.query(ref, `select webhook_secret from roamkeep_secrets;`).catch(() => null);
  const secret = (Array.isArray(rows) ? rows[0] : rows)?.webhook_secret;
  const headers = { 'Content-Type': 'application/json' };
  if (secret) headers['x-roamkeep-webhook'] = secret;
  const res = await api.http({
    method: 'POST',
    url: `https://${ref}.supabase.co/functions/v1/${slug}`,
    headers,
    body: JSON.stringify(body),
  });
  const ok = res.status >= 200 && res.status < 300;
  return { ok, status: res.status, body: String(res.text || '').slice(0, 200) };
}

/**
 * Probe every function, waiting out a cold start.
 *
 * A function deployed seconds ago can answer 404 or 5xx while its first
 * isolate boots. The desktop wizard tells the person to re-run a step; a
 * phone has nobody to tell, so it waits a little before believing it.
 */
export async function probeFunctions(api, ref, { attempts = 6, waitMs = 10000, sleep = defaultSleep } = {}) {
  const out = {};
  for (const slug of FUNCTIONS) {
    let last;
    for (let i = 0; i < attempts; i++) {
      last = await probeFunction(api, ref, slug);
      if (last.ok) break;
      if (i < attempts - 1) await sleep(waitMs);
    }
    if (!last.ok) throw new Error(`${slug} answered ${last.status} after ${attempts} tries`);
    out[slug] = last.status;
  }
  return out;
}

/**
 * Close sign-ups, open for the next `days`: the founding family signs up
 * inside the window, and the door shuts itself if nobody remembers to. The
 * same window the app's Settings → New accounts offers (schema v17).
 *
 * Written straight to roamkeep_meta, because set_signups() needs a signed-in
 * owner and at setup time there is nobody. Only on a project with no Keep
 * yet: provisioning resumed against a server a family already lives on must
 * not shut their door — that is an owner's decision, made in the app.
 *
 * @returns the window's end, or null when a family is already there
 */
export async function openSignupWindow(api, ref, days = 7) {
  const d = Number(days);
  if (!Number.isInteger(d) || d < 1 || d > 30) throw new Error(`sign-up window must be 1-30 days, not ${days}`);
  const rows = await api.query(ref, `
    update roamkeep_meta
       set signups_closed = true,
           signups_open_until = now() + interval '${d} days',
           updated_at = now()
     where id and not exists (select 1 from keeps)
    returning signups_open_until;`);
  return (Array.isArray(rows) ? rows[0] : rows)?.signups_open_until ?? null;
}

/**
 * Set a password on the family's server, as its Supabase account holder.
 *
 * For the one person a reset code cannot help: an owner with nobody to
 * issue them one (issue_password_reset never serves an owner, by design).
 * Their Supabase token is the real root of trust over the server, so it is
 * what authorises this — the same bcrypt write redeem_password_reset makes,
 * proved by the 2026-10-01 spike to sign in afterwards.
 *
 * Both values are user input going into SQL, so each is dollar-quoted with
 * a random tag that is checked not to occur inside it: nothing in either can
 * end the literal. NUL is refused; Postgres text cannot hold it.
 *
 * @returns the number of accounts changed — 0 when no account has that email
 */
export async function setUserPassword(api, ref, email, password) {
  const e = String(email ?? '').trim();
  const p = String(password ?? '');
  if (!e || /\0/.test(e) || /\0/.test(p)) throw new Error('invalid email or password');
  if (p.length < 8) throw new Error('password must be at least 8 characters');
  const lit = (s) => {
    let tag;
    do { tag = '$rk' + Math.random().toString(36).slice(2, 10) + '$'; } while (s.includes(tag));
    return tag + s + tag;
  };
  const rows = await api.query(ref, `
    update auth.users
       set encrypted_password = extensions.crypt(${lit(p)}, extensions.gen_salt('bf', 10)),
           updated_at = now()
     where lower(email) = lower(${lit(e)})
    returning id;`);
  return Array.isArray(rows) ? rows.length : (rows ? 1 : 0);
}

/**
 * Hand the sign-up switch to the app, keeping sign-ups closed.
 *
 * Before v17 the only way to close sign-ups was the dashboard's "Allow new
 * users to sign up", and OWNER_SETUP told owners to use it. GoTrue checks
 * that switch BEFORE the v17 trigger runs, so on such a project the app's
 * Settings → New accounts would read "Open" while every sign-up failed.
 *
 * Closes the app's gate first and only then reopens GoTrue's, so there is
 * no moment with both open: if the second call fails, sign-ups are simply
 * still closed. Needs the v17 columns, so it runs after the schema.
 *
 * @returns 'handed-over' when it moved the switch, 'app' when the app
 *          already had it
 */
export async function handOverSignups(api, ref) {
  const cfg = await api.getAuthConfig(ref);
  if (!cfg || cfg.disable_signup !== true) return 'app';
  await api.query(ref, `
    update roamkeep_meta
       set signups_closed = true, signups_open_until = null, updated_at = now()
     where id;`);
  await api.updateAuthConfig(ref, { disable_signup: false });
  return 'handed-over';
}

/**
 * Can this project be brought up to date from here?
 *
 * schema.sql is additive and safe on any keeps-era database, but on one
 * from before the v9 rename it would build a second, empty set of tables
 * beside the family's real ones. Refuse that, and refuse a database newer
 * than this engine — running an older schema over a newer one is not an
 * update.
 *
 * @returns { ok, version, reason? } — version null when it predates the marker
 */
export async function checkUpgradeable(api, ref) {
  const rows = await api.query(ref,
    `select to_regclass('public.keeps') is not null as keeps;`);
  if (!(Array.isArray(rows) ? rows[0] : rows)?.keeps) {
    return { ok: false, version: null, reason: 'not-roamkeep' };
  }
  const version = await readSchemaVersion(api, ref);
  if (version !== null && version > SCHEMA_VERSION) return { ok: false, version, reason: 'newer' };
  return { ok: true, version };
}

/**
 * Bringing an existing family's server up to date, in order. The desktop
 * wizard's --upgrade runs the same functions (checked by cli/test.mjs).
 *
 * Functions are redeployed on every update, not only when missing: a
 * release can change them as well as the schema, and old function code
 * against a new schema is the mixed state that fails silently.
 */
export function upgradeSteps({ schemaSql, functions }) {
  return [
    { id: 'extensions', run: (api, ref) => enableExtensions(api, ref) },
    { id: 'schema', run: (api, ref) => applySchema(api, ref, schemaSql) },
    { id: 'verify', run: (api, ref) => verifySchema(api, ref) },
    {
      id: 'webhook',
      run: async (api, ref) => {
        await setProjectUrl(api, ref);
        await createWebhook(api, ref, schemaSql);
        await verifyWebhook(api, ref);
      },
    },
    { id: 'functions', run: (api, ref) => deployFunctions(api, ref, functions) },
    { id: 'probe', run: (api, ref) => probeFunctions(api, ref) },
    {
      // Who can create accounts, and with what: the password minimum rides
      // here so the wizard's numbered steps (and --from) stay as they are.
      id: 'signups',
      run: async (api, ref) => {
        const handed = await handOverSignups(api, ref);
        await applyPasswordRules(api, ref);
        return handed;
      },
    },
  ];
}

/**
 * Everything after the project exists and is healthy, in order: what turns
 * an empty Supabase project into a family's server.
 *
 * The phone runs exactly this list. The desktop wizard (index.js) runs the
 * same functions as numbered steps of its own, because it adds per-step
 * manual fallbacks and `--from` resume points; cli/test.mjs checks it still
 * calls every one, so the two cannot quietly drift apart. Every step is
 * idempotent, which is what makes resuming after a killed app safe: run the
 * whole list again.
 *
 * Each `run` returns something worth keeping, or nothing; the last returns
 * the client key a setup link carries.
 */
export function setupSteps({ schemaSql, functions }) {
  return [
    { id: 'extensions', run: (api, ref) => enableExtensions(api, ref) },
    { id: 'schema', run: (api, ref) => applySchema(api, ref, schemaSql) },
    { id: 'verify', run: (api, ref) => verifySchema(api, ref) },
    { id: 'auth', run: (api, ref) => configureAuth(api, ref) },
    {
      id: 'webhook',
      run: async (api, ref) => {
        await setProjectUrl(api, ref);
        await createWebhook(api, ref, schemaSql);
        await verifyWebhook(api, ref);
      },
    },
    { id: 'functions', run: (api, ref) => deployFunctions(api, ref, functions) },
    { id: 'probe', run: (api, ref) => probeFunctions(api, ref) },
    { id: 'signups', run: (api, ref) => openSignupWindow(api, ref, 7) },
    { id: 'key', run: (api, ref) => getClientKey(api, ref) },
  ];
}
