# get.roamkeep.app

The landing page setup links point at. Two files, both static.

## What it is for

A setup link looks like:

```
https://get.roamkeep.app/s#v=1&u=<base64url(projectUrl)>&k=<anonKey>&c=<code>
```

If Roamkeep is installed, Android **App Links** intercept it and the app
handles it directly — this page never loads. This page exists only for the
case where it isn't installed: someone tapping a link on a phone with no
app, or on a desktop.

## The fragment never reaches this server

Everything after `#` is a URL fragment, and browsers **do not send
fragments to the server**. So a family's project URL and anon key never
appear in this host's access logs, however it is hosted. That is the whole
reason the link format puts them there rather than in a query string.

The page reads the fragment in the browser only, to carry it through the
install flow. It never transmits it anywhere.

## Files

| | |
|---|---|
| `index.html` | the page itself, and what unknown paths fall back to |
| `setup.js` | reads the link and adapts the page |
| `s/index.html` | makes `/s` a real path; hands off to `/` |
| `s/redirect.js` | that hand-off |
| `privacy/`, `terms/` | the published documents |
| `.well-known/assetlinks.json` | Android App Links verification |

The JavaScript sits in files rather than inline `<script>` blocks because
the response headers set by `cloudfront-static-site.yaml` include
`script-src 'self'` with no `'unsafe-inline'`. Inline blocks are blocked
outright, and the only trace is a console message: for a while the Copy
button did nothing and "Open in Roamkeep" never appeared, on the one page
whose whole job is catching setup links. Keep them as files.

## Hosting

Any static host, with two requirements:

1. **`/.well-known/assetlinks.json` must be served over HTTPS as
   `application/json`, with no redirect.** Android fetches it directly and
   a redirect fails verification silently.
2. **`/s` must serve `index.html`.** Either add a rewrite, or serve
   `index.html` as the 404 document.
3. **Upload the `.js` files with the HTML, never after.** A missing one
   does not 404 under the arrangement above: the error mapping answers with
   the root page and a `200`, so the browser gets HTML where it asked for
   JavaScript and the page breaks exactly as it did when the scripts were
   inline — silently.

The existing `cloudfront-static-site.yaml` template works — deploy a
second stack with `SubDomain=get`.

## Two fingerprints, and why

`assetlinks.json` lists **both** signing keys, because the same app is
signed two different ways depending on how it was installed:

| fingerprint | signs | comes from |
|---|---|---|
| `2C:8F:69:…:AE:FA` | sideloaded APKs | the local release keystore |
| `27:59:DB:…:D6:E1` | Play installs | Play App Signing (Google holds this key) |

Play App Signing re-signs the upload, so a Play build's certificate is
**not** the one you built with. List only one and App Links silently fail
on the other channel — links open in the browser with no error anywhere.

If the signing setup ever changes (new upload key, a second app entry),
re-check **Play Console → Test and release → Setup → App integrity** and
update this file. `cli/test.mjs` asserts both are present and well-formed.

## Verifying

After deploying, check Android agrees:

```
https://developers.google.com/digital-asset-links/tools/generator
```

On a device, `adb shell pm get-app-links com.roamkeep.app` should report
`verified` for `get.roamkeep.app`.
