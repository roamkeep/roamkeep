// Hands off to the page that actually reads the setup link.
//
// A FILE rather than an inline <script>, for the same reason as /setup.js:
// the site's CSP sets script-src 'self' with no 'unsafe-inline', so an
// inline block never runs and this page simply sits on "Opening your setup
// link…" until the visitor notices the Continue link underneath it.
//
// Absolute path, and it has a file extension — CloudFront's index-rewrite
// only touches extensionless paths, so this is fetched as itself.
// replace(), not assign(): the hop should not sit in the back stack,
// so Back from the setup page returns where the family member came
// from rather than bouncing them through here again.
location.replace('/' + location.hash);
