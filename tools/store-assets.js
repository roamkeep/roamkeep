// Generate the Play Store listing graphics, and make device screenshots
// conform to Play's aspect-ratio rules.
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
// repo, and it is mandatory.
//
// SCREENSHOTS are the trap. Play requires 16:9 or 9:16. Real device grabs
// are neither: the phone here is 1080x2086 (9:17.4) and the tablet is
// 1600x2400 (2:3). Uploading either gets rejected on aspect ratio, so they
// are letterboxed onto a compliant canvas.
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

// Brand tokens, same values as styles.css and the privacy page.
const TEAL = '#0E7C7B';
const TEAL_DEEP = '#0B5F5E';
const CORAL = '#FF6B5B';

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

/** The keep mark, lifted from assets/icon-foreground.svg. */
function mark(size, x, y) {
  const s = size / 108;
  return `<g transform="translate(${x},${y}) scale(${s})">
    <path fill="#FFFFFF" d="M26,18 L35,18 L35,26 L44,26 L44,18 L56,18 L56,26 L65,26 L65,18 L74,18 L74,60 L50,88 L26,60 Z"/>
    <path fill="${CORAL}" d="M40,58 L40,44 A10,10 0 0 1 60,44 L60,58 Z"/>
  </g>`;
}

function featureGraphicSvg(withText = true) {
  const text = withText ? `
    <text x="392" y="232" font-family="Segoe UI, Roboto, Arial, sans-serif"
          font-size="86" font-weight="700" fill="#FFFFFF">Roamkeep</text>
    <text x="394" y="292" font-family="Segoe UI, Roboto, Arial, sans-serif"
          font-size="34" font-weight="400" fill="#CFE9E8">Private family location sharing</text>
    <text x="394" y="346" font-family="Segoe UI, Roboto, Arial, sans-serif"
          font-size="30" font-weight="600" fill="${CORAL}">Your Family. Your Keep. Your Data.</text>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="500" viewBox="0 0 1024 500">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="${TEAL}"/>
        <stop offset="1" stop-color="${TEAL_DEEP}"/>
      </linearGradient>
    </defs>
    <rect width="1024" height="500" fill="url(#bg)"/>
    <circle cx="905" cy="70" r="190" fill="#FFFFFF" opacity="0.04"/>
    <circle cx="120" cy="470" r="150" fill="#FFFFFF" opacity="0.04"/>
    ${mark(300, 130, 112)}
    ${text}
  </svg>`;
}

async function buildFeatureGraphic() {
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, 'feature-graphic.png');
  await sharp(Buffer.from(featureGraphicSvg(true))).png().toFile(file);

  // Text in an SVG only renders if the rasteriser found a font. A silently
  // fontless render would look fine as a file and be wrong as a graphic, so
  // compare against a deliberately text-free render and insist they differ.
  const withText = await sharp(Buffer.from(featureGraphicSvg(true))).raw().toBuffer();
  const without = await sharp(Buffer.from(featureGraphicSvg(false))).raw().toBuffer();
  let diff = 0;
  for (let i = 0; i < withText.length; i += 4) if (withText[i] !== without[i]) diff++;
  const pct = (diff / (withText.length / 4)) * 100;

  // metadata() has no `size` for a file source — stat it.
  const { width, height } = await sharp(file).metadata();
  const size = fs.statSync(file).size;
  return { file, width, height, size, textPixels: diff, textPct: pct };
}

/** Which device a grab came from, by the name Android gave it. */
function deviceOf(name) {
  return /^tablet/i.test(name) ? 'tablet' : 'phone';
}

/**
 * Letterbox a screenshot onto a compliant canvas of its own orientation.
 *
 * `contain`, not `cover`: cropping a 2:3 tablet grab to 9:16 would take
 * 250 px off the width, and on these screens that is map and chrome worth
 * keeping. Bars are the brand teal so they read as a deliberate frame.
 */
async function fitShot(src, dest, w, h) {
  await sharp(src)
    .resize(w, h, { fit: 'contain', background: TEAL })
    .png()
    .toFile(dest);
  return fs.statSync(dest).size;
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

    const dir = path.join(OUT, device);
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, f.replace(/\.(png|jpe?g)$/i, '.png'));
    const bytes = await fitShot(src, dest, w, h);

    // How much of the output is bar rather than screenshot. A grab that is
    // nearly the right shape barely shows any; one that is far off looks
    // like a postage stamp, and that is worth knowing before upload.
    const scale = Math.min(w / meta.width, h / meta.height);
    const barPct = (1 - (meta.width * scale * meta.height * scale) / (w * h)) * 100;

    rows.push({
      name: f, device, orientation, bytes, barPct,
      from: `${meta.width}x${meta.height}`,
      to: `${w}x${h}`,
      ratio: meta.width / meta.height,
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
  console.log(ok(fg.size < 15 * 1024 * 1024) +
    `under 15 MB, got ${(fg.size / 1024).toFixed(0)} KB`);
  console.log(ok(fg.textPct > 0.5) +
    `text actually rasterised (${fg.textPct.toFixed(1)}% of pixels differ from a text-free render)`);
  console.log('       ' + path.relative(ROOT, fg.file));

  const shots = await buildScreenshots();
  console.log('\nscreenshots');
  if (!shots) {
    console.log('  --   none found. Drop device grabs into ' +
      path.relative(ROOT, SHOTS_IN) + ' and re-run.');
  } else {
    for (const s of shots) {
      console.log(`  ${s.device.padEnd(6)} ${s.orientation.padEnd(9)} ${s.from.padEnd(10)}` +
        ` -> ${s.to.padEnd(10)} ${String(Math.round(s.barPct)).padStart(2)}% bars  ` +
        `${(s.bytes / 1024 / 1024).toFixed(1)} MB  ${s.name}`);
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

    // 8 MB per image is Play's ceiling. A detailed map screenshot as PNG can
    // get close, so this is a real check rather than a formality.
    const heavy = shots.filter((s) => s.bytes > 8 * 1024 * 1024);
    console.log(ok(heavy.length === 0) +
      `every image under Play's 8 MB limit` +
      (heavy.length ? ` — over: ${heavy.map((s) => s.name).join(', ')}` : ''));

    // Not a failure, a judgement call: heavy letterboxing is compliant and
    // ugly. Worth flagging so it is a decision rather than a surprise.
    const barry = shots.filter((s) => s.barPct > 20);
    if (barry.length) {
      console.log(`  note   ${barry.length} shot(s) are more than 20% bars — ` +
        `re-grab at 16:9 or 9:16 if that bothers you:`);
      for (const s of barry) console.log(`         ${Math.round(s.barPct)}%  ${s.name}`);
    }
  }

  console.log('\napp icon');
  const icon = await sharp(path.join(ROOT, 'icon-512.png')).metadata();
  const istat = fs.statSync(path.join(ROOT, 'icon-512.png'));
  console.log(ok(icon.width === 512 && icon.height === 512 && istat.size < 1024 * 1024) +
    `icon-512.png is ${icon.width}x${icon.height}, ${(istat.size / 1024).toFixed(1)} KB — upload as-is`);
})();
