#!/usr/bin/env node
//
// Probe a STAGING family server through its real APIs, as every role.
//
//   $env:SUPABASE_ACCESS_TOKEN = "sbp_..."     # PowerShell
//   node tools/probe-staging.mjs --ref <staging-ref> --staging
//
// WHY THIS EXISTS
// ---------------
// db/tests/ proves the schema in PGlite, which stands in for Supabase's
// roles but not for Supabase itself. What a family's phone actually talks
// to is GoTrue (sign-up and sign-in), PostgREST (/rest/v1) and pg_graphql
// (/graphql/v1), with real JWTs. This signs in as each role through GoTrue
// and tries, through those front doors, everything the role must be
// refused, plus a few things it must be allowed (the controls: a probe that
// sees nothing because it never signed in would otherwise "pass" by
// default).
//
// Roles: an owner, an adult, a child, a pending member, a removed member,
// an account with no membership, and no account at all (anon).
//
// WHAT IT TOUCHES
// ---------------
// It makes a throwaway "Probe Family" and its accounts, and deletes them at
// the end whatever happens. It opens the server's sign-up gate for as long
// as it takes to make the accounts, closes it to test it, and then puts it
// back exactly as it found it. It changes the probe adult's password (a
// reset code is redeemed). It inserts two made-up push tokens to check that
// a reset notice wakes only its member; the relay reports them stale and
// notify-places clears them.
//
// Run it on staging, never on a family's server: --staging is required,
// the project in deploy.config.json (and any listed in neverSeed or
// ROAMKEEP_NEVER_SEED) is refused, so is a project holding the review demo's
// family, and so is any project without staging's v17owner@test.local. Run Check and repair on staging first, so it is probing
// the schema and functions this checkout ships.
//
// The token needs Resource access to the staging project with Full access.
// It is used only to read the public key and to set up and clean up with
// SQL, and it is never printed or written anywhere.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');

const arg = (n) => { const i = process.argv.indexOf('--' + n); return i > -1 ? process.argv[i + 1] : null; };
const has = (n) => process.argv.includes('--' + n);
function die(msg) { console.error('\n  ' + msg + '\n'); process.exit(2); }

const ref = arg('ref');
if (!ref || !/^[a-z0-9]{20}$/.test(ref) || !has('staging')) {
  die('Usage: node tools/probe-staging.mjs --ref <staging-ref> --staging');
}
const never = new Map();
try {
  const cfg = JSON.parse(fs.readFileSync(path.join(REPO, 'deploy.config.json'), 'utf8'));
  const m = /https:\/\/([a-z0-9]+)\.supabase\.co/i.exec(cfg.url || '');
  if (m) never.set(m[1], 'the project in deploy.config.json');
  for (const r of cfg.neverSeed || []) never.set(String(r).trim(), 'listed in deploy.config.json neverSeed');
} catch { /* no deploy config here */ }
for (const r of (process.env.ROAMKEEP_NEVER_SEED || '').split(',')) if (r.trim()) never.set(r.trim(), 'ROAMKEEP_NEVER_SEED');
if (never.has(ref)) die(`Refusing ${ref}: ${never.get(ref)}. This makes and deletes accounts; staging only.`);

const token = process.env.SUPABASE_ACCESS_TOKEN;
if (!token) die('No SUPABASE_ACCESS_TOKEN in the environment.\n  PowerShell:  $env:SUPABASE_ACCESS_TOKEN = "sbp_..."');

const { createClient } = await import('../cli/src/api.js');
const { getClientKey } = await import('../cli/src/engine.js');
const api = createClient(token);
const URL_ = `https://${ref}.supabase.co`;
const q = (v) => (v === null || v === undefined ? 'null' : `'${String(v).replace(/'/g, "''")}'`);
const sql = async (s) => { const r = await api.query(ref, s); return Array.isArray(r) ? r : []; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── preflight ─────────────────────────────────────────────────
const meta = (await sql('select schema_version, project_url, signups_closed, signups_open_until from roamkeep_meta'))[0];
if (!meta) die('No roamkeep_meta row: not a Roamkeep server.');
if (meta.schema_version < 17) die(`Schema ${meta.schema_version}: run Check and repair first (this probes v17).`);
const demo = await sql(`select 1 from keeps where name = 'Demo Family' limit 1`);
if (demo.length) die(`${ref} holds the review demo's family. Staging only.`);
// Staging's fingerprint: the account db/tests/v17-verify.sql needs, which no
// family's server has. Holds wherever this runs, deploy.config.json or not.
const fp = await sql(`select 1 from auth.users where email = 'v17owner@test.local' limit 1`);
if (!fp.length) die(`${ref} has no v17owner@test.local account, so it doesn't look like staging. Refusing.`);
const KEY = await getClientKey(api, ref);
const others = await sql(`select id from keeps where name <> 'Probe Family'`);

console.log(`\n  probing   ${URL_}  (schema v${meta.schema_version})`);
console.log(`  others    ${others.length} other keep(s) on this server, used as the isolation target\n`);

// ── HTTP helpers ──────────────────────────────────────────────
const sessions = {};          // role -> access token
async function http(method, url, { jwt, body, headers = {} } = {}) {
  const res = await fetch(url, {
    method,
    headers: { apikey: KEY, Authorization: 'Bearer ' + (jwt || KEY), 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* text */ }
  return { status: res.status, json, text };
}
const rest = (who, method, p, body, prefer = 'return=representation') =>
  http(method, `${URL_}/rest/v1${p}`, { jwt: sessions[who], body, headers: prefer ? { Prefer: prefer } : {} });
const rpc = (who, fn, args = {}) => rest(who, 'POST', `/rpc/${fn}`, args, null);
const gql = (who, query) => http('POST', `${URL_}/graphql/v1`, { jwt: sessions[who], body: { query } });

// ── results ───────────────────────────────────────────────────
const results = [];
function rec(id, ok, name, detail) {
  results.push({ id, ok, name, detail });
  console.log(`  ${ok === null ? 'skip' : ok ? 'ok  ' : 'FAIL'} ${id.padEnd(5)} ${name}${ok ? '' : `  [${String(detail || '').slice(0, 180)}]`}`);
}
const empty = (r) => (r.status === 200 && Array.isArray(r.json) && r.json.length === 0) || [401, 403, 404].includes(r.status);
// Supabase loads a safe-update guard in front of PostgREST: an UPDATE or
// DELETE with no WHERE clause is refused outright (21000). That is a
// refusal, and a stronger one than "no rows".
const noWrite = (r) => empty(r) || (r.status === 400 && r.text.includes('21000'));
// A filter that matches every row but names a column, so the row has to be
// visible (SELECT policies apply) as well as updatable: the way past the
// safe-update guard, and the real route to the v17 self-review's R2.
const ALL = '?id=not.is.null';
// pg_graphql's update, which needs no filter at all.
const GQL_UPDATE = 'mutation { updatekeep_membersCollection(set: {status: "probe"}, atMost: 50) { affectedCount } }';
const gqlNone = (r) => !(r.json?.data?.updatekeep_membersCollection?.affectedCount > 0);
// Set by control C4: a GraphQL refusal proves nothing unless the mutation is
// real, so without a working control those checks report skip, not ok.
let GQL_OK = false;
const gqlCheck = (r) => (GQL_OK ? gqlNone(r) : null);
const refused = (r, code) => r.status >= 400 && (!code || r.text.includes(code));
const brief = (r) => `${r.status} ${r.text.slice(0, 160)}`;

// ── fixture ───────────────────────────────────────────────────
const tag = crypto.randomBytes(4).toString('hex');
const people = {};            // role -> { email, password, uid, mid }
let keepId = null, keepCode = null;
const ROLES = ['owner', 'adult', 'child', 'pending', 'removed', 'outsider'];

// Through GoTrue's own sign-up, the path a phone takes. If sign-up is
// switched off in the Supabase dashboard, the account is made in SQL with
// an email identity, which GoTrue's password sign-in accepts.
async function makeAccount(role) {
  const email = `probe-${role}-${tag}@example.com`;
  const password = crypto.randomBytes(18).toString('base64url');
  const r = await http('POST', `${URL_}/auth/v1/signup`, { body: { email, password } });
  if (!(r.status >= 200 && r.status < 300)) {
    const u = await sql(`insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
        email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
        confirmation_token, recovery_token, email_change_token_new, email_change)
      values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated',
        ${q(email)}, extensions.crypt(${q(password)}, extensions.gen_salt('bf')), now(),
        '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', '')
      returning id`);
    const uid = u[0].id;
    await sql(`insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
      values (${q(uid)}, ${q(uid)}, jsonb_build_object('sub', ${q(uid)}, 'email', ${q(email)}, 'email_verified', true),
        'email', now(), now(), now())`);
  }
  const s = await http('POST', `${URL_}/auth/v1/token?grant_type=password`, { body: { email, password } });
  if (s.status !== 200 || !s.json?.access_token) throw new Error(`sign-in for ${role} failed: ${brief(s)}`);
  people[role] = { email, password, uid: s.json.user.id };
  sessions[role] = s.json.access_token;
}

async function setup() {
  await sql(`delete from keeps where name = 'Probe Family'`);
  await sql(`delete from auth.users where email like 'probe-%@example.com'`);
  await sql(`update roamkeep_meta set signups_closed = false, signups_open_until = null where id`);
  for (const role of ROLES) await makeAccount(role);
  const k = await sql(`insert into keeps (code, name, created_by, code_expires_at, require_approval)
    values (_roamkeep_gen_code(), 'Probe Family', ${q(people.owner.uid)}, now() + interval '72 hours', true)
    returning id, code`);
  keepId = k[0].id; keepCode = k[0].code;
  const add = async (role, r, type, approved) => {
    const m = await sql(`insert into keep_members (keep_id, user_id, name, avatar, role, member_type, approved)
      values (${q(keepId)}, ${q(people[role].uid)}, ${q('Probe ' + role)}, '🧪', ${q(r)}, ${q(type)}, ${approved})
      returning id`);
    people[role].mid = m[0].id;
  };
  await add('owner', 'owner', 'adult', true);
  await add('adult', 'member', 'adult', true);
  await add('child', 'member', 'child', true);
  await add('pending', 'member', 'adult', false);
  await add('removed', 'member', 'adult', true);
  await sql(`insert into keep_places (keep_id, name, icon, lat, lng, radius_m, created_by)
    values (${q(keepId)}, 'Probe Place', '🧪', 0.5, 0.5, 100, ${q(people.owner.uid)})`);
  await sql(`insert into checkins (keep_id, member_id, member_name, member_avatar, place, type)
    values (${q(keepId)}, ${q(people.adult.mid)}, 'Probe adult', '🧪', 'Probe Place', 'manual'),
           (${q(keepId)}, ${q(people.child.mid)}, 'Probe child', '🧪', 'Probe Place', 'manual')`);
  await sql(`insert into location_history (keep_id, member_id, lat, lng)
    values (${q(keepId)}, ${q(people.adult.mid)}, 0.5, 0.5)`);
  // Removed: the member row goes, the account and its session stay.
  await sql(`delete from keep_members where id = ${q(people.removed.mid)}`);
}

async function cleanup() {
  const uids = Object.values(people).map((p) => p.uid).filter(Boolean);
  try { if (keepId) await sql(`delete from keeps where id = ${q(keepId)}`); } catch (e) { console.log('  cleanup: keep ' + e.message); }
  try {
    if (uids.length) await sql(`delete from auth.users where id in (${uids.map(q).join(',')})`);
    await sql(`delete from auth.users where email like ${q(`probe-%-${tag}@example.com`)}`);
  } catch (e) { console.log('  cleanup: accounts ' + e.message); }
  try {
    await sql(`update roamkeep_meta set signups_closed = ${meta.signups_closed},
      signups_open_until = ${q(meta.signups_open_until)} where id`);
  } catch (e) { console.log('  cleanup: sign-up setting ' + e.message + ' (restore it in Settings → New accounts)'); }
}

// ── the probe ─────────────────────────────────────────────────
const TABLES = ['keeps', 'keep_members', 'checkins', 'location_history', 'keep_places', 'keep_notify_prefs',
  'keep_member_push', 'password_reset_codes', 'keep_join_attempts', 'roamkeep_secrets'];
const NIL = '00000000-0000-0000-0000-000000000000';
// Real argument names: called with none, PostgREST answers "no such
// function" whatever the caller's privileges, and the test would pass for
// the wrong reason. With them, only a missing EXECUTE grant refuses.
const ARGS = {
  create_keep: { p_family_name: 'x', p_display_name: 'x', p_avatar: 'x' },
  join_keep_by_code: { p_code: 'X', p_display_name: 'x', p_avatar: 'x' },
  my_membership: {}, approve_member: { p_member_id: NIL }, set_signups: { p_closed: false, p_open_until: null },
  issue_password_reset: { p_member_id: NIL }, delete_my_account: {}, request_account_deletion: { p_on: true },
  delete_child_account: { p_member_id: NIL }, set_require_approval: { p_keep_id: NIL, p_on: false },
  prune_keep_history: {}, get_invite: { p_keep_id: NIL }, set_project_url: { p_url: 'https://x.supabase.co' },
  checkin_recipients: { p_checkin: NIL }, keep_push_recipients: { p_keep: NIL },
  keep_owner_push_recipients: { p_keep: NIL }, reset_notice_recipients: { p_user: NIL },
  _roamkeep_gen_code: {}, roamkeep_notify_join: {}, roamkeep_notify_reset: {},
};
const NOT_FOR_CLIENTS = ['checkin_recipients', 'keep_push_recipients', 'keep_owner_push_recipients',
  'reset_notice_recipients', '_roamkeep_gen_code', 'roamkeep_notify_join', 'roamkeep_notify_reset'];
// Refused for want of the privilege (or not exposed at all), not for any
// other reason.
const noExec = (r) => r.status === 404 || ([401, 403].includes(r.status) && r.text.includes('permission denied'));

async function probe() {
  const P = people;
  const other = others[0]?.id || null;

  // Controls: the probe must see what it should, or every "nothing" below means nothing.
  let r = await rest('owner', 'GET', `/keep_members?select=id&keep_id=eq.${keepId}`);
  const ownerSees = Array.isArray(r.json) ? r.json.length : -1;
  rec('C1', ownerSees === 4, 'control: the owner sees the family, the pending member included', brief(r));
  r = await rest('adult', 'GET', `/checkins?select=id&keep_id=eq.${keepId}`);
  rec('C2', Array.isArray(r.json) && r.json.length === 2, 'control: an adult reads the family\'s check-ins', brief(r));
  r = await rpc(null, 'roamkeep_schema_version');
  rec('C3', r.status === 200, 'control: anon reads the schema version', brief(r));
  r = await gql('owner', `mutation { updatekeep_membersCollection(set: {status: "probe owner"}, filter: {id: {eq: "${P.owner.mid}"}}, atMost: 1) { affectedCount } }`);
  GQL_OK = r.json?.data?.updatekeep_membersCollection?.affectedCount === 1;
  // pg_graphql is off by default on newer projects; then there is no GraphQL
  // surface at all, and nothing to probe there.
  const gqlOff = /pg_graphql extension is not enabled/i.test(r.text);
  rec('C4', gqlOff ? null : GQL_OK, gqlOff
    ? 'GraphQL is not enabled on this project: no GraphQL surface, so its checks are skipped'
    : 'control: the owner can update their own row through GraphQL (so the GraphQL refusals mean something)', brief(r));
  if (ownerSees !== 4) { rec('C!', false, 'controls failed: signed-in reads are not working, so the rest would prove nothing', ''); return; }

  // ── anon ──
  for (const t of TABLES) {
    r = await rest(null, 'GET', `/${t}?select=*&limit=1`);
    rec('N1', empty(r), `anon reads nothing from ${t}`, brief(r));
  }
  for (const fn of ['create_keep', 'join_keep_by_code', 'my_membership', 'approve_member', 'set_signups',
    'issue_password_reset', 'delete_my_account', 'request_account_deletion', 'delete_child_account',
    'set_require_approval', 'prune_keep_history', 'get_invite', 'set_project_url', ...NOT_FOR_CLIENTS]) {
    r = await rpc(null, fn, ARGS[fn]);
    rec('N2', noExec(r), `anon has no EXECUTE on ${fn}`, brief(r));
  }
  r = await rpc(null, 'redeem_password_reset', { p_email: `nobody-${tag}@example.com`, p_code: 'AAAAA-AAAAA', p_new_password: 'Whatever-123' });
  rec('N3', r.status === 200 && r.text.includes('invalid'), 'anon: an unknown email answers "invalid"', brief(r));
  r = await rest(null, 'POST', '/checkins', { keep_id: keepId, member_id: P.adult.mid, member_name: 'x', member_avatar: 'x', place: 'x', type: 'sos' });
  rec('N4', refused(r), 'anon cannot file a check-in', brief(r));
  r = await rest(null, 'PATCH', '/keep_members', { status: 'probe' });
  rec('N5', noWrite(r), 'anon cannot update any member (no filter)', brief(r));
  r = await rest(null, 'PATCH', '/keep_members' + ALL, { status: 'probe' });
  rec('N5b', noWrite(r), 'anon cannot update any member (a filter matching all)', brief(r));
  r = await gql(null, GQL_UPDATE);
  rec('N5c', gqlCheck(r), 'anon cannot update any member through GraphQL', brief(r));
  r = await gql(null, '{ keep_membersCollection(first: 5) { edges { node { id } } } }');
  rec('N6', !(r.json?.data?.keep_membersCollection?.edges?.length), 'anon reads no members through GraphQL', brief(r));

  // ── an account with no membership, and a removed member ──
  for (const who of ['outsider', 'removed']) {
    const W = who === 'outsider' ? 'X' : 'R';
    for (const t of TABLES) {
      r = await rest(who, 'GET', `/${t}?select=*&limit=1`);
      rec(W + '1', empty(r), `${who} reads nothing from ${t}`, brief(r));
    }
    r = await rpc(who, 'create_keep', { p_family_name: 'Probe Second', p_display_name: 'X', p_avatar: '🧪' });
    rec(W + '2', refused(r, 'family_exists'), `${who} cannot start a second family (family_exists)`, brief(r));
    r = await rpc(who, 'join_keep_by_code', { p_code: 'WRONGCODE2345', p_display_name: 'X', p_avatar: '🧪' });
    rec(W + '3', r.status === 200 && r.json?.[0]?.status === 'invalid_code', `${who}: a wrong code answers invalid_code`, brief(r));
    r = await rpc(who, 'set_signups', { p_closed: false, p_open_until: null });
    rec(W + '4', refused(r, 'not_owner'), `${who} cannot change sign-ups`, brief(r));
    for (const [fn, a] of [['approve_member', { p_member_id: P.pending.mid }], ['issue_password_reset', { p_member_id: P.adult.mid }],
      ['delete_child_account', { p_member_id: P.child.mid }], ['remove_member', { p_member_id: P.adult.mid }]]) {
      r = await rpc(who, fn, a);
      rec(W + '5', refused(r), `${who} cannot ${fn}`, brief(r));
    }
    const mid = who === 'removed' ? P.removed.mid : P.adult.mid;
    r = await rest(who, 'POST', '/checkins', { keep_id: keepId, member_id: mid, member_name: 'x', member_avatar: 'x', place: 'x', type: 'sos' });
    rec(W + '6', refused(r), `${who} cannot file a check-in into the family${who === 'removed' ? ' with their old member id' : ''}`, brief(r));
    r = await rest(who, 'PATCH', '/keep_members', { status: 'probe' });
    rec(W + '7', noWrite(r), `${who} updates no member row (no filter)`, brief(r));
    r = await rest(who, 'PATCH', '/keep_members' + ALL, { status: 'probe' });
    rec(W + '7b', noWrite(r), `${who} updates no member row (a filter matching all)`, brief(r));
    r = await gql(who, GQL_UPDATE);
    rec(W + '7c', gqlCheck(r), `${who} updates no member row through GraphQL`, brief(r));
    r = await rpc(who, 'my_membership');
    rec(W + '8', r.status === 200 && Array.isArray(r.json) && r.json.length === 0, `${who} has no membership`, brief(r));
    r = await gql(who, '{ keep_membersCollection(first: 5) { edges { node { id } } } }');
    rec(W + '9', !(r.json?.data?.keep_membersCollection?.edges?.length), `${who} reads no members through GraphQL`, brief(r));
    if (who === 'outsider') {
      for (const fn of NOT_FOR_CLIENTS) {
        r = await rpc(who, fn, ARGS[fn]);
        rec('X10', noExec(r), `a signed-in account has no EXECUTE on ${fn}`, brief(r));
      }
    }
  }

  // ── a pending member ──
  for (const t of TABLES) {
    r = await rest('pending', 'GET', `/${t}?select=*&limit=1`);
    rec('P1', empty(r), `pending reads nothing from ${t}, their own row included`, brief(r));
  }
  r = await rpc('pending', 'my_membership');
  rec('P2', r.status === 200 && r.json?.[0]?.approved === false, 'pending: my_membership says waiting', brief(r));
  r = await rest('pending', 'POST', '/checkins', { keep_id: keepId, member_id: P.pending.mid, member_name: 'x', member_avatar: 'x', place: '🆘', type: 'sos' });
  rec('P3', refused(r), 'pending cannot file a check-in, SOS included', brief(r));
  r = await rest('pending', 'POST', '/keep_member_push', { member_id: P.pending.mid, keep_id: keepId, fcm_token: 'probe' });
  rec('P4', refused(r), 'pending cannot register a push token', brief(r));
  r = await rest('pending', 'PATCH', '/keep_members', { status: 'probe edit' });
  rec('P5', noWrite(r), 'pending cannot change their own row (no filter)', brief(r));
  r = await rest('pending', 'PATCH', '/keep_members' + ALL, { status: 'probe edit' });
  rec('P5b', noWrite(r), 'pending cannot change their own row (a filter matching all)', brief(r));
  r = await gql('pending', GQL_UPDATE.replace('"probe"', '"probe edit"'));
  rec('P5c', gqlCheck(r), 'pending cannot change their own row through GraphQL (self-review R2)', brief(r));
  const pRow = (await sql(`select status from keep_members where id = ${q(P.pending.mid)}`))[0];
  rec('P5d', pRow?.status !== 'probe edit', 'pending: their row is unchanged after all three', pRow?.status);
  r = await rpc('pending', 'approve_member', { p_member_id: P.pending.mid });
  rec('P6', refused(r, 'not_owner'), 'pending cannot approve themselves', brief(r));
  r = await rest('pending', 'PATCH', `/keep_members?id=eq.${P.pending.mid}`, { approved: true });
  rec('P7', empty(r) || refused(r, 'protected_column'), 'pending cannot PATCH approved', brief(r));
  r = await gql('pending', '{ keep_membersCollection(first: 5) { edges { node { id } } } }');
  rec('P8', !(r.json?.data?.keep_membersCollection?.edges?.length), 'pending reads no members through GraphQL', brief(r));

  // ── a child ──
  r = await rpc('child', 'delete_my_account');
  rec('K1', refused(r, 'child_cannot_delete'), 'a child cannot delete their own account', brief(r));
  r = await rpc('child', 'leave_keep', { p_member_id: P.child.mid });
  rec('K2', refused(r, 'child_cannot_leave'), 'a child cannot leave', brief(r));
  for (const [col, val] of [['role', 'owner'], ['member_type', 'adult'], ['approved', false], ['keep_id', other || keepId],
    ['paused_until', new Date(Date.now() + 3600e3).toISOString()], ['deletion_requested_at', new Date().toISOString()],
    ['user_id', P.adult.uid]]) {
    if (col === 'keep_id' && !other) { rec('K3', null, `a child cannot move their own keep_id (no other keep to point at)`, ''); continue; }
    r = await rest('child', 'PATCH', `/keep_members?id=eq.${P.child.mid}`, { [col]: val });
    rec('K3', refused(r), `a child cannot PATCH their own ${col}`, brief(r));
  }
  r = await rest('child', 'PATCH', `/keep_members?id=eq.${P.adult.mid}`, { status: 'probe' });
  rec('K4', empty(r), 'a child cannot update another member\'s row', brief(r));
  r = await rest('child', 'POST', '/checkins', { keep_id: keepId, member_id: P.adult.mid, member_name: 'x', member_avatar: 'x', place: 'x', type: 'sos' });
  rec('K5', refused(r), 'a child cannot file a check-in as someone else', brief(r));

  // ── an adult ──
  r = await rest('adult', 'PATCH', `/keep_members?id=eq.${P.adult.mid}`, { role: 'owner' });
  rec('A1', refused(r, 'protected_column'), 'an adult cannot make themselves an owner', brief(r));
  for (const [fn, a] of [['issue_password_reset', { p_member_id: P.child.mid }], ['delete_child_account', { p_member_id: P.child.mid }],
    ['approve_member', { p_member_id: P.pending.mid }], ['decline_member', { p_member_id: P.pending.mid }],
    ['set_require_approval', { p_keep_id: keepId, p_on: false }], ['rotate_keep_code', { p_keep_id: keepId }],
    ['remove_member', { p_member_id: P.child.mid }], ['set_member_role', { p_member_id: P.child.mid, p_role: 'owner' }],
    ['set_member_type', { p_member_id: P.child.mid, p_type: 'adult' }], ['set_signups', { p_closed: false, p_open_until: null }]]) {
    r = await rpc('adult', fn, a);
    rec('A2', refused(r), `an adult cannot ${fn}`, brief(r));
  }
  r = await rest('adult', 'POST', '/checkins', { keep_id: keepId, member_id: P.child.mid, member_name: 'x', member_avatar: 'x', place: 'x', type: 'sos' });
  rec('A3', refused(r), 'an adult cannot file a check-in as someone else', brief(r));
  if (other) {
    r = await rest('adult', 'POST', '/checkins', { keep_id: other, member_id: P.adult.mid, member_name: 'x', member_avatar: 'x', place: 'x', type: 'manual' });
    rec('A4', refused(r), 'an adult cannot pair their member id with another family\'s keep', brief(r));
  }
  const place = (await sql(`select id from keep_places where keep_id = ${q(keepId)} limit 1`))[0]?.id;
  r = await rest('adult', 'PATCH', `/keep_places?id=eq.${place}`, { created_by: P.adult.uid });
  rec('A5', refused(r, 'protected_column'), 'an adult cannot rewrite a place\'s creator', brief(r));
  r = await rest('adult', 'POST', '/keep_places', { keep_id: keepId, name: 'x', icon: 'x', lat: 0, lng: 0, radius_m: 100, created_by: P.owner.uid });
  rec('A6', refused(r), 'an adult cannot add a place in someone else\'s name', brief(r));
  r = await rest('adult', 'DELETE', `/keep_members?id=eq.${P.child.mid}`);
  rec('A7', empty(r), 'an adult cannot delete a member row', brief(r));
  for (const t of ['keep_members', 'checkins', 'location_history', 'keep_places']) {
    r = await rest('adult', 'GET', `/${t}?select=keep_id`);
    const foreign = Array.isArray(r.json) ? r.json.filter((x) => x.keep_id !== keepId).length : -1;
    rec('A8', foreign === 0, `an adult sees only their own family in ${t}`, `${foreign} foreign row(s); ${brief(r)}`);
  }

  // ── an owner, and the reset flow (v17 self-review R1, R3) ──
  r = await rpc('owner', 'delete_child_account', { p_member_id: P.adult.mid });
  rec('O1', refused(r, 'not_child'), 'an owner cannot delete an adult\'s account', brief(r));
  r = await rpc('owner', 'issue_password_reset', { p_member_id: P.pending.mid });
  rec('O2', refused(r, 'member_pending'), 'an owner cannot reset a pending member', brief(r));
  r = await rpc('owner', 'issue_password_reset', { p_member_id: P.owner.mid });
  rec('O3', refused(r, 'cannot_reset'), 'an owner cannot reset their own password by code', brief(r));

  // Five wrong guesses burn a code (child's; their password is not changed).
  r = await rpc('owner', 'issue_password_reset', { p_member_id: P.child.mid });
  const childCode = typeof r.json === 'string' ? r.json : null;
  for (let i = 0; i < 5; i++) {
    await rpc(null, 'redeem_password_reset', { p_email: P.child.email, p_code: `WRONG-${i}AAAA`, p_new_password: 'Whatever-123' });
  }
  r = await rpc(null, 'redeem_password_reset', { p_email: P.child.email, p_code: childCode, p_new_password: 'Whatever-123' });
  rec('B1', !!childCode && r.text.includes('invalid'), 'five wrong guesses burn the code (the right one then fails)', brief(r));

  // The adult: made-up push tokens for the owner and the adult, then a code
  // for the adult. The notice must wake the adult only (recipients=1).
  await sql(`insert into keep_member_push (member_id, keep_id, fcm_token) values
    (${q(P.owner.mid)}, ${q(keepId)}, ${q('probe-token-owner-' + tag)}),
    (${q(P.adult.mid)}, ${q(keepId)}, ${q('probe-token-adult-' + tag)})
    on conflict (member_id) do update set fcm_token = excluded.fcm_token`);
  // The database's clock, not this machine's: a skewed PC clock would miss
  // every response.
  const before = (await sql('select now()::text as t'))[0]?.t || new Date(Date.now() - 60e3).toISOString();
  r = await rpc('owner', 'issue_password_reset', { p_member_id: P.adult.mid });
  const adultCode = typeof r.json === 'string' ? r.json : null;
  rec('O4', !!adultCode, 'an owner can issue a code for an adult (allowed by design; the adult is told)', brief(r));
  r = await rest('adult', 'GET', '/password_reset_codes?select=code_hash');
  rec('R3', refused(r, 'permission denied'), 'the member cannot read their code\'s hash', brief(r));
  r = await rest('adult', 'GET', '/password_reset_codes?select=issued_by,issued_at,redeemed_at');
  rec('R3b', r.status === 200 && r.json?.[0]?.issued_by === P.owner.uid, 'the member can read who issued it and when', brief(r));
  if (!meta.project_url) {
    rec('R1c', null, 'the reset trigger posts a wake (project_url is not set, so no trigger posts)', '');
  } else {
    // The trigger's own request. pg_net records a response row whether the
    // call answered or timed out (it waits 5 s, and a cold function plus the
    // relay can take longer); either proves the trigger fired.
    let rows = [];
    for (let i = 0; i < 12 && !rows.length; i++) {
      await sleep(1500);
      rows = await sql(`select status_code, timed_out, left(coalesce(content, ''), 120) as content
        from net._http_response where created > ${q(before)}::timestamptz order by created`);
    }
    const desc = rows.map((x) => x.timed_out ? 'timed out' : `${x.status_code} ${x.content}`).join(' | ');
    rec('R1c', rows.length > 0, 'issuing a reset code fires the wake trigger', desc || 'no request recorded since the code was issued');
  }
  // Who gets woken, asked of notify-places directly with the server's own
  // secret: deterministic, where the trigger's call may time out unrecorded.
  // The tokens are made up; the relay reports them stale and they are cleared.
  await sql(`update keep_member_push set fcm_token = ${q('probe-token-owner-' + tag)} where member_id = ${q(P.owner.mid)};
             update keep_member_push set fcm_token = ${q('probe-token-adult-' + tag)} where member_id = ${q(P.adult.mid)}`);
  const secret = (await sql('select webhook_secret from roamkeep_secrets limit 1'))[0]?.webhook_secret || '';
  r = await http('POST', `${URL_}/functions/v1/notify-places`, {
    headers: { 'x-roamkeep-webhook': secret },
    body: { type: 'INSERT', table: 'password_reset_codes', schema: 'public',
            record: { id: P.adult.uid, keep_id: keepId, user_id: P.adult.uid }, old_record: null },
  });
  rec('R1a', r.status === 200 && r.text.includes('table=password_reset_codes') && r.text.includes('recipients=1'),
    'a reset notice wakes its member\'s phones only (recipients=1)',
    r.text.includes('recipients=2') ? 'woke the whole family: notify-places is not the rc8 function (run Check and repair)' : brief(r));
  r = await rpc(null, 'redeem_password_reset', { p_email: P.adult.email, p_code: adultCode, p_new_password: crypto.randomBytes(12).toString('base64url') });
  rec('O5', r.text.includes('ok'), 'the code redeems signed out', brief(r));
  r = await rpc('adult', 'delete_my_account');
  rec('R1b', refused(r, 'recent_reset'), 'the account cannot be deleted for a day after a reset', brief(r));

  // ── the sign-up gate, through GoTrue itself ──
  await sql(`update roamkeep_meta set signups_closed = true, signups_open_until = null where id`);
  r = await http('POST', `${URL_}/auth/v1/signup`, { body: { email: `probe-gate-${tag}@example.com`, password: crypto.randomBytes(12).toString('base64url') } });
  const gateRows = (await sql(`select count(*)::int as n from auth.users where email = ${q(`probe-gate-${tag}@example.com`)}`))[0]?.n;
  rec('G1', r.status >= 400 && gateRows === 0, 'closed: a new account is refused, and none is made', `${brief(r)} · rows ${gateRows}`);
  // The wording is GoTrue's choice. It has passed the gate's text through,
  // and it has also answered "Database error saving new user" (rc9 device
  // test), so the app reads the gate's state instead (G1c). Reported, not
  // judged.
  rec('G1b', r.text.includes('signups_closed') ? true : null, 'GoTrue passes the reason through as signups_closed', brief(r));
  const meta = await rest(null, 'GET', '/roamkeep_meta?select=signups_closed,signups_open_until');
  rec('G1c', meta.status === 200 && meta.json?.[0]?.signups_closed === true,
    'signed out, the app can read that new accounts are closed (how it explains a refusal)', brief(meta));
  r = await http('POST', `${URL_}/auth/v1/signup`, { body: {} });
  rec('G2', r.status >= 400, 'closed: an anonymous sign-in is refused', brief(r));
  const settings = await http('GET', `${URL_}/auth/v1/settings`);
  const anonOn = settings.json?.external?.anonymous_users === true;
  rec('G3', !anonOn, 'anonymous sign-ins are switched off in Supabase Auth', anonOn ? 'ON: anonymous accounts can be made whenever new accounts are open' : brief(settings));
  await sql(`update roamkeep_meta set signups_closed = true, signups_open_until = now() + interval '10 minutes' where id`);
  r = await http('POST', `${URL_}/auth/v1/signup`, { body: { email: `probe-window-${tag}@example.com`, password: crypto.randomBytes(12).toString('base64url') } });
  rec('G4', r.status >= 200 && r.status < 300, 'closed, inside an open window: a new account is allowed', brief(r));
}

let failed = false;
try {
  await setup();
  await probe();
} catch (e) {
  failed = true;
  console.log('\n  STOPPED: ' + e.message);
} finally {
  await cleanup();
}
const fails = results.filter((x) => x.ok === false);
const skips = results.filter((x) => x.ok === null);
console.log(`\n  ${results.length - fails.length - skips.length} ok, ${fails.length} failed, ${skips.length} skipped` +
  (failed ? ', and the run stopped early' : '') + '. Probe family and accounts removed; sign-up setting restored.\n');
process.exit(fails.length || failed ? 1 : 0);
