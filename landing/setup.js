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
    // Nothing at all: someone typed get.roamkeep.app, or followed a plain
    // link to it. What they want is the project's website. Anything else
    // here (a fragment that arrived cut short, or the ?invite that /s adds
    // when an invite lost its fragment on the way) is a broken invite, and
    // the explanation below is for them.
    if (!frag && !location.search) {
      location.replace('https://roamkeep.app/');
      return;
    }
    // Someone reached the page with a setup link that didn't survive.
    document.getElementById('title').textContent = 'Roamkeep';
    document.getElementById('sub').textContent =
      'Private family location sharing. To join a family you need their setup link. Ask whoever set up your Keep to share one from the app.';
    document.getElementById('steps').innerHTML =
      '<p class="bad" style="padding:14px 0">No setup link found in this address.' +
      '<br><br>A setup link is long and ends in a <code>#</code> followed by your ' +
      'family\'s details. If you copied it from a terminal or a message it may ' +
      'have been cut short. Ask for it again and copy the whole thing.</p>' +
      '<p style="padding:0 0 14px">Looking for Roamkeep itself? ' +
      '<a href="https://roamkeep.app/">Visit roamkeep.app</a>.</p>';
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
      'Your invite code is included in this link, and the app will fill it in for you.';
  }

  document.getElementById('copy').addEventListener('click', function () {
    var box = document.getElementById('linkbox');
    var url = location.href;
    var done = function () {
      this.textContent = 'Copied. Paste it in the app';
    }.bind(this);
    if (navigator.clipboard) {
      navigator.clipboard.writeText(url).then(done, function () {
        box.textContent = url; box.style.display = 'block';
      });
    } else {
      box.textContent = url; box.style.display = 'block';
    }
  });

  // Someone without the app is about to leave for Google Play, and this
  // link — their only way onto the family's server — would otherwise be
  // left behind in a browser tab. So the tap that sends them there copies
  // it first, and the app's Connect screen has "Paste invite link" waiting.
  // Clipboard, not Play's install referrer: a referrer would carry the
  // family's server address through Google.
  //
  // Bounded wait: a clipboard that never answers must not strand them here.
  var play = document.getElementById('play');
  play.addEventListener('click', function (e) {
    if (!navigator.clipboard) return;   // just a link, then
    e.preventDefault();
    var gone = false;
    var go = function () { if (!gone) { gone = true; location.href = play.href; } };
    setTimeout(go, 1500);
    navigator.clipboard.writeText(location.href).then(go, go);
  });
})();
