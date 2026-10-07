/**
 * Roamkeep push relay.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every family runs their own Supabase, but there is only ONE Roamkeep in
 * the Play Store and its google-services.json — the Firebase project push
 * is delivered through — is baked into that APK at build time. A family's
 * own Edge Function therefore cannot send them a push: it would need the
 * Roamkeep Firebase service-account key, which we are obviously not going
 * to hand out.
 *
 * So their Edge Function calls this instead. It holds the service-account
 * key and forwards a WAKE-UP, not a message.
 *
 * WHAT THIS CAN SEE
 * -----------------
 * Device push tokens, how many there are, and when. That is all. The
 * payload it sends is the fixed literal {"t":"sync"} — no names, no
 * places, no coordinates, no message text, not even whether the event was
 * an arrival, a departure or an SOS. The woken app fetches the actual
 * content from its OWN family's Supabase and composes the notification
 * on-device.
 *
 * Nothing is stored and nothing is logged: no storage is bound, and there
 * are no console calls. Do not add any, even temporarily; the privacy
 * claim depends on it. A particular call is diagnosed from the family's
 * side: notify-checkin answers "ok recipients=N sent=N dead=N" in their
 * own Supabase.
 *
 * Every wake-up goes out at HIGH priority, so the relay is never told
 * which events are urgent.
 */

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const MAX_TOKENS = 20;

/**
 * Throughput limit. The key is a fixed literal, the same for every request
 * from every family, so the counter is a fact about the service ("N
 * requests this minute") and never about a caller. Nothing identifying
 * goes into it, which keeps "the relay stores nothing" true without
 * qualification.
 */
const RATE_LIMIT_KEY = 'relay';

// Access tokens last ~1h. Cache per isolate so warm invocations skip the
// signing + exchange round-trip.
let cachedToken = null;

const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function pemToDer(pem) {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  const raw = atob(body);
  const der = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) der[i] = raw.charCodeAt(i);
  return der.buffer;
}

async function getAccessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAt - 60 > now) return cachedToken.value;

  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToDer(sa.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const enc = new TextEncoder();
  const header = b64url(enc.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claims = b64url(enc.encode(JSON.stringify({
    iss: sa.client_email,
    sub: sa.client_email,
    aud: 'https://oauth2.googleapis.com/token',
    scope: FCM_SCOPE,
    iat: now,
    exp: now + 3600,
  })));
  const signingInput = `${header}.${claims}`;
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', key, enc.encode(signingInput));
  const jwt = `${signingInput}.${b64url(sig)}`;

  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  if (!r.ok) throw new Error(`token exchange failed: ${r.status}`);
  const j = await r.json();
  cachedToken = { value: j.access_token, expiresAt: now + (j.expires_in ?? 3600) };
  return cachedToken.value;
}

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Liveness probe for the setup wizard's verification step.
    if (request.method === 'GET' && url.pathname === '/v1/health') {
      return json({ ok: true });
    }
    if (request.method !== 'POST' || url.pathname !== '/v1/push') {
      return json({ error: 'not found' }, 404);
    }

    // Throughput limit (see RATE_LIMIT_KEY), checked before the body is
    // read. The binding is optional, so local runs and the tests work
    // without it.
    if (env.RATE_LIMITER) {
      const { success } = await env.RATE_LIMITER.limit({ key: RATE_LIMIT_KEY });
      if (!success) return json({ error: 'rate limited' }, 429);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'bad json' }, 400);
    }

    const tokens = Array.isArray(body?.tokens) ? body.tokens : null;
    if (!tokens || !tokens.length) return json({ error: 'tokens required' }, 400);
    if (tokens.length > MAX_TOKENS) {
      return json({ error: `max ${MAX_TOKENS} tokens per call` }, 400);
    }
    if (!tokens.every((t) => typeof t === 'string' && t.length > 20 && t.length < 4096)) {
      return json({ error: 'malformed token' }, 400);
    }

    let sa;
    try {
      sa = JSON.parse(env.FCM_SERVICE_ACCOUNT || '{}');
    } catch {
      return json({ error: 'relay misconfigured' }, 500);
    }
    if (!sa.private_key || !sa.client_email || !sa.project_id) {
      return json({ error: 'relay misconfigured' }, 500);
    }

    let accessToken;
    try {
      accessToken = await getAccessToken(sa);
    } catch {
      return json({ error: 'upstream auth failed' }, 502);
    }

    const endpoint =
      `https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`;

    // Stale tokens are reported back as INDICES into the caller's array,
    // never echoed as values — the caller knows which member each index
    // belongs to, and the relay has no reason to hand tokens back.
    const stale = [];
    let sent = 0;

    await Promise.allSettled(tokens.map(async (token, i) => {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: {
            token,
            // Data-only: no `notification` block, so Android hands this
            // to the app's messaging service instead of drawing anything
            // itself. The app decides what (if anything) to show.
            data: { t: 'sync' },
            android: { priority: 'HIGH' },
          },
        }),
      });
      if (res.ok) { sent++; return; }
      const text = await res.text();
      if (text.includes('UNREGISTERED') ||
          text.includes('INVALID_ARGUMENT') ||
          text.includes('NOT_FOUND')) {
        stale.push(i);
      }
    }));

    // Counts go back to the CALLER — the family's own Edge Function, which
    // logs them on their own infrastructure. Nothing is recorded here.
    return json({ sent, stale });
  },
};
