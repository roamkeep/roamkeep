// npm pack / publish helper: copy the wizard's inputs into cli/assets/.
//
//   node pack-assets.mjs          (prepack)  copy db/schema.sql and the
//                                            Edge Function sources in
//   node pack-assets.mjs --clean  (postpack) remove them again
//
// A clone or ZIP reads its inputs from the repo (../db, ../supabase); an
// npm package has no repo around it, so they travel inside it. steps.js
// prefers assets/ when it exists — which is why postpack removes it: left
// behind in a working clone, it would quietly shadow every later edit to
// db/schema.sql.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FUNCTIONS } from './src/engine.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(HERE, 'assets');
const REPO = path.join(HERE, '..');

fs.rmSync(ASSETS, { recursive: true, force: true });
if (process.argv.includes('--clean')) process.exit(0);

fs.mkdirSync(ASSETS, { recursive: true });
fs.copyFileSync(path.join(REPO, 'db', 'schema.sql'), path.join(ASSETS, 'schema.sql'));
for (const slug of FUNCTIONS) {
  const src = path.join(REPO, 'supabase', 'functions', slug);
  const dst = path.join(ASSETS, 'functions', slug);
  fs.mkdirSync(dst, { recursive: true });
  for (const f of fs.readdirSync(src).filter((n) => /\.(ts|json)$/.test(n))) {
    fs.copyFileSync(path.join(src, f), path.join(dst, f));
  }
}
console.log(`pack-assets: schema.sql and ${FUNCTIONS.length} functions copied into assets/`);
