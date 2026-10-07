// Setup-link construction.
//
// ⚠ This format is implemented in THREE places and they must agree:
//   • app.js          buildSetupLink / parseSetupLink   (the consumer)
//   • tools/setup-link.js                               (bootstrap helper)
//   • here                                              (the wizard)
//
// test.mjs asserts all three produce byte-identical output for the same
// input, so drift fails a test rather than producing a link the app
// silently rejects.
//
// Everything rides in the FRAGMENT so a family's project URL and anon key
// are never sent to the landing host — browsers don't transmit fragments.

export const SETUP_LINK_BASE = 'https://get.roamkeep.app/s';

export function buildSetupLink(url, anonKey, code) {
  const clean = String(url).trim().replace(/\/+$/, '');
  const u = Buffer.from(clean, 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const parts = ['v=1', 'u=' + u, 'k=' + encodeURIComponent(String(anonKey).trim())];
  if (code) parts.push('c=' + encodeURIComponent(code));
  return SETUP_LINK_BASE + '#' + parts.join('&');
}
