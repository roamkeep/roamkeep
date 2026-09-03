// Reads the setup link's fragment and adapts this page to it.
//
// A FILE rather than an inline <script>, because the response headers in
// cloudfront-static-site.yaml set script-src 'self' with no 'unsafe-inline'.
// An inline block here is blocked outright, and the only trace is a console
// message nobody is looking at. That is exactly what happened: the Copy
// button did nothing and "Open in Roamkeep" never appeared, on the one page
// whose whole job is catching setup links on a device without the app.
//
// Referenced with an ABSOLUTE path. This page is also what CloudFront's
// error mapping serves for unknown paths, so a relative src would resolve
// against whatever address the visitor happened to arrive at.
//
// Note for deploys: a MISSING file here does not 404. The same error
// mapping answers with the root page and a 200, so the browser gets HTML
// where it asked for JavaScript and the page breaks exactly as it did
// before. Upload this alongside the HTML, never after it.
(function () {
  'use strict';
  // Fragment only. Read in the browser, never sent anywhere: there is no
  // fetch/XHR/beacon on this page, deliberately.
  var frag = location.hash ? location.hash.slice(1) : '';
  var p;
  try { p = new URLSearchParams(frag); } catch (e) { p = null; }
  var hasConfig = !!(p && p.get('u') && p.get('k'));

  if (!hasConfig) {
    // Someone reached the page without a setup link.
    document.getElementById('title').textContent = 'Roamkeep';
    document.getElementById('sub').textContent =
      'Private family location sharing. To join a family you need their setup link — ask whoever set up your Keep to share one from the app.';
    document.getElementById('steps').innerHTML =
      '<p class="bad" style="padding:14px 0">No setup link found in this address.' +
      '<br><br>A setup link is long and ends in a <code>#</code> followed by your ' +
      'family\'s details. If you copied it from a terminal or a message it may ' +
      'have been cut short — ask for it again and copy the whole thing.</p>';
    // Hidden rather than left dead: with no fragment there is nothing to
    // copy and nothing to open. The message above now says so, because a
    // vanished button reads as "the button does nothing".
    document.getElementById('copy').style.display = 'none';
    return;
  }

  // Same fragment, custom scheme. Works whether or not Android has
  // verified the App Link for this domain.
  var openapp = document.getElementById('openapp');
  openapp.href = 'com.roamkeep.app://s#' + frag;
  openapp.style.display = '';

  if (p.get('c')) {
    document.getElementById('sub').textContent =
      'Your invite code is included in this link — the app will fill it in for you.';
  }

  document.getElementById('copy').addEventListener('click', function () {
    var box = document.getElementById('linkbox');
    var url = location.href;
    var done = function () {
      this.textContent = 'Copied — paste it in the app';
    }.bind(this);
    if (navigator.clipboard) {
      navigator.clipboard.writeText(url).then(done, function () {
        box.textContent = url; box.style.display = 'block';
      });
    } else {
      box.textContent = url; box.style.display = 'block';
    }
  });
})();
