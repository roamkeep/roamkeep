// notify-places
//
// Supabase Edge Function fired by a Database Webhook on INSERT, UPDATE or
// DELETE of public.keep_places. It asks the Roamkeep relay to wake every
// device in the keep so each one re-reads the place list and re-arms its
// geofences.
//
// ── Why this exists ─────────────────────────────────────────────
//
// Three stores hold a copy of what keep_places says, and none of them is
// the database: the Play Services fence registry, PrefsStore's place
// metadata, and PrefsStore's inside-place set. They exist so the geofence
// receivers work with the app dead — that is the whole point — but it
// means every change to a place has to reach three places, on every
// device, or they drift.
//
// The realtime subscription looks like it handles this. It does not:
// Android suspends the WebView's realtime socket while the app is
// backgrounded, and Supabase does not replay missed events. So a
// keep_places change only lands on a device that happens to be in the
// foreground at that moment. Every other device learns about it, if at
// all, at the next app open.
//
// That gap has produced two shipped bugs already: a place added on
// another device was never armed (PR #40), and a place deleted on another
// device was never pruned, so a phone went on filing check-ins for a place
// that no longer existed (PR #42). Both were invisible — the database was
// consistent, the UI rendered the database, and the wrong behaviour
// happened in a receiver with no screen.
//
// This closes it: a place change wakes every device within seconds, app
// closed, and the woken device reconciles against the authoritative list.
//
// ── How it differs from notify-checkin ──────────────────────────
//
// Deliberately a separate function, not a branch inside that one. The
// recipient rules share nothing, and a bug in place sync must not be able
// to stop an SOS being delivered.
//
//   * It does NOT respect notify_on_checkin. This is a data sync, not a
//     notification — muting alerts must not leave a phone holding stale
//     geofences. Nothing user-visible results from this wake-up unless
//     the device also finds a check-in worth raising.
//   * It INCLUDES the actor. Their own other devices need it, and their
//     originating device gets an idempotent no-op (the reconcile compares
//     a signature before touching anything). Cheaper than working out who
//     to exclude — a DELETE does not even carry who deleted it.
//
// The relay is unchanged and learns nothing new: same endpoint, same
// tokens-only body, same fixed {"t":"sync"} on the wire. If anything it
// sees less, because a wake-up no longer implies that a family member
// arrived somewhere.
//
// Webhook config — created by db/schema.sql (trigger on_place_notify), or
// by hand:
//   Table:    keep_places
//   Events:   Insert, Update, Delete
//   Type:     Supabase Edge Functions → notify-places
//
// Optional secret:
//   RELAY_URL   – override the default relay endpoint.
// Auto-injected by Supabase:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY  (bypasses RLS — needed to read tokens)
//
// Deploy:
//   supabase functions deploy notify-places --no-verify-jwt

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const DEFAULT_RELAY = 'https://relay.roamkeep.app/v1/push';
const RELAY_BATCH = 20;   // relay's per-call token cap

/**
 * Cached expected webhook secret, per isolate. See notify-checkin for the
 * full reasoning: the database issues its own secret, the trigger sends it,
 * and this function reads the same row with the service-role key — so there
 * is nothing for an owner to configure and no way for the two to drift.
 *
 * `undefined` = not looked up. `null` = nothing there, which leaves the
 * check open so a function deployed ahead of the v14 migration keeps working.
 */
let cachedSecret: string | null | undefined;

async function webhookSecret(sb: ReturnType<typeof createClient>): Promise<string | null> {
  if (cachedSecret !== undefined) return cachedSecret;
  const { data } = await sb.from('roamkeep_secrets').select('webhook_secret').maybeSingle();
  cachedSecret = (data as { webhook_secret?: string } | null)?.webhook_secret ?? null;
  return cachedSecret;
}

/** Accept RELAY_URL with or without the endpoint path — see notify-checkin. */
function relayEndpoint(): string {
  const raw = (Deno.env.get('RELAY_URL') || DEFAULT_RELAY).trim().replace(/\/+$/, '');
  return raw.endsWith('/v1/push') ? raw : raw + '/v1/push';
}

interface PlaceRow {
  id: string;
  keep_id: string;
  name: string;
}

/** One row of keep_push_recipients(). */
interface Recipient {
  member_id: string;
  fcm_token: string;
}

interface WebhookPayload {
  type: 'INSERT' | 'UPDATE' | 'DELETE';
  table: string;
  record: PlaceRow | null;
  schema: string;
  old_record: PlaceRow | null;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });

  const sb = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );

  // Deployed --no-verify-jwt, so without this anyone who knew the project
  // ref could invoke it and wake every device in a keep, repeatedly. See
  // notify-checkin. Checked before the body is read.
  const want = await webhookSecret(sb);
  if (want && req.headers.get('x-roamkeep-webhook') !== want) {
    return new Response('forbidden', { status: 403 });
  }

  let payload: WebhookPayload;
  try {
    payload = await req.json();
  } catch {
    return new Response('bad json', { status: 400 });
  }

  // A DELETE has no `record`; old_record carries keep_id only because
  // keep_places is REPLICA IDENTITY FULL. Without that the id would
  // arrive and the keep would not, and this would silently wake nobody.
  const keepId = payload?.record?.keep_id ?? payload?.old_record?.keep_id;
  if (!keepId) return new Response('no keep_id', { status: 200 });

  // EVERY member with a token, including whoever made the change. See the
  // header for why notify_on_checkin is not consulted here.
  //
  // Since v14 this goes through an RPC rather than selecting
  // keep_members.fcm_token directly: that column moved to keep_member_push,
  // whose RLS is own-row only, so a member can no longer read a relative's
  // push token. Only service_role may execute keep_push_recipients().
  const { data, error } = await sb.rpc('keep_push_recipients', { p_keep: keepId });

  if (error) {
    console.error('recipients query failed', error);
    return new Response('db error', { status: 500 });
  }
  const recipients = (data ?? []) as Recipient[];
  if (!recipients.length) return new Response('no recipients', { status: 200 });

  const relayUrl = relayEndpoint();
  const dead: string[] = [];
  let sent = 0;

  // Best-effort, exactly like notify-checkin: the keep_places row is
  // already committed, so a relay outage must never fail this webhook.
  // A device that misses the wake-up still reconciles at its next app
  // open, which is today's behaviour — this only makes it faster.
  for (let i = 0; i < recipients.length; i += RELAY_BATCH) {
    const batch = recipients.slice(i, i + RELAY_BATCH);
    try {
      const res = await fetch(relayUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Tokens only. Nothing about which place, or what happened to it.
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
        // keep_push_recipients() names the column member_id, not id.
        if (r) dead.push(r.member_id);
      }
    } catch (e) {
      console.warn('relay call failed', e);
    }
  }

  if (dead.length) {
    // Since v14 the token lives in keep_member_push, keyed on member_id.
    await sb.from('keep_member_push').update({ fcm_token: null }).in('member_id', dead);
  }

  return new Response(
    `ok op=${payload.type} recipients=${recipients.length} sent=${sent} dead=${dead.length}`,
    { status: 200 },
  );
});
