// Offline checks for the wizard. Touches no network and no Supabase
// account: everything here is either pure logic or reads repo files.
//
//   node test.mjs
//
// The important one is the three-way link compatibility check. The setup
// link format is implemented in app.js, tools/setup-link.js and the CLI;
// if they drift, the wizard hands out links the app silently rejects, and
// nothing else would catch it.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { buildSetupLink } from './src/link.js';
import { saveSetupFiles } from './src/setupfile.js';
import * as steps from './src/steps.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
};

const URL_ = 'https://abcdefghijklmnop.supabase.co';
const KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature';

console.log('wizard: setup-link format');

const mine = buildSetupLink(URL_, KEY);
check('starts at the landing base', mine.startsWith('https://get.roamkeep.app/s#'));
check('config is in the fragment, not the query',
  mine.indexOf('#') < mine.indexOf('u=') && !mine.includes('?'));
check('carries v=1', mine.includes('v=1'));

// app.js's OWN parseSetupLink and buildSetupLink, cut out of the source and
// run here (4.11.1). This used to be a hand-copied mirror of the parser, so
// a change to the real one could leave every check below green; and the
// app's writer was never compared with the other two at all.
function cutFromApp(head) {
  const app = fs.readFileSync(path.join(REPO, 'app.js'), 'utf8');
  const at = app.indexOf(head);
  if (at < 0) return null;
  let depth = 0, i = app.indexOf('{', at);
  for (; i < app.length; i++) {
    if (app[i] === '{') depth++;
    else if (app[i] === '}' && --depth === 0) break;
  }
  return app.slice(at, i + 1);
}
const appLink = (() => {
  const srcs = ['function parseSetupLink(text)', 'function privilegedKey(k)', 'function buildSetupLink(code)']
    .map(cutFromApp);
  if (srcs.some((s) => !s)) return null;
  return (sbUrl, sbKey) => new Function('SB_URL', 'SB_KEY', `
    const SETUP_LINK_BASE = 'https://get.roamkeep.app/s';
    ${srcs.join('\n')}
    return { parseSetupLink, buildSetupLink };`)(sbUrl, sbKey);
})();
check('app.js setup-link functions found', !!appLink, 'moved or renamed');
const parseSetupLink = appLink ? appLink(URL_, KEY).parseSetupLink : () => null;

const round = parseSetupLink(mine);
check('app.js parser accepts it', !!round);
check('url survives the round trip', round?.url === URL_);
check('anon key survives the round trip', round?.anonKey === KEY);
check('code is null when omitted', round?.code === null);

const withCode = parseSetupLink(buildSetupLink(URL_, KEY, 'ABC123XYZ789'));
check('invite code survives', withCode?.code === 'ABC123XYZ789');

check('trailing slash on the project URL is normalised',
  parseSetupLink(buildSetupLink(URL_ + '/', KEY))?.url === URL_);

// The app's own invite share must write the very same link.
if (appLink) {
  check('app.js buildSetupLink agrees with the wizard exactly',
    appLink(URL_, KEY).buildSetupLink(null) === mine);
  check('...and with an invite code',
    appLink(URL_, KEY).buildSetupLink('ABC123XYZ789') === buildSetupLink(URL_, KEY, 'ABC123XYZ789'));
}

// What the app must REFUSE (4.11.1). Each of these used to connect, or try.
{
  const frag = (u, k, extra = '') =>
    '#v=1&u=' + Buffer.from(u).toString('base64url') + '&k=' + encodeURIComponent(k) + extra;
  const jwt = (claims) => 'eyJhbGciOiJIUzI1NiJ9.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.sig';
  const refused = {
    'plain http': frag('http://abcdefghijklmnop.supabase.co', KEY),
    'user-info in the address': frag('https://name:pw@abcdefghijklmnop.supabase.co', KEY),
    'a query in the address': frag(URL_ + '/?x=1', KEY),
    'a fragment in the address': frag(URL_ + '/#x', KEY),
    'an unknown link version': '#v=2&u=' + Buffer.from(URL_).toString('base64url') + '&k=' + KEY,
    'an empty key': frag(URL_, '   '),
    'a secret key': frag(URL_, 'sb_secret_abc123'),
    'a service_role JWT': frag(URL_, jwt({ role: 'service_role' })),
    'a code with odd characters': frag(URL_, KEY, '&c=' + encodeURIComponent('A<B')),
  };
  for (const [what, link] of Object.entries(refused)) {
    check(`app refuses ${what}`, parseSetupLink(link) === null);
  }
  check('app accepts an anon-role JWT', parseSetupLink(frag(URL_, jwt({ role: 'anon' })))?.url === URL_);
  check('app accepts a self-hosted address with a path',
    parseSetupLink(frag('https://family.example.org/supabase/', KEY))?.url === 'https://family.example.org/supabase');
  let threw = false;
  try { buildSetupLink(URL_, 'sb_secret_abc123'); } catch { threw = true; }
  check('the wizard refuses to write a link with a secret key', threw);
  let toolErr = '';
  try {
    execFileSync(process.execPath, [path.join(REPO, 'tools', 'setup-link.js'), '--url', URL_,
      '--key', jwt({ role: 'service_role' })], { encoding: 'utf8', cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) { toolErr = String(e.stderr || ''); }
  check('tools/setup-link.js refuses a service_role key', /secret \(service-role\) key/.test(toolErr), toolErr.slice(0, 80));
}

// Three-way agreement: the wizard and the bootstrap tool must emit the
// byte-identical link, or one of them is producing something the app
// treats differently.
{
  const out = execFileSync(process.execPath,
    [path.join(REPO, 'tools', 'setup-link.js'), '--url', URL_, '--key', KEY],
    { encoding: 'utf8', cwd: REPO });
  const fromTool = (out.match(/^https:\/\/get\.roamkeep\.app\/s#.+$/m) || [])[0];
  check('tools/setup-link.js emits a link', !!fromTool);
  check('wizard and tools/setup-link.js agree exactly', fromTool === mine,
    fromTool ? `\n        tool: ${fromTool.slice(0, 70)}\n        cli : ${mine.slice(0, 70)}` : '');

  // The wrong-project warning must stay rare to stay read. An explicit
  // --url is a deliberate choice, so it fires only when the project was
  // inferred from deploy.config.json — if it starts firing here it will
  // fire on every run and be tuned out exactly when it matters.
  check('no wrong-project warning when --url is explicit',
    !/DIFFERENT project/.test(out));
  check('the link names its project before the QR, not after',
    out.indexOf('Project :') > -1 && out.indexOf('Project :') < out.search(/[█▀▄]/));
}

console.log('\nwizard: repo inputs');

const schema = steps.readSchema();
check('schema.sql is readable', schema.length > 1000);
check('schema has the core tables',
  ['keeps', 'keep_members', 'checkins', 'keep_places', 'location_history']
    .every((t) => schema.includes(t)));
check('schema has the RPCs the app needs',
  ['create_keep', 'join_keep_by_code', 'rotate_keep_code', 'remove_member']
    .every((f) => schema.includes(f)));
check('schema is idempotent enough to re-run',
  schema.includes('CREATE TABLE IF NOT EXISTS') && schema.includes('DROP POLICY IF EXISTS'));

const fn = steps.readFunction();
check('notify-checkin source is readable', fn.length > 500);
check('function targets the relay, not FCM directly',
  fn.includes('relayEndpoint') && !fn.includes('fcm.googleapis.com'));

// The wizard's check-in trigger once carried its own hand-written body with
// no x-roamkeep-webhook header, and since it runs after the schema it
// replaced the working trigger on every provision and --upgrade: notify-
// checkin answered 403 to every check-in, silently. It now takes the body
// from schema.sql; these pin both halves of that.
{
  const sql = steps.webhookSql();
  check('wizard webhook sends the x-roamkeep-webhook secret',
    sql.includes("'x-roamkeep-webhook'") && sql.includes('roamkeep_secrets'));
  check('wizard webhook reads the URL from roamkeep_meta, not a hardcoded one',
    sql.includes('FROM roamkeep_meta') && !/https:\/\/[a-z0-9]+\.supabase\.co/.test(sql));
  check('wizard webhook is taken verbatim from schema.sql',
    schema.replace(/\r\n/g, '\n').includes(
      sql.split('\n\n').find((s) => s.includes('CREATE OR REPLACE FUNCTION public.roamkeep_notify_checkin()'))));
  check('probeFunction takes the api client (it reads the secret)', steps.probeFunction.length >= 2);
  const stamp = (schema.match(/VALUES \(true, (\d+)\)\s*ON CONFLICT[\s\S]*?GREATEST\(roamkeep_meta\.schema_version, (\d+)\)/) || []);
  check('SCHEMA_VERSION matches the version schema.sql stamps',
    Number(stamp[1]) === steps.SCHEMA_VERSION && Number(stamp[2]) === steps.SCHEMA_VERSION,
    `schema.sql ${stamp[1]}/${stamp[2]}, steps.js ${steps.SCHEMA_VERSION}`);
  // The app offers owners an update when their server is behind this number.
  // Left behind, it stops offering one; run ahead, it offers an update that
  // the bundled engine cannot deliver.
  const appSrc = fs.readFileSync(path.join(REPO, 'app.js'), 'utf8');
  const shipped = Number((appSrc.match(/const SHIPPED_SCHEMA = (\d+);/) || [])[1]);
  check('app.js SHIPPED_SCHEMA matches the version schema.sql stamps',
    shipped === Number(stamp[2]), `app.js ${shipped}, schema.sql ${stamp[2]}`);
}

console.log('\nwizard: landing assets');

const al = JSON.parse(fs.readFileSync(path.join(REPO, 'landing', '.well-known', 'assetlinks.json'), 'utf8'));
check('assetlinks targets the right package',
  al[0]?.target?.package_name === 'com.roamkeep.app');
check('assetlinks declares handle_all_urls',
  al[0]?.relation?.includes('delegate_permission/common.handle_all_urls'));
{
  const fps = al[0]?.target?.sha256_cert_fingerprints || [];
  const FP = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;
  check('assetlinks lists at least one fingerprint', fps.length >= 1);
  check('every fingerprint is colon-separated uppercase SHA-256',
    fps.length > 0 && fps.every((f) => FP.test(f)),
    fps.filter((f) => !FP.test(f)).join(', '));
  check('no duplicate fingerprints', new Set(fps).size === fps.length);
  // Sideload and Play builds are signed with different keys — Play App
  // Signing re-signs — so both must be listed or App Links silently fail
  // on one channel. Two is the expected steady state.
  check('both signing channels covered (sideload + Play)', fps.length >= 2,
    fps.length === 1 ? '(only one — Play App Signing key missing?)' : '');
}

const landing = fs.readFileSync(path.join(REPO, 'landing', 'index.html'), 'utf8');
check('landing page has no way to exfiltrate the fragment',
  !/fetch\(|XMLHttpRequest|sendBeacon/.test(landing));

console.log('\nwizard: saved setup files');

// The terminal QR dies with the window, so these files are the only
// route back onto a family's own server. Exercised in a temp dir — the
// wizard writes to cwd, so the test must not run in the repo.
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roamkeep-setup-'));
  const cwd = process.cwd;
  process.cwd = () => tmp;
  try {
    const REF = 'abcdefghijklmnop';
    const linkWithKey = buildSetupLink(URL_, KEY);
    const r = await saveSetupFiles(REF, URL_, linkWithKey);

    check('setup files are written', r.ok === true, r.err || '');
    check('filenames carry the project ref so a second project cannot clobber the first',
      r.txt === `roamkeep-setup-${REF}.txt` && r.png === `roamkeep-setup-${REF}.png`);

    const saved = fs.readFileSync(path.join(tmp, r.txt), 'utf8');
    // The whole point of the file: the link must survive verbatim, since
    // a user copy-pastes it straight into the Connect screen.
    check('the .txt carries the link byte-identically', saved.includes(linkWithKey));
    check('parsing the link back out of the .txt yields the same project',
      parseSetupLink((saved.match(/^https:\/\/get\.roamkeep\.app\/s#.+$/m) || [])[0])?.url === URL_);
    check('the .txt names the anon key, and warns off service_role',
      /anon/.test(saved) && /service_role/.test(saved));
    // Prose only. The link and the recovery command are single
    // unbreakable tokens — wrapping either would corrupt a copy-paste.
    {
      const long = saved.split('\n')
        .filter((l) => !/https:\/\/|node tools\//.test(l))
        .filter((l) => l.length > 90);
      check('no prose line runs past 90 columns', long.length === 0, long[0] || '');
    }

    const pngBytes = fs.readFileSync(path.join(tmp, r.png));
    check('the QR image is a real PNG', pngBytes.subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));
    check('the QR image is not a blank placeholder', pngBytes.length > 500);

    // A finished setup must not be reported as a failure because the
    // directory happened to be read-only.
    process.cwd = () => path.join(tmp, 'does-not-exist');
    const bad = await saveSetupFiles(REF, URL_, linkWithKey);
    check('an unwritable directory is reported, not thrown',
      bad.ok === false && typeof bad.err === 'string' && bad.err.length > 0);
  } finally {
    process.cwd = cwd;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log('\nwizard: resume advice');

// `--from N` is advice the wizard gives its own user, and getting it wrong
// fails silently in the worst way: every remaining step passes and the run
// still ends by asking for yet another run. That is exactly what happened
// with `--from 9`, which skipped the anon-key read and so could never
// produce the setup link the whole wizard exists to print.
{
  const src = fs.readFileSync(path.join(REPO, 'cli', 'src', 'index.js'), 'utf8');

  const stepNums = [...src.matchAll(/\bstep\(\s*(\d+),/g)].map((m) => Number(m[1]));
  const maxStep = Math.max(...stepNums);
  check('the wizard has a numbered step list', stepNums.length >= 8 && maxStep >= 9);

  // Comments get scanned along with the strings. That is deliberate: a
  // comment naming a step that does not exist is stale documentation of
  // the same fact, and worth failing on.
  const advised = [...src.matchAll(/--from (\d+)/g)].map((m) => Number(m[1]));
  const bogus = advised.filter((n) => !stepNums.includes(n));
  check('every --from the wizard suggests names a real step',
    advised.length > 0 && bogus.length === 0, bogus.join(', '));

  // The anon key is what the setup link carries, and reading it is a read,
  // not an action — there is no such thing as having already done it. So it
  // must be exempt from --from, or any resume past it is a dead end.
  const keyStep = Number((src.match(/step\((\d+), 'Reading the project API keys'/) || [])[1]);
  check('the anon-key read is a numbered step', Number.isInteger(keyStep));
  const keyCall = src.slice(src.indexOf(`step(${keyStep}, 'Reading the project API keys'`), -1).slice(0, 800);
  check('the anon-key read is exempt from --from, so a resume past it still prints the link',
    /\{\s*always:\s*true\s*\}/.test(keyCall));

  // The wizard told owners to resume with `npx create-roamkeep-server`, a
  // package that has never been published — the registry answers 404. It
  // failed at the worst possible moment: mid-setup, with the wizard's own
  // output as the only instruction to hand.
  //
  // Comments may name it (the header explains why not to use it, and SELF
  // returns it when genuinely running under npx). A hardcoded occurrence in
  // a string that reaches the user may not.
  {
    const strings = src
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))      // drop comment lines
      .join('\n');
    const hardcoded = [...strings.matchAll(/npx create-roamkeep-server/g)].length;
    // One legitimate occurrence: the SELF branch that returns it.
    check('resume advice is derived, not a hardcoded npx command',
      hardcoded <= 1,
      hardcoded > 1 ? `${hardcoded} occurrences outside comments — use SELF` : '');
    check('SELF derives the invocation from how the process was launched',
      /const SELF = \(\(\) =>/.test(src) && /npm_lifecycle_event/.test(src));
  }
}

console.log('\nengine: shared with the app');

// engine.js is the provisioning logic the app's phone setup runs too. The
// app has no Node, so a single Node built-in here would work in the wizard
// and fail only on a phone, mid-setup, for a family that cannot debug it.
{
  const src = fs.readFileSync(path.join(HERE, 'src', 'engine.js'), 'utf8');
  check('engine imports nothing (no Node built-ins, no packages)', !/^\s*import\s/m.test(src));
  check('engine never touches Buffer, process, require or fs',
    !/\bBuffer\.|\bprocess\.|\brequire\(|\bfs\./.test(src));
}

const engine = await import('./src/engine.js');

// The multipart body is built as a string (so the phone's native HTTP can
// send it). Node's own form parser is the independent judge of whether it
// is well formed — the spike proved Supabase accepts FormData, and this
// proves the string parses the way FormData's output does.
{
  const unicode = '// arrive — leave · 🧪\nexport default 1;\n';
  const { body, contentType } = engine.multipart([
    { name: 'metadata', content: JSON.stringify({ name: 'x', verify_jwt: false }) },
    { name: 'file', filename: 'index.ts', content: unicode, contentType: 'application/typescript' },
    { name: 'file', filename: 'deno.json', content: '{"imports":{}}', contentType: 'application/typescript' },
  ]);
  const form = await new Request('http://local.test/', {
    method: 'POST', headers: { 'content-type': contentType }, body,
  }).formData();
  check('multipart: metadata field round-trips', form.get('metadata') === JSON.stringify({ name: 'x', verify_jwt: false }));
  const files = form.getAll('file');
  check('multipart: both files arrive, named', files.length === 2 && files[0].name === 'index.ts' && files[1].name === 'deno.json');
  check('multipart: file content survives byte-for-byte, non-ASCII included', (await files[0].text()) === unicode);
}

// What deployFunction actually sends, captured from a fake transport.
{
  const seen = [];
  const http = async (req) => { seen.push(req); return { status: 201, text: '{"slug":"notify-checkin"}' }; };
  const api = engine.createClient({ token: 'sbp_test_token_0000000000', http });
  const fns = steps.readFunctions();
  await api.deployFunction('abcdefghijklmnop', 'notify-checkin', fns['notify-checkin'].files, fns['notify-checkin'].importMap);
  const req = seen[0];
  check('deploy: POST to /functions/deploy?slug=…',
    req.method === 'POST' && req.url === 'https://api.supabase.com/v1/projects/abcdefghijklmnop/functions/deploy?slug=notify-checkin');
  check('deploy: bearer token sent', req.headers.Authorization === 'Bearer sbp_test_token_0000000000');
  const form = await new Request('http://local.test/', {
    method: 'POST', headers: { 'content-type': req.headers['Content-Type'] }, body: req.body,
  }).formData();
  const meta = JSON.parse(form.get('metadata'));
  check('deploy: metadata as proven by the spike (index.ts, verify_jwt false, deno.json import map)',
    meta.name === 'notify-checkin' && meta.entrypoint_path === 'index.ts'
      && meta.verify_jwt === false && meta.import_map_path === 'deno.json');
  check('deploy: sends the function\'s own files',
    form.getAll('file').map((f) => f.name).sort().join(',') === 'deno.json,index.ts');
}

{
  const fns = steps.readFunctions();
  check('readFunctions covers every function', engine.FUNCTIONS.every((s) => fns[s]?.files?.length > 0));
  check('notify-places has no import map', fns['notify-places'].importMap === undefined);

  const deployed = [];
  const api = { deployFunction: async (ref, slug) => { deployed.push(slug); } };
  await engine.deployFunctions(api, 'ref', fns);
  check('deployFunctions deploys both', deployed.join(',') === engine.FUNCTIONS.join(','));
  let threw = false;
  try { await engine.deployFunctions(api, 'ref', { 'notify-checkin': fns['notify-checkin'] }); } catch { threw = true; }
  check('deployFunctions refuses a missing function source rather than skipping it', threw);
}

{
  const keys = (list) => ({ getApiKeys: async () => list });
  check('client key: legacy anon preferred',
    await engine.getClientKey(keys([{ name: 'default', api_key: 'sb_publishable_x' }, { name: 'anon', api_key: 'eyJanon' }], 'r')) === 'eyJanon');
  check('client key: falls back to sb_publishable_ when no anon key is issued',
    await engine.getClientKey(keys([{ name: 'default', api_key: 'sb_publishable_x' }, { name: 'default', api_key: 'sb_secret_y' }])) === 'sb_publishable_x');
  let threw = false;
  try { await engine.getClientKey(keys([{ name: 'default', api_key: 'sb_secret_y' }])); } catch { threw = true; }
  check('client key: never hands out a secret key', threw);
}

// The sign-up window both shells leave behind.
{
  const sql = [];
  const api = (rows) => ({ query: async (ref, q) => { sql.push(q); return rows; } });
  const until = await engine.openSignupWindow(api([{ signups_open_until: '2026-10-09T00:00:00Z' }]), 'r', 7);
  check('sign-up window: closes with a 7-day opening', /signups_closed = true/.test(sql[0]) && /interval '7 days'/.test(sql[0]));
  check('sign-up window: never on a server a family already uses', /not exists \(select 1 from keeps\)/.test(sql[0]));
  check('sign-up window: reports when it ends', until === '2026-10-09T00:00:00Z');
  check('sign-up window: null when a family was already there', await engine.openSignupWindow(api([]), 'r', 7) === null);
  let threw = 0;
  for (const bad of [0, 31, 2.5, '7; drop table keeps']) {
    try { await engine.openSignupWindow(api([]), 'r', bad); } catch { threw++; }
  }
  check('sign-up window: refuses anything but 1-30 whole days (it is interpolated into SQL)', threw === 4);
}

// A cold function answers 404/5xx for a while; the phone has nobody to
// re-run a step, so the probe waits it out — and still gives up eventually.
{
  let calls = 0;
  const api = {
    query: async () => [{ webhook_secret: 's' }],
    http: async (req) => { calls++; return { status: req.url.endsWith('notify-checkin') && calls < 3 ? 404 : 200, text: 'ok' }; },
  };
  const out = await engine.probeFunctions(api, 'r', { attempts: 5, waitMs: 0, sleep: async () => {} });
  check('probe: waits out a cold start', out['notify-checkin'] === 200 && out['notify-places'] === 200 && calls === 4);
  const dead = { query: async () => [], http: async () => ({ status: 503, text: '' }) };
  let threw = false;
  try { await engine.probeFunctions(dead, 'r', { attempts: 3, waitMs: 0, sleep: async () => {} }); } catch { threw = true; }
  check('probe: gives up after its attempts', threw);
}

{
  const seen = [];
  const api = engine.createClient({ token: 't', http: async (req) => { seen.push(req); return { status: 201, text: '{"id":"o1","name":"Roamkeep"}' }; } });
  const org = await api.createOrganization('Roamkeep');
  check('createOrganization: POST /v1/organizations with a name',
    seen[0].method === 'POST' && seen[0].url.endsWith('/v1/organizations') && JSON.parse(seen[0].body).name === 'Roamkeep' && org.id === 'o1');
}

// One ordered list of setup steps, and the desktop wizard must keep calling
// every one of them. The phone runs setupSteps() as it is; the wizard runs
// the same functions as numbered steps of its own (manual fallbacks, --from).
// Two orderings of one sequence is how a step gets dropped from one shell.
{
  const ids = engine.setupSteps({ schemaSql: '', functions: {} }).map((s) => s.id);
  const WIZARD = {
    extensions: /steps\.enableExtensions\(/,
    schema: /steps\.applySchema\(/,
    verify: /steps\.verifySchema\(/,
    auth: /steps\.configureAuth\(/,
    webhook: /steps\.setProjectUrl\([\s\S]*steps\.createWebhook\([\s\S]*steps\.verifyWebhook\(/,
    functions: /steps\.deployFunctions\(/,
    probe: /steps\.probeFunction\(/,
    signups: /steps\.openSignupWindow\(/,
    key: /steps\.getAnonKey\(/,
  };
  // Scoped to main(), so a call that only the upgrade path makes cannot
  // satisfy a setup check, and the other way round below.
  const src = fs.readFileSync(path.join(HERE, 'src', 'index.js'), 'utf8');
  const wizard = src.slice(src.indexOf('async function main('));
  check('setup steps: the wizard knows every step the phone runs',
    ids.join(',') === Object.keys(WIZARD).join(','), `engine: ${ids.join(',')}`);
  const missing = Object.entries(WIZARD).filter(([, re]) => !re.test(wizard)).map(([id]) => id);
  check('setup steps: the wizard still calls each of them', missing.length === 0, missing.join(', '));

  const upIds = engine.upgradeSteps({ schemaSql: '', functions: {} }).map((s) => s.id);
  const UPGRADE = {
    extensions: /steps\.enableExtensions\(/,
    schema: /steps\.applySchema\(/,
    verify: /steps\.verifySchema\(/,
    webhook: /steps\.setProjectUrl\([\s\S]*steps\.createWebhook\([\s\S]*steps\.verifyWebhook\(/,
    functions: /steps\.deployFunctions\(/,
    probe: /steps\.probeFunction\(/,
    signups: /steps\.handOverSignups\([\s\S]*steps\.applyPasswordRules\(/,
  };
  const upgrade = src.slice(src.indexOf('async function runUpgrade('), src.indexOf('async function main('));
  check('update steps: the wizard\'s --upgrade knows every step the phone runs',
    upIds.join(',') === Object.keys(UPGRADE).join(','), `engine: ${upIds.join(',')}`);
  const upMissing = Object.entries(UPGRADE).filter(([, re]) => !re.test(upgrade)).map(([id]) => id);
  check('update steps: --upgrade still calls each of them', upMissing.length === 0, upMissing.join(', '));
  check('update steps: --upgrade refuses unsuitable databases first', /steps\.checkUpgradeable\(/.test(upgrade));
}

// Handing the sign-up switch to the app: the app's gate is closed BEFORE
// GoTrue's is opened, so there is never a moment with both open.
{
  const seen = [];
  const api = (disabled) => ({
    getAuthConfig: async () => ({ disable_signup: disabled }),
    query: async (ref, q) => { seen.push('close:' + /signups_closed = true, signups_open_until = null/.test(q)); return []; },
    updateAuthConfig: async (ref, patch) => { seen.push('open:' + JSON.stringify(patch)); },
  });
  check('hand-over: nothing to do when the dashboard switch is on', await engine.handOverSignups(api(false), 'r') === 'app' && seen.length === 0);
  const out = await engine.handOverSignups(api(true), 'r');
  check('hand-over: closes the app\'s gate, then reopens GoTrue\'s, in that order',
    out === 'handed-over' && seen.join(' ') === 'close:true open:{"disable_signup":false}', seen.join(' '));
  seen.length = 0;
  const failing = { ...api(true), query: async () => { throw new Error('db down'); } };
  let threw = false;
  try { await engine.handOverSignups(failing, 'r'); } catch { threw = true; }
  check('hand-over: if closing the app\'s gate fails, GoTrue\'s is left shut', threw && seen.length === 0);
}

// The server's password rules (4.11.3): at least 8 characters, raised and
// never lowered, and the current password needed to change it. Set at setup
// and on every update, whose signups step runs them.
{
  const patches = [];
  const api = (min, cur) => ({
    getAuthConfig: async () => ({ password_min_length: min, mailer_autoconfirm: true,
      security_update_password_require_current_password: cur }),
    updateAuthConfig: async (ref, patch) => { patches.push(JSON.stringify(patch)); },
  });
  const both = '{"password_min_length":8,"security_update_password_require_current_password":true}';
  await engine.applyPasswordRules(api(6, false), 'r');
  check('passwords: Supabase\'s defaults (6, no current password) are tightened', patches.join() === both, patches.join());
  patches.length = 0;
  await engine.applyPasswordRules(api(12, false), 'r');
  check('passwords: an owner\'s longer minimum is kept',
    patches.join() === '{"security_update_password_require_current_password":true}', patches.join());
  patches.length = 0;
  await engine.applyPasswordRules(api(8, true), 'r');
  check('passwords: nothing is written when the rules already hold', patches.length === 0, patches.join());
  patches.length = 0;
  await engine.configureAuth(api(6, false), 'r');
  check('passwords: setup sets them, in the same write as confirmations off',
    patches.join() === '{"mailer_autoconfirm":true,"password_min_length":8,"security_update_password_require_current_password":true}',
    patches.join(' '));
  patches.length = 0;
  const signups = engine.upgradeSteps({ schemaSql: '', functions: {} }).find((s) => s.id === 'signups');
  await signups.run({ ...api(6, false), query: async () => [] }, 'r');
  check('passwords: an update sets them', patches.includes(both), patches.join(' '));
}

// The app's own rule (passwordProblem), its real source run against the
// real list: every place that sets a password goes through it.
{
  const app = fs.readFileSync(path.join(HERE, '..', 'app.js'), 'utf8');
  const start = app.indexOf('  async function passwordProblem(');
  const end = app.indexOf('\n  }\n', start) + 4;
  const list = new Set(fs.readFileSync(path.join(HERE, '..', 'data', 'common-passwords.txt'), 'utf8').split(/\r?\n/).filter(Boolean));
  const loadBundle = async () => ({ isCommon: (p) => list.has(String(p).toLowerCase()) });
  const passwordProblem = new Function('loadBundle', app.slice(start, end) + '\nreturn passwordProblem;')(loadBundle);
  const ok = async (pw, email) => (await passwordProblem(pw, email)) === null;
  check('passwords: 7 characters are refused', !(await ok('Xq7!pLm', 'a@b.c')));
  check('passwords: a common one is refused, whatever its case', !(await ok('Password1', 'a@b.c')) && !(await ok('ILOVEYOU', 'a@b.c')));
  check('passwords: one containing the email\'s name is refused', !(await ok('olivia-2026x', 'olivia@example.com')));
  check('passwords: one containing the app\'s name is refused', !(await ok('MyRoamkeep!', 'a@b.c')));
  check('passwords: an ordinary passphrase is accepted', await ok('purple tractor sandwich', 'olivia@example.com'));
  check('passwords: no character-mixing rule (lower-case words are fine)', await ok('quietlantern', 'a@b.c'));
  // The app logs a warning when the list can't load. Captured here and
  // checked, rather than printed: a stack trace in the release log reads
  // like a failure (4.11.3-rc3 build).
  {
    const noList = new Function('loadBundle', app.slice(start, end) + '\nreturn passwordProblem;')(
      async () => { throw new Error('missing'); });
    const warn = console.warn;
    const warned = [];
    console.warn = (...a) => { warned.push(a.map(String).join(' ')); };
    let common, short;
    try {
      common = await noList('Password1', 'a@b.c');
      short = await noList('short', 'a@b.c');
    } finally {
      console.warn = warn;
    }
    check('passwords: if the list fails to load, the other rules still hold, and it says so',
      common === null && short !== null && warned.length === 1 && warned[0].startsWith('pwcheck'),
      warned.join(' | '));
  }
  const calls = (app.match(/await passwordProblem\(/g) || []).length;
  check('passwords: sign-up, Change password, a reset code and owner recovery all use it', calls === 4, `${calls} call sites`);
  check('passwords: Change password sends the current password',
    /updateUser\(\{ password: a, current_password: cur \}\)/.test(app));
  check('passwords: the list holds the 5,000 most common, lower-cased, 8 or more characters',
    list.size === 5000 && [...list].every((w) => w.length >= 8 && w === w.toLowerCase()));
}

// What an update refuses to touch.
{
  const api = (keeps, version) => ({
    query: async (ref, q) => {
      if (q.includes("to_regclass('public.keeps')")) return [{ keeps }];
      if (q.includes("to_regclass('public.roamkeep_meta')")) return [{ present: version !== null }];
      return [{ schema_version: version }];
    },
  });
  const a = await engine.checkUpgradeable(api(false, null), 'r');
  check('update: refuses a database with no keeps table (not Roamkeep, or pre-v9)', !a.ok && a.reason === 'not-roamkeep');
  const b = await engine.checkUpgradeable(api(true, engine.SCHEMA_VERSION + 1), 'r');
  check('update: refuses a database newer than this engine', !b.ok && b.reason === 'newer');
  const c = await engine.checkUpgradeable(api(true, 13), 'r');
  const d = await engine.checkUpgradeable(api(true, null), 'r');
  check('update: accepts an older or untracked keeps-era database', c.ok && c.version === 13 && d.ok && d.version === null);
}

// The whole phone sequence against a fake Management API: every step runs,
// in order, and it ends with the client key.
{
  const order = [];
  const http = async (req) => {
    const u = new URL(req.url);
    const p = u.pathname;
    const q = req.body ? (JSON.parse(req.body.startsWith('{') ? req.body : '{}').query || '') : '';
    let rows = [];
    if (p.endsWith('/database/query')) {
      if (q.includes('create trigger on_checkin_notify')) { /* part of 'webhook' */ }
      else if (/^create extension/i.test(q.trim())) order.push('extensions');
      else if (q.includes('ROAMKEEP_TEST_SCHEMA')) order.push('schema');
      else if (q.includes('information_schema.tables')) { order.push('verify'); rows = [{ tables: 6, rpcs: 5 }]; }
      else if (q.includes('to_regclass')) rows = [{ present: true }];
      else if (q.includes('select schema_version')) rows = [{ schema_version: engine.SCHEMA_VERSION }];
      else if (q.includes('update roamkeep_meta set project_url')) order.push('webhook');
      else if (q.includes('select project_url')) rows = [{ project_url: 'https://r.supabase.co' }];
      else if (q.includes('pg_trigger')) rows = [{ tgname: 'on_checkin_notify' }, { tgname: 'on_place_notify' }];
      else if (q.includes('sends_secret')) rows = [{ sends_secret: true }];
      else if (q.includes('webhook_secret')) rows = [{ webhook_secret: 's' }];
      else if (q.includes('signups_closed = true')) { order.push('signups'); rows = [{ signups_open_until: 'later' }]; }
    } else if (p.endsWith('/config/auth')) {
      if (req.method === 'PATCH') order.push('auth');
      rows = { mailer_autoconfirm: true };
    } else if (p.includes('/functions/deploy')) {
      order.push('functions:' + u.searchParams.get('slug'));
      rows = { slug: u.searchParams.get('slug') };
    } else if (u.host.endsWith('.supabase.co')) {
      order.push('probe:' + p.split('/').pop());
      return { status: 200, text: 'ok' };
    } else if (p.endsWith('/api-keys')) {
      order.push('key');
      rows = [{ name: 'anon', api_key: 'eyJanon' }];
    }
    return { status: 200, text: JSON.stringify(rows) };
  };
  const api = engine.createClient({ token: 't', http });
  const list = engine.setupSteps({ schemaSql: steps.readSchema() + '\n-- ROAMKEEP_TEST_SCHEMA', functions: steps.readFunctions() });
  let last;
  for (const s of list) last = await s.run(api, 'r');
  check('setup steps: run end to end, in order, ending with the client key',
    order.join(' ') === 'extensions extensions schema verify auth webhook functions:notify-checkin functions:notify-places '
      + 'probe:notify-checkin probe:notify-places signups key' && last === 'eyJanon',
    order.join(' '));
}

// Both Edge Functions' own secret lookup and comparison, cut out of the
// TypeScript and run against a stubbed database answer. Only a missing TABLE
// (a database from before v14) may leave the check open; a table without a
// usable secret in it fails closed, which before v18 it did not.
console.log('\nedge functions: the webhook secret check');
{
  const { transform } = await import('esbuild');
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const answers = {
    'a secret':            { data: { webhook_secret: 'expected' }, error: null },
    'no row':              { data: null, error: null },
    'a NULL secret':       { data: { webhook_secret: null }, error: null },
    'an empty secret':     { data: { webhook_secret: '' }, error: null },
    'no table (Postgres)': { data: null, error: { code: '42P01' } },
    'no table (PostgREST)': { data: null, error: { code: 'PGRST205' } },
    'a database outage':   { data: null, error: { code: '08006' } },
  };
  for (const fn of ['notify-checkin', 'notify-places']) {
    const src = fs.readFileSync(path.join(REPO, 'supabase', 'functions', fn, 'index.ts'), 'utf8');
    const start = src.indexOf('const SECRET_TTL_MS');
    const end = src.indexOf('\n}', src.indexOf('async function secretMatches')) + 2;
    if (start < 0 || end < 2) { check(`${fn}: secret helpers found`, false, 'moved or renamed'); continue; }
    const js = (await transform(src.slice(start, end), { loader: 'ts' })).code;
    const outcome = {};
    for (const [name, answer] of Object.entries(answers)) {
      const run = new AsyncFunction('sb', js + `
        try {
          const want = await webhookSecret(sb);
          if (want === null) return 'open';
          const ok = await secretMatches('expected', want);
          const wrong = await secretMatches('wrong', want);
          const none = await secretMatches(null, want);
          return ok && !wrong && !none ? 'checked' : 'BROKEN';
        } catch (e) { return 'refused'; }`);
      const sb = { from: () => ({ select: () => ({ maybeSingle: async () => answer }) }) };
      outcome[name] = await run(sb);
    }
    check(`${fn}: a stored secret is required and compared`, outcome['a secret'] === 'checked', outcome['a secret']);
    check(`${fn}: a table without a usable secret refuses (503)`,
      ['no row', 'a NULL secret', 'an empty secret'].every((k) => outcome[k] === 'refused'),
      JSON.stringify(outcome));
    check(`${fn}: only a missing table leaves the check open`,
      outcome['no table (Postgres)'] === 'open' && outcome['no table (PostgREST)'] === 'open',
      JSON.stringify(outcome));
    check(`${fn}: a database outage refuses (503)`, outcome['a database outage'] === 'refused', outcome['a database outage']);
  }
}

// The app's own place-arming code, cut out of app.js and run against a fake
// native bridge. The contract (the architecture notes, "the recurring bug"): the native
// side is handed the COMPLETE list, an empty one included, but never a list
// nobody has read; and a list counts as armed only once native says Play
// Services took it (4.11.1).
console.log('\napp: arming geofences from the place list');
{
  const app = fs.readFileSync(path.join(REPO, 'app.js'), 'utf8');
  const cut = (head) => {
    const at = app.indexOf(head);
    if (at < 0) return null;
    let depth = 0, i = app.indexOf('{', at);
    for (; i < app.length; i++) {
      if (app[i] === '{') depth++;
      else if (app[i] === '}' && --depth === 0) break;
    }
    return app.slice(at, i + 1);
  };
  const sigSrc = cut('function placesSignature()');
  const armSrc = cut('async function rearmGeofencesFromPlaces(why, force)');
  if (!sigSrc || !armSrc) {
    check('place-arming functions found in app.js', false, 'moved or renamed');
  } else {
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
    const scenario = async (S, answer) => {
      const calls = [];
      const NG = { armPlaces: async (arg) => { calls.push(arg.places.map((p) => p.id)); return answer; } };
      const run = new AsyncFunction('S', 'NG', `
        let _armedSig = null, _lastArmMs = 0;
        const ARM_THROTTLE_MS = 15000;
        const isNative = () => true, nativeGeo = () => NG, syncNativeAddPlace = async () => {};
        const console = { info() {}, warn() {} };
        ${sigSrc}
        ${armSrc}
        await rearmGeofencesFromPlaces('test', true);
        return { armedSig: _armedSig };`);
      const out = await run(S, NG);
      return { calls, armedSig: out.armedSig };
    };
    const home = { id: 'a', lat: 1, lng: 2, radius_m: 100, name: 'Home', icon: '🏠' };

    let r = await scenario({ places: [], _placesLoaded: true }, { armed: 0, ok: true });
    check('an empty list that was read reaches native (the prune case)',
      r.calls.length === 1 && r.calls[0].length === 0, JSON.stringify(r.calls));
    r = await scenario({ places: [] }, { armed: 0, ok: true });
    check('an empty list nobody has read does not', r.calls.length === 0, JSON.stringify(r.calls));
    r = await scenario({ places: [home], _placesLoaded: true }, { armed: 1, ok: true });
    check('a list Play Services accepted is recorded as armed',
      r.calls.length === 1 && r.armedSig === 'a:1:2:100:Home:🏠', String(r.armedSig));
    r = await scenario({ places: [home], _placesLoaded: true }, { armed: 0, ok: false });
    check('a list Play Services refused is not, so it is retried', r.armedSig === null, String(r.armedSig));
  }
}

// Sign-out and Disconnect, made offline. supabase-js resolves with an error
// and stops BEFORE clearing its stored session when the logout request
// fails on the network; the privacy page says Disconnect "clears the app's
// stored credentials". signOutHere must remove them either way (4.11.1).
console.log('\napp: signing out on this device');
{
  const app = fs.readFileSync(path.join(REPO, 'app.js'), 'utf8');
  const at = app.indexOf('async function signOutHere()');
  let src = null;
  if (at >= 0) {
    let depth = 0, i = app.indexOf('{', at);
    for (; i < app.length; i++) {
      if (app[i] === '{') depth++;
      else if (app[i] === '}' && --depth === 0) break;
    }
    src = app.slice(at, i + 1);
  }
  if (!src) {
    check('signOutHere found in app.js', false, 'moved or renamed');
  } else {
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
    for (const [label, answer] of [['offline', { error: { name: 'AuthRetryableFetchError' } }], ['online', { error: null }]]) {
      const removed = [];
      const S = { sb: { auth: { storageKey: 'sb-abc-auth-token', signOut: async () => answer } } };
      const store = { removeItem: async (k) => { removed.push(k); } };
      const run = new AsyncFunction('S', 'store', `
        const SB_URL = 'https://abc.supabase.co';
        const buildAuthStorage = () => store;
        const window = {};
        const console = { warn() {} };
        ${src}
        return signOutHere();`);
      const confirmed = await run(S, store);
      check(`${label}: the stored session is removed from this device`,
        removed.includes('sb-abc-auth-token'), JSON.stringify(removed));
      check(`${label}: says whether the server heard`, confirmed === (label === 'online'), String(confirmed));
    }
  }
}

console.log('\nwizard: every source file parses');

// security.txt (RFC 9116), published on both sites from one file. Its Expires
// date is the trap: a lapsed file tells a researcher the contact may be dead,
// and nothing else would notice. So this starts failing a month before it
// lapses, which is the reminder to renew it (and to keep it under a year,
// as the RFC asks).
{
  const file = path.join(REPO, 'site', '.well-known', 'security.txt');
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const field = (name) => lines.filter((l) => l.toLowerCase().startsWith(name.toLowerCase() + ':'))
    .map((l) => l.slice(name.length + 1).trim());
  check('security.txt: every line is a field (no comments: published files carry none)',
    lines.length > 0 && lines.every((l) => /^[A-Za-z-]+: \S/.test(l)), lines.find((l) => !/^[A-Za-z-]+: \S/.test(l)) || 'empty');
  check('security.txt: contacts are the security address and private reporting',
    field('Contact').includes('mailto:security@roamkeep.app')
      && field('Contact').includes('https://github.com/roamkeep/roamkeep/security/advisories/new'),
    field('Contact').join(', '));
  check('security.txt: both sites are Canonical',
    ['https://roamkeep.app/.well-known/security.txt', 'https://get.roamkeep.app/.well-known/security.txt']
      .every((u) => field('Canonical').includes(u)), field('Canonical').join(', '));
  check('security.txt: one Expires, and a Policy', field('Expires').length === 1 && field('Policy').length === 1);
  const days = (Date.parse(field('Expires')[0]) - Date.now()) / 864e5;
  check('security.txt: Expires is between 30 and 366 days away (renew it when this fails)',
    days > 30 && days <= 366, Number.isFinite(days) ? `${Math.round(days)} days` : 'unreadable date');
}

// The suite read src/index.js as TEXT for the --from checks above and never
// asked Node whether it was valid JavaScript. So it reported 39/39 on a
// wizard that would not start: a patch had left literal newlines inside
// string literals, and `npm start` died with SyntaxError on line 341.
//
// Passing tests on a program that cannot load is the worst kind of green.
// `node --check` parses without executing, which matters here because
// importing index.js would launch the wizard.
{
  const files = fs.readdirSync(path.join(HERE, 'src'))
    .filter((f) => f.endsWith('.js'))
    .map((f) => path.join('src', f))
    .concat(['test.mjs']);

  for (const rel of files) {
    let err = '';
    try {
      execFileSync(process.execPath, ['--check', path.join(HERE, rel)],
        { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) {
      err = String(e.stderr || e.message).split('\n').find((l) => /Error/.test(l)) || 'failed to parse';
    }
    check(`${rel} parses`, !err, err);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
