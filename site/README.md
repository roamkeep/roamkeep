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
- **`faq`**, "Someone has an old invite link. Can they get in?" (signed
  off 2026-10-07): a link without a current code reaches the server, not the
  family; codes stop after 72 hours or when rotated; removing someone
  rotates it. Change it if any of those stops being true.
- **`security`**, "What has been reviewed", which changes when an
  independent review is booked or published; and **every release lists the
  SHA-256 of `app.js`** on GitHub, from 4.11.0.

Still to come: the setup video and the promo video (Phase 2), and
screenshots of the release build (Phase 2).
