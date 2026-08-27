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

const DEFAULT_RELAY = 'https://roamkeep-relay.roamkeep.workers.dev/v1/push';
const RELAY_BATCH = 20;   // relay's per-call token cap

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

  const sb = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );

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
  const dead: string[] = [];
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
        // checkin_recipients() names the column member_id, not id.
        if (r) dead.push(r.member_id);
      }
    } catch (e) {
      console.warn('relay call failed', e);
    }
  }

  if (dead.length) {
    // Null out stale tokens so we stop trying. The next time the
    // affected device opens the app, the registration listener
    // re-populates with a fresh token.
    await sb.from('keep_members').update({ fcm_token: null }).in('id', dead);
  }

  return new Response(
    `ok recipients=${recipients.length} sent=${sent} dead=${dead.length}`,
    { status: 200 },
  );
});
