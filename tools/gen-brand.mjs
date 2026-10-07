#!/usr/bin/env node
// The in-app copies of the Roamkeep trade mark, and the checks that keep
// them the registered mark.
//
//   node tools/gen-brand.mjs           check, then print the wordmark symbol
//   node tools/gen-brand.mjs --write   replace #rk-wordmark in index.html
//   node tools/gen-brand.mjs --check   exit 1 if anything below has drifted
//
// The wordmark is "Roamkeep" in Roboto Bold, letter-spacing 2 at 132px, as
// assets/trademark/SPEC.md specifies, converted to OUTLINES. Live <text>
// would fall back silently to another face wherever Roboto is missing (the
// PWA on Windows, most desktop browsers), and the mark would change shape
// with no error at all, which is the failure SPEC.md warns about.
//
// Checks, each only where its inputs exist (the public repo has no
// assets/trademark/, so it skips the two that need it):
//   - the #rk-wordmark symbol in index.html is what this generates;
//   - brand-tile.png is byte-identical to the lodged representation;
//   - the outlines, drawn in the lodged artwork's geometry, reproduce its
//     wordmark (rendered with sharp and compared pixel by pixel).
//
// Needs Roboto-Bold.ttf installed, or its path in ROBOTO_BOLD.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'package.json'));
const opentype = require('opentype.js');

const INDEX = path.join(ROOT, 'index.html');
const TILE = path.join(ROOT, 'brand-tile.png');
const LODGED = path.join(ROOT, 'assets', 'trademark', 'roamkeep-mark-512.png');

// SPEC.md: Wordmark.
const TEXT = 'Roamkeep';
const SIZE = 132;
const SPACING = 2;
const SPEC_X = 512, SPEC_Y = 808;   // text-anchor middle, baseline

function findFont() {
  const home = os.homedir();
  const candidates = [
    process.env.ROBOTO_BOLD,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts', 'Roboto-Bold.ttf'),
    'C:\\Windows\\Fonts\\Roboto-Bold.ttf',
    path.join(home, 'Library', 'Fonts', 'Roboto-Bold.ttf'),
    '/Library/Fonts/Roboto-Bold.ttf',
    path.join(home, '.local', 'share', 'fonts', 'Roboto-Bold.ttf'),
    '/usr/share/fonts/truetype/roboto/unhinted/RobotoTTF/Roboto-Bold.ttf',
    '/usr/share/fonts/truetype/roboto/hinted/Roboto-Bold.ttf',
    '/usr/share/fonts/TTF/Roboto-Bold.ttf',
  ].filter(Boolean);
  const hit = candidates.find((p) => fs.existsSync(p));
  if (!hit) {
    console.error('Roboto-Bold.ttf not found. Install Roboto, or set ROBOTO_BOLD to its path.');
    process.exit(2);
  }
  return hit;
}

function loadFont(file) {
  const b = fs.readFileSync(file);
  return opentype.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}

/**
 * The wordmark as one outlined path with its left edge at x. Glyphs are
 * placed by hand rather than with stringToGlyphs, which runs GSUB features
 * this font's tables trip over; eight plain letters need none. Kerning on,
 * and no spacing after the last letter: that layout reproduces the lodged
 * artwork exactly, where each of the other three does not.
 */
function wordmarkPath(font, x, baseline) {
  const glyphs = [...TEXT].map((c) => font.charToGlyph(c));
  const scale = SIZE / font.unitsPerEm;
  const out = new opentype.Path();
  let pen = 0;
  glyphs.forEach((g, i) => {
    out.extend(g.getPath(x + pen, baseline, SIZE));
    pen += g.advanceWidth * scale;
    if (i + 1 < glyphs.length) pen += SPACING + font.getKerningValue(g, glyphs[i + 1]) * scale;
  });
  return { path: out, width: pen };
}

/** The <symbol> for index.html: the outline moved to the origin, cropped to its ink. */
function symbol(font) {
  const { path: p } = wordmarkPath(font, 0, 0);
  const bb = p.getBoundingBox();
  const { path: q } = wordmarkPath(font, -bb.x1, -bb.y1);
  const w = Math.ceil((bb.x2 - bb.x1) * 10) / 10;
  const h = Math.ceil((bb.y2 - bb.y1) * 10) / 10;
  return '<symbol id="rk-wordmark" viewBox="0 0 ' + w + ' ' + h + '">\n'
    + '    <path fill="currentColor" d="' + q.toPathData(1) + '"/>\n'
    + '  </symbol>';
}

const SYMBOL_RE = /<symbol id="rk-wordmark"[\s\S]*?<\/symbol>/;

/** Percentage of the wordmark band that differs from the lodged PNG. */
async function fidelity(font) {
  let sharp;
  try { sharp = require('sharp'); } catch (_) { return null; }
  const { width } = wordmarkPath(font, 0, SPEC_Y);
  const { path: placed } = wordmarkPath(font, SPEC_X - width / 2, SPEC_Y);
  // SPEC.md: Canvas, Background and Device, unchanged.
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">'
    + '<rect width="1024" height="1024" fill="#0E7C7B"/>'
    + '<g transform="translate(192.0,79.8) scale(6.4)">'
    + '<path fill="#FFFFFF" d="M26,18 L35,18 L35,26 L44,26 L44,18 L56,18 L56,26 L65,26 L65,18 L74,18 L74,60 L50,88 L26,60 Z"/>'
    + '<path fill="#FF6B5B" d="M40,58 L40,44 A10,10 0 0 1 60,44 L60,58 Z"/>'
    + '</g><path fill="#FFFFFF" d="' + placed.toPathData(2) + '"/></svg>';
  const mine = await sharp(Buffer.from(svg)).resize(512, 512).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const lodged = await sharp(LODGED).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  if (lodged.info.width !== 512 || lodged.info.height !== 512) throw new Error('lodged PNG is not 512x512');
  const a = mine.data, b = lodged.data;
  let diff = 0, total = 0;
  // The wordmark band at 512: baseline 404, ascender to descender.
  for (let y = 360; y < 430; y++) {
    for (let x = 0; x < 512; x++) {
      const i = (y * 512 + x) * 3;
      const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
      total++;
      if (d > 96) diff++;   // past anti-aliasing noise
    }
  }
  return 100 * diff / total;
}

const mode = process.argv.includes('--write') ? 'write' : process.argv.includes('--check') ? 'check' : 'print';
const font = loadFont(findFont());
const sym = symbol(font);
let ok = true;
const say = (good, what) => { console.log((good ? '  ok   ' : '  FAIL ') + what); ok = ok && good; };

const html = fs.readFileSync(INDEX, 'utf8');
const m = html.match(SYMBOL_RE);
if (mode === 'write') {
  if (!m) { console.error('index.html has no <symbol id="rk-wordmark"> to replace'); process.exit(1); }
  fs.writeFileSync(INDEX, html.replace(SYMBOL_RE, sym));
  console.log('  wrote #rk-wordmark into index.html');
} else {
  say(!!m && m[0] === sym, 'index.html #rk-wordmark is the generated outline');
}

if (fs.existsSync(LODGED)) {
  const same = fs.existsSync(TILE) && Buffer.compare(fs.readFileSync(TILE), fs.readFileSync(LODGED)) === 0;
  say(same, 'brand-tile.png is byte-identical to the lodged representation');
  const pct = await fidelity(font);
  if (pct === null) console.log('  skip outline fidelity (sharp not installed)');
  else say(pct < 0.5, 'outlines reproduce the lodged wordmark (' + pct.toFixed(2) + '% of the band differs)');
} else {
  console.log('  skip lodged-artwork checks (assets/trademark/ not in this tree)');
}

if (mode === 'print') console.log('\n  ' + sym + '\n');
process.exit(ok || mode === 'write' ? 0 : 1);
