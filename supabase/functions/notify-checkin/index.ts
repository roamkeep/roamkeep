// notify-checkin
//
// Supabase Edge Function fired by a Database Webhook on INSERT into
// public.checkins. It works out WHO should be told about an
// arrived / left / sos row, and then asks the Roamkeep relay to wake
// those devices.
//
// It does NOT compose a notification.
//
// Why: every family runs their own Supabase, but there is one Roamkeep in
// the Play Store and the Firebase project push is delivered through is
// baked into that APK. This function cannot hold the Roamkeep FCM
// service-account key, so it cannot send a push itself. The relay holds
// the key and forwards a fixed, content-free {"t":"sync"} wake-up; the
// woken app reads the actual check-in back out of THIS database — the
// family's own — and builds the notification text on-device.
//
// The upshot is that names, places and coordinates never leave the
// family's own infrastructure. The relay learns only that some device
// should wake up, and when.
//
// The mute rule still lives here, because it decides recipients rather
// than content — but it is EXPRESSED IN SQL, not in this file. Since v13
// it is per (viewer, subject, place) rather than one boolean per member,
// and the same rule has to be readable from the opposite direction by the
// device (my_checkin_feed). Two hand-written copies of a three-way
// predicate would drift, so both call the one definition:
//
//   checkin_recipients(checkin_id) → the members to wake
//   my_checkin_feed                → the rows a given member should see
//
// SOS ignores every mute, and so does a check-in with no place_id.
//
// The device-side filter is NOT redundant with this one. The wake-up is
// content-free and untargeted, so an SOS — or an unmuted event about
// someone else — wakes every phone, and the woken device then fetches
// everything newer than its watermark. Filtering only here would leak
// muted notifications through unrelated wakes.
//
// Webhook config (Supabase Dashboard → Database → Webhooks):
//   Name:     notify-checkin
//   Table:    checkins
//   Events:   Insert
//   Type:     Supabase Edge Functions → notify-checkin
//   Method:   POST
//
// Optional secret:
//   RELAY_URL   – override the default relay endpoint (self-hosters who
//                 run their own Firebase + relay set this).
// Auto-injected by Supabase:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY  (bypasses RLS — needed to read tokens)
//
// Deploy:
//   supabase functions deploy notify-checkin --no-verify-jwt

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const DEFAULT_RELAY = 'https://relay.roamkeep.app/v1/push';
const RELAY_BATCH = 20;   // relay's per-call token cap

/**
 * Cached expected webhook secret, per isolate.
 *
 * The database issues its own secret (roamkeep_secrets, RLS-denied to
 * everyone) and the trigger sends it as a header. We read the same row with
 * the service-role key, so there is nothing for an owner to configure and no
 * way for the two sides to drift apart.
 *
 * Deliberately NOT an Edge Function secret the owner sets by hand. That
 * works at three projects and silently protects nobody at three thousand,
 * because most owners will never run the command — and a check that is off
 * for most deployments is not a check.
 *
 * `null` = looked up, no secret there, which is the expand case: a function
 * deployed against a database that has not run the v14 migration keeps
 * working exactly as it did before.
 *
 * FAILS CLOSED. Until 4.9.0 a lookup that ERRORED was also cached as null,
 * for the life of the isolate — so one database blip during a cold start
 * switched the check off, and anyone who knew the project ref could invoke
 * this function until the isolate recycled. Only a missing TABLE means
 * "pre-v14"; any other error answers 503 and is not cached.
 *
 * Cached for SECRET_TTL_MS, not forever: rotating the secret after an
 * incident used to leave warm isolates rejecting the new one until they
 * happened to recycle, which is a push outage of unknown length.
 */
const SECRET_TTL_MS = 10 * 60 * 1000;
let cachedSecret: { value: string | null; at: number } | undefined;

async function webhookSecret(sb: ReturnType<typeof createClient>): Promise<string | null> {
  if (cachedSecret && Date.now() - cachedSecret.at < SECRET_TTL_MS) return cachedSecret.value;
  const { data, error } = await sb.from('roamkeep_secrets').select('webhook_secret').maybeSingle();
  if (error) {
    // 42P01 from Postgres, PGRST205 from PostgREST: the table does not exist.
    if (error.code === '42P01' || error.code === 'PGRST205') {
      cachedSecret = { value: null, at: Date.now() };
      return null;
    }
    throw new Error(`webhook secret lookup failed: ${error.code || error.message}`);
  }
  const value = (data as { webhook_secret?: string } | null)?.webhook_secret ?? null;
  cachedSecret = { value, at: Date.now() };
  return value;
}

/** Constant-time comparison: hash both sides, then compare every byte. */
async function secretMatches(got: string | null, want: string): Promise<boolean> {
  if (got === null) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(got)),
    crypto.subtle.digest('SHA-256', enc.encode(want)),
  ]);
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/**
 * Accept RELAY_URL with or without the endpoint path.
 *
 * `wrangler deploy` prints the worker's ORIGIN, so the natural thing to
 * paste into the secret is "https://…workers.dev" — which POSTs to the
 * relay's root and gets a 404. Push then fails silently, because the
 * whole path is best-effort by design. Normalising here means either
 * form works instead of one of them being a silent trap.
 */
function relayEndpoint(): string {
  const raw = (Deno.env.get('RELAY_URL') || DEFAULT_RELAY).trim().replace(/\/+$/, '');
  return raw.endsWith('/v1/push') ? raw : raw + '/v1/push';
}

interface CheckinRow {
  id: string;
  keep_id: string;
  member_id: string;
  member_name: string;
  member_avatar: string;
  type: 'arrived' | 'left' | 'manual' | 'sos';
  place: string;
  // v13. NULL on manual/sos rows and on anything written before v13 —
  // and NULL is never muted, which is what keeps old rows behaving.
  place_id: string | null;
  created_at: string;
}

/** One row of checkin_recipients(). */
interface Recipient {
  member_id: string;
  fcm_token: string;
}

interface WebhookPayload {
  type: 'INSERT' | 'UPDATE' | 'DELETE';
  table: string;
  record: CheckinRow;
  schema: string;
  old_record: CheckinRow | null;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });

  const sb = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );

  // This function is deployed --no-verify-jwt, because a Database Webhook
  // has no user JWT to present. Without the check below, anyone who knew
  // the project ref could invoke it — and the ref is in every setup link
  // and QR code. Checked before the body is read, so a forged call is
  // rejected as cheaply as possible.
  let want: string | null;
  try {
    want = await webhookSecret(sb);
  } catch (e) {
    console.error(String(e));
    return new Response('secret unavailable', { status: 503 });
  }
  if (want !== null && !(await secretMatches(req.headers.get('x-roamkeep-webhook'), want))) {
    return new Response('forbidden', { status: 403 });
  }

  let payload: WebhookPayload;
  try {
    payload = await req.json();
  } catch {
    return new Response('bad json', { status: 400 });
  }

  const row = payload?.record;
  if (!row) return new Response('no record', { status: 200 });

  // Fan out for geofence transitions and SOS. Manual check-ins are user-
  // initiated and the actor already knows, so we skip them.
  const isSos = row.type === 'sos';
  if (row.type !== 'arrived' && row.type !== 'left' && !isSos) {
    return new Response('skip type=' + row.type, { status: 200 });
  }

  // Recipients: decided by checkin_recipients() in the family's own
  // database — everyone else in the keep with a token, minus anyone who
  // has muted this person at this place, with SOS exempt from all of it.
  // See the header: the rule is SQL so the device can read the same one
  // from the other direction.
  const { data, error } = await sb.rpc('checkin_recipients', { p_checkin: row.id });

  if (error) {
    console.error('recipients query failed', error);
    return new Response('db error', { status: 500 });
  }
  const recipients = (data ?? []) as Recipient[];
  if (!recipients.length) return new Response('no recipients', { status: 200 });

  const relayUrl = relayEndpoint();
  const dead: Recipient[] = [];
  let sent = 0;

  // Push is BEST-EFFORT. The check-in row is already committed, so a
  // relay outage must never fail this webhook — the notification simply
  // shows up when the recipient next opens the app. Hence the try/catch
  // and the unconditional 200 at the end.
  for (let i = 0; i < recipients.length; i += RELAY_BATCH) {
    const batch = recipients.slice(i, i + RELAY_BATCH);
    try {
      const res = await fetch(relayUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Tokens only. Nothing about who, where, or what kind of event.
        body: JSON.stringify({ tokens: batch.map((r) => r.fcm_token) }),
      });
      if (!res.ok) {
        console.warn(`relay ${res.status}`);
        continue;
      }
      const out = await res.json();
      sent += out?.sent ?? 0;
      // `stale` is a list of INDICES into the batch we sent.
      for (const idx of (out?.stale ?? [])) {
        const r = batch[idx];
        if (r) dead.push(r);
      }
    } catch (e) {
      console.warn('relay call failed', e);
    }
  }

  // Null out stale tokens so we stop trying. The next time the affected
  // device opens the app (or FCM hands it a new token), it re-registers.
  // Matched on the TOKEN as well as the member: a device can register a
  // fresh token between the recipient read above and this write, and
  // clearing by member_id alone wiped that fresh token too.
  for (const r of dead) {
    await sb.from('keep_member_push').update({ fcm_token: null })
      .eq('member_id', r.member_id).eq('fcm_token', r.fcm_token);
  }

  return new Response(
    `ok recipients=${recipients.length} sent=${sent} dead=${dead.length}`,
    { status: 200 },
  );
});
