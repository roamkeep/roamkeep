# roamkeep.app

The public website. Six static pages, no script, no analytics, no cookies and
nothing loaded from anywhere else. A site that explains why a family's data
should stay with the family should not be collecting its visitors'.

| | |
|---|---|
| `layout.html` | the page shell: header, footer, and the brand sprite |
| `pages/*.html` | one fragment per page, starting with a `<!-- {json} -->` header (title, description, path) |
| `style.css` | everything visual |
| `robots.txt` | indexing allowed |
| `.well-known/security.txt` | the security contact (RFC 9116), published on this site and on get.roamkeep.app; `cli/test.mjs` fails a month before its `Expires` date, which is the reminder to renew it |

```bash
npm run build:site       # → site-dist/ (gitignored); fails on any broken internal link
npm run deploy:site      # build, upload, invalidate, then check the live pages
```

The logo is never copied in. The build lifts the keep and the outlined
wordmark out of `index.html` (`tools/gen-brand.mjs` writes the wordmark) and
copies `brand-tile.png`, so the site cannot drift from the registered mark.
The screenshots are the README's (`docs/screenshots/`) until Phase 2 replaces
both.

The page's own meta CSP allows styles and images from itself and nothing
else, with no script at all. That is why the sprite carries a class rather
than a `style=""`, and why the video, when there is one, is a link to YouTube
rather than an embed: an embed would need a frame source, and is a request
to Google before anyone has chosen to watch.

## Deploying

`npm run deploy:site` builds, uploads and checks the live pages. How the
three sites are hosted, and the one-time move to this layout, are in the
author's private hosting notes, not in this repository.

## Commitments the pages make

Signed off by the owner on 2026-10-06. Change them only with the owner's
say-so, because each is a public promise:

- **`support`**: running Roamkeep on your own server is free, with every
  feature, for ever; no ads; we never sell, or see, your data. The costs
  table names what the money pays for, with **no figures**, and there is
  **no periodic report** of donations.
- **`faq`**, "How was Roamkeep built?": the disclosure wording.
- **`faq`**, "Will Roamkeep ever cost money?" (signed off 2026-10-12): free
  on your own server, with every feature, always. Any paid service, if one
  ever exists, has no features the free version lacks and is built so that
  we can't see a family's locations, which means end-to-end encryption.
  The home page, the `faq` "What does it cost?", the invite page, the README
  and the Play listing say "no paid features", never "no subscriptions" or
  "no hosted tier", so this stays possible without breaking a promise.
- **`faq`**, "Someone has an old invite link. Can they get in?" (signed
  off 2026-10-07): a link without a current code reaches the server, not the
  family; codes stop after 72 hours or when rotated; declining or removing
  someone rotates it and deletes their account (v19). Change it if any of
  those stops being true.
- **`security`**, "What has been reviewed" (revised and signed off
  2026-10-11): the September and October reviews were both AI-assisted and
  run by the developer, so neither is independent; no independent audit has
  been done, and paying for one is a donation item (`support` lists it, and
  the `faq` "Has it been audited?" says the same). It changes when an audit
  is booked or published. And **every release lists the SHA-256 of
  `app.js`** on GitHub, from 4.11.0.
- **`delete-account`** (2026-10-11): this is the deletion URL in Play
  Console, so its steps must match the app's labels: **Leave and delete my
  account**; a child's **Ask to leave and delete my account**; an owner's
  **Remove**, which deletes the person's account. Change it with any change
  to those labels or to what leaving deletes.

Still to come: the setup video and the promo video (Phase 2), and
screenshots of the release build (Phase 2).
