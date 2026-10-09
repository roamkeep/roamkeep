// Setup-link construction.
//
// ⚠ This format is implemented in THREE places and they must agree:
//   • app.js          buildSetupLink / parseSetupLink   (the consumer)
//   • tools/setup-link.js                               (bootstrap helper)
//   • here                                              (the wizard)
//
// test.mjs runs all three (app.js's own source, not a copy) and asserts
// they produce byte-identical output for the same input, so drift fails a
// test rather than producing a link the app silently rejects.
//
// Everything rides in the FRAGMENT so a family's project URL and anon key
// are never sent to the landing host — browsers don't transmit fragments.

export const SETUP_LINK_BASE = 'https://get.roamkeep.app/s';

/**
 * A key that bypasses row-level security: a Supabase secret key, or a
 * legacy JWT whose role is service_role. A setup link is shared with the
 * whole family and anyone they forward it to, so such a key in one hands
 * them the whole database. Refused here, by the tool and by the app
 * (4.11.1). The same rule as privilegedKey() in app.js.
 */
export function privilegedKey(key) {
  const k = String(key).trim();
  if (/^sb_secret_/i.test(k)) return true;
  const parts = k.split('.');
  if (parts.length !== 3) return false;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return !!claims && claims.role === 'service_role';
  } catch {
    return false;
  }
}

export function buildSetupLink(url, anonKey, code) {
  const clean = String(url).trim().replace(/\/+$/, '');
  if (!/^https:\/\//i.test(clean)) throw new Error('The project URL must be https://');
  if (privilegedKey(anonKey)) {
    throw new Error('That is a secret (service-role) key. A setup link needs the public anon or publishable key.');
  }
  const u = Buffer.from(clean, 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const parts = ['v=1', 'u=' + u, 'k=' + encodeURIComponent(String(anonKey).trim())];
  if (code) parts.push('c=' + encodeURIComponent(code));
  return SETUP_LINK_BASE + '#' + parts.join('&');
}
