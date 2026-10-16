#!/usr/bin/env node
// Build the public website (roamkeep.app) into site-dist/.
//
//   node tools/build-site.mjs        or   npm run build:site
//
// The site is plain HTML: one layout (site/layout.html) and one fragment
// per page (site/pages/*.html), each starting with a JSON comment that
// gives its title, description and path. No framework, no client-side
// script, no third-party request of any kind, so nothing on it can track a
// visitor. Deploy site-dist/, never site/ (tools/deploy-static.mjs).
//
// The brand comes from its single sources rather than copies: the keep and
// the outlined wordmark are the <symbol>s in index.html (tools/gen-brand.mjs
// writes the wordmark), and the registered tile is brand-tile.png. The
// screenshots are the README's, until Phase 2 replaces both.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'site');
const OUT = path.join(ROOT, 'site-dist');

const read = (p) => fs.readFileSync(p, 'utf8');

// The two brand symbols, lifted out of the app so the site can never drift
// from what the app (and the trade mark check) says the mark is.
function brandSprite() {
  const html = read(path.join(ROOT, 'index.html'));
  const pick = (id) => {
    const m = html.match(new RegExp('<symbol id="' + id + '"[\\s\\S]*?</symbol>'));
    if (!m) throw new Error('index.html has no <symbol id="' + id + '">');
    return m[0];
  };
  // A class, not style="": the site's CSP allows no inline style.
  return '<svg class="sprite" width="0" height="0" aria-hidden="true" focusable="false">\n'
    + pick('rk-mark') + '\n' + pick('rk-wordmark') + '\n</svg>';
}

function parsePage(file) {
  const src = read(file);
  const m = src.match(/^\s*<!--\s*(\{[\s\S]*?\})\s*-->/);
  if (!m) throw new Error(path.basename(file) + ' must start with a <!-- {json} --> header');
  const meta = JSON.parse(m[1]);
  for (const k of ['title', 'description', 'path']) {
    if (!meta[k]) throw new Error(path.basename(file) + ': header needs "' + k + '"');
  }
  return { meta, body: src.slice(m[0].length).trim() };
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

function render(layout, sprite, { meta, body }) {
  // The nav marks the page you are on, for sighted readers and screen readers.
  const nav = layout.replace(/<a ([^>]*?)href="([^"]+)"([^>]*)>/g, (all, a, href, b) =>
    href === meta.path ? '<a ' + a + 'href="' + href + '"' + b + ' aria-current="page">' : all);
  return nav
    .replace('{{sprite}}', sprite)
    .replace(/\{\{title\}\}/g, esc(meta.title))
    .replace(/\{\{description\}\}/g, esc(meta.description))
    .replace(/\{\{path\}\}/g, esc(meta.path))
    .replace('{{content}}', body);
}

// CHANGELOG.md, as a page. Just the Markdown it uses: headings, lists
// (with indented continuation lines), paragraphs, bold, code and links. A
// renderer this small can't drift from the file, and needs no dependency.
function changelogPage() {
  const md = read(path.join(ROOT, 'CHANGELOG.md')).replace(/\r\n/g, '\n');
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
  const out = [];
  let list = null, para = null;
  const flush = () => {
    if (para) { out.push('<p>' + inline(para.join(' ')) + '</p>'); para = null; }
    if (list) { out.push('<ul>' + list.map((li) => '<li>' + inline(li) + '</li>').join('') + '</ul>'); list = null; }
  };
  let title = 'Changelog';
  for (const line of md.split('\n')) {
    if (/^# /.test(line)) { flush(); title = line.slice(2).trim(); continue; }
    if (/^## /.test(line)) { flush(); out.push('<h2>' + inline(line.slice(3).trim()) + '</h2>'); continue; }
    if (/^- /.test(line)) { if (para) flush(); (list = list || []).push(line.slice(2).trim()); continue; }
    if (/^ {2}\S/.test(line) && list) { list[list.length - 1] += ' ' + line.trim(); continue; }
    if (!line.trim()) { flush(); continue; }
    if (list) flush();
    (para = para || []).push(line.trim());
  }
  flush();
  const [lead, ...rest] = out;
  return {
    meta: { title: title + ' · Roamkeep', description: 'What changed in each version of Roamkeep, in plain language.', path: '/changelog/' },
    body: '<section class="page-head"><div class="wrap narrow"><span class="kicker">What\'s new</span>'
      + '<h1>' + esc(title) + '</h1>' + lead.replace('<p>', '<p class="lead">') + '</div></section>\n'
      + '<section class="article"><div class="wrap narrow">\n' + rest.join('\n') + '\n</div></section>',
  };
}

function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const layout = read(path.join(SRC, 'layout.html'));
const sprite = brandSprite();
const pages = fs.readdirSync(path.join(SRC, 'pages')).filter((f) => f.endsWith('.html')).sort()
  .map((f) => parsePage(path.join(SRC, 'pages', f)));
pages.push(changelogPage());
for (const page of pages) {
  // Comments are notes for whoever edits the source (drafts, hosting
  // details); none of them is for visitors, so none is published.
  const html = render(layout, sprite, page).replace(/<!--[\s\S]*?-->\s*/g, '');
  const dir = path.join(OUT, page.meta.path);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), html);
  console.log('  page   ' + page.meta.path);
}

copy(path.join(SRC, 'style.css'), path.join(OUT, 'style.css'));
copy(path.join(SRC, 'robots.txt'), path.join(OUT, 'robots.txt'));
// RFC 9116. The one source for both sites: build-landing.mjs copies this
// same file, and cli/test.mjs fails as its Expires date nears.
copy(path.join(SRC, '.well-known', 'security.txt'), path.join(OUT, '.well-known', 'security.txt'));
copy(path.join(ROOT, 'brand-tile.png'), path.join(OUT, 'assets', 'brand-tile.png'));
// Each screenshot comes at 540 wide (1x screens, and the README) and at the
// grab's native 1080, which srcset gives to 2x screens and up: shown ~280
// CSS px wide, a 540 image was being enlarged there, and looked soft.
for (const shot of ['map', 'places', 'history']) {
  for (const f of [shot + '.jpg', shot + '-1080.jpg']) {
    copy(path.join(ROOT, 'docs', 'screenshots', f), path.join(OUT, 'assets', f));
  }
}

// Every internal link must land on a page this build made, and every asset
// on a file it copied. A broken link on the site is found here, not by a
// visitor.
const made = new Set(pages.map((p) => p.meta.path));
let broken = 0;
for (const { meta } of pages) {
  const html = read(path.join(OUT, meta.path, 'index.html'));
  const refs = [...html.matchAll(/(?:href|src)="(\/[^"#?]*)/g)].map((m) => m[1]);
  for (const [, set] of html.matchAll(/srcset="([^"]*)"/g)) {
    for (const cand of set.split(',')) refs.push(cand.trim().split(/\s+/)[0]);
  }
  for (const ref of refs) {
    const ok = ref.endsWith('/') ? made.has(ref) : fs.existsSync(path.join(OUT, ref));
    if (!ok) { broken++; console.error('  BROKEN ' + meta.path + ' → ' + ref); }
  }
}
if (broken) { console.error('\n  ' + broken + ' broken link(s)'); process.exit(1); }
console.log('  site-dist/ ready (' + pages.length + ' pages)');
