// Regenerates data/common-passwords.txt, the list the app refuses as a new
// password (4.11.3).
//
//   node tools/gen-common-passwords.mjs <path to 100k-most-used-passwords-NCSC.txt>
//
// Source: the UK National Cyber Security Centre's 100,000 most used
// passwords (from breach data), as published in the SecLists collection
// (github.com/danielmiessler/SecLists, MIT licence), file
// Passwords/Common-Credentials/100k-most-used-passwords-NCSC.txt. The copy
// used for 4.11.3 had SHA-256
// c2e5696882c603b76bb67a47ee970897e5a76fc4c3f5547abe3d0ca340c576e0.
//
// Kept: the first COUNT entries, in the source's own frequency order, that
// the app would otherwise accept (8 to 72 printable ASCII characters),
// lower-cased and de-duplicated, because the check ignores case. Shorter
// ones are refused by the length rule already. These are the guesses an
// attacker makes first, which is what an online guessing limit is up
// against.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const COUNT = 5000;
const src = process.argv[2];
if (!src) {
  console.error('Usage: node tools/gen-common-passwords.mjs <100k-most-used-passwords-NCSC.txt>');
  process.exit(2);
}
const seen = new Set();
const out = [];
for (const line of fs.readFileSync(src, 'utf8').split(/\r?\n/)) {
  const w = line.toLowerCase();
  if (w.length < 8 || w.length > 72 || !/^[\x20-\x7e]+$/.test(w) || seen.has(w)) continue;
  seen.add(w);
  out.push(w);
  if (out.length === COUNT) break;
}
const dest = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'common-passwords.txt');
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, out.join('\n') + '\n');
console.log(`wrote ${out.length} entries to ${dest}`);
