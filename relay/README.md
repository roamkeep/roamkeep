# Roamkeep push relay

A single Cloudflare Worker that forwards **content-free push wake-ups**.

## Why it exists

Every family runs their own Supabase, but there is one Roamkeep in the
Play Store, and the `google-services.json` that push is delivered through
is baked into that APK. A family's own Edge Function therefore *cannot*
push to them — it would need the Roamkeep Firebase service-account key.

So their Edge Function calls this relay, which holds the key and forwards
a wake-up.

## What the relay can see

> The relay receives device push tokens, how many there are, and when. It
> cannot see names, places, locations, or message content, and it stores
> nothing.

The payload it sends is the fixed literal `{"t":"sync"}`. The woken app
fetches the real content from its own family's Supabase and composes the
notification on-device. The relay is not even told whether the event was
an arrival, a departure, or an SOS — every wake-up goes out at the same
HIGH priority, precisely so that urgency isn't leaked to it.

There is no database binding, no KV, and `[observability]` is off.

### The relay is blind to its own health — deliberately

Because nothing is logged, a fleet-wide push failure produces **no signal
here**. That is an accepted cost of the retention claim, not an oversight.

Diagnose from the family side instead: `notify-checkin` returns
`ok recipients=N sent=M dead=K limited=L` and that line lands in **each
family's own Supabase logs**, on infrastructure they control. The relay
hands those counts back in its response rather than recording them.

Do not add logging here "temporarily" to debug. The claim above is only
true while this stays as it is.

## Rate limiting

**One global counter for the whole relay**, keyed on a fixed constant.
Nothing about any caller — no IP, no token, no device — contributes to the
key, so the counter is a fact about the *service* ("N requests this
minute"), never about a person. That is what keeps the retention claim
above unqualified.

Be clear about what it does and doesn't do: it is a **quota guard, not an
abuse guard**. It stops a runaway or a flood from silently burning the
daily Workers quota and taking push down for everyone. It cannot stop
someone who holds a token from spamming that one device.

Two designs were rejected, recorded so they aren't reintroduced:

- **Per source IP** (the original) — every request arrives from a Supabase
  Edge Function and Supabase egress IPs are shared, so unrelated families
  shared a budget. Check-ins burst together at school-run times, so a few
  hundred families behind one egress IP could trip the limit and lose
  notifications silently.
- **Per device, keyed on a token hash** — better protection, but it places
  a counter *about a device* into Cloudflare's backing store, whose
  retention is undocumented. That qualifies the privacy claim, and the
  attack it defends already requires holding an unguessable token — i.e.
  the family's Supabase or the device is compromised, at which point
  battery drain is not the problem.

> ⚠ **Sizing: raise the limit as families are added.** 1000/min is roughly
> 10× a plausible peak for a few hundred families (a family generates ~50
> wake-ups/day, heavily clustered). Undersize it and you recreate the
> per-IP bug at a larger scale: unrelated families throttled together,
> silently, because push is best-effort.

## API

### `POST /v1/push`

```jsonc
{ "tokens": ["fcm-token", "..."] }   // max 20
```

```jsonc
{ "sent": 2, "stale": [1] }
```

`stale` holds **indices** into the request array, not token values — the
caller knows which member each index maps to, and the relay has no reason
to hand tokens back. Callers should null the matching `fcm_token` rows.

### `GET /v1/health`

`{ "ok": true }` — used by the setup wizard's verification step.

## Deploy

```bash
cd relay
npm install
npx wrangler login
npx wrangler secret put FCM_SERVICE_ACCOUNT   # paste the whole JSON
npx wrangler deploy
```

Then point families' Edge Functions at the resulting URL by setting
`RELAY_URL` (the `notify-checkin` function falls back to the built-in
default if unset).

## Threat model

- **Unauthenticated, by design.** An FCM registration token is a long
  unguessable string; possessing one is already the capability to be woken.
  The worst an attacker with a token can do is make that app sync its own
  data — no content is injectable, because none is carried. The per-device
  budget above caps how hard they can do it.
- **Relay down = degraded, not broken.** `notify-checkin` treats the call
  as best-effort and always returns 200; the check-in is already committed
  and the notification simply appears the next time the app is opened.
- **Operator sees timing.** Cloudflare terminates TLS, so the operator
  could in principle observe token + timestamp in transit. Logging is
  disabled and nothing is persisted, but this is the one residual metadata
  exposure and is stated plainly rather than hidden.
- **Rate-limit counter.** The limiter keeps one counter keyed on a fixed
  constant. It records the relay's own throughput and nothing about any
  caller — no per-device or per-family state exists to expose.
