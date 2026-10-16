#!/usr/bin/env node
// Build get.roamkeep.app (landing/) into landing-dist/ for deploying.
//
//   node tools/build-landing.mjs     or   npm run build:landing
//
// The pages are hand-written, so this only takes out what visitors don't
// need: HTML comments, and comments in the scripts (minified with esbuild).
// They are notes for whoever edits these files: why a rule exists, what
// is still a draft, how the hosting behaves. None of it is for the public,
// and some of it is better not offered.
//
// README.md stays behind; assetlinks.json is copied byte for byte, because
// Android checks it exactly.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'package.json'));
const esbuild = require('esbuild');
const SRC = path.join(ROOT, 'landing');
const OUT = path.join(ROOT, 'landing-dist');

fs.rmSync(OUT, { recursive: true, force: true });

function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const from = path.join(dir, name);
    const rel = path.relative(SRC, from);
    if (fs.statSync(from).isDirectory()) { walk(from); continue; }
    if (rel === 'README.md') continue;
    const to = path.join(OUT, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (name.endsWith('.html')) {
      fs.writeFileSync(to, fs.readFileSync(from, 'utf8').replace(/<!--[\s\S]*?-->\s*/g, ''));
    } else if (name.endsWith('.js')) {
      fs.writeFileSync(to, esbuild.transformSync(fs.readFileSync(from, 'utf8'), { minify: true, legalComments: 'none' }).code);
    } else {
      fs.copyFileSync(from, to);
    }
    console.log('  ' + rel.split(path.sep).join('/'));
  }
}
walk(SRC);

// security.txt (RFC 9116) is the same file on both sites, so it has one
// source, in site/; both name each other as Canonical.
{
  const to = path.join(OUT, '.well-known', 'security.txt');
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'site', '.well-known', 'security.txt'), to);
  console.log('  .well-known/security.txt (from site/)');
}

// Nothing that was a comment may survive into what is published.
let leaks = 0;
for (const f of ['index.html', 'privacy/index.html', 'terms/index.html', 's/index.html']) {
  if (/<!--/.test(fs.readFileSync(path.join(OUT, f), 'utf8'))) { leaks++; console.error('  comment left in ' + f); }
}
if (leaks) process.exit(1);
console.log('  landing-dist/ ready');
