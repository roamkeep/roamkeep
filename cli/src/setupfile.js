// Writes the wizard's setup link to disk beside the terminal QR.
// Split out of index.js so it can be exercised without standing up a
// Supabase project — the QR round-trip is the assertion that matters.

import fs from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';

/**
 * Persist the setup link next to wherever the wizard was run.
 *
 * The terminal QR is the whole deliverable and it disappears with the
 * window. A family that closes it has no route back onto their own
 * server except digging the anon key out of the dashboard — which is
 * exactly the manual step this wizard exists to remove.
 *
 * The project ref is in the filename on purpose: someone provisioning a
 * second project from the same folder must not silently overwrite the
 * first one's link. Re-running for the SAME project overwrites its own
 * file, which is what you want.
 *
 * Never throws. This runs after every real step has succeeded, so a
 * read-only directory must not turn a finished setup into a failure —
 * the caller falls back to telling the user to copy the link by hand.
 */
export async function saveSetupFiles(ref, projectUrl, link) {
  const dir = process.cwd();
  const txt = `roamkeep-setup-${ref}.txt`;
  const png = `roamkeep-setup-${ref}.png`;
  const body =
`ROAMKEEP — SETUP LINK FOR YOUR FAMILY SERVER
============================================

Created  : ${new Date().toISOString().slice(0, 10)}
Project  : ${projectUrl}
Ref      : ${ref}

YOUR SETUP LINK
---------------
${link}

HOW TO USE IT
-------------
1. Install Roamkeep on a phone.
2. On the Connect screen, tap "Scan setup QR code" and scan
   ${png}
   — or tap "Paste setup link" and paste the line above.
3. Sign up. The first person to connect creates the Keep and becomes
   its owner.
4. Everyone else joins from an invite shared inside the app
   (Family tab -> Invite), not from this link.

KEEP THIS SAFE — BUT IT IS NOT A PASSWORD
-----------------------------------------
The link contains your project address and its public "anon" key. That
key is public by design: the database is protected by row-level security,
not by hiding the key. The same key ships inside every copy of the app.

What it does mean is that anyone holding this link can reach your Keep's
sign-up screen. Share it like your home address, not like a password —
and rotate invite codes from inside the app if one gets out.

It does NOT contain your database password, your service_role key, or
your Supabase access token. Never put any of those in a setup link.

IF YOU LOSE THIS FILE
---------------------
Supabase Dashboard -> project ${ref}
  -> Project Settings -> API -> the key labelled "anon public".

Then, from a copy of the Roamkeep repo:

  node tools/setup-link.js --url ${projectUrl} --key <anon-key>

Use the "anon public" key, never "service_role" — service_role bypasses
row-level security, and a setup link carrying it would hand anyone who
scanned it full read/write on your whole database.
`;

  try {
    fs.writeFileSync(path.join(dir, txt), body, 'utf8');
  } catch (e) {
    return { ok: false, err: e?.message || String(e) };
  }

  // The .txt already carries the link, so a PNG failure is cosmetic —
  // report it rather than losing the whole rescue path over it.
  let pngOk = true;
  try {
    await QRCode.toFile(path.join(dir, png), link, { width: 600, margin: 2 });
  } catch (_) { pngOk = false; }

  return { ok: true, dir, txt, png, pngOk };
}

