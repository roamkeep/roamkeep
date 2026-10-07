# Roamkeep push relay

A small, stateless service that forwards **content-free push wake-ups**.

## Why it exists

Every family runs their own Supabase, but there is one Roamkeep in the
Play Store, and the `google-services.json` that push is delivered through
is baked into that APK. A family's own Edge Function therefore *cannot*
push to them: it would need the Roamkeep Firebase service-account key.

So their Edge Function calls this relay, which holds the key and forwards
a wake-up.

## What the relay can see

> The relay receives device push tokens, how many there are, and when. It
> cannot see names, places, locations, or message content, and it stores
> nothing.

The payload it sends is the fixed literal `{"t":"sync"}`. The woken app
fetches the real content from its own family's Supabase and composes the
notification on-device. The relay is not even told whether the event was
an arrival, a departure, or an SOS: every wake-up goes out at the same
HIGH priority, so that urgency isn't revealed to it.

Nothing is bound for storage, and logging is off (`[observability]` in
`wrangler.toml`). Do not add logging here "temporarily" to debug: the claim
above is only true while this stays as it is. The hosting provider still
shows the operator aggregate counts of requests and errors; those are
counts, not records of any call.

What leaves no record here is anything about a particular call: which
family, which device, which event. Diagnose a call from the family side
instead: `notify-checkin` answers `ok recipients=N sent=M dead=K`, and that
answer is kept, briefly, in **each family's own Supabase**, on
infrastructure they control. The relay hands those counts back in its
response rather than recording them.

## Rate limiting

Two limits, and neither records anything about a family or a device:

- **In the relay**, one counter keyed on a fixed constant. It counts the
  service's own traffic and nothing about any caller.
- **In front of it**, the hosting provider's rate limit on the caller's
  address, which keeps a short record of the requests it blocks: the
  address, its network and the time. Every caller is a family's Supabase
  Edge Function, never a phone, so that address is Supabase's shared
  outgoing address, which identifies neither a family nor a device.

Their values are not published. The binding in `wrangler.toml` carries an
example.

## API

### `POST /v1/push`

```jsonc
{ "tokens": ["fcm-token", "..."] }   // max 20
```

```jsonc
{ "sent": 2, "stale": [1] }
```

`stale` holds **indices** into the request array, not token values: the
caller knows which member each index maps to, and the relay has no reason
to hand tokens back. Callers should null the matching `fcm_token` rows.

### `GET /v1/health`

`{ "ok": true }`, used by the setup wizard's verification step.

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

- **Unauthenticated, by design.** An FCM registration token is a long,
  unguessable string, and holding one is already the capability to wake
  that phone. The worst a holder can do is make that app sync its own data:
  nothing can be injected, because nothing is carried. The rate limits
  above are for floods.
- **Relay down means degraded, not broken.** `notify-checkin` treats the
  call as best-effort and always returns 200; the check-in is already
  saved, and the notification appears the next time the app is opened.
- **The operator sees timing.** The hosting provider terminates TLS, so the
  operator could in principle observe a token and its timestamp in transit.
  Logging is off and nothing is persisted, but this is the one remaining
  metadata exposure, and it is stated plainly rather than hidden.
