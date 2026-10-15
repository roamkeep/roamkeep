// Stage the web bundle into dist/ for Capacitor — minifying our own
// JS/CSS on the way through. dist/ is what ships (APK assets AND the
// S3/CloudFront PWA deploy), so comments and readable structure stay in
// the repo but never reach a device. supabase.js is a vendored bundle
// and is copied as-is; index.html stays readable (it's structural — the
// interesting logic lives in app.js).

const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');

// name → esbuild loader for files we minify; everything else is copied.
const MINIFY = { 'app.js': 'js', 'sw.js': 'js', 'styles.css': 'css' };

const ASSETS = [
  'index.html',
  'styles.css',
  'app.js',
  'supabase.js',
  'sw.js',
  'manifest.json',
  'icon-192.png',
  'icon-512.png',
  'brand-tile.png'
];

// Optional pre-connected build, OPT-IN via `--bake`.
//
// The app ships with NO backend compiled in: a Play Store install asks the
// user to scan a setup link for their own family's Supabase. But a PWA
// published to a fixed URL for one known family can be pre-pointed at it
// with deploy.config.json (gitignored):
//
//   { "url": "https://xxxx.supabase.co", "anonKey": "eyJ..." }
//
// substituted into the BUILD_INJECT_BACKEND line in app.js.
//
// Baking is deliberately NOT the default, because `npm run sync` feeds the
// Android build as well — a default-on bake would quietly ship one
// family's project inside the Play Store APK.
const BAKE = process.argv.includes('--bake');

function bakedBackendLine() {
  if (!BAKE) return null;
  const cfgPath = path.join(ROOT, 'deploy.config.json');
  if (!fs.existsSync(cfgPath)) {
    console.warn('[build] --bake given but deploy.config.json not found — building unconnected');
    return null;
  }
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  if (!cfg.url || !cfg.anonKey) {
    console.warn('[build] deploy.config.json missing url/anonKey — ignoring');
    return null;
  }
  return '  const BAKED_BACKEND = ' + JSON.stringify({ url: cfg.url, anonKey: cfg.anonKey }) +
         '; /* BUILD_INJECT_BACKEND */';
}

// ── Release gate: sw.js CACHE must move with android versionCode ──
//
// Leaving CACHE alone means returning PWA users keep being served the
// previous bundle out of the service worker's cache, so a fix — a security
// fix included — ships to the store and silently never reaches the web.
// Nothing reports it: the build succeeds, the deploy succeeds, and only the
// users are stale.
//
// It has already happened once. 4.5.10 (versionCode 52) went out with CACHE
// still at roamkeep-v59, the value 4.5.9 had shipped.
//
// The release convention is that a behavioural change bumps versionCode,
// versionName and CACHE together, so the two numbers move in lockstep and
// their difference is a constant. Pinning the difference catches a miss in
// either direction, and — unlike recording the last released CACHE here —
// never needs updating, so it cannot decay into a check that always passes.
//
// If a release ever has a real reason to break the pairing, move
// CACHE_VERSION_OFFSET in the same commit and say why.
const CACHE_VERSION_OFFSET = 7;   // roamkeep-v79 ↔ versionCode 72

function checkCacheVersion() {
  const swPath = path.join(ROOT, 'sw.js');
  const gradlePath = path.join(ROOT, 'android', 'app', 'build.gradle');
  // A web-only checkout has no android/ — there is nothing to check against,
  // and refusing to build one would be its own kind of wrong.
  if (!fs.existsSync(swPath) || !fs.existsSync(gradlePath)) {
    console.warn('[build] cache/versionCode gate skipped — sw.js or android/app/build.gradle not present');
    return;
  }
  const cacheM = /const CACHE = 'roamkeep-v(\d+)'/.exec(fs.readFileSync(swPath, 'utf8'));
  const codeM = /versionCode\s+(\d+)/.exec(fs.readFileSync(gradlePath, 'utf8'));
  if (!cacheM || !codeM) {
    throw new Error(
      '[build] cannot read CACHE from sw.js or versionCode from build.gradle.\n' +
      '        Repair the pattern rather than dropping the gate — a gate that\n' +
      '        cannot read its inputs is the same as no gate at all.'
    );
  }
  const cache = Number(cacheM[1]);
  const code = Number(codeM[1]);
  const want = code + CACHE_VERSION_OFFSET;
  if (cache !== want) {
    throw new Error(
      '[build] sw.js CACHE is out of step with the android versionCode.\n' +
      '        versionCode ' + code + ' expects roamkeep-v' + want + ', found roamkeep-v' + cache + '.\n' +
      '        Every behavioural change bumps versionCode, versionName and CACHE\n' +
      '        together; a stale CACHE leaves PWA users on the previous bundle with\n' +
      '        no error anywhere. Bump whichever is behind — or CACHE_VERSION_OFFSET,\n' +
      '        if the pairing is deliberately changing.'
    );
  }
  console.log('[build] cache/versionCode in step (roamkeep-v' + cache + ' ↔ versionCode ' + code + ')');
}

// Before the wipe, so a failed gate leaves dist/ as it was.
checkCacheVersion();

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

for (const name of ASSETS) {
  const src = path.join(ROOT, name);
  if (!fs.existsSync(src)) {
    console.warn(`[build] skipped missing: ${name}`);
    continue;
  }
  if (MINIFY[name]) {
    let source = fs.readFileSync(src, 'utf8');
    if (name === 'app.js') {
      const line = bakedBackendLine();
      if (line) {
        const before = source;
        source = source.replace(/^.*BUILD_INJECT_BACKEND.*$/m, line);
        if (source === before) {
          throw new Error('[build] BUILD_INJECT_BACKEND marker not found in app.js');
        }
        console.log('[build] baked backend from deploy.config.json');
      }
    }
    const out = esbuild.transformSync(source, {
      minify: true,
      loader: MINIFY[name]
    });
    fs.writeFileSync(path.join(DIST, name), out.code);
    const kb = (n) => (fs.statSync(n).size / 1024).toFixed(1);
    console.log(`[build] minified ${name} (${kb(src)} kB → ${kb(path.join(DIST, name))} kB)`);
  } else {
    fs.copyFileSync(src, path.join(DIST, name));
    console.log(`[build] copied ${name}`);
  }
}

// ── Phone setup: the provisioning engine, and what it installs ────
//
// "Set up a new family" runs the same engine as the desktop wizard
// (cli/src/engine.js), fed the same inputs: db/schema.sql and the Edge
// Function sources, read by the wizard's own reader (cli/src/steps.js) so
// the two cannot pick different files. Bundled into one IIFE that defines
// window.RoamkeepProvision, loaded by app.js only when someone opens setup.
//
// Then it is loaded back and compared with the files on disk. A phone that
// provisioned a family with a stale or truncated schema would report
// success and leave them on a server that is quietly wrong — the one
// failure nothing downstream would notice.
async function bundleProvision() {
  const { pathToFileURL } = require('url');
  const vm = require('vm');
  const steps = await import(pathToFileURL(path.join(ROOT, 'cli', 'src', 'steps.js')).href);
  const schemaSql = steps.readSchema();
  const functions = steps.readFunctions();
  const entry =
    "export * from './cli/src/engine.js';\n" +
    'export const schemaSql = ' + JSON.stringify(schemaSql) + ';\n' +
    'export const functions = ' + JSON.stringify(functions) + ';\n';
  const out = esbuild.buildSync({
    stdin: { contents: entry, resolveDir: ROOT, sourcefile: 'provision-entry.js', loader: 'js' },
    bundle: true,
    format: 'iife',
    globalName: 'RoamkeepProvision',
    minify: true,
    legalComments: 'none',
    target: 'es2020',
    write: false
  });
  const code = out.outputFiles[0].text;

  const ctx = {};
  vm.runInNewContext(code + '\n;this.R = RoamkeepProvision;', ctx);
  const R = ctx.R;
  const onDisk = fs.readFileSync(path.join(ROOT, 'db', 'schema.sql'), 'utf8');
  const stamp = Number((/GREATEST\(roamkeep_meta\.schema_version,\s*(\d+)\)/.exec(onDisk) || [])[1]);
  const problems = [];
  if (!R || R.schemaSql !== onDisk) problems.push('schemaSql is not byte-identical to db/schema.sql (a stale cli/assets/?)');
  // Read supabase/functions/ here, independently. Comparing against the
  // `functions` above proved only that the bundle matched its own input:
  // steps.js prefers cli/assets/ whenever a packed schema is there, so a
  // pack left behind after an Edge Function edit passed with stale code.
  const fnDir = path.join(ROOT, 'supabase', 'functions');
  const onDiskFns = {};
  for (const slug of (R && R.FUNCTIONS) || []) {
    const names = fs.readdirSync(path.join(fnDir, slug)).filter((f) => /\.(ts|json)$/.test(f)).sort();
    onDiskFns[slug] = {
      files: names.map((name) => ({ name, content: fs.readFileSync(path.join(fnDir, slug, name), 'utf8') })),
      importMap: names.includes('deno.json') ? 'deno.json' : undefined,
    };
  }
  if (!R || JSON.stringify(R.functions) !== JSON.stringify(onDiskFns)) {
    problems.push('function sources differ from supabase/functions/ (a stale cli/assets/?)');
  }
  if (!R || R.SCHEMA_VERSION !== stamp) problems.push('engine SCHEMA_VERSION ' + (R && R.SCHEMA_VERSION) + ' != schema.sql stamp ' + stamp);
  for (const fn of ['createClient', 'waitForProject', 'setupSteps', 'ApiError']) {
    if (!R || typeof R[fn] !== 'function') problems.push('missing export ' + fn);
  }
  if (problems.length) throw new Error('[build] provision.js failed its self-check:\n  ' + problems.join('\n  '));

  fs.writeFileSync(path.join(DIST, 'provision.js'), code);
  console.log('[build] bundled provision.js (' + (code.length / 1024).toFixed(1) + ' kB; schema v' + stamp +
    ', ' + Object.keys(functions).join(' + ') + ')');
}

// ── Invite QR codes ───────────────────────────────────────────────
//
// The invite sheet draws the setup link as a QR code, so a family member in
// the same room can scan it from the Connect screen. Rendered on the phone
// from the qrcode package's own browser build — never by a web service,
// which would see every family's server address and invite code. Loaded by
// app.js only when the invite sheet opens. Checked the same way as
// provision.js: loaded back and asked for a code.
function bundleQr() {
  const vm = require('vm');
  const out = esbuild.buildSync({
    stdin: {
      contents: "import { toString } from 'qrcode';\n" +
        "export const svg = (text) => toString(text, { type: 'svg', errorCorrectionLevel: 'L', margin: 1 });\n",
      resolveDir: ROOT, sourcefile: 'qr-entry.js', loader: 'js'
    },
    bundle: true,
    format: 'iife',
    globalName: 'RoamkeepQR',
    platform: 'browser',
    minify: true,
    legalComments: 'eof',
    target: 'es2020',
    write: false
  });
  const code = out.outputFiles[0].text;
  const ctx = { TextEncoder };   // a browser global the encoder uses
  vm.runInNewContext(code + '\n;this.Q = RoamkeepQR;', ctx);
  return ctx.Q.svg('https://get.roamkeep.app/s#v=1&u=x&k=y&c=ABCDEF123456').then((s) => {
    if (!/^<svg[\s\S]*<\/svg>\s*$/.test(String(s))) throw new Error('[build] qr.js failed its self-check: no SVG produced');
    fs.writeFileSync(path.join(DIST, 'qr.js'), code);
    console.log('[build] bundled qr.js (' + (code.length / 1024).toFixed(1) + ' kB)');
  });
}

// pwcheck.js: the 5,000 most common passwords the app refuses (4.11.3), from
// data/common-passwords.txt (tools/gen-common-passwords.mjs says where that
// comes from). Loaded only on the screens that set a password, and never
// fetched from anywhere else. Lower-cased, because the check ignores case.
// Loaded back and asked, like qr.js, so a broken list fails the build.
function bundlePasswords() {
  const vm = require('vm');
  const list =fs.readFileSync(path.join(ROOT, 'data', 'common-passwords.txt'), 'utf8')
    .split(/\r?\n/).filter(Boolean);
  const code = 'window.RoamkeepPasswords=(function(){var s=new Set(' + JSON.stringify(list) +
    ');return{isCommon:function(p){return s.has(String(p).toLowerCase())}}})();\n';
  const ctx = { window: {} };
  vm.runInNewContext(code, ctx);
  const P = ctx.window.RoamkeepPasswords;
  const problems = [];
  if (list.length < 1000) problems.push('only ' + list.length + ' entries');
  if (!P || !P.isCommon('Password1') || !P.isCommon('iloveyou')) problems.push('a common password passed');
  if (P && P.isCommon('correct horse battery staple')) problems.push('an uncommon password was refused');
  if (problems.length) throw new Error('[build] pwcheck.js failed its self-check: ' + problems.join(', '));
  fs.writeFileSync(path.join(DIST, 'pwcheck.js'), code);
  console.log('[build] bundled pwcheck.js (' + (code.length / 1024).toFixed(1) + ' kB, ' + list.length + ' passwords)');
}

bundleProvision().then(bundleQr).then(bundlePasswords).then(
  () => console.log(`[build] dist/ ready at ${DIST}`),
  (e) => { console.error(e.message || e); process.exitCode = 1; }
);
