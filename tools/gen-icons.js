// Rasterise the brand SVGs in assets/ into every PNG the app needs.
//
//   npm run icons
//
// The SVGs are the source of truth (assets/icon.svg et al). This script
// only produces the PNG inputs; `npx @capacitor/assets generate` then
// fans those out into the Android mipmap/drawable densities. The PWA
// icons at repo root are written directly here because build.js copies
// them into dist/ verbatim.

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..');
const A = (n) => path.join(ROOT, 'assets', n);

// [source svg, output png, pixel size]
const JOBS = [
  ['icon.svg',            A('icon.png'),            1024],
  ['icon-foreground.svg', A('icon-foreground.png'), 1024],
  ['icon-background.svg', A('icon-background.png'), 1024],
  ['splash.svg',          A('splash.png'),          2732],
  // The splash is a flat brand colour, so light and dark are identical —
  // @capacitor/assets wants both files to exist.
  ['splash.svg',          A('splash-dark.png'),     2732],
  // PWA icons (referenced by manifest.json + precached by sw.js).
  ['icon.svg',            path.join(ROOT, 'icon-192.png'), 192],
  ['icon.svg',            path.join(ROOT, 'icon-512.png'), 512]
];

(async () => {
  for (const [src, out, size] of JOBS) {
    const svg = fs.readFileSync(A(src));
    // Each SVG declares its own intrinsic width/height, so the default
    // 96-DPI rasterisation already lands at full size; anything larger
    // blows past sharp's pixel limit on the 2732px splash. Downscales
    // (e.g. the 192px PWA icon off the 1024px source) stay crisp.
    await sharp(svg)
      .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toFile(out);
    console.log(`[icons] ${src} -> ${path.relative(ROOT, out)} (${size}px)`);
  }
  console.log('[icons] done — now run: npx @capacitor/assets generate --android');
})().catch((e) => { console.error(e); process.exit(1); });
