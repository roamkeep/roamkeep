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

### The relay keeps no per-request record — but it is not blind

`[observability]` off disables Workers **Logs**: persisted, per-request
records. It does not disable Workers **Metrics**, the aggregate request,
error and CPU counts under Workers &amp; Pages → `roamkeep-relay` → Metrics.
Those are counts rather than records, so they cost the retention claim
nothing, and a flood or a fleet-wide failure shows in them plainly.

What genuinely produces no signal here is anything *about a particular
call* — which family, which device, which event. That is the accepted cost
of the retention claim, not an oversight.

Diagnose from the family side instead: `notify-checkin` returns
`ok recipients=N sent=M dead=K limited=L` and that line lands in **each
family's own Supabase logs**, on infrastructure they control. The relay
hands those counts back in its response rather than recording them.

Do not add logging here "temporarily" to debug. The claim above is only
true while this stays as it is.

## Rate limiting

There are **two** limiters, in different places, doing different jobs.

**In the Worker: one global counter**, keyed on a fixed constant. Nothing
about any caller — no IP, no token, no device — contributes to the key, so
the counter is a fact about the *service* ("N requests this minute"), never
about a person.

Be clear about what it does and doesn't do: it is a **quota guard, not an
abuse guard**. It caps how many FCM sends and how much CPU a runaway can
burn. Note that it does **not** protect the daily Workers *request*
allowance, whatever an earlier version of this file claimed:
`env.RATE_LIMITER.limit()` is evaluated inside `fetch()`, so by the time it
returns `success: false` the Worker has been invoked and the request has
already been counted.

**At the Cloudflare edge: a rate-limiting rule on `relay.roamkeep.app`**,
keyed on the caller's address. This is the abuse guard, and it is the reason
the relay moved off `workers.dev` — zone rules cannot be attached to a zone
Cloudflare owns. A rule here runs before the Worker is invoked, so a
rejected flood costs no invocation, no request allowance, and no share of
the global ceiling above. Without it, any stranger with `curl` could hold
that ceiling at its limit and take push down for every family at once,
silently, because push is best-effort.

Its threshold and period are **deliberately not published**. The mechanism
is disclosed here and on the privacy page; publishing the calibration would
only tell an attacker how to stay under it.

Two designs were rejected, recorded so they aren't reintroduced:

- **Per source IP, inside the Worker** — every request arrives from a
  Supabase Edge Function and Supabase egress IPs are shared, so unrelated
  families shared a budget. Check-ins burst together at school-run times, so
  a few hundred families behind one egress IP could trip the limit and lose
  notifications silently.

  Per-IP was later reintroduced **one layer out**, at the Cloudflare edge, on
  purpose. The shared-egress hazard above is unchanged and is exactly what
  sizes the threshold — it is a flood guard, not a precise control, and it
  must be raised in step with the global ceiling as families are added. What
  moving it out buys is that a rejection there costs nothing: no invocation,
  no request allowance, no share of the global counter that real traffic
  depends on.
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

- **Unauthenticated, by design — but no longer unprotected.** An FCM
  registration token is a long unguessable string; possessing one is already
  the capability to be woken. The worst an attacker with a token can do is
  make that app sync its own data — no content is injectable, because none is
  carried.

  What that reasoning missed for a while is that flooding the endpoint needs
  no token at all: any stranger could spend the global ceiling and take push
  down for every family at once. The edge rule described above is the answer
  to that, and it is why the relay now lives on a hostname in a zone we
  control. There is still no per-caller credential, so a family provisions
  themselves and it simply works.
- **Relay down = degraded, not broken.** `notify-checkin` treats the call
  as best-effort and always returns 200; the check-in is already committed
  and the notification simply appears the next time the app is opened.
- **Operator sees timing.** Cloudflare terminates TLS, so the operator
  could in principle observe token + timestamp in transit. Logging is
  disabled and nothing is persisted, but this is the one residual metadata
  exposure and is stated plainly rather than hidden.
- **Rate-limit counters.** Two. In the Worker, one keyed on a fixed
  constant — the relay's own throughput, nothing about any caller. At the
  Cloudflare edge, a rate-limiting rule on `relay.roamkeep.app` keyed on the
  caller's address, held for the rule's period. Every caller is a Supabase
  Edge Function, so that address identifies Supabase's shared egress and
  never a family or a device — no phone contacts the relay directly.
  Requests the rule blocks appear in this account's Security Events with
  address, ASN and timestamp, retained on Cloudflare's schedule. The Worker
  itself still writes nothing.
