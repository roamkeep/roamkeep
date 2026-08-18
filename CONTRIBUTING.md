# Contributing to Roamkeep

Thanks for looking. This is a small project run by one person, so the most
useful things you can send are small and specific.

> **The contributor terms below are a draft and have not been reviewed by a
> lawyer.** They are here because merging outside code without them would
> quietly remove options that this project's licence explicitly reserves —
> see the reasoning in that section.

## Before anything else

**Found a security problem?** Do not open an issue or a pull request. See
[SECURITY.md](SECURITY.md) — there is a private reporting channel, and using
it means a fix can be prepared before the problem is public.

**Changing anything about what the software collects, stores, transmits or
retains?** Open an issue and describe it first. Roamkeep's privacy claims are
published, specific, and checkable against this code — *"the relay stores
nothing and logs nothing"* is a claim about `relay/`, not a slogan. A change
that makes one of those statements untrue is not a code review question, it
is a product decision, and it needs to be made before the code is written
rather than after.

## Contributor terms

**By opening a pull request you confirm the following.**

1. **The work is yours to give.** You wrote it, or you have the right to
   submit it — including, if it was written in the course of employment,
   that your employer has waived its rights or authorised the contribution.
   It is not copied from a project whose licence forbids this.

2. **You grant David Carabetta a perpetual, worldwide, non-exclusive,
   royalty-free, irrevocable licence** to use, reproduce, modify, prepare
   derivative works of, publicly display, sublicense and distribute your
   contribution — under the Business Source License 1.1, under the Change
   Licence it converts to, and under other licence terms including
   commercial ones.

3. **You keep your copyright.** This is a licence, not an assignment. You may
   use your own contribution however you like, elsewhere.

4. **It is contributed as-is**, with no warranty from you.

Add a `Signed-off-by` line to each commit to record this:

```bash
git commit -s -m "your message"
```

### Why this is asked for

Roamkeep is under the [Business Source License 1.1](LICENSE), which does two
things that depend on one party holding the necessary rights: **every version
converts to Apache 2.0 on its Change Date**, and **commercial licences can be
granted on request**.

Merging a contribution without clause 2 would remove both of those for the
code in question. Not deliberately — simply because nobody would hold the
rights needed to relicense it. One merged pull request is enough to make the
automatic Apache conversion impossible for that file, which would be a
strange way to lose a promise the licence makes to everybody.

If you would rather not agree to this, that is entirely reasonable — please
still open an issue describing the fix. A clear bug report is worth more than
most patches.

## Practical conventions

The repository is deliberately plain: vanilla JS with no framework, no build
step for the app itself beyond minification, and Java on the Android side.
Match the surrounding code rather than introducing a new style.

**Every behavioural change bumps three things together:**

| | |
|---|---|
| `android/app/build.gradle` | `versionCode` +1 and `versionName` |
| `sw.js` | the `CACHE` constant, so PWA users get the new bundle rather than a stale one |

Android rejects an in-place upgrade whose `versionCode` did not increase, and
a service worker keeps serving the old bundle until its cache name changes.

**Before opening a pull request:**

```bash
node --check app.js && node build.js
```

```bash
cd cli && node test.mjs
```

**Things worth knowing before you touch them:**

- **`tools/mockgps/` has one dependency and should keep exactly one.** It is
  granted mock-location privilege on a real phone; the argument for using it
  rather than something off the store is that there is almost nothing in it
  to audit. It also has no `INTERNET` permission, enforced by a build check.
- **The setup-link format is implemented three times** — `app.js`,
  `tools/setup-link.js` and `cli/src/link.js`. `cli/test.mjs` asserts they
  emit byte-identical output. Change one, change all three.
- **Native state and the database drift apart silently.** Anything that
  mirrors `keep_places` into the OS needs a reconcile against the
  authoritative list, not only a realtime handler. `docs/ARCHITECTURE.md`
  explains why, and it has caused several bugs already.
- Commit messages: short subject, and a body explaining *why* — ideally the
  failure mode being fixed. The history here is used as documentation.

## What is unlikely to be merged

- Reformatting, or migrating to a framework or a build system
- New runtime dependencies in the app, unless they earn their weight
- Analytics, crash reporting or telemetry of any kind — their absence is a
  published claim
- Features that require the developer to operate a server. The one
  author-run component is a relay that cannot see what it relays, and that
  is a deliberate ceiling rather than a current limitation.
