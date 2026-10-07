// Generate the Play Store listing graphics, and turn device screenshots into
// captioned, Play-compliant listing images.
//
//   node tools/store-assets.js
//
// Outputs into store/ (gitignored — these are build products).
//
// WHY THIS EXISTS
// ---------------
// Two of the four listing assets are traps.
//
// The app icon is already fine: icon-512.png is 512x512, fully opaque and
// 9.5 KB. Nothing to do.
//
// The FEATURE GRAPHIC has to be made — there is no 1024x500 anywhere in the
// repo, and it is mandatory. It carries the registered mark: the exact
// brand-tile.png the app shows, so the listing can never show a different
// logo from the app. The tile already says "Roamkeep", so beside it goes the
// tagline, large, rather than the name a second time.
//
// SCREENSHOTS are the trap. Play requires 16:9 or 9:16. Real device grabs
// are neither: the phone here is 1080x2086 (9:17.4) and the tablet is
// 1600x2400 (2:3). Uploading either gets rejected on aspect ratio, so they
// are placed on a compliant canvas.
//
// NO ALPHA, ANYWHERE. Play rejects a feature graphic with an alpha channel
// even when every pixel is opaque, and an SVG render or a device grab
// usually has one. Every output is flattened onto a solid colour and
// checked for three channels, not merely eyeballed.
//
// CAPTIONS. A shot named <Device>-<n>-<slug>.png (Phone-1-map.png) gets the
// caption tools/store-captions.json gives that slug, in a band above the
// screenshot. The number is only the upload order. A slug with no caption
// gets a plain frame, and the run says so. The captions are listing text:
// core features and differentiators only, plain punctuation.
//
// ORIENTATION AND DEVICE ARE BOTH INFERRED, AND BOTH MATTER.
// An earlier version put every image through one portrait canvas. That is
// fine until a landscape tablet grab arrives, which it then squeezed into a
// 9:16 portrait frame — a thin strip of app between two enormous teal bars.
// Files are routed by their name prefix (Phone*/Tablet*, which is what
// Android's own screenshot naming gives you) and matched to a canvas of
// their own orientation.

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'store');
const SHOTS_IN = path.join(OUT, 'screenshots-raw');
const CAPTIONS = JSON.parse(fs.readFileSync(path.join(__dirname, 'store-captions.json'), 'utf8'));

// Brand tokens, same values as styles.css and the privacy page.
const TEAL = '#0E7C7B';
const TEAL_DEEP = '#0B5F5E';
const CORAL = '#FF6B5B';
const INK = '#0F172A';
const INK_2 = '#334155';
const FONT = 'Segoe UI, Roboto, Arial, sans-serif';

/**
 * Canvas per device and orientation.
 *
 * Play wants each side 320-3840 for phone and 1080-7680 for tablet. The
 * phone pair sits comfortably inside both; the tablet pair is deliberately
 * 1440/2560 rather than 1080/1920, because 1080 is exactly the tablet
 * minimum and sitting on a limit is asking for a rejection.
 */
const CANVAS = {
  phone:  { portrait: [1080, 1920], landscape: [1920, 1080], min: 320,  max: 3840 },
  tablet: { portrait: [1440, 2560], landscape: [2560, 1440], min: 1080, max: 7680 },
};

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** One solid, three-channel PNG: flattened, alpha removed, nothing else. */
const opaque = (img, background) => img.flatten({ background }).removeAlpha().png();

// ── feature graphic ──────────────────────────────────────────

const FG_W = 1024, FG_H = 500;
const TILE = { size: 300, x: 84, y: 100 };
const TAGLINE = ['Your Family.', 'Your Keep.', 'Your Data.'];
const SUBTITLE = 'Private family location sharing';
const TEXT_X = 430, TEXT_MAX_W = FG_W - TEXT_X - 60;

/**
 * The largest size at which every tagline line fits beside the tile,
 * measured from a real render like the captions are. Null if no font
 * rendered at all.
 */
async function taglineSize() {
  for (let s = 84; s >= 44; s -= 2) {
    let widest = 0;
    for (const line of TAGLINE) {
      const w = await textWidth(line, s, FG_W, FG_H);
      if (w === null) return null;
      widest = Math.max(widest, w);
    }
    if (widest <= TEXT_MAX_W) return s;
  }
  return 44;
}

/**
 * The background and the words, without the tile. The tile is composited
 * from brand-tile.png itself rather than redrawn, because the registered
 * mark is that artwork, not an approximation of it.
 *
 * Light, like the app's own header: a teal tile on a teal ground loses its
 * edge, which is the edge of the mark.
 */
function featureGraphicSvg(withText, size) {
  // The three lines and the subtitle, centred as one block on the tile.
  const lineH = size * 1.1, subSize = 32, gap = 26;
  const blockH = TAGLINE.length * lineH + gap + subSize;
  const top = TILE.y + TILE.size / 2 - blockH / 2;
  const text = withText ? TAGLINE.map((line, i) => `
    <text x="${TEXT_X}" y="${top + size * 0.86 + i * lineH}" font-family="${FONT}"
          font-size="${size}" font-weight="700" fill="${i === TAGLINE.length - 1 ? CORAL : TEAL}">${esc(line)}</text>`).join('') + `
    <text x="${TEXT_X + 2}" y="${top + TAGLINE.length * lineH + gap + subSize * 0.8}" font-family="${FONT}"
          font-size="${subSize}" font-weight="400" fill="${INK_2}">${esc(SUBTITLE)}</text>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${FG_W}" height="${FG_H}" viewBox="0 0 ${FG_W} ${FG_H}">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#FFFFFF"/>
        <stop offset="1" stop-color="#E6F2F2"/>
      </linearGradient>
      <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
        <feGaussianBlur stdDeviation="14"/>
      </filter>
    </defs>
    <rect width="${FG_W}" height="${FG_H}" fill="url(#bg)"/>
    <circle cx="930" cy="60" r="200" fill="${TEAL}" opacity="0.05"/>
    <circle cx="70" cy="480" r="160" fill="${TEAL}" opacity="0.05"/>
    <rect x="${TILE.x + 6}" y="${TILE.y + 14}" width="${TILE.size}" height="${TILE.size}"
          fill="${TEAL_DEEP}" opacity="0.28" filter="url(#shadow)"/>
    ${text}
  </svg>`;
}

async function renderFeatureGraphic(withText, size) {
  const tile = await sharp(path.join(ROOT, 'brand-tile.png')).resize(TILE.size, TILE.size).png().toBuffer();
  const base = await sharp(Buffer.from(featureGraphicSvg(withText, size)))
    .composite([{ input: tile, left: TILE.x, top: TILE.y }])
    .png().toBuffer();
  return opaque(sharp(base), '#FFFFFF');
}

async function buildFeatureGraphic() {
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, 'feature-graphic.png');
  const size = await taglineSize();
  if (size === null) throw new Error('the tagline did not render: no usable font for "' + FONT + '"');
  await (await renderFeatureGraphic(true, size)).toFile(file);

  // Text in an SVG only renders if the rasteriser found a font. A silently
  // fontless render would look fine as a file and be wrong as a graphic, so
  // compare against a deliberately text-free render and insist they differ.
  const withText = await (await renderFeatureGraphic(true, size)).raw().toBuffer();
  const without = await (await renderFeatureGraphic(false, size)).raw().toBuffer();
  let diff = 0;
  for (let i = 0; i < withText.length; i += 3) if (withText[i] !== without[i]) diff++;
  const pct = (diff / (withText.length / 3)) * 100;

  // metadata() has no `size` for a file source — stat it.
  const { width, height, channels, hasAlpha } = await sharp(file).metadata();
  return { file, width, height, channels, hasAlpha, size: fs.statSync(file).size, tagline: size,
           textPixels: diff, textPct: pct };
}

// ── screenshots ──────────────────────────────────────────────

/** Which device a grab came from, by the name Android gave it. */
function deviceOf(name) {
  return /^tablet/i.test(name) ? 'tablet' : 'phone';
}

/** The caption for Phone-1-map.png is CAPTIONS.map; none is fine. */
function captionOf(name) {
  const slug = (name.replace(/\.(png|jpe?g)$/i, '').split('-').pop() || '').toLowerCase();
  return { slug, text: CAPTIONS[slug] || null };
}

/** A caption line's rendered width at a size, or null if nothing rendered. */
async function textWidth(text, size, w, h) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <text x="${w / 2}" y="${h / 2}" text-anchor="middle" font-family="${FONT}" font-size="${size}"
          font-weight="700" fill="#FFFFFF">${esc(text)}</text></svg>`;
  try {
    const { info } = await sharp(Buffer.from(svg)).trim().toBuffer({ resolveWithObject: true });
    return info.width;
  } catch {
    return null;   // a blank render cannot be trimmed: no font was found
  }
}

/**
 * The largest size at which the caption fits the band: one line if it can,
 * else two lines split at the most even word break. Measured from a real
 * render, not estimated from a character count, so a wide font or a long
 * word cannot spill off the edge.
 */
async function fitCaption(text, bandW, bandH) {
  const maxW = bandW * 0.86;
  const top = Math.round(bandH * 0.34);
  for (let s = top; s >= Math.round(top * 0.7); s -= 2) {
    const tw = await textWidth(text, s, bandW, bandH);
    if (tw === null) return null;
    if (tw <= maxW) return { lines: [text], size: s };
  }
  const words = text.split(' ');
  let best = null;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(' '), b = words.slice(i).join(' ');
    const d = Math.abs(a.length - b.length);
    if (!best || d < best.d) best = { lines: [a, b], d };
  }
  if (!best) return { lines: [text], size: Math.round(top * 0.6) };
  for (let s = Math.round(top * 0.8); s >= Math.round(top * 0.45); s -= 2) {
    const w1 = await textWidth(best.lines[0], s, bandW, bandH);
    const w2 = await textWidth(best.lines[1], s, bandW, bandH);
    if (w1 === null || w2 === null) return null;
    if (Math.max(w1, w2) <= maxW) return { lines: best.lines, size: s };
  }
  return { lines: best.lines, size: Math.round(top * 0.45) };
}

/**
 * A captioned listing image: the caption in a band at the top, and the
 * screenshot below it with rounded corners, on the brand teal.
 */
async function captionedShot(src, dest, w, h, caption) {
  const bandH = Math.round(h * 0.17);
  const fit = await fitCaption(caption, w, bandH);
  if (!fit) throw new Error('caption did not render: no usable font for "' + FONT + '"');

  const lineH = fit.size * 1.18;
  const y0 = bandH / 2 - ((fit.lines.length - 1) * lineH) / 2 + fit.size * 0.35;
  const textSvg = fit.lines.map((l, i) =>
    `<text x="${w / 2}" y="${y0 + i * lineH}" text-anchor="middle" font-family="${FONT}"
       font-size="${fit.size}" font-weight="700" fill="#FFFFFF">${esc(l)}</text>`).join('');

  const pad = Math.round(Math.min(w, h) * 0.06);
  const boxW = w - 2 * pad, boxH = h - bandH - pad;
  const meta = await sharp(src).metadata();
  const scale = Math.min(boxW / meta.width, boxH / meta.height);
  const sw = Math.round(meta.width * scale), sh = Math.round(meta.height * scale);
  const r = Math.round(Math.min(sw, sh) * 0.035);
  const mask = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${sw}" height="${sh}">
    <rect width="${sw}" height="${sh}" rx="${r}" ry="${r}" fill="#FFFFFF"/></svg>`);
  const shot = await sharp(src).resize(sw, sh).ensureAlpha()
    .composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
  const left = Math.round((w - sw) / 2), top = bandH;

  const bg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${TEAL}"/><stop offset="1" stop-color="${TEAL_DEEP}"/>
      </linearGradient>
      <filter id="sh" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="${pad / 3}"/></filter>
    </defs>
    <rect width="${w}" height="${h}" fill="url(#bg)"/>
    <rect x="${left}" y="${top + pad / 4}" width="${sw}" height="${sh}" rx="${r}" fill="#000000"
          opacity="0.28" filter="url(#sh)"/>
    ${textSvg}
  </svg>`);

  await opaque(sharp(bg).composite([{ input: shot, left, top }]), TEAL).toFile(dest);
  return { bytes: fs.statSync(dest).size, area: (sw * sh) / (w * h), fit };
}

/**
 * No caption: letterbox onto a compliant canvas of its own orientation.
 *
 * `contain`, not `cover`: cropping a 2:3 tablet grab to 9:16 would take
 * 250 px off the width, and on these screens that is map and chrome worth
 * keeping. Bars are the brand teal so they read as a deliberate frame.
 */
async function plainShot(src, dest, w, h) {
  await opaque(sharp(src).resize(w, h, { fit: 'contain', background: TEAL }), TEAL).toFile(dest);
  const meta = await sharp(src).metadata();
  const scale = Math.min(w / meta.width, h / meta.height);
  return { bytes: fs.statSync(dest).size, area: (meta.width * scale * meta.height * scale) / (w * h) };
}

async function buildScreenshots() {
  if (!fs.existsSync(SHOTS_IN)) {
    fs.mkdirSync(SHOTS_IN, { recursive: true });
    return null;
  }
  const files = fs.readdirSync(SHOTS_IN).filter((f) => /\.(png|jpe?g)$/i.test(f)).sort();
  if (!files.length) return null;

  const rows = [];
  for (const f of files) {
    const src = path.join(SHOTS_IN, f);
    const meta = await sharp(src).metadata();
    const device = deviceOf(f);
    const orientation = meta.width > meta.height ? 'landscape' : 'portrait';
    const [w, h] = CANVAS[device][orientation];
    const caption = captionOf(f);

    const dir = path.join(OUT, device);
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, f.replace(/\.(png|jpe?g)$/i, '.png'));
    const made = caption.text
      ? await captionedShot(src, dest, w, h, caption.text)
      : await plainShot(src, dest, w, h);
    const out = await sharp(dest).metadata();

    rows.push({
      name: f, device, orientation, caption, bytes: made.bytes,
      // How much of the image is screenshot. Captioned shots are framed on
      // purpose; a plain one far off 9:16 looks like a postage stamp, and
      // that is worth knowing before upload.
      shotPct: made.area * 100,
      fit: made.fit,
      from: `${meta.width}x${meta.height}`,
      to: `${w}x${h}`,
      opaque: out.channels === 3 && !out.hasAlpha,
      sideOk: Math.min(w, h) >= CANVAS[device].min && Math.max(w, h) <= CANVAS[device].max,
    });
  }
  return rows;
}

(async () => {
  const fg = await buildFeatureGraphic();
  const ok = (c) => (c ? '  ok   ' : '  FAIL ');

  console.log('feature graphic');
  console.log(ok(fg.width === 1024 && fg.height === 500) +
    `1024x500 required, got ${fg.width}x${fg.height}`);
  console.log(ok(fg.channels === 3 && !fg.hasAlpha) +
    `no alpha channel (Play rejects one), got ${fg.channels} channels`);
  console.log(ok(fg.size < 15 * 1024 * 1024) +
    `under 15 MB, got ${(fg.size / 1024).toFixed(0)} KB`);
  console.log(ok(fg.textPct > 0.5) +
    `text actually rasterised (${fg.textPct.toFixed(1)}% of pixels differ from a text-free render)`);
  console.log('       tagline at ' + fg.tagline + 'px, fitted beside the tile');
  console.log('       ' + path.relative(ROOT, fg.file));

  const shots = await buildScreenshots();
  console.log('\nscreenshots');
  if (!shots) {
    console.log('  --   none found. Drop device grabs into ' +
      path.relative(ROOT, SHOTS_IN) + ' as Phone-1-map.png, Tablet-1-map.png … and re-run.');
  } else {
    for (const s of shots) {
      console.log(`  ${s.device.padEnd(6)} ${s.orientation.padEnd(9)} ${s.from.padEnd(10)}` +
        ` -> ${s.to.padEnd(10)} ${String(Math.round(s.shotPct)).padStart(2)}% screenshot  ` +
        `${(s.bytes / 1024 / 1024).toFixed(1)} MB  ${s.name}`);
      console.log('         ' + (s.caption.text
        ? `"${s.fit.lines.join(' / ')}" at ${s.fit.size}px`
        : `no caption: "${s.caption.slug}" is not in tools/store-captions.json`));
    }
    console.log('');

    for (const device of ['phone', 'tablet']) {
      const mine = shots.filter((s) => s.device === device);
      if (!mine.length) {
        console.log(ok(false) + `no ${device} screenshots — Play requires at least 2`);
        continue;
      }
      console.log(ok(mine.length >= 2 && mine.length <= 8) +
        `${device}: ${mine.length} shots (Play wants 2-8)`);
      console.log(ok(mine.every((s) => s.sideOk)) +
        `${device}: every side within Play's ${CANVAS[device].min}-${CANVAS[device].max} px range`);
      console.log('       -> ' + path.relative(ROOT, path.join(OUT, device)));
    }

    console.log(ok(shots.every((s) => s.opaque)) + 'every image opaque, three channels');

    // 8 MB per image is Play's ceiling. A detailed map screenshot as PNG can
    // get close, so this is a real check rather than a formality.
    const heavy = shots.filter((s) => s.bytes > 8 * 1024 * 1024);
    console.log(ok(heavy.length === 0) +
      `every image under Play's 8 MB limit` +
      (heavy.length ? ` — over: ${heavy.map((s) => s.name).join(', ')}` : ''));

    // Not a failure, a judgement call: heavy letterboxing is compliant and
    // ugly. Worth flagging so it is a decision rather than a surprise.
    const small = shots.filter((s) => !s.caption.text && s.shotPct < 80);
    if (small.length) {
      console.log(`  note   ${small.length} uncaptioned shot(s) are more than 20% bars — ` +
        `re-grab at 16:9 or 9:16 if that bothers you:`);
      for (const s of small) console.log(`         ${Math.round(100 - s.shotPct)}%  ${s.name}`);
    }
  }

  console.log('\napp icon');
  const icon = await sharp(path.join(ROOT, 'icon-512.png')).metadata();
  const istat = fs.statSync(path.join(ROOT, 'icon-512.png'));
  console.log(ok(icon.width === 512 && icon.height === 512 && istat.size < 1024 * 1024) +
    `icon-512.png is ${icon.width}x${icon.height}, ${(istat.size / 1024).toFixed(1)} KB — upload as-is`);
})();
