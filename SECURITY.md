# Security Policy

Roamkeep's premise is that a family's location data is reachable only by that
family. If you have found something that breaks that, please tell us.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Use GitHub's private vulnerability reporting:
**[Report a vulnerability](https://github.com/roamkeep/roamkeep/security/advisories/new)**.
It is private to the maintainers and gives us somewhere to discuss a fix
with you before anything is public.

If you would rather use email, write to **security@roamkeep.app**.

Please include:

- what an attacker can do, not only what looks wrong
- the steps to reproduce it, or a proof of concept
- the version — `versionName` from the app's Settings screen, or a commit SHA
- whether you have told anyone else

Do not include another person's real location data in a report. If a real
account is involved, describe it rather than pasting it, and we will work out
what we need.

## What to expect

| | |
|---|---|
| Acknowledgement | within 3 working days |
| Initial assessment | within 10 working days |
| Fix or mitigation for a confirmed high-severity issue | as fast as we can, and we will tell you the plan |
| Public disclosure | coordinated with you, and by default no later than 90 days after the report |

This is a small project run by one person. Those are honest targets, not a
commercial SLA. If a deadline slips you will hear from us before it does,
not after.

We will credit you by name or handle in the release notes and the advisory
unless you ask us not to.

## Scope

**In scope**

- The mobile app and the PWA — anything in `app.js`, `index.html`,
  `styles.css`, `sw.js`, and the Android project under `android/`
- The database schema, and in particular the row-level security policies and
  `SECURITY DEFINER` functions in `db/`
- The push relay in `relay/`
- The provisioning wizard in `cli/` and the helpers in `tools/`
- The landing and setup-link handling in `landing/`
- The `notify-checkin` Edge Function in `supabase/functions/`

**Out of scope**

- A particular family's own Supabase project, unless the weakness is in the
  schema or policies this repository ships. Each family administers their own
  backend; a misconfiguration there is theirs to fix, and we would still like
  to hear about it if our defaults led them into it.
- Supabase, Google Play Services, Firebase and other third-party
  infrastructure. Report those to their own programmes.
- The demo backend used for Play review. Its credentials are published on
  purpose and it contains only invented people. Finding that you can sign in
  to it is not a vulnerability.
- Social engineering, physical access, and denial of service through sheer
  volume.

## Things that look like vulnerabilities and are not

These are deliberate, and understanding them will save you time.

**The Supabase anon key is public.** It is in the setup link, in the app
bundle for a baked build, and in any family's QR code. It is designed to be
public. **Row-level security is the boundary**, not the key: a valid key with
no session reads nothing, and a session reads only rows belonging to keeps it
is a member of. If you can read another keep's rows with an anon key, that is
a serious bug and we want to know immediately.

**The client is obfuscated, not secured.** `build.js` minifies and the Android
release runs R8. That is to make casual inspection tedious, nothing more.
Every security decision is enforced server-side by RLS or by a
`SECURITY DEFINER` function.

**The relay accepts device tokens without authenticating the caller.** It
sends a fixed, content-free wake-up and is rate-limited by a single global
counter. It holds no per-caller state on purpose — see `relay/README.md` —
because a counter about a caller is a record about a caller. Abuse of it costs
quota, not privacy. If you can make it reveal anything about who called it or
what event occurred, that is a real finding.

**Invite codes are short.** They expire in 72 hours, `join_keep_by_code` is
rate-limited per user, and failed attempts are logged to enforce that.
Demonstrating that a code is guessable in principle is less interesting than
demonstrating that the limiter can be bypassed.

**Setup links carry the project URL and anon key in the URL fragment.** That
is deliberate: fragments are never sent to a web server, so the family's
backend address stays out of the landing host's access logs. If you find a
path where the fragment does reach a server, that is a finding.

## Safe harbour

If you make a good-faith effort to follow this policy, we will not pursue or
support legal action against you for your research. Please:

- only test against your own family's backend, or a backend you have been
  given permission to test
- do not access, modify or delete another person's data
- do not degrade the service for anyone else
- give us reasonable time to fix an issue before disclosing it

If you are unsure whether something is in scope, ask first — quietly.
