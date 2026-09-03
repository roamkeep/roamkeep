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
  'icon-512.png'
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
const CACHE_VERSION_OFFSET = 7;   // roamkeep-v72 ↔ versionCode 65

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

console.log(`[build] dist/ ready at ${DIST}`);
