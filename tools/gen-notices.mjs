#!/usr/bin/env node
//
// Generate NOTICE.md — the third-party attributions that ship with Roamkeep.
//
//   node tools/gen-notices.mjs            # write NOTICE.md
//   node tools/gen-notices.mjs --check    # fail if it is out of date
//
// WHY THIS IS GENERATED
// ---------------------
// Apache-2.0 requires attribution to travel with the distribution, and a
// hand-written list of dependencies is wrong the moment somebody adds one.
// This reads the versions and licence fields out of the packages that are
// actually installed, so the file cannot quietly drift from what ships.
//
// It also REFUSES to produce a file when a dependency declares no licence,
// which is the case worth catching: an unlicensed package is not an
// attribution problem, it is a "we may not be allowed to ship this" problem.
//
// Build-time tools are deliberately excluded. esbuild, typescript and
// @capacitor/assets never reach a user's device, and listing them would
// bury the ones that do.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const OUT = path.join(REPO, 'NOTICE.md');
const check = process.argv.includes('--check');

const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');
const readJson = (p) => JSON.parse(read(p));

/** Resolve an installed package's version and licence. */
function pkg(name, bases = ['node_modules', 'cli/node_modules']) {
  for (const base of bases) {
    const dir = path.join(REPO, base, name);
    const manifest = path.join(dir, 'package.json');
    if (!fs.existsSync(manifest)) continue;
    const j = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    const licence = j.license || (Array.isArray(j.licenses) && j.licenses[0]?.type) || null;
    return { name, version: j.version, licence, dir };
  }
  return { name, version: null, licence: null, dir: null };
}

// ── what actually ships ───────────────────────────────────────

const appDeps = Object.keys(readJson('package.json').dependencies || {}).sort().map((n) => pkg(n));
const cliDeps = Object.keys(readJson('cli/package.json').dependencies || {}).sort().map((n) => pkg(n));

/**
 * Android dependencies, read from the Gradle files rather than typed out.
 *
 * Versions live in two places: named constants in variables.gradle, and
 * literals in app/build.gradle. Both are resolved here so a bump in either
 * shows up in the notices without anyone remembering.
 */
function androidDeps() {
  const vars = read('android/variables.gradle');
  const gradle = read('android/app/build.gradle');
  const constants = Object.fromEntries(
    [...vars.matchAll(/(\w+)\s*=\s*'([^']+)'/g)].map((m) => [m[1], m[2]]),
  );
  const out = [];
  for (const m of gradle.matchAll(/(?:implementation|api)\s+["']([^"']+)["']/g)) {
    let spec = m[1];
    // "androidx.appcompat:appcompat:$androidxAppCompatVersion"
    spec = spec.replace(/\$(\w+)/g, (_, k) => constants[k] || '$' + k);
    if (spec.includes('project(')) continue;
    const [group, artifact, version] = spec.split(':');
    if (!artifact) continue;
    out.push({ coord: `${group}:${artifact}`, version: version || 'unspecified' });
  }
  return out.sort((a, b) => a.coord.localeCompare(b.coord));
}

// The Android libraries above are all Apache-2.0. Stated once here rather
// than guessed per-artifact: AndroidX, Play Services and Firebase are
// uniformly Apache-2.0, and asserting anything else would need evidence
// this script does not have.
const ANDROID_LICENCE = 'Apache-2.0';

/**
 * Is the map using the host the OSM Tile Usage Policy requires?
 *
 * Derived from app.js rather than stated, because a hand-written verdict in
 * this file is exactly the kind of claim that drifts away from the code with
 * nothing to catch it. The policy says to use exactly
 * tile.openstreetmap.org; the old code rotated across a/b/c subdomains,
 * which it warns "may be slower or withdrawn without notice".
 */
function tileHostOk() {
  const src = read('app.js');
  const canonical = src.includes("'https://tile.openstreetmap.org/'");
  const rotates = /\['a', 'b', 'c'\]/.test(src);
  return canonical && !rotates;
}

/** supabase-js is vendored as supabase.js rather than installed. */
function vendoredSupabase() {
  const src = read('supabase.js');
  const v = (src.match(/supabase-js-\w+\/([0-9]+\.[0-9]+\.[0-9]+)/) || [])[1]
    || (src.match(/storage-js\/([0-9]+\.[0-9]+\.[0-9]+)/) || [])[1]
    || 'unknown';
  return { name: '@supabase/supabase-js', version: v, licence: 'MIT' };
}

// ── verify before writing ─────────────────────────────────────

const problems = [];
for (const d of [...appDeps, ...cliDeps]) {
  if (!d.version) problems.push(`${d.name} is declared but not installed — run npm install`);
  else if (!d.licence) problems.push(`${d.name}@${d.version} declares no licence`);
}
if (problems.length) {
  console.error('\n  Cannot generate notices:\n' + problems.map((p) => '    ' + p).join('\n') + '\n');
  process.exit(1);
}

// ── render ────────────────────────────────────────────────────

const row = (d) => `| \`${d.name}\` | ${d.version} | ${d.licence} |`;
const arow = (d) => `| \`${d.coord}\` | ${d.version} | ${ANDROID_LICENCE} |`;
const sb = vendoredSupabase();
const android = androidDeps();
const tileRow = tileHostOk()
  ? 'Met — the map fetches from the canonical host, with no subdomain rotation'
  : '**Not yet met.** The map fetches from `a/b/c.tile.openstreetmap.org`. '
    + 'The policy warns other hostnames "may be slower or withdrawn without '
    + 'notice", so this is an availability risk as much as a breach';

const body = `# Third-party notices

Roamkeep includes software from the projects below. Each remains under its
own licence and its own copyright; nothing here changes those terms, and
Roamkeep's own [LICENSE](LICENSE) does not apply to them.

Generated by \`node tools/gen-notices.mjs\` from the packages that are
actually installed — do not edit by hand.

## In the app and the web bundle

| Package | Version | Licence |
|---|---|---|
${appDeps.map(row).join('\n')}
| \`${sb.name}\` | ${sb.version} | ${sb.licence} |

\`supabase.js\` is a vendored build of supabase-js committed directly to this
repository rather than installed from npm, which is why it does not appear
in \`package.json\`.

## In the Android package

| Library | Version | Licence |
|---|---|---|
${android.map(arow).join('\n')}

Google Play services and Firebase are additionally subject to the
[Google APIs Terms of Service](https://developers.google.com/terms).

## In the provisioning wizard (\`cli/\`)

| Package | Version | Licence |
|---|---|---|
${cliDeps.map(row).join('\n')}

## Map data

Map tiles are rendered from **OpenStreetMap** data, © OpenStreetMap
contributors, available under the
[Open Database License](https://www.openstreetmap.org/copyright) (ODbL).
The attribution is displayed on the map itself, which is what the licence
requires.

Roamkeep meets the
[Tile Usage Policy](https://operations.osmfoundation.org/policies/tiles/) as
follows. The policy welcomes third-party use — it states plainly that
"we welcome creative uses and do not require you to use a specific API" —
but it sets requirements, and these are the ones that bear on an app like
this one:

| Requirement | Where Roamkeep stands |
|---|---|
| Use exactly \`https://tile.openstreetmap.org/{z}/{x}/{y}.png\` | ${tileRow} |
| Visible licence attribution | Met — drawn on the map itself |
| HTTPS, never the http:// URL | Met |
| No bulk downloading or prefetching | Met — tiles are fetched only for the viewport being drawn |
| No \`Cache-Control: no-cache\` | Met — nothing sets it |
| Honour cache headers | Met by the WebView's own HTTP cache. The policy notes that browsers with default settings already satisfy this; \`sw.js\` deliberately does not intercept cross-origin requests |

> **One item is worth confirming rather than assuming: identification.**
> The policy requires apps to send a User-Agent naming the application, and
> says traffic using generic SDK defaults *will be blocked*. Roamkeep loads
> tiles with \`new Image()\` inside an Android WebView, so the User-Agent is
> the WebView's browser string — which §3.1 accepts for browsers, and which
> is not a library default. Whether a WebView-hosted app counts as "a
> browser" or "an app" here is genuinely ambiguous, and the safe answer is
> to ask the Operations Working Group rather than guess. Availability is
> best-effort with no SLA in any case, so a tile provider with a contract
> is worth considering before the user base grows.

## Apache-2.0 attribution

Several of the components above are licensed under the Apache License,
Version 2.0, which requires that this notice travel with the distribution.
The full licence text is at
<https://www.apache.org/licenses/LICENSE-2.0>.

Unless required by applicable law or agreed to in writing, software
distributed under the Apache License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.

## Excluded on purpose

Build-time tooling — esbuild, TypeScript, \`@capacitor/assets\`, the Gradle
plugin and the Android SDK — is not listed. None of it reaches a user's
device, and listing it would bury the components that do.
`;

if (check) {
  // Compare with line endings normalised. This repository checks out CRLF on
  // Windows while the generator emits LF, so a byte comparison fails after
  // any fresh checkout no matter what the content says — which makes the
  // check worse than useless, because it cries wolf on a correct file. The
  // same trap already caught a section-stripping regex in
  // tools/public-sync.mjs; CRLF is worth suspecting first here.
  const norm = (t) => t.split(String.fromCharCode(13)).join('');
  const current = fs.existsSync(OUT) ? norm(fs.readFileSync(OUT, 'utf8')) : '';
  if (current !== norm(body)) {
    console.error('\n  NOTICE.md is out of date. Run: node tools/gen-notices.mjs\n');
    process.exit(1);
  }
  console.log('  ok   NOTICE.md matches the installed dependencies');
  process.exit(0);
}

fs.writeFileSync(OUT, body);
console.log('');
console.log(`  app bundle   ${appDeps.length} packages + vendored supabase-js ${sb.version}`);
console.log(`  android      ${android.length} libraries`);
console.log(`  cli          ${cliDeps.length} packages`);
console.log(`  written      ${path.relative(REPO, OUT)}`);
console.log('');
