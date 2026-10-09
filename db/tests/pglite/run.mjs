// npm run test:db — db/schema.sql and the verify scripts, end to end, in
// PGlite under the Supabase stand-in (./supabase.mjs). No project, no token,
// a few seconds. It is what to run before pasting a schema anywhere, because
// a version freezes the moment it is applied off this machine.
//
//   A  fresh install, applied twice (owners re-paste it), then every verify
//      script — once alone, once with an older keep in the project, which
//      is the case staging has and the oldest-keep rules turn on;
//   B  upgrade from the last release tag's schema with a family already in
//      it: nothing an existing family relies on may change (expand-only);
//   C  a join request wakes the owners through notify-places, with the
//      webhook secret, and an ordinary join wakes nobody;
//   D  the "Checking it actually took" query in docs/OWNER_SETUP.md finds
//      every object on a complete install;
//   E  a test account already in a real Keep stops v17-verify with one
//      readable "0 setup" row, touching nothing — which is what happened on
//      staging the first time somebody made the family with v17owner;
//   F  the SQL the engine writes itself (sign-up window, hand-over, upgrade
//      check, setUserPassword with hostile input) against the real schema;
//   G  re-pasting the schema repairs a deleted check-in trigger and a
//      loosened grant, and the same test fails without the repair block.
//
// Options: --from <git ref>  the schema to upgrade from (default: the latest
//                            v* tag that is not an -rc).
//
// Proving the verify scripts can fail is a separate job: npm run test:db:mutate.

import fs from 'node:fs'
import { ROOT, read, prep, stampOf, project, addUser, actAs, signOut, previousSchema, verify } from './supabase.mjs'

const SCHEMA = read('db/schema.sql')
const VERSION = stampOf(SCHEMA)

// v8 and v10 predate later hardening and still assert what was true then
// (see the security review notes); from v16 on, each script must hold on
// every later schema too.
const VERIFY = fs.readdirSync(ROOT + 'db/tests')
  .map((f) => [f, Number((f.match(/^v(\d+)-verify\.sql$/) || [])[1])])
  .filter(([, n]) => n >= 16)
  .sort((a, b) => a[1] - b[1])

let failures = 0
const fail = (msg) => { failures++; console.log(`!! ${msg}`) }
async function section(name, fn) {
  try { await fn() } catch (e) { fail(`${name}: ${e.message.split('\n')[0]}`) }
}
async function verifyAll(db, when) {
  for (const [file, n] of VERIFY) {
    failures += await verify(db, `db/tests/${file}`, `${file} ${when}`)
  }
}
async function accounts(db) {
  for (const [, n] of VERIFY) {
    await addUser(db, `v${n}owner@test.local`)
    await addUser(db, `v${n}member@test.local`)
  }
}
// Made directly, as the table owner: from v17 create_keep allows one family
// per server, and section A seeds this one after the verify scripts made
// theirs. join_keep_by_code still does the joining.
async function family(db, prefix) {
  const o = await addUser(db, `${prefix}-owner@test.local`)
  const k = await addUser(db, `${prefix}-kid@test.local`)
  const keep = (await db.query(
    `INSERT INTO keeps (code, name, created_by, code_expires_at)
     VALUES (_roamkeep_gen_code(), $1, $2, now() + interval '72 hours')
     RETURNING id AS keep_id, code AS keep_code`, [`Family ${prefix}`, o])).rows[0]
  await db.query(`INSERT INTO keep_members (keep_id, user_id, name, avatar, role, member_type)
                  VALUES ($1, $2, 'Mum', '👩', 'owner', 'adult')`, [keep.keep_id, o])
  await actAs(db, k)
  await db.query(`SELECT * FROM join_keep_by_code($1, 'Kid', '👦')`, [keep.keep_code])
  await db.query(`INSERT INTO keep_places (keep_id, name, lat, lng, created_by) VALUES ($1, 'Home', 1, 2, $2)`,
    [keep.keep_id, o])
  await signOut(db)
  return { o, k, keep }
}
/** What a member can see as a client, through RLS. */
async function sees(db, uid) {
  await actAs(db, uid)
  await db.exec('SET ROLE authenticated')
  const n = async (t) => (await db.query(`SELECT count(*)::int n FROM ${t}`)).rows[0].n
  const out = { members: await n('keep_members'), places: await n('keep_places') }
  await db.exec('RESET ROLE')
  await signOut(db)
  return out
}

console.log(`schema.sql stamps v${VERSION}; verify scripts: ${VERIFY.map(([f]) => f).join(', ')}`)

await section('A fresh install', async () => {
  const db = await project()
  await db.exec(prep(SCHEMA))
  await db.exec(prep(SCHEMA))
  await accounts(db)
  await verifyAll(db, 'on a fresh project')
  await family(db, 'older')
  await verifyAll(db, 'with an older keep present')
  await db.close()
})

const from = previousSchema(process.argv.includes('--from') ? process.argv[process.argv.indexOf('--from') + 1] : null)
if (!from.sql) {
  console.log(`\n-- B skipped: no previous schema at ${from.ref} (no release tags in this clone?)`)
} else {
  await section('B upgrade', async () => {
    const db = await project()
    await db.exec(prep(from.sql))
    const f = await family(db, 'live')
    const before = await sees(db, f.k)
    await db.exec(prep(SCHEMA))
    const after = await sees(db, f.k)
    const ver = (await db.query('SELECT schema_version FROM roamkeep_meta')).rows[0].schema_version
    console.log(`\n== upgrade ${from.ref} (v${stampOf(from.sql)}) → working tree (v${VERSION}): ` +
      `kid saw ${JSON.stringify(before)}, now ${JSON.stringify(after)}`)
    if (ver !== VERSION) fail(`B: upgraded database reports v${ver}`)
    if (JSON.stringify(before) !== JSON.stringify(after)) fail('B: an existing member lost sight of their family')
    // v17: an existing family must not wake up needing approval.
    const v17 = (await db.query(`SELECT bool_and(m.approved) a, bool_or(k.require_approval) r
                                   FROM keep_members m JOIN keeps k ON k.id = m.keep_id`)).rows[0]
    if (v17.a !== true || v17.r !== false) fail(`B: upgrade left members unapproved or approval on ${JSON.stringify(v17)}`)
    await accounts(db)
    await verifyAll(db, 'on the upgraded project')
    await db.close()
  })
}

await section('C join wake', async () => {
  const db = await project()
  await db.exec(prep(SCHEMA))
  await db.exec(`UPDATE roamkeep_meta SET project_url = 'https://example.supabase.co' WHERE id`)
  const o = await addUser(db, 'o@test.local'), a = await addUser(db, 'a@test.local'), b = await addUser(db, 'b@test.local')
  await actAs(db, o)
  const keep = (await db.query(`SELECT * FROM create_keep('F', 'O', '👩')`)).rows[0]
  await actAs(db, a)
  await db.query(`SELECT * FROM join_keep_by_code($1, 'A', '👦')`, [keep.keep_code])
  await actAs(db, o)
  await db.query(`SELECT set_require_approval($1, true)`, [keep.keep_id])
  await actAs(db, b)
  const pending = (await db.query(`SELECT * FROM join_keep_by_code($1, 'B', '👧')`, [keep.keep_code])).rows[0]
  // A child's deletion request wakes the owners the same way: when a request
  // is made, never when it is repeated or taken back. Ask, ask again, take
  // back, ask: two wakes.
  const kid = await addUser(db, 'kid@test.local')
  const kidRow = (await db.query(`INSERT INTO keep_members (keep_id, user_id, name, avatar, role, member_type)
                                  VALUES ($1, $2, 'Kid', '🧒', 'member', 'child') RETURNING id`,
                                 [keep.keep_id, kid])).rows[0]
  await actAs(db, kid)
  for (const on of [true, true, false, true]) await db.query('SELECT request_account_deletion($1)', [on])
  await signOut(db)
  const calls = (await db.query(`SELECT url, body, length(headers->>'x-roamkeep-webhook') AS secret
                                   FROM net.calls WHERE body->>'table' = 'keep_members'`)).rows
  const joins = calls.filter((c) => c.body.record.id === pending.member_id)
  const asks = calls.filter((c) => c.body.record.id === kidRow.id)
  const ok = joins.length === 1 && asks.length === 2 && calls.length === 3 &&
    calls.every((c) => c.url.endsWith('/functions/v1/notify-places') && c.secret > 0 &&
                       Object.keys(c.body.record).sort().join() === 'id,keep_id')
  console.log(`\n== owner wakes: ${ok ? 'ok' : 'WRONG'} (${joins.length} for 1 pending + 1 ordinary join, ` +
    `${asks.length} for a child's ask, ask again, take back, ask)`)
  if (!ok) fail(`C: ${JSON.stringify(calls)}`)
  await db.close()
})

await section('D owner query', async () => {
  const md = read('docs/OWNER_SETUP.md')
  const q = md.slice(md.indexOf('### Checking it actually took')).match(/```sql\r?\n([\s\S]*?)```/)[1]
  const db = await project()
  await db.exec(prep(SCHEMA))
  await db.exec(`UPDATE roamkeep_meta SET project_url = 'https://example.supabase.co' WHERE id`)
  await db.exec(prep(SCHEMA))   // the check-in trigger is only installed once the URL is known
  const r = (await db.query(q)).rows[0]
  const missing = Object.entries(r).filter(([, v]) => v === 0 || v === null || v === false).map(([k]) => k)
  console.log(`\n== owner query: ${JSON.stringify(r)}`)
  if (r.version !== VERSION || missing.length) fail(`D: complete install reads v${r.version}, missing ${missing.join(', ')}`)
  await db.close()
})

await section('E setup misuse', async () => {
  const db = await project()
  await db.exec(prep(SCHEMA))
  const o = await addUser(db, 'v17owner@test.local')
  await addUser(db, 'v17member@test.local')
  await actAs(db, o)
  await db.query(`SELECT * FROM create_keep('The Real Family', 'Me', '👩')`)
  await signOut(db)
  const keepsBefore = (await db.query('SELECT count(*)::int n FROM keeps')).rows[0].n
  const res = await db.exec(read('db/tests/v17-verify.sql'))
  const rows = res[res.length - 1].rows
  const keepsAfter = (await db.query('SELECT count(*)::int n FROM keeps')).rows[0].n
  // The catalog checks after the DO block still run, and should pass.
  const failed = rows.filter((r) => r.status !== 'PASS')
  const behaviour = rows.filter((r) => /^[1-4][a-z]/.test(r.step))
  const ok = failed.length === 1 && failed[0].step === '0 setup' && behaviour.length === 0 &&
    failed[0].detail.includes('v17owner@test.local is in "The Real Family"') && keepsAfter === keepsBefore
  console.log(`\n== setup misuse: ${ok ? 'ok' : 'WRONG'} — ${failed.map((r) => `${r.step}: ${r.detail}`).join(' | ')}`)
  if (!ok) fail('E: a test account in a real Keep was not reported cleanly')
  await db.close()
})

// The SQL the engine writes itself, run against the real schema: what the
// phone and the wizard send to a family's database outside schema.sql.
await section('F engine SQL', async () => {
  const engine = await import('../../../cli/src/engine.js')
  const db = await project()
  await db.exec(prep(SCHEMA))
  const api = { query: async (ref, sql) => { const r = await db.exec(sql); return r[r.length - 1]?.rows ?? [] } }
  const pw = async (email, p) => (await db.query(
    `select encrypted_password = extensions.crypt($2, encrypted_password) as ok from auth.users where lower(email) = lower($1)`,
    [email, p])).rows[0]?.ok
  const problems = []
  const want = (ok, what) => { if (!ok) problems.push(what) }

  const fresh = await engine.checkUpgradeable(api, 'r')
  want(fresh.ok && fresh.version === VERSION, 'checkUpgradeable on a current schema')
  want(await engine.openSignupWindow(api, 'r', 7) !== null, 'sign-up window opens on a server with no family')
  const o = await addUser(db, 'Owner@Test.Local')
  await addUser(db, 'other@test.local')
  await actAs(db, o)
  await db.query(`SELECT * FROM create_keep('F', 'O', '👩')`)
  await signOut(db)
  want(await engine.openSignupWindow(api, 'r', 7) === null, 'sign-up window leaves a family\'s server alone')

  // setUserPassword: hostile input stays data.
  const hostile = "it's $$ $rk$ ' or '1'='1 \\ ; drop table keeps; --"
  want(await engine.setUserPassword(api, 'r', ' owner@test.local ', hostile) === 1, 'setUserPassword changes one account')
  want(await pw('owner@test.local', hostile), 'the new password signs in')
  want(await engine.setUserPassword(api, 'r', "x' or '1'='1", 'Another-Pass-1') === 0, 'an injected email matches nothing')
  want(await pw('other@test.local', 'Old-Pass-123'), 'other accounts untouched')
  want((await db.query(`select to_regclass('public.keeps') is not null as t`)).rows[0].t, 'keeps survives')

  const calls = []
  const api2 = { ...api, getAuthConfig: async () => ({ disable_signup: true }), updateAuthConfig: async (r, p) => calls.push(p) }
  await db.exec(`update roamkeep_meta set signups_closed = false where id`)
  want(await engine.handOverSignups(api2, 'r') === 'handed-over', 'hand-over runs')
  want((await db.query('select signups_closed from roamkeep_meta')).rows[0].signups_closed === true, 'hand-over leaves sign-ups closed')

  console.log(`\n== engine SQL: ${problems.length ? 'WRONG — ' + problems.join('; ') : 'ok'}`)
  if (problems.length) fail('F: ' + problems.join('; '))
  await db.close()
})

// v18: re-pasting schema.sql is how most owners repair a project, so it must
// put back a deleted check-in trigger, whichever body the function has (the
// body itself is only replaced in narrow cases). Run twice: the real schema
// must repair it, and the schema without its v18 repair block must not, or
// this section could never fail.
await section('G repair', async () => {
  const repairs = async (schema) => {
    const db = await project()
    await db.exec(prep(schema))
    await db.exec(`UPDATE roamkeep_meta SET project_url = 'https://example.supabase.co' WHERE id`)
    await db.exec(prep(schema))
    await db.exec('DROP TRIGGER on_checkin_notify ON public.checkins')
    await db.exec('GRANT EXECUTE ON FUNCTION public.roamkeep_notify_checkin() TO anon')
    await db.exec(prep(schema))
    const r = (await db.query(`SELECT exists(SELECT 1 FROM pg_trigger WHERE tgname = 'on_checkin_notify') AS trigger,
                                      has_function_privilege('anon', 'public.roamkeep_notify_checkin()', 'execute') AS anon`)).rows[0]
    await db.close()
    return r.trigger && !r.anon
  }
  const src = SCHEMA.replace(/\r\n/g, '\n')
  const start = src.indexOf('-- v18: the parts of the above that are safe to apply to ANY installed copy')
  const end = src.indexOf('END$$;', start) + 'END$$;'.length
  const withRepair = await repairs(SCHEMA)
  const withoutRepair = start < 0 ? null : await repairs(src.slice(0, start) + src.slice(end))
  const ok = withRepair && withoutRepair === false
  console.log(`\n== repair: ${ok ? 'ok' : 'WRONG'} (re-paste restores a deleted check-in trigger and its grant: ${withRepair}; ` +
    `without the repair block it would not: ${withoutRepair === false})`)
  if (!ok) fail('G: re-pasting schema.sql does not repair the check-in trigger, or the test cannot tell')
})

console.log(`\n${failures === 0 ? 'ALL OK' : failures + ' FAILURE(S)'}`)
process.exitCode = failures ? 1 : 0
