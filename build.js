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
