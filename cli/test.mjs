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

// Mirror of parseSetupLink() in app.js — the consumer's view.
function parseSetupLink(text) {
  if (!text) return null;
  const s = String(text).trim();
  const hash = s.indexOf('#');
  const frag = hash >= 0 ? s.slice(hash + 1) : s;
  let p;
  try { p = new URLSearchParams(frag); } catch { return null; }
  const u = p.get('u'), k = p.get('k');
  if (!u || !k) return null;
  let url;
  try {
    url = /^https?:\/\//i.test(u) ? u : atob(u.replace(/-/g, '+').replace(/_/g, '/'));
  } catch { return null; }
  if (!/^https:\/\/[^\s]+$/i.test(url)) return null;
  return { url: url.replace(/\/+$/, ''), anonKey: k.trim(), code: p.get('c') || null };
}

const round = parseSetupLink(mine);
check('app.js parser accepts it', !!round);
check('url survives the round trip', round?.url === URL_);
check('anon key survives the round trip', round?.anonKey === KEY);
check('code is null when omitted', round?.code === null);

const withCode = parseSetupLink(buildSetupLink(URL_, KEY, 'ABC123XYZ789'));
check('invite code survives', withCode?.code === 'ABC123XYZ789');

check('trailing slash on the project URL is normalised',
  parseSetupLink(buildSetupLink(URL_ + '/', KEY))?.url === URL_);

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

console.log('\nwizard: every source file parses');

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
