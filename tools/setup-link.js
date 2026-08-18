// Produce a Roamkeep setup link (and a scannable QR) for a backend.
//
//   npm run link                 # uses deploy.config.json
//   npm run link -- --code ABC   # also carry an invite code
//   node tools/setup-link.js --url https://x.supabase.co --key eyJ...
//
// WHY THIS EXISTS
// ---------------
// Since the backend is chosen at runtime, a fresh install shows the
// Connect screen and needs a setup link before it can do anything. The
// in-app Invite share produces those — but only for someone who is
// ALREADY connected and an owner. So the very first device on a brand-new
// Supabase has no way in: a chicken-and-egg the provisioning wizard (P5)
// is meant to close by printing exactly this at the end of setup.
//
// Until then this is the bootstrap, and it stays useful afterwards for
// re-connecting a wiped device without pestering another family member.

const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');

const ROOT = path.join(__dirname, '..');
const SETUP_LINK_BASE = 'https://get.roamkeep.app/s';

function arg(name) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 ? process.argv[i + 1] : null;
}

const explicitUrl = arg('url');
let url = explicitUrl;
let key = arg('key');
const code = arg('code');

if (!url || !key) {
  const cfgPath = path.join(ROOT, 'deploy.config.json');
  if (!fs.existsSync(cfgPath)) {
    console.error('No --url/--key given and deploy.config.json not found.\n' +
      'Either pass them explicitly or create deploy.config.json:\n' +
      '  { "url": "https://xxxx.supabase.co", "anonKey": "eyJ..." }');
    process.exit(1);
  }
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  url = url || cfg.url;
  key = key || cfg.anonKey;
}

url = String(url).trim().replace(/\/+$/, '');
key = String(key).trim();

if (!/^https:\/\//i.test(url)) {
  console.error('Project URL must be https:// — the app rejects anything else.');
  process.exit(1);
}

// ── Guard: is the Supabase CLI linked at a different project? ─────
// `supabase link` and `npm run link` share a word and nothing else.
// This script only ever reads deploy.config.json, so "I linked the test
// project, therefore the QR is for the test project" is a trap: you get
// a perfectly scannable code for the wrong backend, and the only tell is
// the Project line — which prints under a QR you were about to scan.
//
// Only fires when the project was INFERRED from deploy.config.json.
// An explicit --url is a deliberate choice and passes silently, or the
// warning becomes noise and stops being read.
function linkedProjectRef() {
  try {
    const raw = fs.readFileSync(
      path.join(ROOT, 'supabase', '.temp', 'linked-project.json'), 'utf8');
    return JSON.parse(raw).ref || null;
  } catch (_) { return null; }   // not linked, or nothing we can parse
}

const projectRef = (url.match(/^https:\/\/([a-z0-9]+)\.supabase\.co\/?$/i) || [])[1] || null;

if (!explicitUrl) {
  const cliRef = linkedProjectRef();
  if (cliRef && projectRef && cliRef !== projectRef) {
    console.warn(
      '\n⚠  The Supabase CLI is linked to a DIFFERENT project than this link.\n' +
      '\n     supabase link  →  ' + cliRef +
      '\n     this QR        →  ' + projectRef + '   (from deploy.config.json)\n' +
      '\n   `npm run link` never reads the CLI link — it only reads\n' +
      '   deploy.config.json, which is your production PWA backend.\n' +
      '   If you meant ' + cliRef + ', pass it explicitly instead:\n' +
      '\n     node tools/setup-link.js --url https://' + cliRef + '.supabase.co --key <anon-key>\n' +
      '\n   Do not edit deploy.config.json to switch — `npm run build:pwa`\n' +
      '   bakes it into the deployed PWA.\n');
  }
}

// Must match parseSetupLink()/buildSetupLink() in app.js: base64url of the
// project URL, the anon key verbatim, everything in the FRAGMENT so it
// never reaches the landing host's access logs.
const u = Buffer.from(url, 'utf8').toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const parts = ['v=1', 'u=' + u, 'k=' + encodeURIComponent(key)];
if (code) parts.push('c=' + encodeURIComponent(code));
const link = SETUP_LINK_BASE + '#' + parts.join('&');

const out = path.join(ROOT, 'setup-qr.png');

(async () => {
  // Which backend, BEFORE the QR — printed after it, this scrolls off the
  // top of a short terminal exactly when someone is about to scan.
  console.log('\nProject : ' + url + (explicitUrl ? '' : '   (from deploy.config.json)'));

  // Terminal QR — usually enough to scan straight off the screen.
  console.log('\n' + await QRCode.toString(link, { type: 'terminal', small: true }));
  await QRCode.toFile(out, link, { width: 600, margin: 2 });

  console.log('Invite  : ' + (code || '(none — recipient enters a code after signing in)'));
  console.log('QR      : ' + path.relative(ROOT, out));
  console.log('\nLink (paste into the Connect screen if the QR is awkward):\n');
  console.log(link + '\n');
  console.log('NOTE: this link contains your project URL and anon key. The anon');
  console.log('key is public by design (RLS is the boundary), but anyone with the');
  console.log('link can reach your Keep\'s sign-up screen — share it like an address,');
  console.log('not like a password, and rotate invite codes from the app.\n');
})().catch((e) => { console.error(e); process.exit(1); });
