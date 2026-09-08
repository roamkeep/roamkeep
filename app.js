/* Roamkeep — main application script.
 * Loaded as a classic script after supabase.js.
 * All interactive behaviour is wired in init() via addEventListener,
 * so no inline handlers are required and strict CSP (script-src 'self')
 * works without 'unsafe-inline'. */
(() => {
  'use strict';

  // ── BACKEND CONFIG ─────────────────────────────────────────────
  // Roamkeep is multi-tenant by deployment: every family runs their OWN
  // Supabase project, and the app is pointed at one at first run rather
  // than being compiled against it. So there is deliberately no project
  // URL or anon key in this source file.
  //
  // Resolution order:
  //   1. Stored config (Capacitor Preferences on native, localStorage on
  //      the PWA) — written when a setup link / QR is accepted.
  //   2. BAKED_BACKEND, which build.js substitutes from a gitignored
  //      deploy.config.json. That lets a pre-connected PWA be published
  //      to a fixed URL, while the Play Store build ships with none.
  //   3. Nothing → the Connect screen.
  //
  // The anon key is public by design (RLS is the security boundary), but
  // keeping it out of the repo means the source-available release doesn't
  // hand out a pointer to one specific family's project.
  const BAKED_BACKEND = { url: '', anonKey: '' }; /* BUILD_INJECT_BACKEND */
  const BACKEND_STORE_KEY = 'rk_backend';
  // Landing page for setup links. Its only job is to say "install the app"
  // to someone who taps the link without it; the app itself claims the URL
  // via Android App Links. The config never reaches this host — it lives
  // in the fragment.
  const SETUP_LINK_BASE = 'https://get.roamkeep.app/s';

  // ── TERMS OF USE ───────────────────────────────────────────────
  //
  // The binding document is the one published at get.roamkeep.app/terms,
  // and that is the ONLY copy. The gate screen summarises it and links to
  // it; it deliberately does not restate it. Two copies of a legal
  // document drift, and a contradiction between them is worse than either
  // alone — the same reasoning landing/terms and landing/privacy already
  // carry in their own headers.
  //
  // Bump TERMS_VERSION when the published terms change MATERIALLY. Every
  // member is then asked again on next open, which is what makes the
  // published "changes will be noted in the app's release notes" line
  // honest rather than a formality. Do not bump it for a typo.
  const TERMS_VERSION = 2;
  const TERMS_DATE = '17 August 2026';        // matches landing/terms
  // Tracked separately because the two documents move independently — v14
  // changed only the privacy policy, and showing one date for both on the
  // very screen asking people to agree again would be its own small lie.
  const PRIVACY_DATE = '31 August 2026';      // matches landing/privacy
  const TERMS_URL = 'https://get.roamkeep.app/terms';
  const PRIVACY_URL = 'https://get.roamkeep.app/privacy';
  const TERMS_STORE_KEY = 'rk_terms';

  // The two status strings the app writes for itself. Constants because
  // they are now written in one place and read in another — disconnect
  // sets the marker, the next launch retracts it — and two copies of a
  // magic string are two things that can drift apart silently.
  // STATUS_DEFAULT matches the keep_members.status column default in
  // db/schema.sql, so a retracted marker looks exactly like a row that
  // never carried one.
  const STATUS_DEFAULT = '📍 Location sharing on';
  const STATUS_DISCONNECTED = '🔌 Disconnected this device';

  // Assigned once a backend is resolved; every consumer reads these.
  let SB_URL = '';
  let SB_KEY = '';
  // Avatar choices — one array feeds the create, join AND profile-edit
  // pickers. Faces grouped first (they fill the round chip cleanly); the
  // two full-body Australians (kangaroo, croc) sit last since no face
  // variant exists. Every entry is ≤ 8 code points (nm_avatar_len).
  const AVATARS = ['🧑', '👩', '👨', '👧', '👦', '🧓', '👴', '👵', '🧒', '🧔', '👱', '👩‍🦰', '👨‍🦰', '🧕',
    '🐶', '🐱', '🦊', '🐷', '🐮', '🐻', '🐼', '🐨', '🐻‍❄️', '🦁', '🐯', '🐰', '🐵', '🐸', '🐔', '🐧', '🦉', '🦄', '🐢', '🦘', '🐊'];
  const TILE_SIZE = 256;
  const DEFAULT_CENTRE = { lat: -33.87, lng: 151.21, zoom: 13 };
  // Zoom range. S.mZoom is fractional between these (pinch); the zoom
  // buttons step whole levels.
  const MIN_ZOOM = 2, MAX_ZOOM = 18;

  // ── SCHEMA COMPATIBILITY ───────────────────────────────────────
  //
  // Every family runs their own Supabase, and their database is upgraded
  // by their owner while every member's app updates on Google's schedule.
  // So there is always a window where a MIX of app versions is talking to
  // one database. Without a check, a build that needs something the
  // database lacks doesn't say so — it fails at whichever call site needs
  // the missing thing, and on the native path (SupabaseRest, no screen)
  // that failure is a Log.w and nothing else: alerts and trails just stop.
  //
  // NEEDS_SCHEMA is the minimum version THIS build requires. Raise it in
  // the same commit that starts using a new table, column or RPC.
  const NEEDS_SCHEMA = 13;

  // What to assume when roamkeep_meta / roamkeep_schema_version() is
  // absent. Every database provisioned before v12 is at 11 (the last
  // migration before the marker existed), so absence is a KNOWN version,
  // not an error — and treating it as one is what lets this release ship
  // without locking anyone out.
  const SCHEMA_PRE_META = 11;

  // 4.7.0 shipped this equal to SCHEMA_PRE_META, so the gate was INERT on
  // arrival — a gate that demanded its own migration would have locked
  // every member out until their owner acted, making the mechanism's
  // first act in the world an outage it caused. 4.8.0 is the first
  // release to raise it, and it can only do that safely because 4.7.0 is
  // already installed and will show the outdated screen rather than
  // failing at whichever call needs keep_notify_prefs.

  // ── STATE ──────────────────────────────────────────────────────
  const S = {
    sb: null,
    user: null,
    keepId: null,
    keepCode: '',
    keepName: '',
    myId: null,
    members: [],
    checkins: [],
    sosActive: false,
    channel: null,
    selAv: AVATARS[0],
    mLat: DEFAULT_CENTRE.lat,
    mLng: DEFAULT_CENTRE.lng,
    mZoom: DEFAULT_CENTRE.zoom,
    tiles: {},
    pinching: false,           // true mid-pinch: suppresses tile fetches
    dragging: false,
    dragStart: null,
    viewStart: null,
    mapCtx: null,
    authHandled: false,
    deferredPrompt: null,
    places: [],
    insidePlaces: new Set(),   // place IDs the local user is currently inside
    placePicker: null,         // { lat, lng } while picking icon/name for a new place
    placeIcon: '🏠',
    placeRadius: 100,
    profileEdit: null,         // { memberId } while the edit-profile sheet is open
    trail: [],                 // breadcrumb points {lat,lng,recorded_at} for trailMemberId
    trailMemberId: null,       // whose trail is currently shown (null = none)
    trailLabel: '24h',         // window label in the trail pill ('24h' or a timeline day)
    trackingMode: 'auto',      // auto | live | balanced | saver
    tlMemberId: null,          // timeline: selected member (defaults to self)
    tlDayOffset: 0,            // timeline: 0 = today … HISTORY_DAYS-1
    tlTrips: [],               // timeline: current day's trips, kept for tap-to-draw
    // The database's own schema version, read once at connect. Kept even
    // when the check passes: this is what a future per-feature fallback
    // reads (`if (S.schemaVersion >= 13) … else …`) if we ever switch
    // from refusing to degrading.
    schemaVersion: null,
    placeNotifyFor: null,      // place id while the per-place notify sheet is open
    // Per-place notification mutes, as a Set of 'subjectMemberId|placeId'.
    // Exception rows only — presence means MUTED. See loadNotifyPrefs.
    notifyPrefs: new Set()
  };

  const PLACE_ICONS = ['🏠', '🏫', '🏢', '🛒', '🏋️', '🏥', '⛪', '🌳', '🍴', '📍'];

  // ── PLATFORM ───────────────────────────────────────────────────
  // Capacitor injects window.Capacitor when running inside the native
  // Android shell. The web build (S3/CloudFront PWA) leaves it undefined,
  // so every isNative() caller transparently falls back to web APIs.
  const isNative = () => !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());

  // ── BACKEND CONFIG STORE ───────────────────────────────────────
  // Capacitor Preferences (SharedPreferences) on native so the value
  // survives WebView storage eviction; localStorage on the PWA.
  async function loadBackendConfig() {
    let raw = null;
    try {
      const Prefs = window.Capacitor?.Plugins?.Preferences;
      if (Prefs) {
        const { value } = await Prefs.get({ key: BACKEND_STORE_KEY });
        raw = value;
      } else {
        raw = localStorage.getItem(BACKEND_STORE_KEY);
      }
    } catch (_) {}
    if (raw) {
      try {
        const c = JSON.parse(raw);
        if (c && c.url && c.anonKey) return { url: c.url, anonKey: c.anonKey };
      } catch (_) { /* corrupt — fall through to the baked default */ }
    }
    if (BAKED_BACKEND.url && BAKED_BACKEND.anonKey) {
      return { url: BAKED_BACKEND.url, anonKey: BAKED_BACKEND.anonKey };
    }
    return null;
  }

  async function saveBackendConfig(cfg) {
    const raw = JSON.stringify({ v: 1, url: cfg.url, anonKey: cfg.anonKey });
    try {
      const Prefs = window.Capacitor?.Plugins?.Preferences;
      if (Prefs) await Prefs.set({ key: BACKEND_STORE_KEY, value: raw });
      else localStorage.setItem(BACKEND_STORE_KEY, raw);
    } catch (e) { console.warn('saveBackendConfig', e); }
  }

  // Which terms version this device has accepted, or 0.
  //
  // Stored per DEVICE, not per account, and alongside the backend config
  // rather than in the family's database. Acceptance is this person on
  // this phone agreeing — it is not data their family should hold, and
  // putting it in Supabase would have made it a schema change and a
  // synchronisation problem for something neither needs.
  //
  // Android backup is off (see allowBackup in the manifest), so a
  // reinstall asks again. That is the correct outcome, not a bug.
  async function loadTermsAccepted() {
    try {
      const Prefs = window.Capacitor?.Plugins?.Preferences;
      const raw = Prefs
        ? (await Prefs.get({ key: TERMS_STORE_KEY })).value
        : localStorage.getItem(TERMS_STORE_KEY);
      if (!raw) return 0;
      const v = JSON.parse(raw);
      return Number(v && v.version) || 0;
    } catch (_) { return 0; }
  }

  async function saveTermsAccepted() {
    const raw = JSON.stringify({
      version: TERMS_VERSION,
      // What they agreed to and when, so a support question about which
      // wording someone saw has an answer. Both documents, because the
      // acceptance covers both and they are dated separately.
      terms: TERMS_DATE,
      privacy: PRIVACY_DATE,
      at: new Date().toISOString()
    });
    try {
      const Prefs = window.Capacitor?.Plugins?.Preferences;
      if (Prefs) await Prefs.set({ key: TERMS_STORE_KEY, value: raw });
      else localStorage.setItem(TERMS_STORE_KEY, raw);
    } catch (e) { console.warn('saveTermsAccepted', e); }
  }

  async function clearBackendConfig() {
    try {
      const Prefs = window.Capacitor?.Plugins?.Preferences;
      if (Prefs) await Prefs.remove({ key: BACKEND_STORE_KEY });
      else localStorage.removeItem(BACKEND_STORE_KEY);
    } catch (e) { console.warn('clearBackendConfig', e); }
  }

  // Accepts the setup link produced by the provisioning wizard and the
  // in-app invite share. Everything rides in the URL FRAGMENT, never the
  // query string: fragments are not sent to the server, so the landing
  // page's access logs can never contain a family's project URL or key.
  //
  //   https://get.roamkeep.app/s#v=1&u=<b64url(url)>&k=<anonKey>&c=<code>
  //
  // Also accepts the custom scheme (com.roamkeep.app://s#...) and a bare
  // fragment pasted on its own.
  function parseSetupLink(text) {
    if (!text) return null;
    const s = String(text).trim();
    const hash = s.indexOf('#');
    const frag = hash >= 0 ? s.slice(hash + 1) : s;
    let p;
    try { p = new URLSearchParams(frag); } catch (_) { return null; }
    const u = p.get('u'), k = p.get('k');
    if (!u || !k) return null;
    let url;
    try {
      // base64url → the project URL. Tolerate a plain URL too, so a
      // hand-written link is not a silent failure.
      url = /^https?:\/\//i.test(u) ? u : atob(u.replace(/-/g, '+').replace(/_/g, '/'));
    } catch (_) { return null; }
    if (!/^https:\/\/[^\s]+$/i.test(url)) return null;
    return { url: url.replace(/\/+$/, ''), anonKey: k.trim(), code: p.get('c') || null };
  }

  // Inverse of parseSetupLink — used by the invite share sheet.
  function buildSetupLink(code) {
    const u = btoa(SB_URL).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const parts = ['v=1', 'u=' + u, 'k=' + encodeURIComponent(SB_KEY)];
    if (code) parts.push('c=' + encodeURIComponent(code));
    return SETUP_LINK_BASE + '#' + parts.join('&');
  }

  // ── DOM HELPERS ────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);

  function show(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('on'));
    $(id)?.classList.add('on');
  }

  function setMsg(t) {
    const e = $('load-msg');
    if (e) e.textContent = t;
  }

  function fatal(msg) {
    const e = $('err-msg');
    if (e) e.textContent = msg;
    show('s-err');
  }

  function setErr(id, msg) {
    const e = $(id);
    if (!e) return;
    e.textContent = msg || '';
    e.style.display = msg ? 'block' : 'none';
    // Reset any success styling from prior signups
    if (msg) {
      e.style.background = '';
      e.style.color = '';
      e.style.borderLeftColor = '';
    }
  }

  function btnLoad(id, on, lbl) {
    const b = $(id);
    if (!b) return;
    b.disabled = on;
    b.textContent = on ? '⏳ Please wait…' : lbl;
  }

  function toast(msg, type) {
    const c = $('toasts');
    if (!c) return;
    const t = document.createElement('div');
    t.className = 'toast' + (type ? ' ' + type : '');
    t.textContent = msg;
    c.appendChild(t);
    setTimeout(() => {
      t.style.opacity = '0';
      t.style.transition = 'opacity .35s';
      setTimeout(() => t.remove(), 350);
    }, 4000);
  }

  function timeAgo(iso) {
    if (!iso) return '';
    const d = Math.floor((Date.now() - new Date(iso)) / 1000);
    if (d < 10) return 'Just now';
    if (d < 60) return d + 's ago';
    if (d < 3600) return Math.floor(d / 60) + 'm ago';
    if (d < 86400) return Math.floor(d / 3600) + 'h ago';
    return Math.floor(d / 86400) + 'd ago';
  }

  // Activity-feed timestamps. Relative while fresh (the first hour, when
  // "12m ago" is the most useful read), then an absolute clock time once
  // "Nh ago" stops helping you reconstruct *when* something happened —
  // which was the whole complaint with the old relative-only stamps.
  // Time/date go through the device locale so 12h/24h matches the phone.
  function formatActivityTime(iso) {
    if (!iso) return '';
    const then = new Date(iso);
    if (isNaN(then)) return '';
    const diffS = Math.floor((Date.now() - then) / 1000);
    if (diffS < 10) return 'Just now';
    if (diffS < 3600) return Math.max(1, Math.floor(diffS / 60)) + 'm ago';

    const time = then.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfYesterday = new Date(startOfToday); startOfYesterday.setDate(startOfToday.getDate() - 1);

    if (then >= startOfToday) return 'Today ' + time;
    if (then >= startOfYesterday) return 'Yesterday ' + time;

    const sameYear = then.getFullYear() === now.getFullYear();
    const date = then.toLocaleDateString([], sameYear
      ? { day: 'numeric', month: 'short' }
      : { day: 'numeric', month: 'short', year: 'numeric' });
    return date + ' ' + time;
  }

  // Safe DOM builder — text values go through textContent, not innerHTML.
  // 'style' is applied via CSSOM (style.cssText) so a strict
  // style-src CSP without 'unsafe-inline' still works.
  function el(tag, attrs, children) {
    const n = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        const v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'class') n.className = v;
        else if (k === 'text') n.textContent = v;
        else if (k === 'html') n.innerHTML = v;
        else if (k === 'dataset') for (const dk in v) n.dataset[dk] = v[dk];
        else if (k === 'style') n.style.cssText = v;
        else n.setAttribute(k, v === true ? '' : v);
      }
    }
    if (children) {
      for (const c of [].concat(children)) {
        if (c == null || c === false) continue;
        n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      }
    }
    return n;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  // ── LUCIDE ICONS ───────────────────────────────────────────────
  // Inline SVG paths vendored from lucide.dev (MIT). We keep them
  // as strings so there's no runtime fetch and no build step; the
  // wrapper below renders one at a given pixel size using
  // currentColor, so consumers tint via regular CSS color.
  const LUCIDE = {
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    'map-pin': '<path d="M20 10c0 7-8 13-8 13s-8-6-8-13a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/>',
    plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
    activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
    'alert-triangle': '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    'zoom-in': '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/><path d="M11 8v6"/><path d="M8 11h6"/>',
    'zoom-out': '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/><path d="M8 11h6"/>',
    'locate-fixed': '<path d="M2 12h3"/><path d="M19 12h3"/><path d="M12 2v3"/><path d="M12 19v3"/><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="3"/>',
    pencil: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
    'trash-2': '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M10 11v6"/><path d="M14 11v6"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    share: '<path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/>',
    'log-out': '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
    'settings': '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.2.61.75 1.03 1.4 1.03H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
    history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
    qr: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3z"/><path d="M21 14v3"/><path d="M14 21h3"/><path d="M21 21h.01"/>',
    save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>'
  };

  function iconSvg(name, size) {
    const body = LUCIDE[name];
    if (!body) return '';
    const s = size || 20;
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + s + '" height="' + s +
           '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
           'stroke-linecap="round" stroke-linejoin="round">' + body + '</svg>';
  }

  // Walk every .ic[data-icon] in the DOM and fill it with its SVG.
  // Called once on boot plus after any dynamic markup (e.g. nav
  // rebuild). Safe to call repeatedly — no-ops if already filled.
  function renderStaticIcons(root) {
    const host = root || document;
    host.querySelectorAll('.ic[data-icon]').forEach(n => {
      if (n.firstElementChild && n.firstElementChild.tagName === 'svg') return;
      const name = n.dataset.icon;
      const sz = n.dataset.iconSize ? Number(n.dataset.iconSize) : undefined;
      n.innerHTML = iconSvg(name, sz);
    });
  }

  function mapRpcError(error) {
    const code = (error && (error.message || '')).toString();
    // Join oracle: the server collapses {bad format, not found, expired}
    // into one opaque 'invalid_code', so the copy stays deliberately vague.
    if (code.includes('too_many_attempts')) return 'Too many tries. Wait an hour and try again, or ask your family for a fresh code.';
    if (code.includes('invalid_code') || code.includes('keep_not_found')) return 'That code didn’t work. Ask your family for the current code — codes expire and get refreshed.';
    if (code.includes('invalid_family_name')) return 'Please enter a family name.';
    if (code.includes('invalid_display_name')) return 'Please enter your display name.';
    if (code.includes('invalid_avatar')) return 'Please choose an avatar.';
    if (code.includes('not_authenticated')) return 'Please sign in again.';
    if (code.includes('not_owner')) return 'Only an owner can do that.';
    if (code.includes('not_authorized')) return 'You can only edit your own profile — ask an owner.';
    if (code.includes('member_not_found')) return 'That member is no longer in the Keep.';
    if (code.includes('not_adult')) return 'Only an adult can do that.';
    if (code.includes('last_owner')) return 'A Keep needs at least one owner. Make someone else an owner first.';
    if (code.includes('owner_must_be_adult')) return 'An owner must be an adult. Remove their owner role first.';
    if (code.includes('child_cannot_pause')) return 'Children can’t pause their own location.';
    if (code.includes('cannot_remove_self')) return 'You can’t remove yourself here — use Leave this Keep in Settings.';
    if (code.includes('child_cannot_leave')) return 'Children can’t leave a Keep on their own — ask an adult in your family.';
    if (code.includes('invalid_pause')) return 'Pick a pause length up to 24 hours.';
    if (code.includes('protected_column')) return 'That change has to go through the family controls.';
    return error?.message || 'Something went wrong.';
  }

  // ── ROLE / TYPE / PAUSE HELPERS ────────────────────────────────
  // Two orthogonal axes on a member: role (owner|member) is admin power;
  // member_type (adult|child) is life-stage / tracking policy. paused_until
  // is an adult's time-boxed self-pause (NULL = active).
  function myMember() { return S.members.find(m => m.id === S.myId) || null; }
  function isPausedRow(m) {
    return !!(m && m.paused_until && new Date(m.paused_until).getTime() > Date.now());
  }
  // Owner drives the family-management UI; default false when a row hasn't
  // loaded yet so admin buttons don't flash in before we know the role.
  function amOwner() { const me = myMember(); return !!me && me.role === 'owner'; }

  function pauseClock(iso) {
    try { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
    catch (_) { return ''; }
  }

  // ── TABS / SCREEN SWITCHERS ────────────────────────────────────
  function authTab(t) {
    document.querySelectorAll('#s-auth .tab').forEach((b, i) => {
      b.classList.toggle('on', (t === 'in' && i === 0) || (t === 'up' && i === 1));
    });
    $('tp-in').classList.toggle('on', t === 'in');
    $('tp-up').classList.toggle('on', t === 'up');
    setErr('auth-err', '');
  }

  function keepTab(t) {
    document.querySelectorAll('#s-keep .tab').forEach((b, i) => {
      b.classList.toggle('on', (t === 'cr' && i === 0) || (t === 'jo' && i === 1));
    });
    $('tp-cr').classList.toggle('on', t === 'cr');
    $('tp-jo').classList.toggle('on', t === 'jo');
    setErr('keep-err', '');
  }

  function sTab(id, btn) {
    document.querySelectorAll('.stab').forEach(t => t.classList.remove('on'));
    if (btn) btn.classList.add('on');
    // Keep the bottom nav in step with the drawer tab. Switching tabs inside
    // the open drawer goes through a .stab tap (this fn) without touching the
    // bnav, which left the two strips highlighting different tabs. mobNav()
    // also routes through here, so both entry points stay in sync.
    document.querySelectorAll('.bnav-btn').forEach(b => b.classList.remove('on'));
    document.querySelector('.bnav-btn[data-nav="' + id + '"]')?.classList.add('on');
    document.querySelectorAll('.sp').forEach(p => p.classList.remove('on'));
    $('sp-' + id)?.classList.add('on');
    // The timeline renders lazily — its queries only run when looked at.
    if (id === 'timeline') initTimeline();
  }

  function mobNav(id, btn) {
    const sb = $('sidebar');
    const wasActive = btn && btn.classList.contains('on') && sb.classList.contains('mob');
    if (wasActive) {
      closeDrawer();
      return;
    }
    document.querySelectorAll('.bnav-btn').forEach(b => b.classList.remove('on'));
    if (btn) btn.classList.add('on');
    sb.classList.add('mob');
    // Look up the matching sidebar tab by data-tab so that adding or
    // reordering bnav/stab buttons doesn't desync the two strips.
    const stab = document.querySelector('.stab[data-tab="' + id + '"]');
    if (stab) sTab(id, stab);
  }

  function closeDrawer() {
    $('sidebar').classList.remove('mob');
    document.querySelectorAll('.bnav-btn').forEach(b => b.classList.remove('on'));
  }

  // ── AUTH ───────────────────────────────────────────────────────
  async function signIn() {
    const email = $('si-e').value.trim();
    const pass = $('si-p').value;
    if (!email || !pass) { setErr('auth-err', 'Please enter email and password.'); return; }
    btnLoad('si-btn', true, 'Sign In →');
    setErr('auth-err', '');
    const { error } = await S.sb.auth.signInWithPassword({ email, password: pass });
    if (error) {
      setErr('auth-err', error.message);
      btnLoad('si-btn', false, 'Sign In →');
    }
  }

  async function signUp() {
    const email = $('su-e').value.trim();
    const pass = $('su-p').value;
    if (!email) { setErr('auth-err', 'Please enter an email.'); return; }
    if (pass.length < 6) { setErr('auth-err', 'Password must be at least 6 characters.'); return; }
    btnLoad('su-btn', true, 'Create Account →');
    setErr('auth-err', '');
    const { data, error } = await S.sb.auth.signUp({ email, password: pass });
    if (error) {
      // A family that has finished onboarding can turn sign-ups off on their
      // own project, which is the strongest answer to "anyone with the setup
      // link can reach our sign-up screen". Supabase's own wording for that
      // is "Signups not allowed for this instance", which reads like a fault.
      // It isn't one — somebody closed a door on purpose — so say that, and
      // point at the person who can open it.
      setErr('auth-err', /signups? not allowed/i.test(error.message || '')
        ? 'This family server isn’t accepting new accounts right now. Ask '
          + 'whoever set up your Keep to turn sign-ups on while you join.'
        : error.message);
      btnLoad('su-btn', false, 'Create Account →');
      return;
    }
    if (data?.session) {
      S.user = data.user;
      initAvPickers();
      show('s-keep'); applyPendingJoinCode();
    } else {
      btnLoad('su-btn', false, 'Create Account →');
      const e = $('auth-err');
      if (e) {
        e.textContent = '📧 Check your email for a confirmation link, then sign in.';
        e.style.display = 'block';
        e.style.background = '#edf7f0';
        e.style.color = 'var(--moss)';
        e.style.borderLeftColor = 'var(--moss)';
      }
    }
  }

  async function signOut() {
    // The sign-out control sits in the header next to routine actions and is
    // easy to hit by mistake; confirm before tearing down the session.
    if (!confirm('Sign out of Roamkeep?\n\nYou can sign back in with your email and password.')) return;
    if (S.channel) S.sb.removeChannel(S.channel);
    if (S.myId) {
      // Clear the FCM token alongside the offline flag so the
      // notify-checkin edge function stops fanning out to a device
      // that's no longer logged in. (It would otherwise still receive
      // pushes addressed to the previous user until FCM rotated the
      // token — annoying, and a privacy leak.)
      try {
        await S.sb.from('keep_members')
          .update({ online: false })
          .eq('id', S.myId);
        // The token moved out of keep_members in v14 — that row is readable
        // across the whole keep, and a push token is nobody else's business.
        await S.sb.from('keep_member_push')
          .update({ fcm_token: null, updated_at: new Date().toISOString() })
          .eq('member_id', S.myId);
      } catch (_) {}
    }
    // Stop the OS from firing geofence transitions or location updates
    // into whatever the previous session's auth was — otherwise the
    // receivers could post against a stale member id.
    const NG = nativeGeo();
    if (NG) {
      try { await NG.clearAll(); } catch (_) {}
      try { await NG.stopLocationUpdates(); } catch (_) {}
    }
    S._nativeGeoReady = false;
    S._nativeLocReady = false;
    Object.assign(S, {
      user: null, keepId: null, myId: null,
      members: [], checkins: [], sosActive: false,
      channel: null,
      tlMemberId: null, tlDayOffset: 0, tlTrips: []
    });
    await S.sb.auth.signOut();
  }

  // ── AVATAR PICKER ──────────────────────────────────────────────
  function initAvPickers() {
    for (const id of ['cr-avs', 'jo-avs']) {
      const host = $(id);
      if (!host) continue;
      clear(host);
      AVATARS.forEach((a, i) => {
        host.appendChild(el('div', {
          class: 'av' + (i === 0 ? ' on' : ''),
          dataset: { action: 'pick-avatar', avatar: a },
          text: a
        }));
      });
    }
  }

  function pickAv(node, av) {
    node.closest('.av-row')?.querySelectorAll('.av').forEach(e => e.classList.remove('on'));
    node.classList.add('on');
    S.selAv = av;
  }

  // ── KEEP (via SECURITY DEFINER RPCs) ───────────────────────────
  async function createKeep() {
    const name = $('cr-name').value.trim();
    const fam = $('cr-fam').value.trim();
    if (!name) { setErr('keep-err', 'Please enter your display name.'); return; }
    if (!fam) { setErr('keep-err', 'Please enter a family name.'); return; }
    btnLoad('cr-btn', true, '🏰 Create Our Keep');
    setErr('keep-err', '');
    try {
      const { data, error } = await S.sb.rpc('create_keep', {
        p_family_name: fam,
        p_display_name: name,
        p_avatar: S.selAv
      });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      if (!row) throw new Error('create_failed');
      S.keepId = row.keep_id;
      S.keepCode = row.keep_code;
      S.keepName = row.keep_name;
      S.myId = row.member_id;
      await launchApp();
      toast('🏰 Keep created! Share code: ' + row.keep_code, 'ok');
    } catch (e) {
      setErr('keep-err', mapRpcError(e));
      btnLoad('cr-btn', false, '🏰 Create Our Keep');
    }
  }

  async function joinKeep() {
    const name = $('jo-name').value.trim();
    const code = $('jo-code').value.trim().toUpperCase();
    if (!name) { setErr('keep-err', 'Please enter your display name.'); return; }
    // Accept both the new 12-char codes and any legacy short code still in
    // its grace window — the server is the authority on validity.
    if (code.length < 6 || code.length > 16) { setErr('keep-err', 'Please enter your family code.'); return; }
    btnLoad('jo-btn', true, '🏰 Join the Keep');
    setErr('keep-err', '');
    try {
      const { data, error } = await S.sb.rpc('join_keep_by_code', {
        p_code: code,
        p_display_name: name,
        p_avatar: S.selAv
      });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      // join_keep_by_code returns a status instead of raising for the
      // invalid_code / too_many_attempts cases (so the rate-limit log
      // survives). Anything but 'ok' is a failure — map it to friendly copy.
      if (!row || row.status !== 'ok') throw new Error(row?.status || 'join_failed');
      S.keepId = row.keep_id;
      S.keepCode = row.keep_code;
      S.keepName = row.keep_name;
      S.myId = row.member_id;
      await launchApp();
      toast('🏰 Joined ' + row.keep_name + '!', 'ok');
    } catch (e) {
      setErr('keep-err', mapRpcError(e));
      btnLoad('jo-btn', false, '🏰 Join the Keep');
    }
  }

  // ── NATIVE GEOFENCE (Android) ──────────────────────────────────
  // The native plugin registers geofences with Google Play Services,
  // whose BroadcastReceiver fires ENTER/EXIT even when our process is
  // dead. This is the only path that's actually reliable on Android
  // — the WebView JS engine is paused in the background regardless of
  // battery settings, so the JS-side checkGeofenceTransitions() can't
  // see transitions until the user reopens the app.
  //
  // All four helpers are no-ops on web and iOS (plugin is Android-only).
  function nativeGeo() {
    return window.Capacitor?.Plugins?.NativeGeofence || null;
  }

  // Pushes Supabase context (URL, keys, tokens, member identity) into
  // SharedPreferences so the native receiver can POST check-ins on its
  // own, then seeds the current places list into GeofencingClient.
  // Called from launchApp() once we know user + keep + members.
  // Single-flight + short debounce. launchApp arms once, then a resume or
  // a pause-reconcile can ask again moments later; each full run writes
  // "app: opened + initialized" and "geo: armed N fence(s)" to the black
  // box, so repeats buried the journal.
  //
  // Only a run that actually ARMS updates the timestamp — the paused and
  // unavailable early-returns must not suppress a later real arm (that
  // would leave tracking down after a pause ends).
  let _initGeoInFlight = null;
  let _initGeoArmedMs = 0;
  const INIT_GEO_MIN_GAP_MS = 8000;

  async function initNativeGeofence() {
    if (_initGeoInFlight) return _initGeoInFlight;
    const since = Date.now() - _initGeoArmedMs;
    if (_initGeoArmedMs && since < INIT_GEO_MIN_GAP_MS) {
      console.info('skip initNativeGeofence: armed ' + Math.round(since / 1000) + 's ago');
      return;
    }
    _initGeoInFlight = (async () => {
      const armed = await _initNativeGeofenceImpl();
      if (armed) _initGeoArmedMs = Date.now();
    })();
    try { return await _initGeoInFlight; } finally { _initGeoInFlight = null; }
  }

  // Returns true only when it got as far as registering the fences.
  async function _initNativeGeofenceImpl() {
    const NG = nativeGeo();
    if (!NG) return false;
    // Respect an active self-pause on cold start: don't register geofences
    // or arm location updates while paused. Make sure native is actually
    // stopped (a stale service from before the pause, or a boot re-arm),
    // then let the auto-resume watcher bring it back when the pause ends.
    if (isPausedRow(myMember())) {
      // Persist the pause + tear down tracking without wiping stored
      // context/places (setPaused stops the FGS + unregisters fences).
      if (typeof NG.setPaused === 'function') {
        try { await NG.setPaused({ pausedUntil: String(new Date(myMember().paused_until).getTime()) }); } catch (_) {}
      } else {
        try { await NG.stopLocationUpdates(); } catch (_) {}
      }
      return false;
    }
    try {
      const avail = await NG.isAvailable();
      if (!avail || !avail.available) {
        console.info('NativeGeofence unavailable (Play Services status ' +
          (avail && avail.playServicesStatus) + '); falling back to JS path');
        return false;
      }
      const { data } = await S.sb.auth.getSession();
      const session = data && data.session;
      if (!session) return false;
      const me = S.members.find(m => m.id === S.myId);
      await NG.initialize({
        supabaseUrl: SB_URL,
        anonKey: SB_KEY,
        accessToken: session.access_token,
        refreshToken: session.refresh_token,
        userId: S.user.id,
        keepId: S.keepId,
        memberId: S.myId,
        memberName: (me && me.name) || 'Someone',
        memberAvatar: (me && me.avatar) || '📍',
        // Seed native state with places we currently consider inside.
        // The receiver union-merges this with what it already has, so
        // ENTERs it captured while the app was closed are preserved.
        // Without this, Google Play Services' synthetic EXITs on
        // re-registration (fresh launch) and power-state transitions
        // (charging unplug) would be accepted as real "left <place>"
        // check-ins for places we were never inside this session.
        insidePlaceIds: Array.from(S.insidePlaces || [])
      });
      // GeofencingClient.addGeofences replaces any existing registration
      // with the same requestId, and PrefsStore.putPlace does the same
      // for the metadata — so re-seeding on every launch is safe and
      // also self-healing (picks up places added on other devices).
      // force: this is the authoritative arm for the session, so it must
      // not be swallowed by the throttle.
      await rearmGeofencesFromPlaces('app launch', true);
      S._nativeGeoReady = true;
      // Sweep anything the receiver couldn't deliver last session.
      // Fire-and-forget; success / failure is logged but not awaited.
      flushPendingCheckins();
      // Arm native breadcrumb logging here, on the SAME reliable path
      // that just registered geofences (permission is proven granted —
      // addGeofence requires it). startGPS arms it too; both are
      // idempotent. Doing it here means a device whose foreground GPS
      // watch is slow to start still gets breadcrumbs armed promptly.
      startNativeLocationUpdates();
      return true;
    } catch (e) {
      console.warn('initNativeGeofence failed', e);
      return false;
    }
  }

  async function syncNativeAddPlace(p) {
    const NG = nativeGeo();
    if (!NG || !p) return;
    try {
      await NG.addGeofence({
        id: p.id,
        name: p.name,
        icon: p.icon || '📍',
        lat: p.lat,
        lng: p.lng,
        radius: p.radius_m
      });
      // Caller has already folded p into S.places, so the OS and S.places
      // now agree — record that, or the next resume would re-arm the
      // whole set for a change we just applied one fence at a time.
      _armedSig = placesSignature();
    } catch (e) { console.warn('NG.addGeofence', e); }
  }

  // Arm native breadcrumb logging (FusedLocationProvider → a receiver,
  // process-independent). Called once location permission is granted
  // (from startGPS, after the BG watcher is up). When this succeeds the
  // JS breadcrumb path stands down — native owns the trail so it keeps
  // recording while the WebView is suspended in the background.
  async function startNativeLocationUpdates() {
    const NG = nativeGeo();
    if (!NG || typeof NG.startLocationUpdates !== 'function') return;
    try {
      await NG.startLocationUpdates({ mode: S.trackingMode });
      S._nativeLocReady = true;
    } catch (e) { console.warn('NG.startLocationUpdates', e); }
  }

  async function syncNativeRemovePlace(id) {
    const NG = nativeGeo();
    if (!NG || !id) return;
    try {
      await NG.removeGeofence({ id });
      _armedSig = placesSignature();
    } catch (e) { console.warn('NG.removeGeofence', e); }
  }

  // Drain any check-ins the native receiver couldn't POST earlier
  // (transient network at the moment of crossing). The plugin runs the
  // retry on a worker thread; we kick it off and forget. Toast on
  // success only when there were enough rows to be visible — a
  // single recovered crossing already shows up in the activity feed
  // via the receiver's INSERT, so we don't double-narrate.
  async function flushPendingCheckins() {
    const NG = nativeGeo();
    if (!NG || typeof NG.flushPending !== 'function') return;
    try {
      const res = await NG.flushPending();
      if (res && res.drained > 0) {
        console.info('drained ' + res.drained + ' pending checkin(s); ' +
          (res.remaining || 0) + ' still pending');
      }
    } catch (e) { console.warn('NG.flushPending', e); }
  }

  // Supabase JWTs expire (default ~1 hour). When supabase-js refreshes,
  // we mirror the new pair into SharedPreferences so the next ENTER/EXIT
  // the receiver handles while the app is dead uses a valid token.
  async function pushNativeTokens() {
    const NG = nativeGeo();
    if (!NG) return;
    try {
      const { data } = await S.sb.auth.getSession();
      const session = data && data.session;
      if (!session) return;
      await NG.setTokens({
        accessToken: session.access_token,
        refreshToken: session.refresh_token
      });
    } catch (e) { console.warn('NG.setTokens', e); }
  }

  // ── PUSH NOTIFICATIONS (Android, via FCM) ──────────────────────
  //
  // On the native shell we register with Firebase Cloud Messaging and
  // persist the per-device token onto our keep_members row. The
  // server side (a Supabase Edge Function `notify-checkin`, triggered
  // by a Database Webhook on `checkins` INSERT) reads tokens for all
  // *other* members in the same keep with notify_on_checkin = true and
  // sends an "Alice arrived at Home" notification via FCM HTTP v1.
  //
  // On the PWA / web path window.Capacitor.Plugins.PushNotifications is
  // undefined and we silently skip — service-worker push is a separate
  // (and lower-priority) road we'll pave later if/when it matters.
  function pushPlugin() {
    return window.Capacitor?.Plugins?.PushNotifications || null;
  }

  // fromSetupSheet: the user tapped Allow on the sheet's Notifications row,
  // which is the affirmative action the gate exists to wait for.
  async function initPushNotifications(fromSetupSheet) {
    const Push = pushPlugin();
    if (!Push) return;
    // See _disclosurePending. requestPermissions() below raises the Android
    // 13+ POST_NOTIFICATIONS dialog, and launchApp fires this un-awaited —
    // so on a first run it landed on top of the disclosure sheet.
    if (_disclosurePending && !fromSetupSheet) return;
    try {
      // Android 13+ surfaces a runtime POST_NOTIFICATIONS prompt;
      // pre-13 it's auto-granted from the manifest declaration.
      const perm = await Push.requestPermissions();
      if (perm && perm.receive !== 'granted') {
        console.info('Push permission not granted: ' + perm.receive);
        return;
      }

      // Register the dedicated SOS notification channel (Android O+) so the
      // notify-checkin function's type='sos' push lands as a loud, max-
      // importance heads-up with sound + vibration, distinct from the
      // quieter arrived/left channel. Importance 5 = HIGH (heads-up);
      // visibility 1 = PUBLIC (shows on the lockscreen). Idempotent — the
      // OS updates the existing channel rather than duplicating it.
      if (typeof Push.createChannel === 'function') {
        try {
          await Push.createChannel({
            id: 'roamkeep_sos',
            name: 'SOS alerts',
            description: 'Emergency SOS alerts from your family.',
            importance: 5,
            visibility: 1,
            // No `sound` → the channel uses the default system notification
            // sound. (A `sound` value must name a res/raw file; a bogus one
            // would leave the channel silent.)
            vibration: true,
            lights: true
          });
        } catch (e) { console.warn('createChannel roamkeep_sos', e); }

        // Arrived/left alerts. The edge function has always sent these on
        // channel `<brand>_places`, but nothing ever created it — so
        // Android had no such channel and the Firebase SDK quietly
        // delivered them on its own `fcm_fallback_notification_channel`,
        // which shows up as "Miscellaneous" in notification settings and
        // can't be tuned separately from anything else. Creating it puts
        // place alerts under their own name at DEFAULT importance (3:
        // notifies without a heads-up banner, deliberately quieter than
        // SOS above).
        try {
          await Push.createChannel({
            id: 'roamkeep_places',
            name: 'Place alerts',
            description: 'When family arrive at or leave a saved place.',
            importance: 3,
            visibility: 1,
            vibration: true
          });
        } catch (e) { console.warn('createChannel roamkeep_places', e); }
      }

      // Listeners must be added BEFORE register() — the registration
      // event fires synchronously on the native side once FCM hands us
      // a token, and we don't want to miss it on a cold start.
      Push.addListener('registration', async (token) => {
        if (!token || !token.value || !S.myId || !S.keepId) return;
        try {
          // keep_member_push, not keep_members: that row is readable across
          // the whole keep and RLS cannot restrict columns, so a token there
          // was a token every relative could read. Upsert because the row
          // may not exist yet on a first run.
          await S.sb.from('keep_member_push')
            .upsert({
              member_id: S.myId,
              keep_id: S.keepId,
              fcm_token: token.value,
              updated_at: new Date().toISOString()
            }, { onConflict: 'member_id' });
        } catch (e) {
          console.warn('persist fcm_token failed', e);
        }
      });

      Push.addListener('registrationError', (err) => {
        console.warn('FCM registration error', err);
      });

      // Foreground delivery. The realtime channel already shows a toast
      // for the underlying check-in (see subscribeRT), so we don't add
      // a second in-app toast here. The OS still drops the notification
      // banner per capacitor.config.ts presentationOptions.
      Push.addListener('pushNotificationReceived', (n) => {
        console.info('push received (fg)', n?.title || n?.notification?.title);
      });

      // Tap-from-tray (cold start or backgrounded). data.member_id is
      // the actor we want to focus on the map.
      Push.addListener('pushNotificationActionPerformed', (a) => {
        const data = a?.notification?.data || {};
        if (data.member_id) focusMember(data.member_id);
      });

      await Push.register();
    } catch (e) {
      console.warn('initPushNotifications failed', e);
    }
  }

  // ── LAUNCH ─────────────────────────────────────────────────────
  /**
   * Clear the "Disconnected this device" marker once the member is back.
   *
   * The status lives on the MEMBER row, not on a device, so the honest
   * moment to retract it is when any of that member's devices opens the
   * app — that device is the evidence. Restores the column default rather
   * than an empty string, so a retracted marker is indistinguishable from
   * a row that never carried one.
   *
   * Filtered on the old value as well as the id, so a status that changed
   * underneath us — an SOS raised from another device between the read and
   * the write — is never clobbered by this.
   */
  async function clearDisconnectedStatus() {
    const me = myMember();
    if (!me || me.status !== STATUS_DISCONNECTED) return;
    try {
      const { error } = await S.sb.from('keep_members')
        .update({ status: STATUS_DEFAULT, online: true })
        .eq('id', S.myId)
        .eq('status', STATUS_DISCONNECTED);
      if (error) return;               // leave good state alone on failure
      me.status = STATUS_DEFAULT;
      me.online = true;
      renderMembers();
    } catch (_) { /* best-effort, exactly like the write that set it */ }
  }

  async function launchApp() {
    show('s-app');
    // Don't passively show the join code in the header anymore — it's now
    // only revealed (and rotatable) inside the owner-only Invite modal.
    $('hdr-sub').textContent = S.keepName;
    // Show which server this device is bound to — with one app talking to
    // many backends, "which one am I on?" is a real question — but the
    // answer now lives in the cog sheet, which fills it in when opened.
    // Setting it here too would be two places to keep in step for a value
    // nobody can see until the sheet is up.
    // Sequential, not Promise.all: loadPlaces seeds insidePlaces from the
    // caller's own member row, so it needs loadMembers to have landed.
    await loadTwice(loadMembers);
    // Retract the disconnect marker now this device is demonstrably back.
    // Nothing used to clear it, so a reconnected member sat at
    // "Disconnected this device" forever — and because the member list
    // shows a PAUSED member's computed status ahead of the stored one,
    // pausing appeared to fix it and resuming brought it straight back.
    await clearDisconnectedStatus();
    await loadTwice(loadCheckins);
    await loadTwice(loadPlaces);
    // After loadMembers (needs S.myId) and loadPlaces (the sheet lists
    // places). Failure leaves the last known set alone and simply means
    // nothing is muted this session — the server-side filters still hold,
    // so the worst case is a toast that should have been suppressed.
    await loadNotifyPrefs();
    warnIfEmpty();
    initMap();
    subscribeRT();
    pruneOwnHistory();   // trim our own breadcrumbs older than 24h
    // Ask for location permission BEFORE arming geofences. addGeofence
    // rejects outright without it, and syncNativeAddPlace swallows the
    // rejection — so on a first run (where the prompt used to come later,
    // in startGPS) every place failed to register and the device never
    // fired a check-in until the app was opened a second time.
    //
    // But on a device that has never granted it, the disclosure has to
    // come first. Play's Prominent Disclosure rule is not only "explain
    // background collection" — the explanation must precede the runtime
    // request and the request must follow an affirmative tap, not fire on
    // its own. Calling ensureLocationPermission() here put the system
    // dialog on screen ~1.2s before the sheet that explains it, which is
    // the exact ordering reviewers reject on.
    //
    // So: no permission yet → open the setup sheet and let the user's tap
    // on "Allow" issue the request (setupFixLocation, which also re-arms
    // afterwards — the repair path this leans on already existed).
    // Already granted → nothing changes, launch is exactly as before.
    //
    // initNativeGeofence still runs either way: it writes the native
    // context that the headless receivers need, and arms nothing until
    // permission exists, which is the state setupFixLocation repairs.
    // Only when the status actually came back AND said the permission is
    // missing. `!(await setupStatus())?.fineLocation` was wrong: setupStatus
    // returns null whenever the plugin is not ready yet, and `null?.x` is
    // undefined, so a FAILED CHECK was indistinguishable from NO PERMISSION
    // — popping the disclosure sheet on a fully granted device and gating
    // its permission requests for the rest of the session.
    const _st0 = isNative() ? await setupStatus() : null;
    if (_st0 && !_st0.fineLocation) {
      _disclosurePending = true;
      await openSetup();
    } else {
      await ensureLocationPermission();
    }

    // Initialise the native geofence plugin *before* starting the BG
    // location watcher. Otherwise the first few GPS fixes (which the
    // BG plugin emits with wide accuracy) can race in before
    // S._nativeGeoReady flips, and the JS-path checkGeofenceTransitions
    // writes spurious arrived/left check-ins for every overlapping
    // place at the user's home location. Native plugin takes tens of
    // ms; it's well worth the wait to keep the DB clean.
    await initNativeGeofence();
    // Push registration is independent of geofence wiring; we kick it
    // off without awaiting because the FCM token can take a beat to
    // arrive (network round-trip), and we don't want to block startGPS.
    initPushNotifications();
    // Load the saved tracking mode before starting GPS so the first
    // watcher is armed with the right distanceFilter.
    await loadTrackingMode();
    startGPS();

    // Seed the background-permission watermark so reconcileSetup can spot
    // the transition to granted, then surface the setup sheet if anything
    // required is still missing. Deferred a beat so the permission prompt
    // startGPS() raises has resolved first — otherwise we'd render the
    // checklist against a stale answer.
    setTimeout(async () => {
      const st = await setupStatus();
      _hadBackgroundLocation = st ? !!st.backgroundLocation : null;
      if (await setupIncomplete()) openSetup();
    }, 1200);
    trackBattery();
    // If we launched into an active self-pause, make sure native is torn
    // down and the auto-resume timer is armed. No-op when not paused.
    reconcileMyPause();
    setInterval(renderMembers, 60000);
    // Keep the activity feed's relative stamps ("12m ago") ticking
    // while they're still in the relative window; once they cross the
    // 1h mark formatActivityTime switches to a static absolute time.
    setInterval(renderCheckins, 60000);
    // Re-evaluate the Live/Stale header badge every 30 s. The badge
    // also updates immediately on every pushLocation, but a periodic
    // tick is what catches the transition Live → Stale during long
    // backgrounded stretches.
    setInterval(refreshLiveBadge, 30000);
    refreshLiveBadge();

    // Android WebView suspends the realtime WebSocket when the app is
    // backgrounded, and Supabase realtime doesn't replay missed events.
    // Refetch members/checkins/places on resume so the UI catches up
    // with anything the native plugin (or other family members) posted
    // while we were backgrounded. Also force a fresh GPS fix so the
    // PWA / no-native-plugin path's checkGeofenceTransitions re-runs
    // against the current coords.
    if (!S._resumeBound) {
      S._resumeBound = true;
      bindResumeHandler();
    }
  }

  // Foregrounding on Android fires BOTH Capacitor's appStateChange and
  // the WebView's visibilitychange, so bindResumeHandler's two listeners
  // both call this, back to back, on every single resume. That was
  // survivable while everything here was either idempotent or covered by
  // ARM_THROTTLE_MS — but the re-arm below deliberately passes force,
  // and neither caller has recorded a new _armedSig yet when the other
  // runs its comparison, so both arm. Two "geo: armed N fence(s)" lines
  // one second apart, and two rounds of synthetic Play Services
  // transitions to go with them.
  //
  // Collapse them into one run. This also halves the resume refetch and
  // drops a duplicate high-accuracy GPS fix that has been happening on
  // every resume since the handler was written.
  let _onResumeInFlight = null;

  function onResume() {
    if (_onResumeInFlight) return _onResumeInFlight;
    _onResumeInFlight = _onResumeImpl().finally(() => { _onResumeInFlight = null; });
    return _onResumeInFlight;
  }

  // Refetch state from Supabase and force a fresh GPS fix so that
  // geofence transitions missed during background suspension fire as
  // soon as the user returns to the app.
  async function _onResumeImpl() {
    if (!S.keepId) return;

    // Settings changes made outside the app (notably "Allow all the
    // time", which from API 30 can only be granted in Settings) come back
    // to us here or nowhere. This also re-arms geofences that were
    // registered while background permission was missing — without it
    // they stay inert until a reboot.
    reconcileSetup();

    // Stale-watcher detection. If pushLocation hasn't run in > 3 min
    // the BG-geolocation foreground service is almost certainly dead
    // (doze, OEM battery saver, or it just got OOM-killed during a
    // long car trip). Re-add the watcher, reconnect realtime, flush
    // the tile cache — together that's what "force quit and reopen"
    // does, but transparently. Without this, the app on resume shows
    // a white map at the old viewport because tiles are keyed off
    // stale coords and nothing is pushing fresh ones.
    const STALE_MS = 3 * 60 * 1000;
    const stale = !S.lastFixMs || (Date.now() - S.lastFixMs > STALE_MS);
    if (stale && isNative()) {
      // Realtime channel: the WebSocket dies during long background
      // stretches and supabase-js doesn't auto-reconnect. Resubscribe.
      if (S.channel) {
        try { S.sb.removeChannel(S.channel); } catch (_) {}
        S.channel = null;
        subscribeRT();
      }
      // Drop the tile cache. Not because the tiles are wrong — they are
      // keyed zoom/x/y, so they never are — but because the viewport may
      // have moved hundreds of km and none of them will be wanted again.
      S.tiles = {};
      // Restart the watcher (fire-and-forget; the new watcher will
      // push a fresh fix via pushLocation, which clears the stale
      // badge and re-centers the map).
      restartGPS();
    }

    // Self-heal native breadcrumb logging: if it never armed at launch,
    // arming it here on resume (which also (re)starts the foreground
    // service) gets it going. Idempotent. Skipped while self-paused — the
    // native side would refuse anyway, but don't even ask.
    if (isNative() && !S._nativeLocReady && !isPausedRow(myMember())) startNativeLocationUpdates();
    // Reconcile pause with native each resume (covers a pause that elapsed
    // while backgrounded, or a resume triggered on another device).
    reconcileMyPause();

    try {
      // Same ordering constraint as launch — loadPlaces reads S.members.
      // Promise.all raced them, so on resume insidePlaces could be seeded
      // from a member row that had not arrived yet.
      await loadTwice(loadMembers);
      await Promise.all([loadTwice(loadCheckins), loadTwice(loadPlaces)]);
      // Realtime is dropped while backgrounded, so a preference changed
      // on this person's other device only arrives via this refetch.
      await loadNotifyPrefs();
      warnIfEmpty();
    } catch (e) { console.warn('resume refetch', e); }

    // Re-arm if the place set moved while we were backgrounded.
    //
    // A place added on ANOTHER device reaches us two ways: the keep_places
    // realtime event (which arms it immediately), or the loadPlaces above.
    // But Android's WebView suspends the realtime WebSocket while the app
    // is backgrounded and Supabase does not replay missed events — so for
    // the common case (someone else adds a place while your app is not in
    // the foreground) only the refetch ever sees it. That path updated
    // S.places, the map and the Places list but never told the OS, so the
    // place looked present on the device while no fence existed for it:
    // breadcrumbs kept recording straight through it and no arrived/left
    // ever fired. The journal's tell is a "geo: armed N fence(s)" line
    // that never reappears after launch.
    //
    // Only on an actual difference. Re-registering identical fences makes
    // Play Services emit synthetic transitions, which is the thing
    // insidePlaceIds exists to paper over — don't manufacture more of it.
    // _armedSig === null means we have never armed — which includes the
    // device that had no places at all at launch, so the FIRST place the
    // family ever creates has to arm from here too.
    if (isNative() && (S.places || []).length && !isPausedRow(myMember())) {
      if (placesSignature() !== _armedSig) {
        await rearmGeofencesFromPlaces('places changed while backgrounded', true);
      }
    }
    // Drain any check-ins the receiver couldn't deliver while the app
    // was backgrounded (transient network at the moment of crossing).
    // The receiver itself drains on every fire, but if the network
    // recovers between transitions the queue would otherwise wait for
    // the next OS wake — resume is the natural moment to sweep.
    flushPendingCheckins();
    // Try to get a fresh position so checkGeofenceTransitions re-runs
    // with current coords. Uses @capacitor/geolocation in native, web
    // geolocation as fallback. Silent on failure — realtime + refetch
    // still cover the common case.
    // Same implicit-request trap as startGPS: getCurrentPosition raises the
    // system dialog by itself if permission is missing. Skip the whole
    // block, not just the Capacitor branch — falling through to
    // navigator.geolocation would prompt via the WebView instead.
    if (_disclosurePending) return;
    try {
      const Geo = window.Capacitor?.Plugins?.Geolocation;
      if (Geo && typeof Geo.getCurrentPosition === 'function') {
        const pos = await Geo.getCurrentPosition({ enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
        if (pos?.coords) pushLocation(pos.coords.latitude, pos.coords.longitude, pos.timestamp);
      } else if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
          (pos) => pushLocation(pos.coords.latitude, pos.coords.longitude, pos.timestamp),
          () => {},
          { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }
        );
      }
    } catch (_) { /* best-effort */ }
  }

  // Subscribes to both Capacitor's native App.appStateChange (reliable
  // on Android) and the HTML visibilitychange event (PWA path). We keep
  // both so PWA users get the same behaviour.
  function bindResumeHandler() {
    const App = window.Capacitor?.Plugins?.App;
    if (App && typeof App.addListener === 'function') {
      try {
        App.addListener('appStateChange', (state) => {
          if (state && state.isActive) onResume();
        });
      } catch (e) { console.warn('App.addListener failed', e); }
    }
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') onResume();
    });
  }

  // These return true only on a real success, because a failure must not
  // touch S.members / S.checkins.
  //
  // `S.members = data || []` looks harmless and is not: on any error
  // supabase-js returns { data: null, error }, so a single dropped request
  // — the network still coming up as the app is foregrounded is the usual
  // one — replaced the whole family with an empty array. Nothing surfaced
  // it. What the user then saw was worse than an empty list: the
  // keep_members realtime handler pushes an unknown member back into
  // S.members whenever one arrives, so the family repopulated ONE AT A
  // TIME as each device happened to post a live pin. The app showed a
  // believable but wrong subset of the family, and healed itself over
  // minutes, which is exactly the shape of a bug nobody can reproduce.
  // Same defect wiped the activity feed. loadPlaces already got this right.
  async function loadMembers() {
    const { data, error } = await S.sb.from('keep_members').select('*')
      .eq('keep_id', S.keepId).order('created_at');
    if (error) { console.warn('loadMembers', error); return false; }
    S.members = data || [];
    renderMembers();
    return true;
  }

  async function loadCheckins() {
    const { data, error } = await S.sb.from('checkins').select('*')
      .eq('keep_id', S.keepId).order('created_at', { ascending: false }).limit(40);
    if (error) { console.warn('loadCheckins', error); return false; }
    S.checkins = data || [];
    renderCheckins();
    return true;
  }

  // Preserving state covers a resume, where there was something to keep.
  // A cold start has nothing to fall back on, so one transient failure
  // still leaves an empty family list — retry once before giving up.
  // Catches as well as retries. A loader that REJECTS rather than returning
  // false would otherwise propagate out of launchApp, which has no
  // try/catch around these — aborting the launch before initMap,
  // subscribeRT, initNativeGeofence and startGPS, leaving a blank app with
  // no tracking. That is the failure mode most likely when the network is
  // genuinely down, which is exactly what this retry exists for.
  async function loadTwice(fn) {
    try { if (await fn()) return true; } catch (e) { console.warn('load failed', e); }
    await new Promise(r => setTimeout(r, 1500));
    try { return await fn(); } catch (e) { console.warn('load failed on retry', e); return false; }
  }

  // Only complain when there is genuinely nothing to show. On a resume the
  // previous data is still on screen and correct, so a network blip should
  // stay quiet rather than train people to ignore the toast.
  function warnIfEmpty() {
    if (!S.members.length) toast('Could not reach your family server — reopen the app to retry', 'err');
  }

  async function loadPlaces() {
    const { data, error } = await S.sb.from('keep_places').select('*')
      .eq('keep_id', S.keepId).order('created_at');
    if (error) { console.warn('loadPlaces', error); return false; }
    S.places = data || [];
    // Seed insidePlaces from the current member row so reopening
    // the app after being inside a place doesn't re-fire 'arrived'.
    const me = S.members.find(m => m.id === S.myId);
    if (me && me.last_place_id) S.insidePlaces.add(me.last_place_id);
    renderPlaces();
    return true;
  }

  // ── PER-PLACE NOTIFICATION PREFERENCES ─────────────────────────
  //
  // EXCEPTION ROWS ONLY: a row means "don't tell me about this person at
  // this place". No row means notify. So an empty set is exactly the
  // behaviour that existed before the feature, and nothing needs
  // migrating or defaulting.
  //
  // Held as a Set of 'subjectMemberId|placeId' — membership is the only
  // question ever asked of it.
  const prefKey = (subjectId, placeId) => subjectId + '|' + placeId;

  const isMuted = (subjectId, placeId) =>
    !!(S.notifyPrefs && S.notifyPrefs.has(prefKey(subjectId, placeId)));

  async function loadNotifyPrefs() {
    if (!S.myId) return false;
    const { data, error } = await S.sb.from('keep_notify_prefs')
      .select('subject_member_id,place_id')
      .eq('member_id', S.myId);
    // NEVER let a failed read overwrite good state. `= data || []` on a
    // failed request is what once replaced a whole family with an empty
    // list and then refilled it one realtime event at a time, showing a
    // plausible but wrong household that healed itself over minutes.
    // Here the equivalent would be silently un-muting everything.
    if (error) { console.warn('loadNotifyPrefs', error); return false; }
    S.notifyPrefs = new Set((data || []).map(r => prefKey(r.subject_member_id, r.place_id)));
    return true;
  }

  // Should a check-in about `subjectId` at `placeId` reach me at all?
  // Mirrors checkin_recipients() / my_checkin_feed in SQL — this copy
  // exists only for the in-app toast, which never goes near the server.
  function shouldAnnounce(ci) {
    if (!ci || ci.member_id === S.myId) return false;
    if (ci.type === 'sos') return true;              // never muteable
    const me = myMember();
    if (me && me.notify_on_checkin === false) return false;   // global mute
    if (!ci.place_id) return true;                   // manual / pre-v13
    return !isMuted(ci.member_id, ci.place_id);
  }

  // ── REALTIME ───────────────────────────────────────────────────
  function subscribeRT() {
    S.channel = S.sb.channel('keep:' + S.keepId)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'keep_members',
        filter: 'keep_id=eq.' + S.keepId
      }, (p) => {
        const c = p.new;
        if (!c || !c.id) return;
        const i = S.members.findIndex(m => m.id === c.id);
        if (i >= 0) {
          const prev = S.members[i];
          if (!prev.sos && c.sos && c.id !== S.myId) toast('🆘 ' + c.name + ' sent an SOS!', 'bad');
          if (c.battery <= 15 && prev.battery > 15 && c.id !== S.myId)
            toast('🪫 ' + c.name + "'s battery is at " + c.battery + '%');
          const pausedChanged = (prev.paused_until || null) !== (c.paused_until || null);
          S.members[i] = c;
          // If MY pause state changed elsewhere (resumed on another device,
          // or the pause lapsed), bring native tracking back in line.
          if (c.id === S.myId && pausedChanged) reconcileMyPause();
        } else {
          S.members.push(c);
          // Only announce an actual join. The "not in S.members" branch
          // also catches UPDATE events that race ahead of loadMembers()
          // on launch/resume — those would otherwise toast "undefined
          // joined" because the row hadn't been seen yet (and, mid-race,
          // S.myId may not be set, so it wouldn't even be filtered as
          // self). Gate on eventType INSERT + a real name + a known
          // self-id so only genuine new members get a greeting.
          if (p.eventType === 'INSERT' && c.name && S.myId && c.id !== S.myId) {
            toast('👋 ' + c.name + ' joined!', 'ok');
          }
        }
        renderMembers();
        renderPins();
      })
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'checkins',
        filter: 'keep_id=eq.' + S.keepId
      }, (p) => {
        const ci = p.new;
        if (!ci) return;
        S.checkins.unshift(ci);
        renderCheckins();
        // The activity list still shows everything — it is a log. Only
        // the interruption is gated. Before v13 this toast consulted no
        // preference at all, not even the existing global mute, so a
        // member who had turned notifications off still got popped at
        // whenever anyone moved while their app was open.
        if (shouldAnnounce(ci)) {
          toast((ci.type === 'sos' ? '🆘 ' : '📍 ') + ci.member_name + ': ' + ci.place,
                ci.type === 'sos' ? 'bad' : 'ok');
        }
      })
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'keep_places',
        filter: 'keep_id=eq.' + S.keepId
      }, (p) => {
        if (p.eventType === 'DELETE') {
          const gone = p.old && p.old.id;
          S.places = S.places.filter(pl => pl.id !== gone);
          S.insidePlaces.delete(gone);
          // Mirror the delete to the native geofence registry so the
          // OS stops firing transitions for places that were removed
          // (including ones removed on another family member's device).
          if (gone) syncNativeRemovePlace(gone);
        } else {
          const row = p.new;
          if (!row) return;
          const i = S.places.findIndex(pl => pl.id === row.id);
          if (i >= 0) S.places[i] = row;
          else S.places.push(row);
          // INSERT *and* UPDATE go through addGeofence — Google Play
          // Services replaces any existing registration with the same
          // requestId, so an edited radius or moved pin is applied
          // atomically.
          syncNativeAddPlace(row);
        }
        renderPlaces();
        // Member cards say where each person is IN TERMS OF PLACES, so a
        // place added or removed changes what those lines should read —
        // "1.4 km from Home" becomes "At School" the moment School
        // exists. Without this they keep the old wording until something
        // else happens to re-render them.
        renderMembers();
        drawMap();
      })
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'keep_notify_prefs',
        filter: 'keep_id=eq.' + S.keepId
      }, (p) => {
        // RLS means only my own rows reach me, but the filter is on
        // keep_id (that is all the realtime filter can express), so check
        // member_id here too rather than trusting the stream's shape.
        const row = p.eventType === 'DELETE' ? p.old : p.new;
        if (!row || !S.myId || row.member_id !== S.myId) return;
        const k = prefKey(row.subject_member_id, row.place_id);
        if (p.eventType === 'DELETE') S.notifyPrefs.delete(k);
        else S.notifyPrefs.add(k);
        // Only redraws the summary counts; the sheet, if open, re-reads
        // from the same Set.
        renderPlaces();
        if (S.placeNotifyFor) renderPlaceNotifySheet();
      })
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'location_history',
        filter: 'keep_id=eq.' + S.keepId
      }, (p) => {
        // Extend the on-screen trail live as new breadcrumbs land (the
        // native receiver writes them, so the JS path no longer appends
        // directly). Only the member whose trail is shown is relevant.
        const row = p.new;
        if (!row || row.member_id !== S.trailMemberId) return;
        S.trail.push({ lat: row.lat, lng: row.lng, recorded_at: row.recorded_at });
        updateTrailPill();
        drawMap();
      })
      .subscribe((s) => {
        const live = s === 'SUBSCRIBED';
        const dot = $('live-dot');
        if (dot) dot.className = 'live-dot' + (live ? '' : ' dead');
        const lbl = $('live-lbl');
        if (lbl) lbl.textContent = live ? 'Live' : 'Reconnecting…';
      });
  }

  // ── CANVAS TILE MAP ────────────────────────────────────────────
  function ll2px(lat, lng) {
    const wrap = $('map-wrap');
    const W = wrap.clientWidth, H = wrap.clientHeight;
    const n = Math.pow(2, S.mZoom);
    const cx = (S.mLng + 180) / 360 * n * TILE_SIZE;
    const cy = (1 - Math.log(Math.tan(S.mLat * Math.PI / 180) + 1 / Math.cos(S.mLat * Math.PI / 180)) / Math.PI) / 2 * n * TILE_SIZE;
    const px = (lng + 180) / 360 * n * TILE_SIZE;
    const py = (1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * n * TILE_SIZE;
    return { x: W / 2 + (px - cx), y: H / 2 + (py - cy) };
  }

  // Inverse Web Mercator: pixel offset within #map-wrap → {lat, lng}.
  function px2ll(px, py) {
    const wrap = $('map-wrap');
    const W = wrap.clientWidth, H = wrap.clientHeight;
    const n = Math.pow(2, S.mZoom);
    const cx = (S.mLng + 180) / 360 * n * TILE_SIZE;
    const cy = (1 - Math.log(Math.tan(S.mLat * Math.PI / 180) + 1 / Math.cos(S.mLat * Math.PI / 180)) / Math.PI) / 2 * n * TILE_SIZE;
    const wx = cx + (px - W / 2);
    const wy = cy + (py - H / 2);
    const lng = wx / (n * TILE_SIZE) * 360 - 180;
    const t = Math.PI - 2 * Math.PI * wy / (n * TILE_SIZE);
    const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(t) - Math.exp(-t)));
    return { lat, lng };
  }

  function initMap() {
    const canvas = $('map-canvas');
    const wrap = $('map-wrap');
    canvas.width = wrap.clientWidth;
    canvas.height = wrap.clientHeight;
    S.mapCtx = canvas.getContext('2d');

    // Long-press → drop-a-pin to add a place anywhere on the map.
    // 550 ms is short enough to feel responsive, long enough not to
    // collide with the start of a pan gesture. Movement past
    // LONG_PRESS_SLOP_PX cancels — that's a drag, not a press.
    const LONG_PRESS_MS = 550;
    const LONG_PRESS_SLOP_PX = 10;
    let lpTimer = null, lpStart = null;
    function lpCancel() { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } }
    function lpArm(clientX, clientY) {
      lpStart = { x: clientX, y: clientY };
      lpCancel();
      lpTimer = setTimeout(() => {
        const rect = wrap.getBoundingClientRect();
        const ll = px2ll(lpStart.x - rect.left, lpStart.y - rect.top);
        if (navigator.vibrate) { try { navigator.vibrate(15); } catch (_) {} }
        openPlaceEditor(ll.lat, ll.lng);
        lpTimer = null;
      }, LONG_PRESS_MS);
    }
    function lpMaybeCancel(clientX, clientY) {
      if (!lpStart) return;
      if (Math.abs(clientX - lpStart.x) > LONG_PRESS_SLOP_PX ||
          Math.abs(clientY - lpStart.y) > LONG_PRESS_SLOP_PX) lpCancel();
    }

    // ── Pan (one finger) and pinch-zoom (two) ────────────────────
    //
    // Both are implemented here rather than left to the browser, and that
    // is deliberate: the viewport meta sets user-scalable=no and #map-wrap
    // sets touch-action:none, because a browser pinch would scale the
    // whole app shell — buttons, text, and this canvas as a stretched
    // bitmap — instead of zooming the map. Neither should be relaxed.
    let t0 = null;
    let pinch = null;   // { dist, zoom, ax, ay } while two fingers are down

    const touchDist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);

    // Re-base the one-finger pan origin. Needed whenever the finger count
    // changes: without it, lifting one finger from a pinch makes the map
    // leap, because the pan handler would carry on from coordinates that
    // belong to a gesture that has already ended.
    function rebasePan(touch) {
      t0 = { x: touch.clientX, y: touch.clientY, lat: S.mLat, lng: S.mLng };
    }

    function beginPinch(e) {
      const rect = wrap.getBoundingClientRect();
      const [a, b] = [e.touches[0], e.touches[1]];
      pinch = {
        dist: Math.max(1, touchDist(a, b)),
        zoom: S.mZoom,
        ax: (a.clientX + b.clientX) / 2 - rect.left,
        ay: (a.clientY + b.clientY) / 2 - rect.top
      };
      S.pinching = true;   // suppresses tile fetches until the gesture ends
    }

    function endPinch() {
      if (!pinch) return;
      pinch = null;
      S.pinching = false;
      // Now — and only now — fetch whatever level we landed on.
      drawMap();
    }

    wrap.addEventListener('touchstart', (e) => {
      // Don't hijack taps on interactive children (zoom buttons, pins).
      // Calling preventDefault on touchstart would cancel the synthesized
      // click event, so we leave those alone entirely.
      if (e.target.closest('[data-action]')) { t0 = null; lpCancel(); return; }
      if (e.touches.length === 1) {
        rebasePan(e.touches[0]);
        lpArm(e.touches[0].clientX, e.touches[0].clientY);
      } else if (e.touches.length === 2) {
        // A second finger is never a long press.
        lpCancel();
        beginPinch(e);
      } else {
        lpCancel();
      }
      // #map-wrap has touch-action: none, so the browser already
      // suppresses scroll/zoom; no preventDefault needed here.
    }, { passive: true });

    wrap.addEventListener('touchmove', (e) => {
      if (pinch && e.touches.length >= 2) {
        const d = Math.max(1, touchDist(e.touches[0], e.touches[1]));
        // Distance ratio → zoom levels: each doubling is one level.
        zoomAbout(pinch.zoom + Math.log2(d / pinch.dist), pinch.ax, pinch.ay);
        drawMap();
        e.preventDefault();
        return;
      }
      if (!t0 || e.touches.length !== 1) { lpCancel(); return; }
      lpMaybeCancel(e.touches[0].clientX, e.touches[0].clientY);
      const dx = e.touches[0].clientX - t0.x;
      const dy = e.touches[0].clientY - t0.y;
      const dpx = (156543.03392 * Math.cos(S.mLat * Math.PI / 180) / Math.pow(2, S.mZoom)) / 111320;
      S.mLat = t0.lat + dy * dpx;
      S.mLng = t0.lng - dx * dpx;
      drawMap();
      e.preventDefault();
    }, { passive: false });

    wrap.addEventListener('touchend', (e) => {
      lpCancel();
      if (pinch && e.touches.length < 2) {
        endPinch();
        // One finger still down → hand back to panning, from where that
        // finger actually is.
        if (e.touches.length === 1) rebasePan(e.touches[0]);
        else t0 = null;
      }
    });
    wrap.addEventListener('touchcancel', () => { lpCancel(); endPinch(); t0 = null; });

    // Desktop parity. The map had no scroll-to-zoom at all before; it is
    // a few lines once the fractional path exists, and it anchors on the
    // cursor for the same reason the pinch anchors between the fingers.
    wrap.addEventListener('wheel', (e) => {
      if (e.target.closest('[data-action]')) return;
      e.preventDefault();
      const rect = wrap.getBoundingClientRect();
      // deltaMode 1 is lines, 2 is pages; normalise both to something
      // near a pixel count so a trackpad and a mouse wheel feel alike.
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1;
      const step = Math.max(-1, Math.min(1, (-e.deltaY * unit) / 300));
      zoomAbout(S.mZoom + step, e.clientX - rect.left, e.clientY - rect.top);
      drawMap();
    }, { passive: false });

    wrap.addEventListener('mousedown', (e) => {
      if (e.target.closest('[data-action]')) return;
      S.dragging = true;
      S.dragStart = { x: e.clientX, y: e.clientY };
      S.viewStart = { lat: S.mLat, lng: S.mLng };
      lpArm(e.clientX, e.clientY);
    });
    window.addEventListener('mousemove', (e) => {
      lpMaybeCancel(e.clientX, e.clientY);
      if (!S.dragging) return;
      const dx = e.clientX - S.dragStart.x;
      const dy = e.clientY - S.dragStart.y;
      const dpx = (156543.03392 * Math.cos(S.mLat * Math.PI / 180) / Math.pow(2, S.mZoom)) / 111320;
      S.mLat = S.viewStart.lat + dy * dpx;
      S.mLng = S.viewStart.lng - dx * dpx;
      drawMap();
    });
    window.addEventListener('mouseup', () => { S.dragging = false; lpCancel(); });

    window.addEventListener('resize', () => {
      canvas.width = wrap.clientWidth;
      canvas.height = wrap.clientHeight;
      drawMap();
    });
    drawMap();
  }

  /**
   * Stand in for a missing tile with the matching quadrant of an ancestor
   * we already hold, scaled up.
   *
   * Without this, crossing a zoom level mid-pinch paints beige until the
   * gesture settles and the new level is fetched — the map appears to
   * blink out exactly while you are looking at it. A blown-up parent is
   * blurry for a few hundred milliseconds and continuous, which is the
   * trade every slippy map makes.
   *
   * Only ever reads the cache; never triggers a fetch. That matters
   * during a pinch, when fetching is deliberately suspended.
   */
  function drawFromParent(ctx, z, tx, ty, px, py, pw, ph) {
    // Two levels is enough to cover a pinch through one boundary, and
    // bounds how blurry the stand-in is allowed to get.
    for (let up = 1; up <= 2; up++) {
      const pz = z - up;
      if (pz < MIN_ZOOM) return false;
      const f = 1 << up;                       // 2 or 4
      const ptx = Math.floor(tx / f), pty = Math.floor(ty / f);
      const t = S.tiles[pz + '/' + ptx + '/' + pty];
      if (!t || t === 'loading' || t === 'err') continue;
      // Which sub-square of the ancestor covers this tile.
      const sub = TILE_SIZE / f;
      const sxp = (tx - ptx * f) * sub;
      const syp = (ty - pty * f) * sub;
      ctx.drawImage(t, sxp, syp, sub, sub, px, py, pw, ph);
      return true;
    }
    return false;
  }

  function drawMap() {
    const canvas = $('map-canvas');
    if (!canvas || !S.mapCtx) return;
    const ctx = S.mapCtx;
    const W = canvas.width, H = canvas.height;

    // S.mZoom is FRACTIONAL (pinch), but OSM tiles only exist at whole
    // zoom levels. So the two are separated: tileZ is what we fetch,
    // S.mZoom is what we draw at, and each tile is scaled by the
    // difference. Without this a pinch could only jump a whole level at a
    // time, which reads as broken rather than as zooming.
    //
    // Everything else — ll2px, px2ll, metresToPx — was already written in
    // terms of Math.pow(2, S.mZoom) and needs no change to work
    // fractionally. Only this loop assumed an integer.
    const tileZ = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(S.mZoom)));
    const scale = Math.pow(2, S.mZoom - tileZ);
    const TS = TILE_SIZE * scale;

    const n = Math.pow(2, tileZ);
    const cx = (S.mLng + 180) / 360 * n;
    const cy = (1 - Math.log(Math.tan(S.mLat * Math.PI / 180) + 1 / Math.cos(S.mLat * Math.PI / 180)) / Math.PI) / 2 * n;
    ctx.clearRect(0, 0, W, H);

    const sx = Math.floor(cx - W / 2 / TS);
    const sy = Math.floor(cy - H / 2 / TS);
    const ex = Math.ceil(cx + W / 2 / TS);
    const ey = Math.ceil(cy + H / 2 / TS);

    for (let tx = sx; tx <= ex; tx++) {
      for (let ty = sy; ty <= ey; ty++) {
        // Ceil the destination size so neighbouring tiles overlap by a
        // sub-pixel instead of leaving hairline seams at fractional scale.
        const px = Math.round((tx - cx) * TS + W / 2);
        const py = Math.round((ty - cy) * TS + H / 2);
        const pw = Math.ceil(TS) + 1, ph = Math.ceil(TS) + 1;
        const k = tileZ + '/' + tx + '/' + ty;
        const tile = S.tiles[k];
        const have = tile && tile !== 'loading' && tile !== 'err';

        // WHAT TO PAINT and WHAT TO FETCH are decided separately, and must
        // stay that way. Folding the fetch into the "nothing to paint"
        // branch means a tile covered by a blown-up ancestor is never
        // requested — the map looks fine, permanently blurry, and never
        // sharpens, because the fallback is doing its job too well.
        if (have) {
          ctx.drawImage(tile, px, py, pw, ph);
        } else if (!drawFromParent(ctx, tileZ, tx, ty, px, py, pw, ph)) {
          ctx.fillStyle = '#e8e0d0';
          ctx.fillRect(px, py, pw, ph);
        }

        // Don't start fetches MID-GESTURE. A pinch crosses zoom levels in
        // a few hundred milliseconds, and requesting every level it passes
        // through would be asking tile.openstreetmap.org for tiles nobody
        // ever sees — against the "only for the viewport being drawn" line
        // in the usage policy (see NOTICE.md), and slower besides. Scaled
        // copies of what we already hold carry the gesture; the real tiles
        // are fetched once it settles.
        if (!tile && !S.pinching) {
          S.tiles[k] = 'loading';
          const img = new Image();
          img.crossOrigin = 'anonymous';
          const ttx = ((tx % n) + n) % n;
          // Canonical host, no a/b/c rotation. The OSM Tile Usage Policy
          // says to use exactly tile.openstreetmap.org and that other
          // subdomains "may be slower or withdrawn without notice" — the
          // rotation was an HTTP/1.1 trick for connection parallelism that
          // HTTP/2 multiplexing makes unnecessary anyway, and the policy
          // recommends HTTP/2.
          img.src = 'https://tile.openstreetmap.org/' + tileZ + '/' + ttx + '/' + ty + '.png';
          ((key, i) => {
            i.onload = () => { S.tiles[key] = i; drawMap(); };
            i.onerror = () => { S.tiles[key] = 'err'; };
          })(k, img);
        }
      }
    }
    // The cache is keyed zoom/x/y, so a tile is never in the wrong place
    // and never needs flushing on a zoom change — this eviction is purely
    // a memory bound. (Zoom handlers used to flush the whole cache, which
    // made zooming out and back in re-request everything and, with a
    // pinch, would have done so many times a second.)
    const keys = Object.keys(S.tiles);
    if (keys.length > 200) keys.slice(0, 60).forEach(k => delete S.tiles[k]);
    drawPlaceCircles(ctx);
    drawTrail(ctx);
    renderPins();
  }

  // A gap longer than this between consecutive breadcrumbs means the
  // person stopped somewhere and later set off again — i.e. a new trip.
  // (Breadcrumbs are distance-gated, so a stationary phone emits none and
  // the time gap grows.)
  const TRIP_GAP_MS = 10 * 60 * 1000;
  // The SECOND way a trip ends, and on Android the only one that ever fires.
  // The silence above assumes a parked phone goes quiet — but a device that
  // doze-cycles every few minutes is never quiet: each doze exit pushes a
  // fresh fix through, so the gap never opens and a whole stationary
  // afternoon arrived here as one continuous "trip". A device that has not
  // left a STILL_RADIUS_M ball in STILL_WINDOW_MS is parked, whatever it is
  // still emitting. 15 minutes to cover 120 m is 0.5 km/h — slower than any
  // purposeful movement.
  const STILL_RADIUS_M  = 120;
  const STILL_WINDOW_MS = 15 * 60 * 1000;
  // Distinct, map-legible colours cycled per trip. 12 hues so a busy day
  // of many trips gets its own colour far longer before any repeat; all
  // kept clear of the place-circle green and the blue radius preview.
  const TRAIL_COLORS = ['#3a6f9a', '#c0504d', '#4e9a4e', '#d08a2c', '#7a4a9a', '#2c8c8c',
    '#b5563f', '#3f7d5a', '#8c4a7a', '#5a7a2c', '#2c6f8c', '#9a7a3a'];
  const ARROW_SPACING_PX = 55;   // draw a direction arrow ~every this many px

  // Split the (oldest → newest) breadcrumb list into trips, on a time gap or
  // on a stretch spent standing still.
  //
  // The stillness test uses a MOVING ANCHOR rather than the diameter of a
  // window, and that choice is what protects real closed-loop activity: a
  // runner doing laps passes 120 m from the anchor every lap, so the clock
  // resets every lap and they are never called parked. Drift re-anchors only
  // rarely, and when it does the anchor lands on the far edge of its ball, so
  // the next escape needs roughly twice the radius from the centre — which
  // drift cannot reach. A stray outlier therefore costs one extra window, not
  // correctness. (Same reasoning as the native breadcrumb anchor in
  // LocationUpdateReceiver, deliberately.)
  function segmentTrips(pts) {
    const trips = [];
    let cur = null, anchor = null;
    for (const p of pts) {
      const t = new Date(p.recorded_at).getTime();
      const gap = !!(cur && cur._lastT != null && t - cur._lastT > TRIP_GAP_MS);
      if (!gap && anchor) {
        if (distanceM(anchor.lat, anchor.lng, p.lat, p.lng) > STILL_RADIUS_M) {
          anchor = { lat: p.lat, lng: p.lng, t };     // real progress — re-anchor
        } else if (t - anchor.t > STILL_WINDOW_MS) {
          // Parked. Drop the point rather than keeping it: it is a jitter
          // sample, and keeping jitter samples is what let an hour of sitting
          // at home add up to "Drive · 4.6 km". The trip resumes at whichever
          // point finally leaves the ball, which re-anchors on the branch
          // above.
          cur = null;
          continue;
        }
      }
      if (!cur || gap) {
        cur = []; cur._lastT = null; trips.push(cur);
        anchor = { lat: p.lat, lng: p.lng, t };
      }
      cur.push(p);
      cur._lastT = t;
    }
    return trips;
  }

  // One definition of "a trip worth showing", used by the map, the trail pill
  // and the History timeline — they disagreed before this existed, so the map
  // drew jitter clusters the timeline correctly hid and the pill could report
  // more trips than the list contained. TRIP_MIN_M / TRIP_SPAN_MIN_M /
  // isRealTrip live with the rest of the timeline constants further down.
  //
  // Memoised on the trail's identity because drawMap calls this on every pan
  // and zoom frame, and segmentTrips + tripStats is O(points).
  let _tripsMemo = { key: null, trips: [] };
  function tripsFrom(pts) {
    if (!pts || !pts.length) return [];
    // The places are part of the key, not just the points: isRealTrip's
    // doorstep test reads them, and a trail drawn before loadPlaces returned
    // would otherwise stay cached against an empty place list for the rest of
    // the session. Cheap — a family has a handful of places.
    const key = pts.length + ':' + pts[0].recorded_at + ':'
      + pts[pts.length - 1].recorded_at + ':' + placesSignature();
    if (_tripsMemo.key !== key) {
      _tripsMemo = { key, trips: segmentTrips(pts).map(tripStats).filter(isRealTrip) };
    }
    return _tripsMemo.trips;
  }

  function drawArrowhead(ctx, x0, y0, x1, y1, color) {
    const ang = Math.atan2(y1 - y0, x1 - x0);
    const s = 7;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x1 - s * Math.cos(ang - Math.PI / 6), y1 - s * Math.sin(ang - Math.PI / 6));
    ctx.lineTo(x1 - s * Math.cos(ang + Math.PI / 6), y1 - s * Math.sin(ang + Math.PI / 6));
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  }

  // The 24h breadcrumb path for S.trailMemberId. Each trip is drawn in its
  // own colour with direction arrows along the way, a hollow ring at the
  // start and a filled dot at the end — so multiple trips and the travel
  // direction are easy to tell apart.
  function drawTrail(ctx) {
    const pts = S.trail;
    if (!pts || pts.length < 2) return;
    // The same filtered list the timeline shows. Sub-threshold clusters now
    // vanish from the map too, which is the point: a day spent at home should
    // render as an empty map, not as a scribble the list refuses to explain.
    const trips = tripsFrom(pts);
    if (!trips.length) return;
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    trips.forEach((t, ti) => {
      const trip = t.pts;
      if (!trip || trip.length < 1) return;
      const color = TRAIL_COLORS[ti % TRAIL_COLORS.length];
      const px = trip.map(p => ll2px(p.lat, p.lng));

      if (px.length >= 2) {
        // Path line.
        ctx.lineWidth = 3.5;
        ctx.strokeStyle = color;
        ctx.globalAlpha = 0.85;
        ctx.beginPath();
        ctx.moveTo(px[0].x, px[0].y);
        for (let i = 1; i < px.length; i++) ctx.lineTo(px[i].x, px[i].y);
        ctx.stroke();

        // Direction arrows, spaced by drawn pixel distance.
        ctx.globalAlpha = 1;
        let acc = 0;
        for (let i = 1; i < px.length; i++) {
          const dx = px[i].x - px[i - 1].x, dy = px[i].y - px[i - 1].y;
          acc += Math.hypot(dx, dy);
          if (acc >= ARROW_SPACING_PX) {
            drawArrowhead(ctx, px[i - 1].x, px[i - 1].y, px[i].x, px[i].y, color);
            acc = 0;
          }
        }
      }

      // Start ring (hollow) and end dot (filled).
      ctx.globalAlpha = 1;
      const a = px[0], b = px[px.length - 1];
      ctx.beginPath();
      ctx.arc(a.x, a.y, 5, 0, Math.PI * 2);
      ctx.fillStyle = '#fff'; ctx.fill();
      ctx.lineWidth = 2.5; ctx.strokeStyle = color; ctx.stroke();
      ctx.beginPath();
      ctx.arc(b.x, b.y, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = color; ctx.fill();
    });

    ctx.restore();
  }

  // metres → pixels at the current map latitude / zoom.
  // Uses the standard Web Mercator resolution formula.
  function metresPerPixel() {
    return (156543.03392 * Math.cos(S.mLat * Math.PI / 180)) / Math.pow(2, S.mZoom);
  }

  function drawPlaceCircles(ctx) {
    if (!S.places && !S.placePicker) return;
    const mpp = metresPerPixel();
    if (!isFinite(mpp) || mpp <= 0) return;

    // Saved places.
    for (const p of (S.places || [])) {
      const pos = ll2px(p.lat, p.lng);
      const r = p.radius_m / mpp;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(120, 160, 100, 0.18)';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(90, 130, 70, 0.75)';
      ctx.stroke();
    }

    // Editor preview circle (blue) so the user sees the radius they're dragging.
    if (S.placePicker) {
      const pos = ll2px(S.placePicker.lat, S.placePicker.lng);
      const r = (S.placeRadius || 100) / mpp;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(58, 111, 154, 0.15)';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = 'rgba(58, 111, 154, 0.9)';
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // The +/- buttons still step WHOLE levels — rounding first so that
  // pressing "+" after a pinch that left us at 14.3 goes to 15, not 15.3.
  function mapZoom(d) {
    setZoom(Math.round(S.mZoom) + d);
    drawMap();
  }

  const clampZoom = (z) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));

  function setZoom(z) { S.mZoom = clampZoom(z); }

  /**
   * Zoom while keeping one screen point over the same piece of ground.
   *
   * The buttons zoom about the centre, which is fine because the centre
   * doesn't move. A pinch or a wheel must instead keep whatever is under
   * the fingers (or the cursor) exactly where it is — otherwise the map
   * slides out from under you as you zoom, which feels broken even though
   * the zoom itself is correct.
   *
   * Done with the existing projection helpers rather than new maths: read
   * the lat/lng under the anchor before, change the zoom, then shift the
   * centre by however far that same lat/lng has moved.
   */
  function zoomAbout(z, ax, ay) {
    const before = px2ll(ax, ay);
    setZoom(z);
    const after = px2ll(ax, ay);
    S.mLat += before.lat - after.lat;
    S.mLng += before.lng - after.lng;
  }

  function mapCenter() {
    const me = S.members.find(m => m.id === S.myId);
    if (me && me.lat) {
      S.mLat = me.lat;
      S.mLng = me.lng;
      S.mZoom = 15;
      drawMap();
    }
  }

  function renderPins() {
    const host = $('map-pins');
    if (!host) return;
    clear(host);

    // Place icons render *under* member pins (appended first).
    for (const p of (S.places || [])) {
      const pos = ll2px(p.lat, p.lng);
      host.appendChild(el('div', {
        class: 'map-place',
        style: 'left:' + pos.x + 'px;top:' + pos.y + 'px',
        dataset: { action: 'focus-place', id: p.id },
        text: p.icon
      }));
    }

    // A paused member's live position is hidden from the map — the family
    // sees "Location paused" in their row instead of a frozen pin.
    for (const m of S.members.filter(x => x.lat != null && x.lng != null && !isPausedRow(x))) {
      const pos = ll2px(m.lat, m.lng);
      const cls = 'map-pin' +
        (m.id === S.myId ? ' me' : '') +
        (m.sos ? ' sos' : '');
      host.appendChild(el('div', {
        class: cls,
        style: 'left:' + pos.x + 'px;top:' + pos.y + 'px',
        dataset: { action: 'pin-click', id: m.id },
        text: m.avatar
      }));
    }
  }

  function pinClick(id) {
    const m = S.members.find(x => x.id === id);
    if (!m) return;
    const pop = $('map-pop');
    if (!pop) return;
    const pos = ll2px(m.lat, m.lng);
    clear(pop);
    const label = m.avatar + ' ' + m.name + (m.id === S.myId ? ' (You)' : '');
    const paused = isPausedRow(m);
    pop.appendChild(el('strong', { text: label }));
    pop.appendChild(el('div', { class: 'pp-s', text: m.sos ? '🆘 SOS ACTIVE'
      : paused ? ('⏸ Location paused' + (m.paused_until ? ' · resumes ' + pauseClock(m.paused_until) : ''))
      : (m.status || '') }));
    if (!paused) pop.appendChild(el('div', { class: 'pp-s', text: '🔋 ' + m.battery + '%' }));
    pop.style.cssText = 'display:block;left:' + pos.x + 'px;top:' + pos.y + 'px';
    setTimeout(() => { if (pop) pop.style.display = 'none'; }, 3000);
    loadTrail(id);
  }

  // ── GPS & BATTERY ──────────────────────────────────────────────
  // One shared sink: every location source (web watchPosition OR native
  // Capacitor plugin) funnels through pushLocation so Supabase update,
  // local state mutation, map redraw, and geofence transition detection
  // all stay in one place.
  let _gpsFirst = true;

  // Tracking profiles. distanceFilter feeds the BG-geolocation watcher
  // (metres of movement before it samples GPS — the main battery lever);
  // writeMs throttles the keep_members lat/lng push so we're not waking
  // the radio on every fix. Breadcrumb writes are distance-gated below.
  const TRACK_PROFILES = {
    live:     { distanceFilter: 5,   writeMs: 8000   },
    balanced: { distanceFilter: 15,  writeMs: 30000  },
    saver:    { distanceFilter: 60,  writeMs: 120000 }
  };
  // 'auto' samples GPS at a fixed, track-friendly granularity. When you
  // stop moving the OS stops emitting fixes anyway (that's what
  // distanceFilter means), so battery is fine without cranking it up —
  // and keeping it constant means we never tear down/re-arm the watcher
  // mid-walk. Auto only adapts the live-pin push cadence (cheap, JS-side).
  const AUTO_DISTANCE_FILTER = 12;
  const AUTO_WRITE_MOVING = 10000;
  const AUTO_WRITE_STILL  = 60000;

  // Breadcrumbs are DISTANCE-gated, not time-gated: a point roughly every
  // TRAIL_STEP_M of travel gives a detailed track while moving and writes
  // nothing while still. (The old time throttle capped a 30-min walk at a
  // handful of points.) TRAIL_MIN_MS stops GPS jitter / fast driving from
  // flooding; TRAIL_IDLE_MS still logs the occasional point on a slow drift.
  const TRAIL_STEP_M  = 25;
  const TRAIL_MIN_MS  = 8000;
  const TRAIL_IDLE_MS = 5 * 60 * 1000;
  // The idle clause exists to catch a genuinely slow mover, so it needs a
  // displacement — not merely "> 0". At "> 0" a stationary PWA outside a
  // place wrote a jitter crumb every 5 minutes, which is SHORTER than
  // TRIP_GAP_MS (10 min), so the silence that ends a trip could never open
  // and the day arrived at the timeline as one endless trip.
  //
  // _lastHistLat/_lastHistLng only advance when a breadcrumb is actually
  // written, so this compares against the last RECORDED point — the same
  // anchor shape the native path uses. Raising TRAIL_IDLE_MS above
  // TRIP_GAP_MS instead would have cost a slow real walk its points.
  // Matches LocationForegroundService.MOVING_DISP_M.
  const TRAIL_IDLE_MIN_M = 40;

  let _lastMemberWriteMs = 0;   // last keep_members lat/lng push
  let _lastHistWriteMs   = 0;   // last location_history breadcrumb (web path)
  let _lastFixLat = null, _lastFixLng = null;
  let _lastHistLat = null, _lastHistLng = null;  // last breadcrumb position
  let _autoMoving = false;      // current auto-mode movement state

  // The profile in effect right now. For 'auto', distanceFilter is fixed
  // and only the live-pin write cadence adapts to movement.
  function currentProfile() {
    if (S.trackingMode === 'auto') {
      return {
        distanceFilter: AUTO_DISTANCE_FILTER,
        writeMs: _autoMoving ? AUTO_WRITE_MOVING : AUTO_WRITE_STILL
      };
    }
    return TRACK_PROFILES[S.trackingMode] || TRACK_PROFILES.balanced;
  }

  let _lastMovementMs = 0;

  // 'auto' mode only: decide whether the user is moving. Prefers the OS's
  // reported speed (reliable for a steady walk); falls back to per-fix
  // displacement. Only the live-pin cadence depends on this now, so there
  // is no watcher re-arm here — that removes the mid-walk thrash where a
  // walk kept decaying back to the low-power profile. 3-minute hysteresis
  // before we call it "still" so a pause at a crossing doesn't flip us.
  function evaluateAutoMovement(speed, movedM, now) {
    if (S.trackingMode !== 'auto') return;
    const STILL_AFTER_MS = 3 * 60 * 1000;
    let isMovingNow;
    if (typeof speed === 'number' && speed >= 0) {
      isMovingNow = speed > 0.6;          // > ~2 km/h
    } else if (movedM != null) {
      isMovingNow = movedM >= 10;
    } else {
      isMovingNow = false;
    }
    if (isMovingNow) {
      _lastMovementMs = now;
      _autoMoving = true;
    } else if (_lastMovementMs && now - _lastMovementMs > STILL_AFTER_MS) {
      _autoMoving = false;
    }
  }

  // Apply a tracking mode: persist it (per-device), refresh the UI, and
  // re-arm the watcher so the new distanceFilter takes effect.
  async function applyTrackingMode(mode) {
    if (mode !== 'auto' && !TRACK_PROFILES[mode]) return;
    S.trackingMode = mode;
    _autoMoving = false; _lastMovementMs = 0;
    try {
      const Prefs = window.Capacitor?.Plugins?.Preferences;
      if (Prefs) await Prefs.set({ key: 'trackingMode', value: mode });
      else localStorage.setItem('roamkeep_trackingMode', mode);
    } catch (_) {}
    updateTrackingModeUI();
    if (isNative()) restartGPS();
  }

  // Read the saved mode on launch (defaults to 'auto'). Called before
  // startGPS so the first watcher is armed with the right distanceFilter.
  async function loadTrackingMode() {
    let mode = 'auto';
    try {
      const Prefs = window.Capacitor?.Plugins?.Preferences;
      if (Prefs) {
        const { value } = await Prefs.get({ key: 'trackingMode' });
        if (value) mode = value;
      } else {
        const v = localStorage.getItem('roamkeep_trackingMode');
        if (v) mode = v;
      }
    } catch (_) {}
    S.trackingMode = (mode === 'auto' || TRACK_PROFILES[mode]) ? mode : 'auto';
    updateTrackingModeUI();
  }

  const TRACK_DESCRIPTIONS = {
    auto:     'Tracks closely while you’re moving and eases off when you’re still — the best balance of detail and battery.',
    live:     'Most frequent, most detailed track. Highest battery use — best for an active outing you want logged precisely.',
    balanced: 'Moderate detail and battery use. A sensible all-day default.',
    saver:    'Fewest updates, lightest on battery. The trail is coarser and your pin updates less often for others.'
  };

  function updateTrackingModeUI() {
    const host = $('track-modes');
    if (host) {
      for (const btn of host.querySelectorAll('[data-mode]')) {
        btn.classList.toggle('on', btn.dataset.mode === S.trackingMode);
      }
    }
    const desc = $('track-desc');
    if (desc) desc.textContent = TRACK_DESCRIPTIONS[S.trackingMode] || TRACK_DESCRIPTIONS.auto;
  }

  // Self-diagnosis readout so a device (especially a managed child device)
  // can report whether native breadcrumb logging is actually working —
  // armed? service running? is the OS-level receiver firing in the
  // background? — without needing adb. Renders into #diag-rows.
  // Diagnostics are collapsed by default; the flip switch expands them
  // and renders fresh telemetry on demand (no work while hidden).
  function toggleDiag(t) {
    const body = $('diag-body');
    if (!body) return;
    if (t.checked) {
      body.style.display = 'block';
      renderDiagnostics();
    } else {
      body.style.display = 'none';
    }
  }

  async function renderDiagnostics() {
    const host = $('diag-rows');
    if (!host) return;
    clear(host);
    const rows = [];

    let version = '—';
    try {
      const App = window.Capacitor?.Plugins?.App;
      if (App && App.getInfo) {
        const info = await App.getInfo();
        version = info.version + ' (' + info.build + ')';
      }
    } catch (_) {}
    rows.push(['App version', version, null]);

    if (!isNative()) {
      rows.push(['Platform', 'Web / PWA — native tracking n/a', null]);
    } else {
      rows.push(['Native breadcrumbs armed', S._nativeLocReady ? 'Yes' : 'No', !!S._nativeLocReady]);

      let st = null;
      const NG = nativeGeo();
      if (NG && NG.getReliabilityStatus) {
        try { st = await NG.getReliabilityStatus(); } catch (e) { console.warn('getReliabilityStatus', e); }
      }
      if (st) {
        rows.push(['Tracking service', st.serviceRunning ? 'Running' : 'Not running', !!st.serviceRunning]);
        rows.push(['Location: all the time', st.backgroundLocation ? 'Yes' : 'No', !!st.backgroundLocation]);
        rows.push(['Battery unrestricted', st.ignoringBatteryOptimizations ? 'Yes' : 'No', !!st.ignoringBatteryOptimizations]);
        rows.push(['Notifications allowed', st.notifications ? 'Yes' : 'No', !!st.notifications]);
        rows.push(['Permissions kept (no auto-reset)', st.autoRevokeWhitelisted ? 'Yes' : 'No', !!st.autoRevokeWhitelisted]);
        rows.push(['Background fixes recorded', String(st.locationFireCount || 0), (st.locationFireCount || 0) > 0]);
        // A tick when points are flowing, but NEVER a cross. Zero written is
        // the correct answer for a phone that has not left a saved place, and
        // since 4.8.5 stopped drift escaping the radius it is the common one —
        // this row spent a whole quiet night reporting healthy behaviour as a
        // red failure. "Is the pipeline alive" is already answered by
        // "Background fixes recorded" above; zero here only means anything
        // read against the two rows below it.
        rows.push(['Breadcrumbs written', String(st.breadcrumbCount || 0),
          (st.breadcrumbCount || 0) > 0 ? true : null]);
        rows.push(['Suppressed (inside a place)', String(st.suppressedCount || 0), null]);
        // Neither good nor bad on its own, so no tick or cross. The useful
        // reading is the PAIR: this climbing while "Breadcrumbs written"
        // stays flat is a stationary phone behaving correctly. Both climbing
        // together on a real journey would mean the drift gate is eating
        // trail, and the journal's "max Nm from anchor" line says which.
        rows.push(['Imprecise fixes ignored', String(st.rejectedCount || 0), null]);
        rows.push(['Last background fix',
          st.lastLocationFireMs ? timeAgo(new Date(st.lastLocationFireMs).toISOString()) : 'never',
          st.lastLocationFireMs > 0]);
      }
      rows.push(['Last foreground fix',
        S.lastFixMs ? timeAgo(new Date(S.lastFixMs).toISOString()) : 'never', null]);
    }

    for (const [label, value, ok] of rows) {
      host.appendChild(el('div', { class: 'diag-row' }, [
        el('div', { class: 'diag-k', text: label }),
        el('div', {
          class: 'diag-v' + (ok === true ? ' ok' : ok === false ? ' bad' : ''),
          text: (ok === true ? '✓ ' : ok === false ? '✗ ' : '') + value
        })
      ]));
    }

    // Black-box journal + process-death history (native only). The
    // journal is what the pipeline was doing while nobody watched —
    // doze transitions, service lifecycle, geofence fires — and the
    // exits are the OS's own record of every time our process died
    // and why. Together they made the doze-stall diagnosis possible
    // without adb; render them so the next one needs only a screenshot.
    const NG2 = isNative() ? nativeGeo() : null;
    if (NG2 && typeof NG2.getJournal === 'function') {
      try {
        const j = await NG2.getJournal();
        const fmtT = (ms) => new Date(ms).toLocaleString([], {
          weekday: 'short', hour: '2-digit', minute: '2-digit'
        });
        const entries = (j && j.entries) || [];
        if (entries.length) {
          host.appendChild(el('div', { class: 'diag-sub', text: '📓 Pipeline journal (newest first)' }));
          for (const e of entries.slice(-40).reverse()) {
            host.appendChild(el('div', { class: 'diag-log', text: fmtT(e.t) + ' · ' + e.e }));
          }
        }
        const exits = (j && j.exits) || [];
        if (exits.length) {
          host.appendChild(el('div', { class: 'diag-sub', text: '💀 Process deaths (OS record)' }));
          for (const x of exits.slice(0, 10)) {
            host.appendChild(el('div', {
              class: 'diag-log',
              text: fmtT(x.t) + ' · ' + x.reason + (x.desc ? ' — ' + x.desc : '')
            }));
          }
        }
      } catch (e) { console.warn('getJournal', e); }
    }
  }

  // `whenMs` is the epoch-ms timestamp the OS stamped on the location
  // sample (Capacitor BG plugin: location.time; web watchPosition:
  // pos.timestamp). We pass it through so that when the WebView is
  // resumed after a background suspension and the plugin drains its
  // buffered samples in rapid succession, each geofence check-in is
  // written with the time the user actually crossed the boundary,
  // not the (near-identical) time the inserts ran on resume.
  function pushLocation(lat, lng, whenMs, speed) {
    if (typeof lat !== 'number' || typeof lng !== 'number') return;
    // Belt-and-braces: if a foreground watch fires while we're paused
    // (e.g. it was armed before the pause), write nothing. No pin push,
    // no breadcrumb, no geofence transition — the pause means dark.
    if (isPausedRow(myMember())) return;
    const when = (typeof whenMs === 'number' && whenMs > 0) ? whenMs : Date.now();
    const whenIso = new Date(when).toISOString();
    const now = Date.now();
    // Stamp the wall-clock time we processed this fix. The resume
    // health check + the "Live" / "Stale" header badge both key off
    // this — together they answer "is the watcher still alive?"
    // without the user having to force-quit to find out.
    S.lastFixMs = now;
    refreshLiveBadge();

    // Movement signal for 'auto' mode (adapts the live-pin cadence only).
    const movedM = (_lastFixLat != null) ? distanceM(_lastFixLat, _lastFixLng, lat, lng) : null;
    evaluateAutoMovement(speed, movedM, now);

    const prof = currentProfile();

    // Local state always updates so the user's own pin glides smoothly
    // on their own screen regardless of how throttled the network is.
    const me = S.members.find(m => m.id === S.myId);
    if (me) { me.lat = lat; me.lng = lng; }
    if (_gpsFirst) {
      S.mLat = lat; S.mLng = lng; S.mZoom = 15;
      _gpsFirst = false;
    }

    // Throttled push of the live pin to Supabase. Always write the very
    // first fix; thereafter only once per profile interval. This is the
    // main battery saver — fewer network/radio wakeups — at the cost of
    // other members seeing your pin update less often in saver mode.
    if (_lastMemberWriteMs === 0 || now - _lastMemberWriteMs >= prof.writeMs) {
      _lastMemberWriteMs = now;
      S.sb.from('keep_members').update({
        lat, lng,
        last_seen: whenIso,
        online: true
      }).eq('id', S.myId).then(() => {});
    }

    // Distance-gated breadcrumb for the 24h trail — but only on the web /
    // PWA path. On native, the FusedLocationProvider receiver owns the
    // trail (it keeps recording while the WebView is suspended), so the
    // JS path stands down to avoid duplicate points. We also skip points
    // inside a saved place so pottering around the house doesn't become a
    // trip (the live pin above still updates).
    if (!S._nativeLocReady && !isInsideAnyPlace(lat, lng)) {
      const histMoved = (_lastHistLat != null) ? distanceM(_lastHistLat, _lastHistLng, lat, lng) : null;
      const sinceHist = _lastHistWriteMs ? now - _lastHistWriteMs : Infinity;
      if (_lastHistWriteMs === 0 ||
          (histMoved != null && histMoved >= TRAIL_STEP_M && sinceHist >= TRAIL_MIN_MS) ||
          (histMoved != null && histMoved >= TRAIL_IDLE_MIN_M && sinceHist >= TRAIL_IDLE_MS)) {
        _lastHistWriteMs = now;
        _lastHistLat = lat; _lastHistLng = lng;
        writeBreadcrumb(lat, lng, whenIso, speed);
      }
    }

    _lastFixLat = lat; _lastFixLng = lng;

    // Geofence detection + redraw run on EVERY fix (cheap + local) so
    // arrivals/departures and the local map stay responsive even when
    // the network writes above are throttled.
    checkGeofenceTransitions(lat, lng, whenIso);
    drawMap();
  }

  // Web / PWA breadcrumb write (native owns this on the app). The trail
  // extends via the location_history realtime subscription — one source
  // for both write paths — so there's no local append here.
  async function writeBreadcrumb(lat, lng, iso, speed) {
    if (!S.keepId || !S.myId) return;
    const row = { keep_id: S.keepId, member_id: S.myId, lat, lng, recorded_at: iso };
    // GPS speed feeds the timeline's walk/drive classifier; leave the
    // column NULL when the fix doesn't report one.
    if (typeof speed === 'number' && isFinite(speed) && speed >= 0) row.speed = speed;
    try {
      await S.sb.from('location_history').insert(row);
    } catch (e) { console.warn('breadcrumb insert', e); }
  }

  // Trim our own breadcrumbs past the timeline window. Runs once on
  // launch and works regardless of whether the JS or the native receiver
  // did the writing. (The v7 migration adds a pg_cron sweep for members
  // whose devices never come back online.)
  async function pruneOwnHistory() {
    if (!S.myId) return;
    const cutoff = new Date(Date.now() - HISTORY_DAYS * 24 * 3600 * 1000).toISOString();
    try {
      await S.sb.from('location_history').delete()
        .eq('member_id', S.myId).lt('recorded_at', cutoff);
    } catch (e) { console.warn('history prune', e); }
  }

  // ── PLACES ─────────────────────────────────────────────────────
  // Haversine great-circle distance in metres. Small-input-safe.
  function distanceM(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const toRad = (d) => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
              Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  // True when (lat,lng) is within the radius of any saved place — used to
  // suppress breadcrumbs inside places so home/work movement isn't a trip.
  function isInsideAnyPlace(lat, lng) {
    for (const p of (S.places || [])) {
      if (distanceM(lat, lng, p.lat, p.lng) <= p.radius_m) return true;
    }
    return false;
  }

  // Called from pushLocation on every GPS tick. For each place, if the
  // user just crossed the boundary we insert an arrived/left check-in
  // and update keep_members.last_place_id. The insidePlaces Set keeps
  // the transition edge — without it we'd spam check-ins.
  async function checkGeofenceTransitions(lat, lng, whenIso) {
    if (!S.places || !S.places.length || !S.myId) return;
    const me = S.members.find(m => m.id === S.myId);
    const myName = me ? me.name : 'Someone';
    const myAv = me ? me.avatar : '📍';
    const ts = whenIso || new Date().toISOString();
    // When the native plugin is handling transitions, Google Play
    // Services is already firing ENTER/EXIT and the BroadcastReceiver
    // is writing check-ins directly. We still maintain the insidePlaces
    // Set locally so the "You are here" UI label stays responsive
    // between GPS fixes, but we must NOT duplicate the DB writes.
    const nativeActive = !!S._nativeGeoReady;
    for (const p of S.places) {
      const inside = distanceM(lat, lng, p.lat, p.lng) <= p.radius_m;
      const was = S.insidePlaces.has(p.id);
      if (inside && !was) {
        S.insidePlaces.add(p.id);
        if (nativeActive) continue;
        await S.sb.from('checkins').insert({
          keep_id: S.keepId,
          member_id: S.myId,
          member_name: myName,
          member_avatar: myAv,
          type: 'arrived',
          place: p.icon + ' ' + p.name,
          // v13: `place` is a display string composed right here, so it
          // can't be matched back to a place after a rename. place_id is
          // what the per-place mute rule joins on.
          place_id: p.id,
          created_at: ts
        });
        await S.sb.from('keep_members').update({ last_place_id: p.id })
          .eq('id', S.myId);
      } else if (!inside && was) {
        S.insidePlaces.delete(p.id);
        if (nativeActive) continue;
        await S.sb.from('checkins').insert({
          keep_id: S.keepId,
          member_id: S.myId,
          member_name: myName,
          member_avatar: myAv,
          type: 'left',
          place: p.icon + ' ' + p.name,
          place_id: p.id,
          created_at: ts
        });
        // Clear last_place_id only if this was the one they were in.
        if (me && me.last_place_id === p.id) {
          await S.sb.from('keep_members').update({ last_place_id: null })
            .eq('id', S.myId);
        }
      }
    }
  }

  async function addPlace(fields) {
    const name = (fields.name || '').trim();
    if (!name) { toast('Place needs a name', 'err'); return false; }
    const icon = fields.icon || '📍';
    const radius_m = Math.max(25, Math.min(2000, Number(fields.radius_m) || 100));
    const { error } = await S.sb.from('keep_places').insert({
      keep_id: S.keepId,
      name, icon, radius_m,
      lat: fields.lat, lng: fields.lng,
      created_by: S.user.id
    });
    if (error) { toast('Could not add place: ' + error.message, 'err'); return false; }
    toast(icon + ' ' + name + ' saved', 'ok');
    return true;
  }

  async function updatePlace(id, fields) {
    const name = (fields.name || '').trim();
    if (!name) { toast('Place needs a name', 'err'); return false; }
    const icon = fields.icon || '📍';
    const radius_m = Math.max(25, Math.min(2000, Number(fields.radius_m) || 100));
    const patch = { name, icon, radius_m };
    // lat/lng only update if they were dragged (currently we keep them).
    if (typeof fields.lat === 'number') patch.lat = fields.lat;
    if (typeof fields.lng === 'number') patch.lng = fields.lng;
    const { error } = await S.sb.from('keep_places').update(patch).eq('id', id);
    if (error) { toast('Could not update place: ' + error.message, 'err'); return false; }
    toast(icon + ' ' + name + ' updated', 'ok');
    return true;
  }

  async function deletePlace(id) {
    const p = S.places.find(x => x.id === id);
    if (!p) return;
    if (!confirm('Delete place "' + p.name + '"?')) return;
    // Optimistic: drop from local state and re-render so the user sees
    // immediate feedback. Realtime DELETE may or may not arrive (it
    // requires REPLICA IDENTITY FULL on keep_places — see v4.1 migration);
    // either way this path keeps the UI in sync. Roll back on error.
    const idx = S.places.findIndex(x => x.id === id);
    const wasInside = S.insidePlaces.has(id);
    S.places = S.places.filter(x => x.id !== id);
    S.insidePlaces.delete(id);
    renderPlaces();
    drawMap();
    const { error } = await S.sb.from('keep_places').delete().eq('id', id);
    if (error) {
      S.places.splice(Math.max(0, idx), 0, p);
      if (wasInside) S.insidePlaces.add(id);
      renderPlaces();
      drawMap();
      toast('Could not delete place', 'err');
    }
  }

  // ── PLACES UI ──────────────────────────────────────────────────
  function renderPlaces() {
    const host = $('places-list');
    if (!host) return;
    clear(host);
    if (!S.places.length) {
      host.appendChild(el('div', { class: 'empty' }, [
        el('div', { class: 'big', text: '📍' }),
        'No saved places yet'
      ]));
      return;
    }
    const others = S.members.filter(m => m.id !== S.myId);
    for (const p of S.places) {
      const inside = S.insidePlaces.has(p.id);
      const mutedHere = others.filter(m => isMuted(m.id, p.id));
      host.appendChild(el('div', {
        class: 'pl-item' + (inside ? ' here' : ''),
        dataset: { action: 'focus-place', id: p.id }
      }, [
        el('div', { class: 'pl-ic', text: p.icon }),
        el('div', { class: 'pl-main' }, [
          el('div', { class: 'pl-nm', text: p.name }),
          el('div', { class: 'pl-sub', text: (inside ? 'You are here · ' : '') + p.radius_m + 'm radius' }),
          // Say what the setting IS, on the row, so it doesn't take a tap
          // to find out that you have muted someone here and forgotten.
          el('div', { class: 'pl-note', text: placeNotifySummary(p, others, mutedHere) })
        ]),
        el('button', {
          class: 'pl-btn' + (mutedHere.length ? ' muted' : ''),
          dataset: { action: 'place-notify', id: p.id },
          'aria-label': 'Who to notify me about at ' + p.name,
          text: mutedHere.length ? '🔕' : '🔔'
        }),
        el('button', {
          class: 'pl-btn',
          dataset: { action: 'edit-place', id: p.id },
          'aria-label': 'Edit place',
          html: iconSvg('pencil', 18)
        }),
        el('button', {
          class: 'pl-btn danger',
          dataset: { action: 'delete-place', id: p.id },
          'aria-label': 'Delete place',
          html: iconSvg('trash-2', 18)
        })
      ]));
    }
  }

  // One line describing who this place will notify me about.
  function placeNotifySummary(p, others, mutedHere) {
    const me = myMember();
    if (me && me.notify_on_checkin === false) return '🔕 All notifications are off';
    if (!others.length) return '';
    if (!mutedHere.length) return '🔔 Everyone';
    if (mutedHere.length === others.length) return '🔕 Nobody';
    // Naming them is more useful than a count while a family is small,
    // and a family that outgrows it gets the count.
    if (mutedHere.length <= 2) {
      return '🔕 Not ' + mutedHere.map(m => m.name).join(' or ');
    }
    return '🔔 ' + (others.length - mutedHere.length) + ' of ' + others.length;
  }

  // ── PER-PLACE NOTIFY SHEET ─────────────────────────────────────
  function openPlaceNotify(placeId) {
    S.placeNotifyFor = placeId;
    renderPlaceNotifySheet();
    closeDrawer();
    const sheet = $('pn-sheet');
    const scrim = $('pn-scrim');
    if (sheet) { sheet.classList.remove('full'); sheet.classList.add('half', 'open'); }
    if (scrim) scrim.classList.add('on');
    document.body.classList.add('sheet-open');
  }

  function closePlaceNotify() {
    const sheet = $('pn-sheet');
    const scrim = $('pn-scrim');
    if (sheet) sheet.classList.remove('open', 'half', 'full');
    if (scrim) scrim.classList.remove('on');
    document.body.classList.remove('sheet-open');
    S.placeNotifyFor = null;
  }

  function renderPlaceNotifySheet() {
    const p = S.places.find(x => x.id === S.placeNotifyFor);
    const host = $('pn-list');
    if (!p || !host) return;

    const title = $('pn-title');
    if (title) title.textContent = p.icon + ' ' + p.name;

    const me = myMember();
    const globallyOff = !!(me && me.notify_on_checkin === false);
    const warn = $('pn-global-off');
    if (warn) warn.style.display = globallyOff ? 'block' : 'none';

    clear(host);
    const others = S.members.filter(m => m.id !== S.myId);
    if (!others.length) {
      host.appendChild(el('div', { class: 'empty' }, ['Nobody else in your Keep yet']));
      return;
    }
    for (const m of others) {
      const on = !isMuted(m.id, p.id);
      const cb = el('input', {
        type: 'checkbox',
        id: 'pn-' + m.id,
        dataset: { action: 'toggle-place-notify', id: m.id }
      });
      cb.checked = on;
      cb.disabled = globallyOff;
      host.appendChild(el('div', { class: 'setting-row' }, [
        el('span', { class: 'setting-lbl' }, [
          el('span', { class: 'pn-av', text: m.avatar || '🙂' }),
          m.name
        ]),
        el('label', { class: 'switch', for: 'pn-' + m.id }, [
          cb,
          el('span', { class: 'switch-slider' })
        ])
      ]));
    }
  }

  // Mute = INSERT a row, un-mute = DELETE it. Optimistic with rollback,
  // same shape as toggleNotify.
  async function togglePlaceNotify(t, subjectId) {
    const placeId = S.placeNotifyFor;
    if (!placeId || !S.myId) return;
    const wantOn = !!t.checked;          // checked = notify me = no row
    const k = prefKey(subjectId, placeId);
    const member = S.members.find(m => m.id === subjectId);
    const name = member ? member.name : 'them';

    if (wantOn) S.notifyPrefs.delete(k); else S.notifyPrefs.add(k);
    renderPlaces();

    let error;
    if (wantOn) {
      ({ error } = await S.sb.from('keep_notify_prefs').delete()
        .eq('member_id', S.myId)
        .eq('subject_member_id', subjectId)
        .eq('place_id', placeId));
    } else {
      ({ error } = await S.sb.from('keep_notify_prefs').insert({
        keep_id: S.keepId,
        member_id: S.myId,
        subject_member_id: subjectId,
        place_id: placeId
      }));
    }

    if (error) {
      // Put the Set and the switch back — a preference that looks saved
      // and isn't is worse than one that visibly failed.
      if (wantOn) S.notifyPrefs.add(k); else S.notifyPrefs.delete(k);
      t.checked = !wantOn;
      renderPlaces();
      toast('Could not save that: ' + error.message, 'err');
      return;
    }
    const place = S.places.find(x => x.id === placeId);
    const where = place ? place.name : 'this place';
    toast(wantOn ? '🔔 ' + name + ' at ' + where : '🔕 Muted ' + name + ' at ' + where, 'ok');
  }

  function initPlaceIconPicker() {
    const host = $('pe-icons');
    if (!host) return;
    clear(host);
    PLACE_ICONS.forEach((ic, i) => {
      host.appendChild(el('div', {
        class: 'av' + (ic === S.placeIcon ? ' on' : (i === 0 && !S.placeIcon ? ' on' : '')),
        dataset: { action: 'pick-place-icon', icon: ic },
        text: ic
      }));
    });
  }

  function pickPlaceIcon(node, icon) {
    node.closest('.av-row')?.querySelectorAll('.av').forEach(e => e.classList.remove('on'));
    node.classList.add('on');
    S.placeIcon = icon;
  }

  function openPlaceEditor(lat, lng, existingId) {
    if (typeof lat !== 'number' || typeof lng !== 'number') {
      toast('No location yet — grant location permission first', 'err');
      return;
    }
    const existing = existingId ? S.places.find(p => p.id === existingId) : null;
    const editing = !!existing;

    S.placePicker = { lat, lng, id: editing ? existing.id : null };
    S.placeIcon = editing ? existing.icon : PLACE_ICONS[0];
    S.placeRadius = editing ? existing.radius_m : 100;

    // Title + CTA copy reflect mode.
    const title = $('pe-title');
    if (title) title.textContent = editing ? 'Edit Place' : 'New Place';
    const saveBtn = $('pe-save');
    if (saveBtn) saveBtn.innerHTML = iconSvg('save') + ' ' + (editing ? 'Update place' : 'Save place');

    // Form values.
    const nameIn = $('pe-name');
    if (nameIn) {
      nameIn.value = editing ? existing.name : '';
      setTimeout(() => nameIn.focus(), 250);
    }
    const rIn = $('pe-radius');
    if (rIn) rIn.value = String(S.placeRadius);
    const rLbl = $('pe-radius-lbl');
    if (rLbl) rLbl.textContent = String(S.placeRadius);
    const coord = $('pe-coord');
    if (coord) coord.textContent = '📍 ' + lat.toFixed(5) + ', ' + lng.toFixed(5);

    initPlaceIconPicker();

    // Close the drawer so the map (and preview ring) is visible behind the sheet.
    closeDrawer();

    // Open the bottom sheet at half height; user can drag to full.
    const sheet = $('place-sheet');
    const scrim = $('place-sheet-scrim');
    if (sheet) {
      sheet.classList.remove('full', 'dragging');
      sheet.classList.add('half', 'open');
    }
    if (scrim) scrim.classList.add('on');
    document.body.classList.add('sheet-open');

    // Centre the map on the place so the preview ring is visible.
    S.mLat = lat; S.mLng = lng; S.mZoom = Math.max(S.mZoom, 15);
    drawMap();
  }

  function cancelPlaceEdit() {
    const sheet = $('place-sheet');
    const scrim = $('place-sheet-scrim');
    if (sheet) sheet.classList.remove('open', 'half', 'full', 'dragging');
    if (scrim) scrim.classList.remove('on');
    document.body.classList.remove('sheet-open');
    S.placePicker = null;
    drawMap();
  }

  // Drag/tap gesture for EVERY sheet that has a handle (not just the place
  // editor). Position is driven by an inline translateY offset, never by
  // mutating height — the old code grew style.height while the .half class
  // pinned the visible height to 380px, so dragging revealed nothing and the
  // action button (e.g. "Update place") stayed unreachable. On release we snap
  // to full / half / close; a tap toggles half<->full. Gated to touch: on
  // desktop the sheet is a centered modal and the X is the control.
  const SHEET_PEEK = 380; // must match .sheet.half translateY(calc(100% - 380px))
  function initSheets() {
    const sheets = Array.from(document.querySelectorAll('.sheet'))
      .filter((s) => s.querySelector('.sheet-handle'));
    if (!sheets.length) return;
    const coarse = () => window.matchMedia('(pointer: coarse)').matches;
    let active = null, startY = 0, baseT = 0, boxH = 0, moved = 0, downT = 0;
    let lastY = 0, lastT = 0, prevY = 0, prevT = 0;

    const stateOffset = (sheet, H) =>
      sheet.classList.contains('full') ? 0 : Math.max(0, H - SHEET_PEEK);

    const onDown = (sheet, e) => {
      if (!coarse()) return; // desktop: no drag, use the X
      if (!sheet.classList.contains('open')) return; // never drag a parked/closed sheet
      const pt = e.touches ? e.touches[0] : e;
      active = sheet;
      boxH = sheet.getBoundingClientRect().height;
      baseT = stateOffset(sheet, boxH);
      startY = prevY = lastY = pt.clientY;
      downT = prevT = lastT = performance.now();
      moved = 0;
      sheet.classList.add('dragging');
    };
    const onMove = (e) => {
      if (!active) return;
      const pt = e.touches ? e.touches[0] : e;
      const dy = pt.clientY - startY;
      moved = Math.max(moved, Math.abs(dy));
      let t = baseT + dy;
      if (t < 0) t = 0; else if (t > boxH) t = boxH;
      active.style.transform = 'translateY(' + t + 'px)';
      prevY = lastY; prevT = lastT;
      lastY = pt.clientY; lastT = performance.now();
      if (e.cancelable) e.preventDefault(); // stop the map/body scrolling under us
    };
    const onUp = () => {
      if (!active) return;
      const sheet = active; active = null;
      sheet.classList.remove('dragging');
      const H = boxH;
      const m = /translateY\(([-\d.]+)px\)/.exec(sheet.style.transform || '');
      const t = m ? parseFloat(m[1]) : baseT;
      sheet.style.transform = ''; // hand back to the class-based transforms
      const v = (lastY - prevY) / Math.max(1, lastT - prevT); // px/ms, +ve = down
      const dur = performance.now() - downT;

      if (moved < 6 && dur < 300) { // tap → toggle half<->full
        const full = sheet.classList.toggle('full');
        sheet.classList.toggle('half', !full);
        return;
      }
      const visible = H - t;
      if (visible < 140 || v > 1.1) { // dragged/flicked down → close via the sheet's own closer
        const act = sheet.querySelector('.sheet-x')?.dataset.action;
        if (act && ACTIONS[act]) ACTIONS[act]();
        else sheet.classList.remove('open', 'half', 'full');
        return;
      }
      if (visible > (SHEET_PEEK + H) / 2) {
        sheet.classList.remove('half'); sheet.classList.add('full');
      } else {
        sheet.classList.remove('full'); sheet.classList.add('half');
      }
    };

    sheets.forEach((sheet) => {
      const handle = sheet.querySelector('.sheet-handle');
      handle.addEventListener('touchstart', (e) => onDown(sheet, e), { passive: true });
      handle.addEventListener('mousedown', (e) => onDown(sheet, e));
    });
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('mousemove', onMove);
    window.addEventListener('touchend', onUp);
    window.addEventListener('mouseup', onUp);
  }

  function initKeyboardInsets() {
    // The WebView is NOT resized for the IME (Keyboard resize:none) — that
    // doesn't shrink under this app's edge-to-edge layout, so the keyboard
    // just overlaps. Instead we set --kb (the occluded height) and float the
    // open sheet / login card above it. The native Keyboard event is a
    // reliable "keyboard is up" signal + height on the app; visualViewport
    // refines it to the EXACT occlusion (native keyboardHeight over-lifts on
    // some devices) and is the sole driver on the PWA.
    const root = document.documentElement;
    let kb = -1, kbOpen = false;
    const setKb = (px) => {
      const v = Math.max(0, Math.round(px || 0));
      if (v === kb) return;
      kb = v;
      root.style.setProperty('--kb', v + 'px');
    };
    setKb(0);
    const KB = window.Capacitor?.Plugins?.Keyboard;
    const native = KB && typeof KB.addListener === 'function';
    if (native) {
      KB.addListener('keyboardWillShow', (info) => { kbOpen = true; setKb(info && info.keyboardHeight); });
      KB.addListener('keyboardWillHide', () => { kbOpen = false; setKb(0); });
    }
    const vv = window.visualViewport;
    if (vv) {
      const onVV = () => {
        const occluded = window.innerHeight - (vv.height + vv.offsetTop);
        const val = occluded > 80 ? occluded : 0; // ignore small browser-UI shifts
        if (native) {
          // Refine the native lift to the exact occlusion, but never zero it
          // while the keyboard is up — keyboardWillHide owns closing.
          if (kbOpen && val > 0) setKb(val);
        } else {
          setKb(val);
        }
      };
      vv.addEventListener('resize', onVV);
      vv.addEventListener('scroll', onVV);
    }
    // Keep the focused field visible within a tall sheet or the login card.
    document.addEventListener('focusin', (e) => {
      const el = e.target;
      if (!el || !el.matches || !el.matches('input, textarea')) return;
      setTimeout(() => {
        try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (_) {}
      }, 250);
    });
  }

  async function savePlaceFromForm() {
    if (!S.placePicker) { cancelPlaceEdit(); return; }
    const name = $('pe-name')?.value || '';
    const radius_m = Number($('pe-radius')?.value) || 100;
    const { lat, lng, id } = S.placePicker;
    const ok = id
      ? await updatePlace(id, { name, icon: S.placeIcon, radius_m })
      : await addPlace({ name, icon: S.placeIcon, radius_m, lat, lng });
    if (ok) cancelPlaceEdit();
  }

  function editPlace(id) {
    const p = S.places.find(x => x.id === id);
    if (!p) return;
    openPlaceEditor(p.lat, p.lng, p.id);
  }

  function addPlaceAtMyLocation() {
    const me = S.members.find(m => m.id === S.myId);
    let lat = me && me.lat, lng = me && me.lng;
    if (lat == null || lng == null) {
      // Fall back to current map centre so the user can still drop a pin
      // before first GPS fix — they can walk into range later.
      lat = S.mLat; lng = S.mLng;
    }
    openPlaceEditor(lat, lng);
  }

  function focusPlace(id) {
    const p = S.places.find(x => x.id === id);
    if (!p) return;
    S.mLat = p.lat; S.mLng = p.lng; S.mZoom = 16;
    drawMap();
    $('sidebar')?.classList.remove('mob');
  }

  // Foreground location prompt, split out of startGPS so launchApp can
  // await it BEFORE arming geofences. Ordering matters more than it
  // looks: addGeofence refuses to register without location permission,
  // so arming first meant a first run registered nothing at all.
  // True between opening the first-run disclosure sheet and the user acting
  // on it.
  //
  // THE RULE: while this is set, NOTHING may raise a system permission
  // dialog. The only thing allowed to request a permission is the user
  // tapping Allow on a row of the sheet. Play requires the disclosure to
  // precede the request and the request to follow an affirmative action,
  // and a dialog landing on top of the sheet fails both.
  //
  // This has been got wrong three times, each time by fixing one call site
  // instead of the rule, so here is the complete set. Anything added to it
  // must be gated:
  //
  //   ensureLocationPermission()   explicit  ACCESS_FINE_LOCATION
  //   startGPS() watchPosition     IMPLICIT  — @capacitor/geolocation asks
  //                                            by itself when a method is
  //                                            called without permission
  //   onResume() getCurrentPosition IMPLICIT — same, and the whole block is
  //                                            skipped because falling
  //                                            through to
  //                                            navigator.geolocation
  //                                            prompts via the WebView
  //   initPushNotifications()      explicit  POST_NOTIFICATIONS (API 33+),
  //                                            fired un-awaited by launchApp
  //
  // Cleared by setupFixLocation (the affirmative tap) and by closeSetup
  // (dismissing counts as having seen it). Both then restart what was held.
  let _disclosurePending = false;

  async function ensureLocationPermission() {
    if (!isNative()) return;
    if (_disclosurePending) return;
    const Geo = window.Capacitor.Plugins && window.Capacitor.Plugins.Geolocation;
    if (!Geo || !Geo.requestPermissions) return;
    try {
      const perm = await Geo.requestPermissions({ permissions: ['location'] });
      if (perm && perm.location !== 'granted' && perm.location !== 'prompt') {
        toast('Location permission denied', 'err');
      }
    } catch (_) { /* some OEMs throw on already-granted; ignore */ }
  }

  async function startGPS() {
    // While the user has paused their own location, arm nothing — the
    // pause has to actually stop tracking, not just flag a column. The
    // auto-resume watcher re-runs startGPS + initNativeGeofence at expiry.
    if (isPausedRow(myMember())) return;
    // Hold everything while the first-run disclosure is on screen.
    // @capacitor/geolocation REQUESTS THE PERMISSION ITSELF when one of its
    // methods is called without it — so gating ensureLocationPermission()
    // alone (4.5.3) achieved nothing: watchPosition below raised the system
    // dialog over the disclosure sheet moments later, which is the exact
    // ordering Play rejects. setupFixLocation calls restartGPS() once the
    // user has actually tapped Allow, so nothing is lost by waiting.
    if (_disclosurePending) return;
    if (isNative()) {
      const Geo = window.Capacitor.Plugins && window.Capacitor.Plugins.Geolocation;
      // Normally already answered by launchApp; harmless if so.
      await ensureLocationPermission();

      // Background trail + live pin: our own foreground service owns the
      // FusedLocation updates (via LocationUpdateReceiver). It survives
      // the app being backgrounded/killed and keeps the app out of the
      // App Standby throttle — the reliable path that replaced the
      // community background-geolocation plugin.
      startNativeLocationUpdates();

      // Foreground smoothness: a plain @capacitor/geolocation watch gives
      // frequent updates on the user's own map while the app is open.
      // Foreground-only — when backgrounded, the native service takes over.
      if (Geo && Geo.watchPosition) {
        try {
          S.geoWatchId = await Geo.watchPosition(
            { enableHighAccuracy: true, timeout: 20000 },
            (pos, err) => {
              if (err || !pos || !pos.coords) return;
              pushLocation(pos.coords.latitude, pos.coords.longitude, pos.timestamp, pos.coords.speed);
            }
          );
        } catch (e) { console.warn('watchPosition failed', e); }
      }
      return;
    }

    // Web / PWA path
    if (!navigator.geolocation) return;
    navigator.geolocation.watchPosition(
      (pos) => pushLocation(pos.coords.latitude, pos.coords.longitude, pos.timestamp),
      null,
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 }
    );
  }

  // Live / Stale header badge. When the BG-geolocation watcher hasn't
  // pushed a fix in > STALE_LBL_MS the badge flips to a tap-to-refresh
  // affordance — much better than the user wondering whether the app
  // froze. Tap fires the same recovery path as appStateChange.active.
  const STALE_LBL_MS = 5 * 60 * 1000;
  function refreshLiveBadge() {
    const badge = $('live-badge');
    const lbl = $('live-lbl');
    if (!badge || !lbl) return;
    const fresh = S.lastFixMs && (Date.now() - S.lastFixMs <= STALE_LBL_MS);
    if (fresh) {
      badge.classList.remove('stale');
      lbl.textContent = 'Live';
    } else {
      badge.classList.add('stale');
      lbl.textContent = '🕗 Tap to refresh';
    }
  }

  // Tear down the foreground location watch (if any) and start fresh.
  // Used by the resume health check when fixes have gone silent. The
  // native foreground service is re-armed by startGPS → it's idempotent.
  // Safe to call when no watch exists; safe to call repeatedly.
  async function restartGPS() {
    const Geo = window.Capacitor?.Plugins?.Geolocation;
    if (Geo && S.geoWatchId != null && Geo.clearWatch) {
      try { await Geo.clearWatch({ id: S.geoWatchId }); }
      catch (e) { console.warn('clearWatch', e); }
      S.geoWatchId = null;
    }
    await startGPS();
  }

  function trackBattery() {
    try {
      if (navigator.getBattery) {
        navigator.getBattery().then((b) => {
          const upd = (level) => {
            S.sb.from('keep_members').update({ battery: Math.round(level * 100) })
              .eq('id', S.myId).then(() => {});
          };
          upd(b.level);
          b.addEventListener('levelchange', () => upd(b.level));
        });
      }
    } catch (_) {}
  }

  // ── RENDER (safe — no innerHTML concat of user data) ───────────
  // ── WHERE SOMEONE IS, IN WORDS ─────────────────────────────────
  //
  // Everything here is computed ON THIS DEVICE from data the family
  // already holds. There is deliberately no reverse geocoding: turning
  // coordinates into "Near Bondi Junction" means sending a family
  // member's live position to a third party on every render, which is
  // exactly what this app promises never to happen. A nearest-saved-place
  // reading is less precise and costs nobody anything.

  // Beyond this, "3 km from Home" stops being a useful description of
  // where someone is and becomes a fact about how far away Home is.
  const NEAR_PLACE_MAX_M = 5000;

  /** Decimal degrees — the one format Google Maps, Apple Maps and Waze
   *  all accept pasted into search. 5dp is ~1 m, past which we would be
   *  quoting precision GPS does not have. */
  function formatCoords(lat, lng) {
    return Number(lat).toFixed(5) + ', ' + Number(lng).toFixed(5);
  }

  /** The saved place a position is inside, or null. */
  function placeContaining(lat, lng) {
    for (const p of (S.places || [])) {
      if (distanceM(lat, lng, p.lat, p.lng) <= p.radius_m) return p;
    }
    return null;
  }

  /** Nearest saved place and how far, or null when there are no places. */
  function nearestPlace(lat, lng) {
    let best = null, bestD = Infinity;
    for (const p of (S.places || [])) {
      const d = distanceM(lat, lng, p.lat, p.lng);
      if (d < bestD) { bestD = d; best = p; }
    }
    return best ? { place: best, metres: bestD } : null;
  }

  function formatDistance(m) {
    if (m < 1000) return Math.round(m / 10) * 10 + ' m';
    return (m / 1000).toFixed(m < 10000 ? 1 : 0) + ' km';
  }

  /**
   * One line saying where a member is.
   *
   * Order of preference: the place they are checked into, then the
   * nearest saved place if one is close enough to be a landmark, then
   * raw coordinates. Returns '' when there is no position at all, so
   * callers can leave the line out rather than print "unknown".
   */
  function whereIs(m) {
    if (!m || typeof m.lat !== 'number' || typeof m.lng !== 'number') return '';

    // last_place_id is the authoritative "they are checked in here" —
    // written on arrive, cleared on leave — so prefer it over recomputing
    // from coordinates, which can disagree at a boundary.
    if (m.last_place_id) {
      const p = (S.places || []).find(x => x.id === m.last_place_id);
      if (p) return 'At ' + p.icon + ' ' + p.name;
    }
    // No check-in, but they may still be standing inside a place added
    // since — or one whose arrival was missed.
    const inside = placeContaining(m.lat, m.lng);
    if (inside) return 'At ' + inside.icon + ' ' + inside.name;

    const near = nearestPlace(m.lat, m.lng);
    if (near && near.metres <= NEAR_PLACE_MAX_M) {
      return formatDistance(near.metres) + ' from ' + near.place.icon + ' ' + near.place.name;
    }
    return formatCoords(m.lat, m.lng);
  }

  function renderMembers() {
    const host = $('members-list');
    if (!host) return;
    clear(host);
    if (!S.members.length) {
      host.appendChild(el('div', { class: 'empty' }, [
        el('div', { class: 'big', text: '👀' }),
        'No members yet'
      ]));
      return;
    }
    const viewerOwner = amOwner();

    for (const m of S.members) {
      const isMe = m.id === S.myId;
      const paused = isPausedRow(m);
      const bc = m.battery <= 15 ? 'lo' : m.battery <= 40 ? 'md' : 'hi';

      const avWrap = el('div', { class: 'mc-av', text: m.avatar });
      avWrap.appendChild(el('div', { class: 'mc-dot' + (m.online ? '' : ' off') }));

      const nameEl = el('div', { class: 'mc-name' }, [m.name]);
      if (isMe) nameEl.appendChild(el('span', { class: 'mc-you', text: ' (You)' }));

      // Role / type / paused badges next to the name.
      const badges = el('span', { class: 'mc-badges' });
      if (m.role === 'owner') badges.appendChild(el('span', { class: 'mc-badge owner', text: '👑 Owner' }));
      if (m.member_type === 'child') badges.appendChild(el('span', { class: 'mc-badge child', text: '🧒 Child' }));
      if (paused) badges.appendChild(el('span', { class: 'mc-badge paused', text: '⏸ Paused' }));
      if (badges.childNodes.length) nameEl.appendChild(badges);

      // Status line. Paused takes visible priority over a stale pin so it
      // never reads as an emergency; SOS still wins over everything.
      const statusText = m.sos ? '🆘 SOS ALERT!'
        : paused ? ('⏸ Location paused' + (m.paused_until ? ' · resumes ' + pauseClock(m.paused_until) : ''))
        : (m.status || '');

      // Where they are, under the status line. Suppressed while paused —
      // the member deliberately went dark, and their last known position
      // is exactly what they chose to stop sharing. Suppressed on SOS
      // too, because the status line is already shouting and the
      // navigable position belongs on the SOS activity entry.
      const whereText = (paused || m.sos) ? '' : whereIs(m);

      const main = el('div', { class: 'mc-main' }, [
        nameEl,
        el('div', { class: 'mc-st', text: statusText }),
        whereText ? el('div', { class: 'mc-where', text: '📍 ' + whereText }) : null
      ]);

      // Hide battery/last-seen while paused — the member deliberately went
      // dark; showing a fresh clock there would undercut the paused signal.
      const meta = el('div', { class: 'mc-meta' }, paused ? [] : [
        el('div', { class: 'batt ' + bc, text: '🔋 ' + m.battery + '%' }),
        el('div', { class: 'mc-ago', text: timeAgo(m.last_seen) })
      ]);

      // Pencil to edit name + avatar. Your own row always; anyone else only
      // for an owner (the server enforces the same rule). Its own data-action
      // means a tap edits rather than focuses the card.
      if (isMe || viewerOwner) {
        meta.appendChild(el('button', {
          class: 'mc-edit',
          dataset: { action: 'open-profile-edit', id: m.id },
          text: '✏️',
          'aria-label': isMe ? 'Edit my profile' : 'Edit ' + m.name
        }));
      }

      const card = el('div', {
        class: 'mc' + (m.sos ? ' sos-c' : '') + (isMe ? ' me-c' : '') + (paused ? ' paused-c' : ''),
        dataset: { action: 'focus-member', id: m.id }
      }, [avWrap, main, meta]);

      // Management actions on OTHER members — OWNER ONLY. Owners are the
      // family admins: they set adult/child, promote/demote owners, and
      // remove members. Non-owners see no management controls. Never on
      // your own row.
      if (!isMe && viewerOwner) {
        const acts = el('div', { class: 'mc-actions' }, [
          el('button', {
            class: 'mc-act',
            dataset: { action: 'set-member-type', id: m.id, type: m.member_type === 'child' ? 'adult' : 'child' },
            text: m.member_type === 'child' ? 'Mark adult' : 'Mark child'
          }),
          el('button', {
            class: 'mc-act',
            dataset: { action: 'set-member-role', id: m.id, role: m.role === 'owner' ? 'member' : 'owner' },
            text: m.role === 'owner' ? 'Remove owner' : 'Make owner'
          }),
          el('button', {
            class: 'mc-act danger',
            dataset: { action: 'remove-member', id: m.id, name: m.name },
            text: 'Remove'
          })
        ]);
        card.appendChild(acts);
      }

      host.appendChild(card);
    }

    // Sync the notification mute toggle's checked state from the
    // current member row. Default TRUE (notifications on) matches the
    // schema default — but we read the row to handle the user having
    // toggled it before.
    const toggle = $('notify-toggle');
    if (toggle) {
      const me = myMember();
      toggle.checked = !me || me.notify_on_checkin !== false;
    }

    // Owner-only Invite button in the header; adult-only self-pause block.
    const invBtn = $('invite-btn');
    if (invBtn) invBtn.style.display = viewerOwner ? '' : 'none';
    renderPauseBlock();
    renderFamilyNameSetting();
    // Whether Leave is offered depends on member_type and on how many
    // owners are left, both of which this render already reflects.
    renderLeaveKeep();
  }

  // ── FAMILY NAME (owner only) ───────────────────────────────────
  // A rename of the keep. `keeps` has no client UPDATE policy, so this
  // goes through the owner-gated rename_keep RPC. The whole Settings block
  // is hidden for non-owners (like the Invite button), and the pencil
  // swaps the resting row for an inline field in place.
  function renderFamilyNameSetting() {
    const block = $('family-name-block');
    if (!block) return;
    if (!amOwner()) { block.style.display = 'none'; return; }
    block.style.display = '';
    const val = $('family-name-val');
    if (val) val.textContent = S.keepName || '—';
    showFamilyNameEdit(false);
  }

  function showFamilyNameEdit(editing) {
    const view = $('family-name-view');
    const edit = $('family-name-edit');
    if (view) view.style.display = editing ? 'none' : '';
    if (edit) edit.style.display = editing ? '' : 'none';
  }

  function editFamilyName() {
    const input = $('family-name-input');
    if (input) input.value = S.keepName || '';
    showFamilyNameEdit(true);
    if (input) setTimeout(() => input.focus(), 50);
  }

  function cancelFamilyName() { showFamilyNameEdit(false); }

  async function saveFamilyName() {
    const input = $('family-name-input');
    const name = (input ? input.value : '').trim();
    if (!name) { toast('Please enter a family name', 'err'); return; }
    const btn = $('family-name-save');
    if (btn) btn.disabled = true;
    try {
      const { data, error } = await S.sb.rpc('rename_keep', { p_keep_id: S.keepId, p_name: name });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      S.keepName = (row && row.keep_name) || name;
      const sub = $('hdr-sub'); if (sub) sub.textContent = S.keepName;
      const val = $('family-name-val'); if (val) val.textContent = S.keepName;
      showFamilyNameEdit(false);
      toast('✅ Family name updated', 'ok');
    } catch (e) {
      toast(mapRpcError(e), 'err');
    } finally { if (btn) btn.disabled = false; }
  }

  // ── PROFILE EDIT (own row always; owner on any row) ────────────
  // Edit a member's display name + avatar via the owner-or-self
  // update_member_profile RPC. Reuses the bottom-sheet + avatar-picker
  // pattern; the picker seeds S.selAv to the current avatar and reuses the
  // existing `pick-avatar` action (scoped to its own .av-row).
  function openProfileEditor(t) {
    const id = t.dataset.id;
    const m = S.members.find(x => x.id === id);
    if (!m) return;
    S.profileEdit = { memberId: id };
    S.selAv = m.avatar;

    const title = $('pf-title');
    if (title) title.textContent = (id === S.myId) ? 'Edit my profile' : 'Edit ' + m.name + '’s profile';
    const nameIn = $('pf-name');
    if (nameIn) { nameIn.value = m.name; setTimeout(() => nameIn.focus(), 250); }

    const host = $('pf-avs');
    if (host) {
      clear(host);
      AVATARS.forEach(a => host.appendChild(el('div', {
        class: 'av' + (a === m.avatar ? ' on' : ''),
        dataset: { action: 'pick-avatar', avatar: a },
        text: a
      })));
    }

    closeDrawer();
    const sheet = $('profile-sheet');
    const scrim = $('profile-scrim');
    if (sheet) { sheet.classList.remove('full'); sheet.classList.add('half', 'open'); }
    if (scrim) scrim.classList.add('on');
    document.body.classList.add('sheet-open');
  }

  function cancelProfile() {
    const sheet = $('profile-sheet');
    const scrim = $('profile-scrim');
    if (sheet) sheet.classList.remove('open', 'half', 'full');
    if (scrim) scrim.classList.remove('on');
    document.body.classList.remove('sheet-open');
    S.profileEdit = null;
  }

  async function saveProfile() {
    const edit = S.profileEdit;
    if (!edit) return;
    const nameIn = $('pf-name');
    const name = (nameIn ? nameIn.value : '').trim();
    if (!name) { toast('Please enter a display name', 'err'); return; }
    const avatar = S.selAv;
    const btn = $('pf-save');
    if (btn) btn.disabled = true;
    try {
      const { error } = await S.sb.rpc('update_member_profile', {
        p_member_id: edit.memberId, p_name: name, p_avatar: avatar
      });
      if (error) throw error;
      // Optimistic local patch — the realtime channel also fires an UPDATE,
      // but we don't want a visual wait for it.
      const m = S.members.find(x => x.id === edit.memberId);
      if (m) { m.name = name; m.avatar = avatar; }
      cancelProfile();
      renderMembers();
      renderPins();
      drawMap();
      toast('✅ Profile updated', 'ok');
    } catch (e) {
      toast(mapRpcError(e), 'err');
    } finally { if (btn) btn.disabled = false; }
  }

  // Self-pause block (Family → Settings). Visible only to adults — a child
  // can't self-pause (also enforced server-side; the UI hide is just to
  // avoid offering a control that would be rejected). Reflects the current
  // paused state with an early-resume button.
  function renderPauseBlock() {
    const block = $('pause-block');
    if (!block) return;
    const me = myMember();
    const isChild = !!me && me.member_type === 'child';
    if (!me || isChild) { block.style.display = 'none'; return; }
    block.style.display = '';

    const paused = isPausedRow(me);
    const opts = $('pause-opts');
    const status = $('pause-status');
    if (opts) opts.style.display = paused ? 'none' : '';
    if (!status) return;
    clear(status);
    if (paused) {
      status.className = 'pause-status on';
      status.appendChild(el('span', { text: '⏸ Paused · resumes ' + pauseClock(me.paused_until) + ' ' }));
      status.appendChild(el('button', {
        class: 'pause-resume', dataset: { action: 'resume-me' }, text: 'Resume now'
      }));
    } else {
      status.className = 'pause-status';
      status.textContent = '';
    }
  }

  async function toggleNotify(t) {
    if (!S.myId) return;
    const next = !!t.checked;
    try {
      const { error } = await S.sb.from('keep_members')
        .update({ notify_on_checkin: next }).eq('id', S.myId);
      if (error) throw error;
      // Optimistic local state — the realtime channel will also fire
      // an UPDATE, but we don't want a visual flicker waiting for it.
      const me = S.members.find(x => x.id === S.myId);
      if (me) me.notify_on_checkin = next;
      toast(next ? '🔔 Notifications on' : '🔕 Notifications muted', 'ok');
    } catch (e) {
      toast('Could not update notifications: ' + e.message, 'err');
      t.checked = !next; // rollback
    }
  }

  /**
   * Open the phone's navigation app at a position.
   *
   * `geo:` is the Android intent that lets the user pick their own nav
   * app, so it is tried first and is what a family member on Android
   * gets. It does nothing on desktop and in some WebViews, so a Google
   * Maps URL is the fallback — universal, and the same coordinates.
   *
   * Both are plain coordinates in a URL the user's own app resolves.
   * Nothing is sent anywhere by us.
   */
  function sosNavigate(t) {
    const lat = Number(t.dataset.lat), lng = Number(t.dataset.lng);
    if (!isFinite(lat) || !isFinite(lng)) return;
    const label = encodeURIComponent('SOS');
    const webUrl = 'https://www.google.com/maps/search/?api=1&query=' + lat + ',' + lng;
    if (isNative()) {
      try {
        // ?q= makes the pin land exactly here rather than centring
        // loosely, which matters when someone is following it.
        window.location.href = 'geo:' + lat + ',' + lng + '?q=' + lat + ',' + lng + '(' + label + ')';
        return;
      } catch (_) { /* fall through to the URL */ }
    }
    window.open(webUrl, '_blank', 'noopener');
  }

  async function sosCopy(t) {
    const coords = t.dataset.coords || '';
    if (!coords) return;
    try {
      await navigator.clipboard.writeText(coords);
      toast('📋 ' + coords + ' copied', 'ok');
    } catch (_) {
      // Clipboard is permission-gated and absent over plain http. Select
      // the text instead so it can still be copied by hand — better than
      // a dead button in an emergency.
      try {
        const r = document.createRange();
        r.selectNodeContents(t);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
        toast('Select and copy the coordinates', 'err');
      } catch (_) {}
    }
  }

  function renderCheckins() {
    const host = $('ci-feed');
    if (!host) return;
    clear(host);
    if (!S.checkins.length) {
      host.appendChild(el('div', { class: 'empty' }, [
        el('div', { class: 'big', text: '📭' }),
        'No activity yet'
      ]));
      return;
    }
    for (const c of S.checkins) {
      const type = (c.type || 'manual').toLowerCase();
      const body = el('div', {}, [
        el('div', { class: 'ci-nm', text: c.member_name }),
        el('div', { class: 'ci-pl', text: c.place }),
        el('span', { class: 'ci-badge ' + type, text: type.charAt(0).toUpperCase() + type.slice(1) }),
        el('div', { class: 'ci-tm', text: formatActivityTime(c.created_at) })
      ]);

      // An SOS that carries a position gets a navigable one. Whoever
      // reads this needs to GET THERE, and the two things that actually
      // achieve that are opening a nav app and pasting coordinates into
      // one — so offer both rather than making them retype anything.
      //
      // Rows written before v13 have no lat/lng; absence is normal and
      // the block is simply left out.
      if (type === 'sos' && typeof c.lat === 'number' && typeof c.lng === 'number') {
        const coords = formatCoords(c.lat, c.lng);
        // Where it happened, in the same words the Family tab uses, so
        // "1.2 km from Home" reads consistently across the app.
        const near = nearestPlace(c.lat, c.lng);
        const hint = near && near.metres <= NEAR_PLACE_MAX_M
          ? formatDistance(near.metres) + ' from ' + near.place.icon + ' ' + near.place.name
          : '';

        body.appendChild(el('div', { class: 'ci-loc' }, [
          hint ? el('div', { class: 'ci-loc-hint', text: hint }) : null,
          el('div', { class: 'ci-coords' }, [
            el('button', {
              class: 'ci-nav',
              dataset: { action: 'sos-navigate', lat: String(c.lat), lng: String(c.lng) },
              text: '🧭 Directions'
            }),
            el('button', {
              class: 'ci-copy',
              dataset: { action: 'sos-copy', coords: coords },
              title: 'Copy coordinates',
              text: coords
            })
          ])
        ]));
      }

      host.appendChild(el('div', { class: 'ci-item' }, [
        el('div', { class: 'ci-av', text: c.member_avatar }),
        body
      ]));
    }
  }

  // ── HISTORY TIMELINE ───────────────────────────────────────────
  // Per-member, per-day journal for the past week: stays at saved
  // places (reconstructed from arrived/left check-in pairs — breadcrumbs
  // are suppressed inside places, so check-ins are the only stay signal)
  // interleaved with trips (segmentTrips over that day's breadcrumbs).
  // Loaded on demand when the tab opens — nothing here runs otherwise.
  const HISTORY_DAYS = 7;
  const TRIP_MIN_M = 120;        // shorter than this is GPS noise, not a trip
  // A trip must not just have PATH, it must have RANGE. Drift is a random
  // walk: its summed path grows with the number of samples while its distance
  // from where it started does not, which is how an afternoon at home
  // presented as "Drive · 4.6 km". spanM is the furthest the device ever got
  // from the trip's first point, so a there-and-back scores its half-length.
  //
  // Deliberately the same number as TRIP_MIN_M, because that makes the new
  // rule cost almost nothing: any ONE-WAY trip clearing 120 m of path has a
  // span of at least 120 m and passes unchanged. The only new casualty is an
  // out-and-back shorter than 240 m of path — you went less than 120 m from
  // the door and came straight back — which is the class TRIP_MIN_M's own
  // comment already calls GPS noise.
  //
  // NOT a spanM/distM ratio: ten laps of a running track score 0.03, and a
  // ratio test would delete a real workout.
  const TRIP_SPAN_MIN_M = 120;
  // A leg implying more than this is one bad fix, not travel — ~324 km/h,
  // above every road and nearly every railway. Set high on purpose: the read
  // side cannot see accuracy, so it must only reject the unarguable.
  const MAX_LEG_SPEED_MS = 90;
  // Floor on a leg's elapsed time, so a one-second gap between two fixes
  // cannot manufacture an implied speed out of ordinary jitter.
  const MIN_LEG_DT_S = 2;
  // A stored speed is only believed when the path around that point can
  // support it — and the test has to be a RATIO, not a floor. Drift produces
  // apparent motion of its own: the fuzzy fixes hop tens of metres between
  // samples, so the breadcrumbs either side of a bad reading are not still,
  // and an absolute threshold never fires. What gives the reading away is
  // the disagreement — the "top 139 km/h" spike sat on a path moving at
  // 1.4 m/s. Only a speed that is itself claiming a DRIVE is ever
  // questioned, and then only if the path around it is more than this factor
  // slower; generous on purpose, because a fix caught pulling away from a
  // red light legitimately outruns the leg that spanned the wait. Rows like
  // that are already stored, so the native speed-trust gate cannot repair
  // them retroactively; this can.
  const SPEED_CORROB_MULT = 4;

  // How far outside a place's radius a fix may land and still count as "at"
  // that place for the doorstep test below. Breadcrumbs are meant to be
  // suppressed inside places; what leaks out is a fuzzy fix sitting within
  // its own error of the edge, which is tens of metres, not hundreds.
  const DOORSTEP_PAD_M = 120;

  /** A "trip" that began and ended at the same saved place, faster than a
   *  stop even registers, did not happen. That is the doorstep-drift
   *  signature: points leaking out around a place and coming straight back —
   *  the "Drive · 501 m · top 73 km/h" filed while the phone sat at home,
   *  whose very fixes the geofence journal was flagging as drift at the same
   *  moment ("fuzzy fix ±66m within 46m of edge — drift, dropped").
   *
   *  Conditional on a saved place on purpose: the identical geometry away
   *  from any place is kept, because there we have no reason to disbelieve
   *  it. */
  function isDoorstepDrift(t) {
    if (!t || !t.pts || t.pts.length < 2) return false;
    if (t.durMs >= TRIP_GAP_MS) return false;
    const a = t.pts[0], b = t.pts[t.pts.length - 1];
    for (const p of (S.places || [])) {
      const r = p.radius_m + DOORSTEP_PAD_M;
      if (distanceM(a.lat, a.lng, p.lat, p.lng) > r) continue;
      if (distanceM(b.lat, b.lng, p.lat, p.lng) > r) continue;
      // Began and ended at this place — but that alone is just a round
      // trip, which is what most errands are. Drift is a trip that never
      // actually LEFT, so the furthest point from the place has to settle
      // it. Without this the test threw away a real 7-minute drive to a
      // saved place and back, while the identically-shaped 17-minute walk
      // an hour earlier survived — the only thing separating them was
      // TRIP_GAP_MS, which has nothing to say about whether a trip is real.
      let far = 0;
      for (const q of t.pts) {
        const d = distanceM(q.lat, q.lng, p.lat, p.lng);
        if (d > far) far = d;
      }
      if (far <= r) return true;
    }
    return false;
  }

  /** The one definition of a trip worth showing. Used by the timeline, the
   *  map trail and the trail pill via tripsFrom(). */
  function isRealTrip(t) {
    return !!t && t.distM >= TRIP_MIN_M && t.spanM >= TRIP_SPAN_MIN_M
      && !isDoorstepDrift(t);
  }
  // Trip classing from GPS speed (per-fix when the breadcrumbs carry
  // it, trip distance/time otherwise). Three bands: walk, ride, drive.
  // "Ride" covers bikes AND runners — speed alone can't split those.
  // A drive needs a sustained ~29 km/h or a ~45 km/h peak: city bikes
  // rarely exceed 45 even downhill, while cars routinely do between
  // lights, so the peak does the discriminating on stop-start urban
  // trips. Known tradeoff: a car crawling in heavy traffic end-to-end
  // can read as a ride.
  const DRIVE_AVG_MS = 8;     // ~29 km/h sustained
  const DRIVE_MAX_MS = 12.5;  // ~45 km/h peak
  const RIDE_AVG_MS  = 2.2;   // ~8 km/h sustained — above brisk-walk pace

  function tlDayStart(offset) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - offset);
    return d;
  }

  function tlDayLabel(offset) {
    if (offset === 0) return 'Today';
    if (offset === 1) return 'Yday';
    return tlDayStart(offset).toLocaleDateString([], { weekday: 'short' });
  }

  function formatClock(ms) {
    return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function formatDur(ms) {
    const m = Math.round(ms / 60000);
    if (m < 1) return '<1 min';
    if (m < 60) return m + ' min';
    const h = Math.floor(m / 60);
    return h + 'h' + (m % 60 ? ' ' + (m % 60) + 'm' : '');
  }

  function formatDist(m) {
    return m < 1000 ? Math.round(m) + ' m' : (m / 1000).toFixed(1) + ' km';
  }

  function initTimeline() {
    if (!S.keepId) return;
    if (!S.tlMemberId || !S.members.some(m => m.id === S.tlMemberId)) {
      S.tlMemberId = S.myId;
    }
    renderTlMembers();
    renderTlDays();
    loadTimeline();
  }

  function renderTlMembers() {
    const host = $('tl-members');
    if (!host) return;
    clear(host);
    for (const m of S.members) {
      host.appendChild(el('button', {
        class: 'tl-chip' + (m.id === S.tlMemberId ? ' on' : ''),
        dataset: { action: 'tl-member', id: m.id },
        text: m.avatar + ' ' + (m.id === S.myId ? 'You' : m.name)
      }));
    }
  }

  function renderTlDays() {
    const host = $('tl-days');
    if (!host) return;
    clear(host);
    // Newest on the right, like a calendar strip read left → right.
    for (let off = HISTORY_DAYS - 1; off >= 0; off--) {
      host.appendChild(el('button', {
        class: 'tl-day' + (off === S.tlDayOffset ? ' on' : ''),
        dataset: { action: 'tl-day', off: off },
        text: tlDayLabel(off)
      }));
    }
  }

  // Fetch ALL location_history rows for a member in [startIso, endIso),
  // chronological, paging past PostgREST's per-request row cap. A single
  // .limit()/.range() truncated an active driving day: breadcrumbs land
  // roughly every 15 m of travel, so ~2000 rows ≈ 30 km — which silently
  // cut long drives short and dropped later trips entirely (e.g. the drive
  // home), while the arrival check-in (a separate query) still showed.
  async function fetchHistoryPaged(memberId, startIso, endIso, cols) {
    const PAGE = 1000;
    const all = [];
    let from = 0;
    // Advance by the number of rows actually returned (not by PAGE) and
    // stop only on an EMPTY page. That way a project-side PostgREST
    // max-rows cap smaller than PAGE can't make us skip rows or stop early
    // — we just take smaller pages and keep going until there's nothing
    // left. The safety cap bounds a pathological loop.
    while (from < 200000) {
      const { data, error } = await S.sb.from('location_history')
        .select(cols)
        .eq('keep_id', S.keepId).eq('member_id', memberId)
        .gte('recorded_at', startIso).lt('recorded_at', endIso)
        .order('recorded_at', { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) return { data: all, error };
      if (!data || data.length === 0) break;   // no more rows
      for (const r of data) all.push(r);
      from += data.length;
    }
    return { data: all, error: null };
  }

  async function loadTimeline() {
    const host = $('tl-feed');
    const mid = S.tlMemberId;
    if (!host || !mid || !S.keepId) return;
    clear(host);
    host.appendChild(el('div', { class: 'note', text: 'Loading…' }));

    const dayStart = tlDayStart(S.tlDayOffset);
    const dayEndMs = dayStart.getTime() + 24 * 3600 * 1000;
    const startIso = dayStart.toISOString();
    const endIso = new Date(dayEndMs).toISOString();
    try {
      const [pts, cis, prior] = await Promise.all([
        // All of the day's breadcrumbs (paged) — never truncate a drive.
        fetchHistoryPaged(mid, startIso, endIso, 'lat,lng,speed,recorded_at'),
        S.sb.from('checkins')
          .select('type,place,created_at')
          .eq('keep_id', S.keepId).eq('member_id', mid)
          .gte('created_at', startIso).lt('created_at', endIso)
          .order('created_at', { ascending: true }).limit(200),
        // The check-in immediately before the day tells us whether the
        // member woke up inside a place — without it, a day spent
        // entirely at home (no transitions) would render empty.
        S.sb.from('checkins')
          .select('type,place,created_at')
          .eq('keep_id', S.keepId).eq('member_id', mid)
          .in('type', ['arrived', 'left'])
          .lt('created_at', startIso)
          .order('created_at', { ascending: false }).limit(1)
      ]);
      if (pts.error || cis.error || prior.error) {
        console.warn('loadTimeline', pts.error || cis.error || prior.error);
        clear(host);
        host.appendChild(el('div', { class: 'note', text: 'Could not load history.' }));
        return;
      }
      // Guard against a stale response landing after the user has
      // already switched member or day.
      if (mid !== S.tlMemberId || dayStart.getTime() !== tlDayStart(S.tlDayOffset).getTime()) return;
      const entries = buildTimeline(
        pts.data || [], cis.data || [], (prior.data || [])[0],
        dayStart.getTime(), dayEndMs
      );
      renderTimeline(entries);
    } catch (e) {
      console.warn('loadTimeline', e);
    }
  }

  // Distance / duration / speed stats for one breadcrumb trip.
  function tripStats(trip) {
    if (!trip || trip.length < 2) return null;
    // Leg speeds first: they are both the teleport test and the corroboration
    // for the stored speed column.
    const legM = new Array(trip.length).fill(0);
    const legMs = new Array(trip.length).fill(0);
    const legOk = new Array(trip.length).fill(true);
    let distM = 0, spanM = 0;
    for (let i = 1; i < trip.length; i++) {
      legM[i] = distanceM(trip[i - 1].lat, trip[i - 1].lng, trip[i].lat, trip[i].lng);
      const dt = Math.max(MIN_LEG_DT_S,
        (new Date(trip[i].recorded_at).getTime()
          - new Date(trip[i - 1].recorded_at).getTime()) / 1000);
      legMs[i] = legM[i] / dt;
      // A leg nothing on the ground could have travelled is one bad fix, not
      // five kilometres of driving. It contributes neither distance nor a
      // top speed.
      if (legMs[i] > MAX_LEG_SPEED_MS) { legOk[i] = false; continue; }
      distM += legM[i];
    }
    for (let i = 0; i < trip.length; i++) {
      spanM = Math.max(spanM, distanceM(trip[0].lat, trip[0].lng, trip[i].lat, trip[i].lng));
    }
    let maxSp = 0, spSum = 0, spN = 0;
    for (let i = 0; i < trip.length; i++) {
      const sp = trip[i].speed;
      if (typeof sp !== 'number' || sp < 0 || sp > MAX_LEG_SPEED_MS) continue;
      // The path around the point has to corroborate the reading. max() of
      // the two adjacent legs, not min(): the first fix after pulling away
      // from a stop has a backward leg spanning the whole stop, which reads
      // slow — its forward leg is the honest one. Only a point with BOTH
      // neighbours stationary is distrusted.
      const back = (i >= 1 && legOk[i]) ? legMs[i] : 0;
      const fwd = (i + 1 < trip.length && legOk[i + 1]) ? legMs[i + 1] : 0;
      const around = Math.max(back, fwd);
      if (sp > Math.max(DRIVE_MAX_MS, around * SPEED_CORROB_MULT)) continue;
      maxSp = Math.max(maxSp, sp);
      spSum += sp; spN++;
    }
    const startMs = new Date(trip[0].recorded_at).getTime();
    const endMs = new Date(trip[trip.length - 1].recorded_at).getTime();
    const durMs = Math.max(0, endMs - startMs);
    const avgSp = spN ? spSum / spN : (durMs > 0 ? distM / (durMs / 1000) : 0);
    const mode = (avgSp >= DRIVE_AVG_MS || maxSp >= DRIVE_MAX_MS) ? 'drive'
               : (avgSp >= RIDE_AVG_MS) ? 'ride'
               : 'walk';
    return {
      kind: 'trip', startMs, endMs, durMs, distM, spanM, maxSp, mode,
      pts: trip
    };
  }

  // Merge stays (check-in pairs), trips (breadcrumbs) and one-off events
  // (manual / SOS check-ins) into a single chronological list.
  function buildTimeline(points, checkins, priorCheckin, dayStartMs, dayEndMs) {
    const entries = [];

    S.tlTrips = tripsFrom(points).slice();
    S.tlTrips.forEach((t, i) => { t.idx = i; entries.push(t); });

    // Reconstruct stays. `open` is the stay we're currently inside of;
    // it's seeded from the last check-in before the day so a day spent
    // entirely at one place still shows up.
    let open = null;
    if (priorCheckin && priorCheckin.type === 'arrived') {
      open = { place: priorCheckin.place, startMs: dayStartMs, fromPrev: true };
    }
    const closeStay = (endMs, stillThere) => {
      if (!open) return;
      entries.push({
        kind: 'stay', place: open.place,
        startMs: open.startMs, endMs,
        fromPrev: !!open.fromPrev, stillThere: !!stillThere
      });
      open = null;
    };
    for (const c of checkins) {
      const t = new Date(c.created_at).getTime();
      if (c.type === 'arrived') {
        closeStay(t);               // close any dangling stay first
        open = { place: c.place, startMs: t };
      } else if (c.type === 'left') {
        if (open) closeStay(t);
        else entries.push({ kind: 'stay', place: c.place, startMs: dayStartMs, endMs: t, fromPrev: true });
      } else if (c.type === 'sos' || c.type === 'manual') {
        entries.push({ kind: 'event', type: c.type, place: c.place, startMs: t, endMs: t });
      }
    }
    closeStay(Math.min(Date.now(), dayEndMs), true);

    entries.sort((a, b) => a.startMs - b.startMs);
    return entries;
  }

  function renderTimeline(entries) {
    const host = $('tl-feed');
    if (!host) return;
    clear(host);
    if (!entries.length) {
      host.appendChild(el('div', { class: 'empty' }, [
        el('div', { class: 'big', text: '🗓️' }),
        'No history for this day'
      ]));
      return;
    }
    for (const e of entries) {
      let ico, title, sub, ds = null, cls = 'tl-row';
      if (e.kind === 'stay') {
        // place strings are stored as "icon name" (e.g. "🏠 Home").
        const sp = e.place.indexOf(' ');
        ico = sp > 0 ? e.place.slice(0, sp) : '📍';
        title = sp > 0 ? e.place.slice(sp + 1) : e.place;
        const from = e.fromPrev ? 'From midnight' : 'Arrived ' + formatClock(e.startMs);
        const to = e.stillThere ? '' : ' · left ' + formatClock(e.endMs);
        sub = from + to + ' · ' + formatDur(e.endMs - e.startMs);
        ds = { action: 'tl-stay', place: e.place };
        cls += ' tap';
      } else if (e.kind === 'trip') {
        ico = e.mode === 'drive' ? '🚗' : e.mode === 'ride' ? '🚴' : '🚶';
        title = (e.mode === 'drive' ? 'Drive' : e.mode === 'ride' ? 'Ride' : 'Walk') +
                ' · ' + formatDist(e.distM);
        sub = formatClock(e.startMs) + '–' + formatClock(e.endMs) +
              ' · ' + formatDur(e.durMs) +
              (e.mode !== 'walk' && e.maxSp ? ' · top ' + Math.round(e.maxSp * 3.6) + ' km/h' : '');
        ds = { action: 'tl-trip', idx: e.idx };
        cls += ' tap';
      } else {
        ico = e.type === 'sos' ? '🆘' : '📍';
        title = e.type === 'sos' ? 'SOS alert' : e.place;
        sub = formatClock(e.startMs);
        if (e.type === 'sos') cls += ' sos';
      }
      host.appendChild(el('div', { class: cls, dataset: ds || undefined }, [
        el('div', { class: 'tl-ico', text: ico }),
        el('div', { class: 'tl-body' }, [
          el('div', { class: 'tl-title', text: title }),
          el('div', { class: 'tl-sub', text: sub })
        ]),
        ds && ds.action === 'tl-trip' ? el('div', { class: 'tl-go', text: '🗺️' }) : null
      ]));
    }
  }

  // Centre + zoom the map so every point of the trip is on screen.
  function fitTrail(pts) {
    let minLa = 90, maxLa = -90, minLo = 180, maxLo = -180;
    for (const p of pts) {
      if (p.lat < minLa) minLa = p.lat;
      if (p.lat > maxLa) maxLa = p.lat;
      if (p.lng < minLo) minLo = p.lng;
      if (p.lng > maxLo) maxLo = p.lng;
    }
    S.mLat = (minLa + maxLa) / 2;
    S.mLng = (minLo + maxLo) / 2;
    const spanM = Math.max(250, distanceM(minLa, minLo, maxLa, maxLo));
    const cv = $('map-canvas');
    const px = Math.min(cv ? cv.clientWidth : 600, cv ? cv.clientHeight : 600) || 600;
    // Web Mercator: metres/px halves per zoom level; solve for the zoom
    // where the trip's diagonal (plus margin) fits the shorter side.
    const z = Math.log2(156543.03392 * Math.cos(S.mLat * Math.PI / 180) * px / (spanM * 1.4));
    S.mZoom = Math.max(3, Math.min(17, Math.floor(z)));
  }

  function showTripOnMap(idx) {
    const trip = S.tlTrips[idx];
    if (!trip || !trip.pts || !trip.pts.length) return;
    S.trail = trip.pts;
    S.trailMemberId = S.tlMemberId;
    S.trailLabel = tlDayLabel(S.tlDayOffset);
    fitTrail(trip.pts);
    updateTrailPill();
    drawMap();
    closeDrawer();
  }

  function focusStayPlace(placeStr) {
    const p = (S.places || []).find(x => x.icon + ' ' + x.name === placeStr);
    if (!p) return;
    S.mLat = p.lat; S.mLng = p.lng; S.mZoom = 16;
    drawMap();
    closeDrawer();
  }

  // ── ACTIONS ────────────────────────────────────────────────────
  function focusMember(id) {
    const m = S.members.find(x => x.id === id);
    if (m && m.lat != null) {
      S.mLat = m.lat; S.mLng = m.lng; S.mZoom = 15;
      drawMap();
      $('sidebar').classList.remove('mob');
    }
    loadTrail(id);
  }

  // Load a member's last-24h breadcrumb trail and show it on the map.
  async function loadTrail(memberId) {
    if (!memberId || !S.keepId) return;
    const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const endIso = new Date(Date.now() + 3600 * 1000).toISOString();
    try {
      // Page the full 24h window so a heavy day's trail isn't capped at
      // ~2000 points (~30 km) — the old single-request limit truncated
      // long or multi-trip days. fetchHistoryPaged returns chronological.
      const { data, error } = await fetchHistoryPaged(memberId, cutoff, endIso, 'lat,lng,recorded_at');
      if (error) { console.warn('loadTrail', error); return; }
      S.trail = data;
      S.trailMemberId = memberId;
      S.trailLabel = '24h';
      updateTrailPill();
      drawMap();
    } catch (e) { console.warn('loadTrail', e); }
  }

  function clearTrail() {
    S.trail = [];
    S.trailMemberId = null;
    updateTrailPill();
    drawMap();
  }

  function updateTrailPill() {
    const pill = $('trail-pill');
    if (!pill) return;
    if (!S.trailMemberId) { pill.style.display = 'none'; return; }
    const m = S.members.find(x => x.id === S.trailMemberId);
    const who = m ? (m.id === S.myId ? 'Your' : m.name + "’s") : 'Member';
    const lbl = $('trail-pill-lbl');
    if (lbl) {
      const trips = S.trail.length ? tripsFrom(S.trail).length : 0;
      if (!S.trail.length) {
        lbl.textContent = '🧭 ' + who + ' trail · no points yet';
      } else if (!trips) {
        // Points, but nothing that went anywhere. Says so plainly rather
        // than reading as a failure to load — a stationary day is a real
        // and correct answer.
        lbl.textContent = '🧭 ' + who + ' trail · no trips · ' + (S.trailLabel || '24h');
      } else {
        lbl.textContent = '🧭 ' + who + ' trail · ' +
          trips + (trips === 1 ? ' trip' : ' trips') + ' · ' + (S.trailLabel || '24h');
      }
    }
    pill.style.display = 'flex';
  }

  async function triggerSOS() {
    if (S.sosActive) { cancelSOS(); return; }
    S.sosActive = true;
    const me = S.members.find(m => m.id === S.myId);
    try {
      await S.sb.from('keep_members').update({ sos: true, status: '🆘 SOS ACTIVE' }).eq('id', S.myId);
      if (me) {
        // Stamp WHERE, not just who and when. This row is what the rest
        // of the family navigates to, and it has to keep meaning the
        // same thing a week later — so it records the position at the
        // moment the alert was raised rather than wherever the member
        // happens to be when someone opens the log.
        //
        // Best effort: a member with no fix yet still gets the alert out.
        // An SOS that failed to send because we were waiting on GPS would
        // be the worst possible trade.
        const sosAt = (typeof me.lat === 'number' && typeof me.lng === 'number')
          ? { lat: me.lat, lng: me.lng } : {};
        await S.sb.from('checkins').insert(Object.assign({
          keep_id: S.keepId,
          member_id: S.myId,
          member_name: me.name,
          member_avatar: me.avatar,
          place: '🆘 Emergency SOS Alert',
          type: 'sos'
        }, sosAt));
      }
    } catch (_) {}
    $('sos-hdr')?.classList.add('ring');
    $('sos-big')?.classList.add('ring');
    const msg = $('sos-msg');
    if (msg) {
      msg.textContent = '🆘 ALERT SENT — Family has been notified!';
      msg.className = 'sos-msg on';
    }
    const can = $('cancel-sos');
    if (can) can.style.display = 'inline-block';
    toast('🆘 SOS alert sent!', 'bad');
  }

  async function cancelSOS() {
    S.sosActive = false;
    try {
      await S.sb.from('keep_members').update({ sos: false, status: STATUS_DEFAULT }).eq('id', S.myId);
    } catch (_) {}
    $('sos-hdr')?.classList.remove('ring');
    $('sos-big')?.classList.remove('ring');
    const msg = $('sos-msg');
    if (msg) {
      msg.textContent = 'Tap to send an emergency alert to all family members';
      msg.className = 'sos-msg';
    }
    const can = $('cancel-sos');
    if (can) can.style.display = 'none';
    toast('✅ SOS cancelled', 'ok');
  }

  // ── INVITE (owner only) ────────────────────────────────────────
  // The join code is no longer shown passively anywhere. It's revealed
  // (and rotatable) only here, and only to owners.
  let _inviteExpiryTimer = null;

  async function openInvite() {
    if (!amOwner()) { toast('Only an owner can manage invites', 'err'); return; }
    // Pull the freshest code + expiry straight from the keep row (members
    // can read their own keep). Avoids threading expiry through every load.
    let code = S.keepCode, expires = null;
    try {
      const { data } = await S.sb.from('keeps')
        .select('code, code_expires_at').eq('id', S.keepId).single();
      if (data) { code = data.code; expires = data.code_expires_at; S.keepCode = code; }
    } catch (_) {}
    renderInvite(code, expires);
    const sheet = $('invite-sheet');
    const scrim = $('invite-scrim');
    if (sheet) { sheet.classList.remove('full'); sheet.classList.add('half', 'open'); }
    if (scrim) scrim.classList.add('on');
    document.body.classList.add('sheet-open');
  }

  function renderInvite(code, expiresIso) {
    const codeEl = $('inv-code');
    if (codeEl) codeEl.textContent = code || '——';
    const expEl = $('inv-expiry');
    if (!expEl) return;
    if (_inviteExpiryTimer) { clearInterval(_inviteExpiryTimer); _inviteExpiryTimer = null; }
    const paint = () => {
      if (!expiresIso) { expEl.textContent = 'This code doesn’t expire.'; return; }
      const ms = new Date(expiresIso).getTime() - Date.now();
      if (ms <= 0) { expEl.textContent = '⚠️ This code has expired — rotate a fresh one.'; return; }
      const h = Math.floor(ms / 3600000), mn = Math.floor((ms % 3600000) / 60000);
      expEl.textContent = 'Expires in ' + (h > 0 ? h + 'h ' : '') + mn + 'm';
    };
    paint();
    // Live countdown while the modal is open.
    _inviteExpiryTimer = setInterval(paint, 30000);
  }

  // ── FIRST-RUN SETUP ────────────────────────────────────────────
  // Two permissions decide whether the app actually works in the
  // background, and neither was ever requested — they had to be set by
  // hand in system settings on every device:
  //
  //  • "Allow all the time" (ACCESS_BACKGROUND_LOCATION). Play Services
  //    ACCEPTS a geofence registration without it and then simply never
  //    delivers transitions unless the app is open. That is why some
  //    devices logged breadcrumbs perfectly but never fired arrived/left,
  //    and why rebooting "fixed" them — BootReceiver re-registered the
  //    fences from scratch.
  //  • Battery unrestricted. Doze otherwise suspends the foreground
  //    service and can disable GPS device-wide.
  //
  // Each row is checked live from the native reliability status, so the
  // sheet doubles as a repair screen if a permission is revoked later.
  const SETUP_ITEMS = [
    {
      key: 'fineLocation', required: true, icon: '📍',
      title: 'Location access',
      why: 'Needed to show your place on the family map at all.',
      action: 'setup-fix-location', cta: 'Allow'
    },
    {
      key: 'backgroundLocation', required: true, icon: '🌙',
      title: 'Allow all the time',
      why: 'Without this, arrive and leave alerts only work while the app is open.',
      action: 'setup-fix-background', cta: 'Allow'
    },
    {
      key: 'ignoringBatteryOptimizations', required: false, icon: '🔋',
      title: 'Unrestricted battery',
      why: 'Stops the phone suspending tracking once it has been idle a while.',
      action: 'setup-fix-battery', cta: 'Allow'
    },
    {
      key: 'notifications', required: false, icon: '🔔',
      title: 'Notifications',
      why: 'Needed for arrive/leave alerts and SOS to reach you.',
      action: 'setup-fix-notifications', cta: 'Allow'
    }
  ];

  // Push every place we know about back down to the native side and
  // re-register its fence. Used after any permission grant. This is the
  // repair path for devices whose first run armed nothing, so it must not
  // depend on native state — S.places is the source of truth here.
  // Several things can trigger a re-arm on a single app open (launch, the
  // resume reconcile, a grant from the setup sheet). Arming is idempotent,
  // but doing it three times over wrote three journal lines per place and
  // buried everything else — so collapse near-simultaneous requests.
  let _lastArmMs = 0;
  const ARM_THROTTLE_MS = 15000;

  // What the OS is currently registered for, as a comparable string.
  // Anything that changes a fence's geometry has to be in here, or a
  // moved pin / edited radius would look identical to the armed set.
  //
  // NAME AND ICON ARE IN HERE TOO, and not for the geometry's sake: the
  // native side keeps its own copy of them in PrefsStore, and
  // GeofenceReceiver composes its check-in text from that copy. With
  // geometry alone, a RENAME never re-armed — so a renamed place went on
  // filing check-ins under its old name indefinitely, on every device
  // that wasn't in the foreground when the edit happened. Same bug family
  // as the never-armed add (PR #40) and the never-pruned delete (PR #42),
  // one field narrower. Keep this in step with GeofenceArmer.signature().
  function placesSignature() {
    return (S.places || [])
      .map(p => [p.id, p.lat, p.lng, p.radius_m, p.name, p.icon].join(':'))
      .sort()
      .join('|');
  }
  // Signature of the set we last successfully pushed to the OS. Empty
  // means "we have never armed", which must not compare equal to a real
  // (also empty) place list — hence the null, not ''.
  let _armedSig = null;

  async function rearmGeofencesFromPlaces(why, force) {
    if (!isNative()) return 0;
    const places = S.places || [];
    // An empty list is not the same as nothing to do: armPlaces prunes
    // whatever the native side still holds, so "the family deleted every
    // place" has to reach it. Only skip when there is nothing to prune
    // either — i.e. we have never armed.
    if (!places.length && _armedSig === null) return 0;
    if (!force && Date.now() - _lastArmMs < ARM_THROTTLE_MS) {
      console.info('skip re-arm (' + why + '): armed ' +
        Math.round((Date.now() - _lastArmMs) / 1000) + 's ago');
      return 0;
    }
    _lastArmMs = Date.now();
    const NG = nativeGeo();
    // One bridge call, one registration, one journal line.
    if (NG && typeof NG.armPlaces === 'function') {
      try {
        const res = await NG.armPlaces({
          places: places.map(p => ({
            id: p.id, name: p.name, icon: p.icon || '📍',
            lat: p.lat, lng: p.lng, radius: p.radius_m
          }))
        });
        console.info('armed geofences (' + why + ')', res);
        _armedSig = placesSignature();
        return (res && res.armed) || 0;
      } catch (e) { console.warn('armPlaces', e); return 0; }
    }
    // Older native build without armPlaces: fall back to one call per place.
    for (const p of places) await syncNativeAddPlace(p);
    _armedSig = placesSignature();
    return places.length;
  }

  async function setupStatus() {
    const NG = nativeGeo();
    if (!NG || typeof NG.getReliabilityStatus !== 'function') return null;
    try { return await NG.getReliabilityStatus(); } catch (_) { return null; }
  }

  // True when something the app genuinely needs is still missing.
  async function setupIncomplete() {
    if (!isNative()) return false;
    const st = await setupStatus();
    if (!st) return false;
    return SETUP_ITEMS.some(i => i.required && !st[i.key]);
  }

  async function openSetup() {
    if (!isNative()) { toast('Setup steps only apply to the Android app'); return; }
    await renderSetup();
    const sheet = $('setup-sheet');
    const scrim = $('setup-scrim');
    if (sheet) { sheet.classList.remove('half'); sheet.classList.add('full', 'open'); }
    if (scrim) scrim.classList.add('on');
    document.body.classList.add('sheet-open');
  }

  function closeSetup() {
    // Dismissing counts as having seen it. Without this the gate would
    // stay shut for the rest of the session and no later caller —
    // startGPS, a resume, the sheet reopened by hand — could ever ask for
    // location again. The disclosure has been shown, which is what the
    // rule actually requires.
    _disclosurePending = false;
    const sheet = $('setup-sheet');
    const scrim = $('setup-scrim');
    if (sheet) sheet.classList.remove('open', 'half', 'full');
    if (scrim) scrim.classList.remove('on');
    document.body.classList.remove('sheet-open');
  }

  async function renderSetup() {
    const host = $('setup-rows');
    if (!host) return;
    const st = await setupStatus();
    clear(host);
    for (const item of SETUP_ITEMS) {
      const ok = !!(st && st[item.key]);
      host.appendChild(el('div', { class: 'setup-row' + (ok ? ' ok' : '') }, [
        el('div', { class: 'setup-ico', text: ok ? '✅' : item.icon }),
        el('div', { class: 'setup-body' }, [
          el('div', { class: 'setup-title', text: item.title +
            (item.required ? '' : ' (recommended)') }),
          el('div', { class: 'setup-why', text: ok ? 'All set.' : item.why })
        ]),
        ok ? null : el('button', {
          class: 'setup-btn', dataset: { action: item.action }, text: item.cta
        })
      ]));
    }
    const foot = $('setup-foot');
    if (foot) {
      const missing = SETUP_ITEMS.filter(i => !(st && st[i.key]));
      foot.textContent = missing.length
        ? 'Tap Allow on each item. Some open Android settings — come back here afterwards and this list updates itself.'
        : 'Everything is set up. Your Keep will stay up to date in the background.';
    }
  }

  // Foreground location, via the same plugin the GPS watcher uses.
  // This is the affirmative tap the disclosure exists to collect, so it
  // is what lifts the gate on ensureLocationPermission.
  async function setupFixLocation() {
    _disclosurePending = false;
    await ensureLocationPermission();
    // Anything that failed to arm before the grant has to be pushed down
    // again — nothing retries on its own.
    const st = await setupStatus();
    if (st && st.fineLocation) {
      await rearmGeofencesFromPlaces('location permission granted');
      // launchApp's startGPS ran while the request was still gated, so it
      // left without a watcher. Nothing else would start one until the
      // next resume, and on a first run that is the whole first session.
      restartGPS();
    }
    await renderSetup();
  }

  // "Allow all the time". Android insists this is asked for on its own,
  // after foreground is granted; from API 30 the runtime dialog may not
  // offer it at all, so we fall back to the app's settings page.
  async function setupFixBackground() {
    const NG = nativeGeo();
    if (!NG || typeof NG.requestBackgroundLocation !== 'function') return;
    let res = null;
    try { res = await NG.requestBackgroundLocation(); } catch (_) {}
    const status = res && res.status;
    if (status === 'needsForeground') {
      toast('Allow location access first', 'err');
      await setupFixLocation();
      return;
    }
    if (status !== 'granted') {
      // No dialog, or declined — send them where the setting actually lives.
      toast('Choose “Allow all the time” under Permissions → Location');
      try { await NG.openAppSettings(); } catch (_) {}
      return;
    }
    // Granted. The native side re-arms whatever it has stored, but that
    // list is empty on a device whose first run predated the permission —
    // so re-seed from S.places too.
    await rearmGeofencesFromPlaces('background permission granted');
    _hadBackgroundLocation = true;
    toast('✅ Background location on — arrive/leave alerts are live', 'ok');
    await renderSetup();
  }

  async function setupFixBattery() {
    const NG = nativeGeo();
    if (!NG || typeof NG.requestIgnoreBatteryOptimizations !== 'function') return;
    try { await NG.requestIgnoreBatteryOptimizations(); } catch (_) {}
    // The dialog resolves immediately; the answer lands when we resume.
  }

  async function setupFixNotifications() {
    // Registering the token and creating the channels is what actually makes
    // push work; this used to request the permission and stop there, so a
    // grant from the sheet did nothing until the next launch. Now that
    // launchApp defers push init behind the disclosure gate, that gap would
    // have swallowed the whole first session.
    await initPushNotifications(true);
    await renderSetup();
  }

  // Called on every resume. Permission changes made in system settings
  // don't fire a callback in-app, so this is the only place we learn that
  // background location was granted — and geofences registered while it
  // was missing stay inert until they're re-registered.
  let _hadBackgroundLocation = null;
  async function reconcileSetup() {
    if (!isNative()) return;
    const st = await setupStatus();
    if (!st) return;
    const nowHas = !!st.backgroundLocation;
    if (nowHas && _hadBackgroundLocation === false) {
      // Re-seed through initNativeGeofence rather than the native
      // reArmGeofences: a device that first ran before permission was
      // granted has an EMPTY PrefsStore place list, and every native
      // re-arm path bails on an empty list. Only S.places knows the
      // real set, so the JS side has to push it down again.
      await rearmGeofencesFromPlaces('background permission granted');
      toast('✅ Arrive/leave alerts are now active', 'ok');
    }
    _hadBackgroundLocation = nowHas;
    // Keep the sheet honest if it happens to be open.
    if ($('setup-sheet') && $('setup-sheet').classList.contains('open')) {
      await renderSetup();
    }
  }

  function closeInvite() {
    const sheet = $('invite-sheet');
    const scrim = $('invite-scrim');
    if (sheet) sheet.classList.remove('open', 'half', 'full');
    if (scrim) scrim.classList.remove('on');
    document.body.classList.remove('sheet-open');
    if (_inviteExpiryTimer) { clearInterval(_inviteExpiryTimer); _inviteExpiryTimer = null; }
  }

  async function rotateCode() {
    if (!amOwner()) return;
    const btn = $('inv-rotate');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Rotating…'; }
    try {
      const { data, error } = await S.sb.rpc('rotate_keep_code', { p_keep_id: S.keepId });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      if (row) { S.keepCode = row.keep_code; renderInvite(row.keep_code, row.code_expires_at); }
      toast('🔄 Fresh code generated', 'ok');
    } catch (e) {
      toast(mapRpcError(e), 'err');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '🔄 Rotate code'; }
    }
  }

  function shareInvite() {
    // One link now carries BOTH which family server to talk to and the
    // join code. That's what makes a cross-device invite work at all now
    // that the app isn't compiled against a fixed backend: the recipient
    // would otherwise have no way to reach our Supabase.
    const link = buildSetupLink(S.keepCode);
    const text = 'Join our Roamkeep!\n\nInstall Roamkeep, then open this link — ' +
      'it connects you to our family server and fills in the join code.\n\n' + link;
    if (navigator.share) {
      navigator.share({ title: 'Roamkeep invite', text }).catch(() => {});
    } else if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(() => toast('Invite copied!', 'ok'));
    }
  }

  // ── SELF-PAUSE (adults only) ───────────────────────────────────
  // Time-boxed with auto-resume — never an open-ended switch (the common
  // failure is going dark and forgetting). Pausing must STOP native
  // tracking, not just flag the column, so we tear down geofences + the
  // foreground service and re-arm at resume.
  let _autoResumeTimer = null;

  async function pauseMe(target) {
    const me = myMember();
    if (!me) return;
    if (me.member_type === 'child') { toast('Children can’t pause their own location', 'err'); return; }
    let until;
    if (target.dataset.evening) {
      // "This evening" = 6pm local today, or +2h if it's already evening.
      const d = new Date(); d.setHours(18, 0, 0, 0);
      if (d.getTime() <= Date.now() + 30 * 60000) d.setTime(Date.now() + 2 * 3600000);
      until = d;
    } else {
      until = new Date(Date.now() + (Number(target.dataset.mins) || 60) * 60000);
    }
    try {
      const { error } = await S.sb.rpc('pause_member', {
        p_member_id: S.myId, p_until: until.toISOString()
      });
      if (error) throw error;
      me.paused_until = until.toISOString();     // optimistic
      S._pausedActive = true;
      await applyPauseToNative(until.getTime());
      scheduleAutoResume();
      renderMembers(); renderPins();
      toast('⏸ Location paused until ' + pauseClock(until.toISOString()), 'ok');
    } catch (e) {
      me.paused_until = null;
      toast(mapRpcError(e), 'err');
    }
  }

  // reconcileMyPause() runs from three places (launch, resume, and the
  // realtime keep_members UPDATE), and on an app open after an expired
  // pause all three see paused_until still set in the DB. The RPC is
  // async, so without this guard all three fire before any completes —
  // producing three resume RPCs, three native re-arms and three toasts.
  let _resumeInFlight = null;

  async function resumeMe() {
    if (_resumeInFlight) return _resumeInFlight;
    _resumeInFlight = _resumeMeImpl();
    try { return await _resumeInFlight; } finally { _resumeInFlight = null; }
  }

  async function _resumeMeImpl() {
    const me = myMember();
    if (!me) return;
    S._pausedActive = false;
    try {
      const { error } = await S.sb.rpc('resume_member', { p_member_id: S.myId });
      if (error) throw error;
    } catch (e) { console.warn('resume_member', e); }
    me.paused_until = null;                        // optimistic regardless
    if (_autoResumeTimer) { clearTimeout(_autoResumeTimer); _autoResumeTimer = null; }
    await clearPauseOnNative();
    renderMembers(); renderPins();
    toast('▶️ Location sharing resumed', 'ok');
  }

  // Fire the local auto-resume exactly when paused_until passes, so the
  // pauser's own device re-arms tracking without waiting for a relaunch.
  function scheduleAutoResume() {
    if (_autoResumeTimer) { clearTimeout(_autoResumeTimer); _autoResumeTimer = null; }
    const me = myMember();
    if (!isPausedRow(me)) return;
    const ms = new Date(me.paused_until).getTime() - Date.now();
    // Cap the timer at ~signed-int-safe range; re-scheduled on resume/launch.
    _autoResumeTimer = setTimeout(() => { resumeMe(); }, Math.min(ms + 500, 24 * 3600000));
  }

  // Push the pause down to native: stop the foreground service, drop the
  // geofences, and persist a paused-until flag so BootReceiver / any
  // geofence kick won't silently restart tracking mid-pause.
  async function applyPauseToNative(untilMs) {
    // Stop the foreground @capacitor/geolocation watch (web + native) so it
    // stops feeding pushLocation.
    try {
      const Geo = window.Capacitor?.Plugins?.Geolocation;
      if (Geo && S.geoWatchId != null && Geo.clearWatch) { await Geo.clearWatch({ id: S.geoWatchId }); S.geoWatchId = null; }
    } catch (_) {}
    const NG = nativeGeo();
    if (NG && typeof NG.setPaused === 'function') {
      // setPaused persists the flag AND tears down the FGS + geofences
      // without wiping stored context/places (so resume re-arms cleanly).
      // Deliberately NOT clearAll() — that would wipe auth + places + the
      // pending-checkin queue.
      try { await NG.setPaused({ pausedUntil: String(untilMs || 0) }); } catch (_) {}
    } else if (NG) {
      // Older native build without setPaused: best-effort stop.
      try { await NG.stopLocationUpdates(); } catch (_) {}
    }
    S._nativeGeoReady = false;
    S._nativeLocReady = false;
  }

  // Undo applyPauseToNative: clear the native flag and re-arm the pipeline.
  async function clearPauseOnNative() {
    const NG = nativeGeo();
    if (NG && typeof NG.setPaused === 'function') { try { await NG.setPaused({ pausedUntil: '0' }); } catch (_) {} }
    // Re-register geofences + breadcrumb service, then re-arm foreground.
    _gpsFirst = true;
    await initNativeGeofence();
    startGPS();
  }

  // Reconcile native tracking with the DB pause state on launch/resume and
  // whenever a realtime UPDATE changes our own paused_until (e.g. resumed
  // from another device, or the pause simply elapsed while we were away).
  // S._pausedActive tracks whether WE'VE torn tracking down, so a resume
  // that happened elsewhere (multi-device) re-arms us instead of leaving
  // this device silently dark.
  function reconcileMyPause() {
    const me = myMember();
    if (isPausedRow(me)) {
      if (!S._pausedActive) { S._pausedActive = true; applyPauseToNative(new Date(me.paused_until).getTime()); }
      scheduleAutoResume();
    } else {
      if (S._pausedActive) {
        S._pausedActive = false;
        // Column still set (stale/past) → clear via RPC (also re-arms).
        // Already null (resumed on another device) → just re-arm native.
        if (me && me.paused_until) resumeMe(); else clearPauseOnNative();
      } else if (me && me.paused_until) {
        // Launched into a stale past-pause we never armed for → clear it.
        resumeMe();
      }
    }
  }

  // ── MEMBER MANAGEMENT (owner / adult) ──────────────────────────
  async function setMemberRole(t) {
    const id = t.dataset.id, role = t.dataset.role;
    try {
      const { error } = await S.sb.rpc('set_member_role', { p_member_id: id, p_role: role });
      if (error) throw error;
      toast(role === 'owner' ? '👑 Made an owner' : 'Owner role removed', 'ok');
    } catch (e) { toast(mapRpcError(e), 'err'); }
  }

  async function setMemberType(t) {
    const id = t.dataset.id, type = t.dataset.type;
    try {
      const { error } = await S.sb.rpc('set_member_type', { p_member_id: id, p_type: type });
      if (error) throw error;
      toast(type === 'child' ? '🧒 Marked as child' : 'Marked as adult', 'ok');
    } catch (e) { toast(mapRpcError(e), 'err'); }
  }

  async function removeMember(t) {
    const id = t.dataset.id, name = t.dataset.name || 'this member';
    if (!confirm('Remove ' + name + ' from the Keep? Their location history is deleted too. This can’t be undone.')) return;
    try {
      const { error } = await S.sb.rpc('remove_member', { p_member_id: id });
      if (error) throw error;
      S.members = S.members.filter(m => m.id !== id);
      renderMembers(); renderPins();
      toast('Removed ' + name, 'ok');
    } catch (e) { toast(mapRpcError(e), 'err'); }
  }

  // ── INSTALL PROMPT ─────────────────────────────────────────────
  async function installPWA() {
    if (!S.deferredPrompt) return;
    S.deferredPrompt.prompt();
    await S.deferredPrompt.userChoice;
    S.deferredPrompt = null;
    $('install-banner')?.classList.remove('on');
  }

  function dismissInstall() {
    $('install-banner')?.classList.remove('on');
  }

  // ── EVENT DISPATCH ─────────────────────────────────────────────
  const ACTIONS = {
    'auth-tab-in': () => authTab('in'),
    'auth-tab-up': () => authTab('up'),
    'sign-in': signIn,
    'sign-up': signUp,
    'sign-out': signOut,
    'keep-tab-cr': () => keepTab('cr'),
    'keep-tab-jo': () => keepTab('jo'),
    'create-keep': createKeep,
    'join-keep': joinKeep,
    'open-invite': openInvite,
    'close-invite': closeInvite,
    'connect-scan': connectFromScan,
    'connect-paste-go': connectFromPaste,
    'leave-keep': leaveKeep,
    'disconnect-backend': disconnectBackend,
    'close-disc': closeDisconnectSheet,
    'copy-disc-link': copyReconnectLink,
    'share-disc-link': shareReconnectLink,
    'disc-go': disconnectFromSheet,
    'open-setup': openSetup,
    'close-setup': closeSetup,
    'setup-fix-location': setupFixLocation,
    'setup-fix-background': setupFixBackground,
    'setup-fix-battery': setupFixBattery,
    'setup-fix-notifications': setupFixNotifications,
    'rotate-code': rotateCode,
    'share-invite': shareInvite,
    'pause-me': (t) => pauseMe(t),
    'resume-me': resumeMe,
    'set-member-role': (t) => setMemberRole(t),
    'set-member-type': (t) => setMemberType(t),
    'remove-member': (t) => removeMember(t),
    'open-profile-edit': (t) => openProfileEditor(t),
    'save-profile': saveProfile,
    'cancel-profile': cancelProfile,
    'edit-family-name': editFamilyName,
    'save-family-name': saveFamilyName,
    'cancel-family-name': cancelFamilyName,
    'map-zoom-in': () => mapZoom(1),
    'map-zoom-out': () => mapZoom(-1),
    'map-center': mapCenter,
    'trigger-sos': triggerSOS,
    'cancel-sos': cancelSOS,
    'reload': () => location.reload(),
    'install-pwa': installPWA,
    'dismiss-install': dismissInstall,
    'focus-member': (t) => focusMember(t.dataset.id),
    'pin-click': (t) => pinClick(t.dataset.id),
    'clear-trail': clearTrail,
    'pick-avatar': (t) => pickAv(t, t.dataset.avatar),
    's-tab': (t) => sTab(t.dataset.tab, t),
    'mob-nav': (t) => mobNav(t.dataset.nav, t),
    'tl-member': (t) => { S.tlMemberId = t.dataset.id; renderTlMembers(); loadTimeline(); },
    'tl-day': (t) => { S.tlDayOffset = Number(t.dataset.off) || 0; renderTlDays(); loadTimeline(); },
    'tl-trip': (t) => showTripOnMap(Number(t.dataset.idx)),
    'tl-stay': (t) => focusStayPlace(t.dataset.place),
    'add-place-here': addPlaceAtMyLocation,
    'save-place': savePlaceFromForm,
    'cancel-place': cancelPlaceEdit,
    'edit-place': (t) => editPlace(t.dataset.id),
    'delete-place': (t) => deletePlace(t.dataset.id),
    'open-settings': openSettings,
    'close-settings': closeSettings,
    'accept-terms': acceptTerms,
    'decline-terms': declineTerms,
    'open-terms': () => openExternal(TERMS_URL),
    'open-privacy': () => openExternal(PRIVACY_URL),
    'sos-navigate': (t) => sosNavigate(t),
    'sos-copy': (t) => sosCopy(t),
    'place-notify': (t) => openPlaceNotify(t.dataset.id),
    'close-place-notify': closePlaceNotify,
    'toggle-place-notify': (t) => togglePlaceNotify(t, t.dataset.id),
    'focus-place': (t) => focusPlace(t.dataset.id),
    'pick-place-icon': (t) => pickPlaceIcon(t, t.dataset.icon),
    'toggle-notify': (t) => toggleNotify(t),
    'set-track-mode': (t) => applyTrackingMode(t.dataset.mode),
    'toggle-diag': (t) => toggleDiag(t),
    'refresh-diag': renderDiagnostics,
    'refresh-fix': () => onResume()
  };

  function bindEvents() {
    document.addEventListener('click', (e) => {
      const target = e.target.closest('[data-action]');
      if (!target) return;
      const handler = ACTIONS[target.dataset.action];
      if (handler) handler(target);
    });

    $('si-p')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') signIn(); });
    $('su-p')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') signUp(); });
    $('jo-code')?.addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase(); });

    // Place editor: live-update the radius label and redraw the map
    // preview ring (once the place is actually saved). Also refresh the
    // coord readout if we regain GPS while the editor is open.
    $('pe-radius')?.addEventListener('input', (e) => {
      const v = Number(e.target.value) || 100;
      S.placeRadius = v;
      const lbl = $('pe-radius-lbl');
      if (lbl) lbl.textContent = String(v);
      drawMap();
    });

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      S.deferredPrompt = e;
      setTimeout(() => $('install-banner')?.classList.add('on'), 4000);
    });
    window.addEventListener('appinstalled', () => {
      $('install-banner')?.classList.remove('on');
      S.deferredPrompt = null;
    });

    window.addEventListener('beforeunload', () => {
      if (S.myId) {
        try { S.sb.from('keep_members').update({ online: false }).eq('id', S.myId); }
        catch (_) {}
      }
    });
  }

  // ── NATIVE CHROME ──────────────────────────────────────────────
  // The system bars sit over white app chrome, so their icons have to be
  // dark to be visible at all.
  //
  // ⚠ Capacitor's Style names describe the BACKGROUND, not the icons:
  // 'DARK' means "light text for dark backgrounds". This asked for 'DARK'
  // — i.e. white icons — which was invisible against the white bar once
  // Android 16 forced edge-to-edge. 'LIGHT' is the one that gives dark
  // text on a light background.
  //
  // The same intent is set on AppTheme.NoActionBar so it holds from the
  // first frame; this call is what keeps it after the plugin touches the
  // window, and what covers pre-Android-16 devices.
  //
  // setBackgroundColor is a no-op from API 35 (the platform ignores
  // setStatusBarColor under edge-to-edge) but still applies below that.
  // It was #2e1f0a — a dark brown that matched nothing; the comment
  // claimed it came from the PWA theme-color, which is #0E7C7B. Neither
  // is right here: the bar sits against the app surface, so it is
  // --surface, and old and new Androids now agree.
  async function configureNativeChrome() {
    if (!isNative()) return;
    const SB = window.Capacitor.Plugins && window.Capacitor.Plugins.StatusBar;
    if (!SB) return;
    try { await SB.setOverlaysWebView({ overlay: false }); } catch (_) {}
    try { await SB.setBackgroundColor({ color: '#FAFBFC' }); } catch (_) {}
    try { await SB.setStyle({ style: 'LIGHT' }); } catch (_) {}
  }

  // Build a localStorage-shaped async adapter backed by Capacitor's
  // Preferences plugin, which writes to SharedPreferences on Android
  // and NSUserDefaults on iOS. WebView localStorage on Android is
  // surprisingly fragile — OEMs evict it under memory pressure, "clear
  // cache" wipes it, and some Samsung firmwares clear it after long
  // idle periods. The result was users having to re-authenticate
  // every few weeks. SharedPreferences only gets cleared on app
  // uninstall or explicit "Clear data", which is exactly the
  // durability we want for the auth session.
  //
  // The first getItem call for any key also migrates from localStorage
  // if a session is already there — that way the upgrade from v1.5
  // doesn't force a re-login.
  //
  // Web / PWA path returns plain window.localStorage; nothing to do.
  function buildAuthStorage() {
    const Prefs = window.Capacitor?.Plugins?.Preferences;
    if (!Prefs) return window.localStorage;
    return {
      async getItem(key) {
        try {
          const { value } = await Prefs.get({ key });
          if (value != null) return value;
        } catch (_) {}
        // One-time migration from WebView localStorage on first read
        // post-upgrade. supabase-js looks up the session under
        // `sb-<ref>-auth-token` on every page load, so this triggers
        // exactly when we need it to.
        const ls = (() => {
          try { return window.localStorage?.getItem(key) ?? null; }
          catch (_) { return null; }
        })();
        if (ls != null) {
          try { await Prefs.set({ key, value: ls }); } catch (_) {}
          try { window.localStorage.removeItem(key); } catch (_) {}
          return ls;
        }
        return null;
      },
      async setItem(key, value) {
        try { await Prefs.set({ key, value }); } catch (_) {}
      },
      async removeItem(key) {
        try { await Prefs.remove({ key }); } catch (_) {}
      }
    };
  }

  // ── CONNECT (first run: point the app at a family server) ──────
  // A pending invite code carried in the setup link, applied once the
  // user reaches the join screen so they don't have to retype it.
  let _pendingJoinCode = null;

  // A setup link that arrived before boot() worked out whether this device
  // already has a backend, plus the handler that will deal with it once it
  // has. See bindSetupLinkHandler / drainSetupLink.
  let _pendingSetupUrl = null;
  let _setupLinkHandler = null;
  let _bootResolved = false;

  function setConnectErr(msg) {
    const el = $('connect-err');
    if (!el) return;
    el.textContent = msg || '';
    el.style.display = msg ? 'block' : 'none';
  }

  // Validate a candidate backend before storing it, so a typo'd or dead
  // link fails here with a clear message instead of leaving the app
  // permanently pointed at nothing.
  async function verifyBackend(cfg) {
    const url = cfg.url.replace(/\/+$/, '') + '/auth/v1/health';
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 10000);
    try {
      const r = await fetch(url, { headers: { apikey: cfg.anonKey }, signal: ctl.signal });
      return r.ok || r.status === 401;   // 401 still proves it's a Supabase project
    } catch (_) {
      return false;
    } finally { clearTimeout(t); }
  }

  // Is this error "the function isn't there" as opposed to "I couldn't
  // reach the server"? PostgREST reports a missing RPC as PGRST202
  // ("Could not find the function … in the schema cache"), NOT Postgres's
  // own 42883 — both are accepted here because the RPC can also be
  // reached directly.
  function isMissingDbObject(error) {
    const code = (error && error.code) || '';
    if (code === 'PGRST202' || code === '42883' || code === '42P01') return true;
    return /does not exist|could not find the function/i.test((error && error.message) || '');
  }

  // Read the database's schema version.
  //
  // Returns { version, minApp } when it positively determined one, or
  // NULL when it could not tell. The distinction is the whole point:
  //
  //   * A missing function is not a failure, it is the answer. Every
  //     database provisioned before v12 lacks it, so absence means
  //     SCHEMA_PRE_META — a known version.
  //   * A genuine outage — offline, project asleep, DNS, 5xx, a bad key —
  //     means we learned NOTHING. Reporting that as a version would
  //     render a train tunnel as "your family's server needs updating":
  //     confident, wrong, and unactionable, since no amount of the owner
  //     running migrations will fix it.
  //
  // Collapsing the two was harmless while NEEDS_SCHEMA equalled
  // SCHEMA_PRE_META (nothing could fail the comparison) and became a bug
  // the moment a release raised the bar. Keep them apart.
  async function readSchemaVersion() {
    try {
      const { data, error } = await S.sb.rpc('roamkeep_schema_version');
      if (error) {
        if (isMissingDbObject(error)) {
          return { version: SCHEMA_PRE_META, minApp: 0 };
        }
        console.warn('schema version unreadable', error.code || '', error.message || '');
        return null;
      }
      const row = Array.isArray(data) ? data[0] : data;
      // Present but empty/garbled: the table exists and says nothing
      // useful. Treat as unknown rather than inventing a number.
      if (!row || typeof row.schema_version !== 'number') return null;
      return { version: row.schema_version, minApp: row.min_app_build || 0 };
    } catch (e) {
      console.warn('schema version check threw', e);
      return null;
    }
  }

  // Our own build number, for the advisory min_app_build banner.
  // Native only — the PWA has no build number and is always current,
  // because it is served fresh rather than installed.
  async function currentAppBuild() {
    if (!isNative()) return null;
    try {
      const App = window.Capacitor.Plugins && window.Capacitor.Plugins.App;
      if (!App || !App.getInfo) return null;
      const info = await App.getInfo();
      const b = parseInt(info && info.build, 10);
      return isNaN(b) ? null : b;
    } catch (_) { return null; }
  }

  // Blocks startup when the database is older than this build needs.
  // Returns true when it is safe to carry on.
  async function checkSchemaCompatible() {
    const info = await readSchemaVersion();

    // Never block on ignorance. If we could not read a version, carry on
    // — the app then fails, if at all, at the call that actually needs
    // the missing thing, which is a smaller and more honest failure than
    // telling a family their server is broken because a tunnel ate the
    // request.
    if (!info) return true;

    const { version, minApp } = info;
    S.schemaVersion = version;

    if (version < NEEDS_SCHEMA) {
      const el = $('outdated-detail');
      if (el) {
        el.textContent = 'This app needs database version ' + NEEDS_SCHEMA +
          '. Your family’s server is on version ' + version + '.';
      }
      show('s-outdated');
      return false;
    }

    // The other direction, and deliberately advisory. A hard block here
    // could strand a family whose Play update hasn't rolled out yet, and
    // unlike the schema direction there is nothing their owner can do
    // about it. An installed app that refuses can never be talked out of
    // refusing by a later database change — the decision lives in the
    // binary — so keep the database's power over installed apps to a
    // banner.
    const build = await currentAppBuild();
    const banner = $('update-banner');
    if (banner) {
      const stale = !!(minApp && build !== null && build < minApp);
      banner.style.display = stale ? 'block' : 'none';
    }
    return true;
  }

  // Tell the database its own URL, so the webhook triggers can reach the
  // Edge Functions. Only the owner can, only when it isn't already set,
  // and the RPC re-checks both — this is a convenience, not the authority.
  //
  // Exists because a family who upgraded by pasting schema.sql into the
  // dashboard never told the database its project URL, and without it
  // their check-in and place webhooks silently no-op.
  async function ensureProjectUrl() {
    if (!S.sb || !SB_URL) return;
    try {
      await S.sb.rpc('set_project_url', { p_url: SB_URL.replace(/\/+$/, '') });
    } catch (_) {
      // Older database without the RPC, or not the owner. Both fine.
    }
  }

  /**
   * Show the terms and wait for an answer. Resolves true once accepted.
   *
   * Placed BEFORE the sign-in screen, so agreement comes before the app
   * asks for an email address — not after, and nowhere near the setup
   * sheet. Interleaving it with the permission flow would put a second
   * dialog on top of the prominent-disclosure sheet, which is the exact
   * ordering this codebase has had to fix three times.
   */
  // The cog sheet. Contents are static markup; the only state it needs is
  // whatever the blocks inside already manage for themselves, so opening
  // it just refreshes the two values that can go stale while it is shut.
  function openSettings() {
    const host = $('backend-host');
    if (host) {
      try { host.textContent = new URL(SB_URL).host; }
      catch (_) { host.textContent = SB_URL; }
    }
    const td = $('set-terms-date');
    if (td) td.textContent = TERMS_DATE;
    const pd = $('set-privacy-date');
    if (pd) pd.textContent = PRIVACY_DATE;
    // Owner-only, and ownership can change while the app is open — so
    // this is re-evaluated on every open rather than once at launch.
    // renderFamilyNameSetting already owns that rule; don't restate it.
    renderFamilyNameSetting();
    // Same reasoning, and the same reason it is not enough to render this
    // once: the last owner leaving is exactly the state that changes under
    // you while the sheet is shut.
    renderLeaveKeep();

    closeDrawer();
    const sheet = $('settings-sheet');
    const scrim = $('settings-scrim');
    if (sheet) { sheet.classList.remove('half'); sheet.classList.add('full', 'open'); }
    if (scrim) scrim.classList.add('on');
    document.body.classList.add('sheet-open');
  }

  function closeSettings() {
    const sheet = $('settings-sheet');
    const scrim = $('settings-scrim');
    if (sheet) sheet.classList.remove('open', 'half', 'full');
    if (scrim) scrim.classList.remove('on');
    document.body.classList.remove('sheet-open');
  }

  /** Open a published page in the system browser, not the WebView — the
   *  app's own WebView has no chrome to get back from. */
  function openExternal(url) {
    try { window.open(url, '_blank', 'noopener'); }
    catch (_) { window.location.href = url; }
  }

  function askTerms() {
    return new Promise((resolve) => {
      const d = $('terms-date');
      if (d) d.textContent = TERMS_DATE;
      const pd = $('privacy-date');
      if (pd) pd.textContent = PRIVACY_DATE;
      const t = $('terms-link');
      if (t) t.href = TERMS_URL;
      const p = $('privacy-link');
      if (p) p.href = PRIVACY_URL;
      _termsResolve = resolve;
      show('s-terms');
    });
  }

  let _termsResolve = null;

  async function acceptTerms() {
    await saveTermsAccepted();
    const done = _termsResolve;
    _termsResolve = null;
    if (done) done(true);
  }

  // Declining is a real answer, so it gets a real outcome rather than a
  // disabled button: the app closes. Nothing is deleted — reopening asks
  // again, and a family member who wants to read the full terms first can
  // do exactly that.
  function declineTerms() {
    const App = window.Capacitor?.Plugins?.App;
    if (isNative() && App && App.exitApp) {
      try { App.exitApp(); return; } catch (_) {}
    }
    const note = $('terms-declined');
    if (note) note.style.display = 'block';
  }

  /**
   * Show the destination and get a yes before adopting it.
   *
   * A setup link decides where a family's location data goes, and until now
   * nothing ever showed the person where that was. The link format accepts
   * any https host on purpose — self-hosters need that — so the only thing
   * standing between a tapped link and a stranger's server is this prompt.
   *
   * `confirm()` rather than a bespoke screen, matching disconnectBackend(),
   * which asks the mirror-image question the same way.
   */
  function confirmBackend(cfg) {
    let host;
    try { host = new URL(cfg.url).host; } catch (_) { host = cfg.url; }
    const odd = !/\.supabase\.co$/i.test(host);
    return confirm(
      'Connect this device to:\n\n' + host + '\n\n' +
      (odd
        ? 'This is NOT a supabase.co address. Only continue if you set up '
          + 'this server yourself.\n\n'
        : '') +
      'Your location will be sent to this server. Only continue if you '
      + 'recognise it.'
    );
  }

  async function applySetupConfig(cfg, opts) {
    setConnectErr('');
    if (!confirmBackend(cfg)) return false;
    const btnIds = ['connect-scan', 'connect-paste-go'];
    btnIds.forEach(id => { const b = $(id); if (b) b.disabled = true; });
    try {
      setMsg('Checking that server…');
      const ok = await verifyBackend(cfg);
      if (!ok) {
        setConnectErr('Couldn’t reach that family server. Check the link and your connection, then try again.');
        return false;
      }
      await saveBackendConfig(cfg);
      if (cfg.code) _pendingJoinCode = cfg.code;
      await startWithBackend(cfg);
      return true;
    } catch (e) {
      setConnectErr('Something went wrong: ' + (e.message || e));
      return false;
    } finally {
      btnIds.forEach(id => { const b = $(id); if (b) b.disabled = false; });
    }
  }

  async function connectFromPaste() {
    const el = $('connect-link');
    const cfg = parseSetupLink(el && el.value);
    if (!cfg) {
      setConnectErr('That doesn’t look like a Roamkeep setup link.');
      return;
    }
    await applySetupConfig(cfg);
  }

  async function connectFromScan() {
    const Scanner = window.Capacitor?.Plugins?.BarcodeScanner;
    if (!Scanner) {
      setConnectErr('QR scanning isn’t available on this device — paste the link instead.');
      return;
    }
    try {
      // scan() hands off to Google's code scanner, which owns the camera
      // and its permission prompt — so we deliberately don't gate on our
      // own permission check here (doing so would block a flow that
      // actually works). It needs the ML Kit barcode module, which Play
      // Services fetches on demand — but on a device where Play Services
      // can't deliver it (some tablets), isSupported() is false and scan()
      // would just reject into nothing. Check first and point at the paste
      // fallback rather than leaving a dead-looking button.
      const sup = await Scanner.isSupported();
      if (sup && sup.supported === false) {
        setConnectErr('QR scanning isn’t available on this device — paste the link instead.');
        return;
      }
      const res = await Scanner.scan();
      const raw = res && res.barcodes && res.barcodes[0] && res.barcodes[0].rawValue;
      const cfg = parseSetupLink(raw);
      if (!cfg) { setConnectErr('That QR code isn’t a Roamkeep setup link.'); return; }
      await applySetupConfig(cfg);
    } catch (e) {
      // A user-cancelled scan also rejects — stay quiet for that. Anything
      // else is a genuine failure (e.g. the scanner module never loaded),
      // so surface it and steer the user to the paste fallback.
      const msg = '' + (e && (e.message || e.code || ''));
      if (/cancel/i.test(msg)) { console.info('scan cancelled', e); return; }
      console.warn('scan failed', e);
      setConnectErr('Couldn’t open the QR scanner — paste the setup link instead.');
    }
  }

  // Setup links can also arrive as a deep link (Android App Link or the
  // custom scheme) while the app is already installed — including when it
  // is already connected, which is how a second family member joins.
  function bindSetupLinkHandler() {
    const App = window.Capacitor?.Plugins?.App;
    const handle = async (url) => {
      // Hold anything that arrives before boot() has decided whether this
      // device already has a backend. The listener has to be registered
      // early or a cold-start intent is dropped, but until loadBackendConfig
      // has returned, S.sb is null on a device that IS connected — and the
      // branch below would then treat the link as a first run and apply it.
      if (!_bootResolved) { _pendingSetupUrl = url; return; }
      const cfg = parseSetupLink(url);
      if (!cfg) return;
      if (S.sb) {
        // Already connected. Switching backends would strand the current
        // session, so only take the invite code and let them join.
        if (cfg.url.replace(/\/+$/, '') === SB_URL) {
          _pendingJoinCode = cfg.code;
          applyPendingJoinCode();
          toast('Invite code filled in', 'ok');
        } else {
          toast('That link is for a different family server. Disconnect first to switch.', 'err');
        }
        return;
      }
      await applySetupConfig(cfg);
    };
    _setupLinkHandler = handle;
    if (App && typeof App.addListener === 'function') {
      try { App.addListener('appUrlOpen', (e) => handle(e && e.url)); } catch (_) {}
    }
    // PWA: the link was opened in the browser, so the fragment is right here.
    if (!isNative() && location.hash && location.hash.length > 3) {
      handle(location.href);
    }
  }

  // Boot has decided; release anything the handler above parked.
  function drainSetupLink() {
    _bootResolved = true;
    const url = _pendingSetupUrl;
    _pendingSetupUrl = null;
    if (url && _setupLinkHandler) _setupLinkHandler(url);
  }

  // Prefill the join-code field once the join screen exists.
  function applyPendingJoinCode() {
    if (!_pendingJoinCode) return;
    const el = $('jo-code');
    if (!el) return;
    el.value = _pendingJoinCode;
    _pendingJoinCode = null;
    const jo = document.querySelector('[data-action="keep-tab-jo"]');
    if (jo) jo.click();
  }

  // Forget the family server entirely: sign out, tear down native
  // tracking, drop the stored config, and return to the Connect screen.
  // The counterpart to applySetupConfig — needed both for switching
  // servers and for handing a device on.
  /**
   * Who is offered the Leave button, and what the others are told instead.
   *
   * The server is the authority — leave_keep() raises child_cannot_leave and
   * last_owner regardless of what the UI does. This only avoids offering
   * somebody a button that is certain to fail. Re-evaluated on every open,
   * because roles and member_type both change while the app is running.
   */
  function renderLeaveKeep() {
    const btn = $('leave-keep-btn');
    const note = $('leave-keep-note');
    if (!btn || !note) return;

    const me = myMember();
    if (!me) { btn.style.display = 'none'; note.style.display = 'none'; return; }

    const isChild = me.member_type === 'child';
    const owners = S.members.filter(m => m.role === 'owner').length;
    const lastOwner = me.role === 'owner' && owners <= 1;

    btn.style.display = (isChild || lastOwner) ? 'none' : 'block';

    if (isChild) {
      note.textContent = 'Ask an adult in your family if you want to leave this Keep.';
    } else if (lastOwner) {
      note.textContent = 'You are the only owner, so you cannot leave — the rest of '
        + 'the family would be left with nobody able to manage the Keep. Make someone '
        + 'else an owner first, or delete the Supabase project to remove everything.';
    }
    note.style.display = (isChild || lastOwner) ? 'block' : 'none';
  }

  /**
   * Leave the Keep: delete this member and everywhere they have been.
   *
   * landing/privacy has always promised this. Until 4.8.3 nothing in the app
   * could do it — signing out only set online=false, and the membership,
   * the location history and the check-ins all survived it.
   *
   * Deliberately does NOT sign out or clear the backend config: after the
   * reload the session is still good, no member row is found, and the user
   * lands on the create-or-join screen. Leaving a family is not the same
   * decision as handing the phone on.
   */
  async function leaveKeep() {
    const me = myMember();
    if (!me) return;
    if (!confirm(
      'Leave ' + (S.keepName || 'this Keep') + '?\n\n'
      + 'Your membership, your location history and your check-ins will be '
      + 'permanently deleted from your family’s server. Your family will no '
      + 'longer see where you are.\n\n'
      + 'This cannot be undone.'
    )) return;

    const btn = $('leave-keep-btn');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Leaving…'; }

    const { error } = await S.sb.rpc('leave_keep', { p_member_id: me.id });
    if (error) {
      if (btn) { btn.disabled = false; btn.textContent = 'Leave this Keep'; }
      toast(mapRpcError(error), 'err');
      return;
    }

    // Stop the OS firing transitions into a keep this device is no longer
    // part of. clearAll wipes the stored auth, places and pending queue —
    // exactly right here, where the membership those referred to is gone.
    const NG = nativeGeo();
    if (NG) {
      try { await NG.clearAll(); } catch (_) {}
      try { await NG.stopLocationUpdates(); } catch (_) {}
    }
    S._nativeGeoReady = false;
    S._nativeLocReady = false;
    if (S.channel) { try { S.sb.removeChannel(S.channel); } catch (_) {} S.channel = null; }

    // Full reload for the same reason as disconnectBackend: it resets every
    // module-level cache honestly instead of hand-clearing each one.
    location.reload();
  }

  /**
   * The only owner's way back, shown before the door shuts.
   *
   * This replaced a chain of confirm() -> navigator.share -> clipboard ->
   * prompt(), every link of which turned out to be unreliable inside the
   * Android WebView:
   *
   *   - navigator.share is not implemented in a plain WebView at all, so
   *     the chain always fell through to the clipboard.
   *   - navigator.clipboard.writeText rejects when the document does not
   *     hold focus, which is exactly the state a modal confirm() leaves it
   *     in. It worked on a second attempt and not a first, which is the
   *     worst kind of bug to be told about.
   *   - prompt(message, defaultValue) then showed an EMPTY box, because
   *     Capacitor's BridgeWebChromeClient.onJsPrompt builds its own
   *     EditText and never applies defaultValue. The last resort — the one
   *     whose entire job was to make sure nobody was stranded — handed
   *     over nothing.
   *
   * So the link is rendered into the page instead, where it is visible and
   * selectable whether or not any clipboard call succeeds, and copying is
   * a convenience rather than the delivery mechanism. The disconnect itself
   * lives on this sheet, so there is no path to it that skips the link.
   *
   * The link carries no join code, unlike the invite: whoever uses it
   * already has a membership and is reconnecting, not joining. The anon key
   * in it is public by design — RLS is the security.
   */
  function openDisconnectSheet() {
    const box = $('disc-link');
    if (box) box.textContent = buildSetupLink(null);
    const note = $('disc-note');
    if (note) {
      note.textContent = 'You are the only owner of ' + (S.keepName || 'this Keep') +
        ', so nobody else can create an invite link for you. This link is what '
        + 'connects a device back to your family server — save it before you go, '
        + 'or you will need your Supabase project details to get back in.';
    }
    // Web Share exists in a browser PWA but not in the WebView, so the
    // button is offered only where it can actually do something.
    const shareBtn = $('disc-share');
    if (shareBtn) shareBtn.style.display = navigator.share ? '' : 'none';

    const sheet = $('disc-sheet');
    const scrim = $('disc-scrim');
    if (sheet) { sheet.classList.remove('full'); sheet.classList.add('half', 'open'); }
    if (scrim) scrim.classList.add('on');
    document.body.classList.add('sheet-open');
  }

  function closeDisconnectSheet() {
    const sheet = $('disc-sheet');
    const scrim = $('disc-scrim');
    if (sheet) sheet.classList.remove('open', 'half', 'full');
    if (scrim) scrim.classList.remove('on');
    document.body.classList.remove('sheet-open');
  }

  async function copyReconnectLink() {
    const box = $('disc-link');
    if (!box) return;
    try {
      // The bare link and nothing else: this gets pasted straight into the
      // Connect screen's field, and any preamble is one more thing to trim
      // off by hand on a phone. The sheet already says what it is, on
      // screen, where the explanation belongs.
      await navigator.clipboard.writeText(box.textContent);
      toast('Setup link copied', 'ok');
      return;
    } catch (_) { /* not focused, or no permission — try the old way */ }
    // execCommand is deprecated but works in the WebView, needs no
    // permission, and runs off this button's own tap rather than an
    // activation inherited through a dialog.
    const sel = window.getSelection();
    try {
      const range = document.createRange();
      range.selectNodeContents(box);
      sel.removeAllRanges();
      sel.addRange(range);
      if (document.execCommand('copy')) { toast('Setup link copied', 'ok'); return; }
    } catch (_) {}
    // Both refused. The link is on screen and now selected, so say what to
    // do rather than claiming a copy that did not happen.
    toast('Press and hold the link to copy it', 'err');
  }

  async function shareReconnectLink() {
    if (!navigator.share) { await copyReconnectLink(); return; }
    try {
      await navigator.share({ title: 'Roamkeep setup link', text: buildSetupLink(null) });
    } catch (e) {
      // Dismissing the sheet is a decision; anything else means it never
      // happened, so fall back to the clipboard.
      if (!e || e.name !== 'AbortError') await copyReconnectLink();
    }
  }

  async function disconnectFromSheet() {
    closeDisconnectSheet();
    await confirmAndDisconnect(true);
  }

  /**
   * Hands this device back: clears the stored family server, signs out, and
   * disarms every native watcher, leaving the app on the Connect screen.
   *
   * Before any of that it marks the member row offline with a status that
   * says so, because until 4.8.4 disconnecting wrote NOTHING to the
   * database. 'online' stayed true, so the rest of the family kept seeing
   * the green dot, and last_seen merely aged — which is exactly what a flat
   * battery, no signal, and an OS-killed foreground service all look like.
   * A deliberate opt-out was indistinguishable from the app being broken,
   * and got chased as a fault.
   *
   * The control is deliberately ungated — a member marked as a child can
   * reach it — and that should not change. Gating it would be
   * unenforceable, since whoever holds the phone can uninstall, revoke
   * location, or turn on airplane mode; the same reasoning is already
   * written on the member DELETE policy and on pause_member. And a
   * location app that is hard to switch off from the tracked device is an
   * app that is better at coercive control, which the terms forbid. The
   * defect here was never the permission, it was the silence: fix it by
   * disclosure, not by enforcement.
   *
   * Two limits, both accepted rather than chased:
   *   - it only covers the in-app path. An uninstall writes nothing at all,
   *     and nothing on the device can make it.
   *   - it is best-effort, exactly like the same write in signOut().
   *     Disconnecting with no signal stays silent.
   * The point is to turn the common, honest case from "looks broken" into
   * "says what happened", not to make severance detectable in every case.
   *
   * The confirmation also says how to get back, because this is a one-way
   * door: the stored config is gone and the Connect screen wants a setup
   * link. See the sole-owner note in the body for who can supply one.
   */
  async function disconnectBackend() {
    // Only an owner can create an invite link (openInvite refuses everyone
    // else), so the ONLY owner is the one person in a Keep with nobody to
    // ask for a way back in. Everyone else can be sent a fresh link; they
    // would have to recover their project URL and anon key from the
    // Supabase dashboard by hand.
    //
    // Offer them the link rather than taking the button away. Disconnect is
    // also how you strip your credentials off a phone you are selling or
    // handing on — the distinction leaveKeep() draws — and that must never
    // be unavailable to anyone, least of all the person whose session has
    // the most reach. Nothing here is destructive: the membership, history
    // and check-ins all survive, so this is a lockout to avoid, not a loss.
    const me = myMember();
    const owners = S.members.filter(m => m.role === 'owner').length;
    const soleOwner = !!me && me.role === 'owner' && owners <= 1;

    // The sole owner goes through the sheet, which carries the link and
    // the disconnect button together — so there is no route to the
    // disconnect that skips being handed the way back.
    //
    // Settings has to close first. Every .sheet shares z-index 60, so two
    // open at once are ordered by their position in the DOM — and
    // #settings-sheet is written after #disc-sheet, so it painted on top
    // and the new sheet was invisible until Settings was dismissed. They
    // would also fight over body.sheet-open, which each one clears on
    // close. One sheet at a time is the fix and the right behaviour.
    if (soleOwner) { closeSettings(); openDisconnectSheet(); return; }

    await confirmAndDisconnect(false);
  }

  async function confirmAndDisconnect(soleOwner) {
    if (!confirm(
      'Disconnect from this family server?\n\n'
      + 'You will be signed out and this device will stop sharing location '
      + 'until you connect again. ' + (soleOwner
          ? 'Only your own setup link can bring it back.'
          : 'To connect again you will need a setup link from an owner.')
      + '\n\nYour family will see that this device was disconnected.\n\n'
      + 'Nothing on the server is deleted.'
    )) return;
    // Own row, and neither column is covered by _roamkeep_guard_member_cols
    // (v14 guards role/member_type/paused_until/keep_id/user_id), so the RLS
    // policy and the trigger both permit this. It has to happen BEFORE
    // signOut() — afterwards there is no session left to write with.
    if (S.myId) {
      try {
        await S.sb.from('keep_members')
          .update({ online: false, status: STATUS_DISCONNECTED })
          .eq('id', S.myId);
      } catch (_) {}
    }
    const NG = nativeGeo();
    if (NG) {
      // clearAll wipes stored auth + places + the pending queue, which is
      // exactly right here (unlike a pause, where it would be destructive).
      try { await NG.clearAll(); } catch (_) {}
      try { await NG.stopLocationUpdates(); } catch (_) {}
    }
    S._nativeGeoReady = false;
    S._nativeLocReady = false;
    try { if (S.sb) await S.sb.auth.signOut(); } catch (_) {}
    if (S.channel) { try { S.sb.removeChannel(S.channel); } catch (_) {} S.channel = null; }
    await clearBackendConfig();
    // Full reload is the honest way to reset every module-level cache
    // (client, session, member state) rather than hand-clearing each.
    location.reload();
  }

  // ── BOOT ───────────────────────────────────────────────────────
  async function boot() {
    renderStaticIcons();
    initSheets();
    initKeyboardInsets();
    await configureNativeChrome();
    setMsg('Loading…');
    if (!window.supabase || !window.supabase.createClient) {
      fatal('Supabase not available. Make sure supabase.js is uploaded.');
      return;
    }
    // Events first: the Connect screen below needs its buttons live even
    // when there is no backend and therefore no Supabase client at all.
    bindEvents();
    initServiceWorker();
    bindSetupLinkHandler();

    const cfg = await loadBackendConfig();
    if (!cfg) {
      // No family server yet — this is a fresh Play Store install.
      show('s-connect');
      drainSetupLink();
      return;
    }
    await startWithBackend(cfg);
    drainSetupLink();
  }

  // Everything from "we know which Supabase to talk to" onwards. Split out
  // of boot() so the Connect screen can call it after a successful scan
  // without a page reload.
  async function startWithBackend(cfg) {
    SB_URL = cfg.url;
    SB_KEY = cfg.anonKey;
    show('s-load');
    setMsg('Connecting to your family server…');

    S.sb = window.supabase.createClient(SB_URL, SB_KEY, {
      auth: {
        storage: buildAuthStorage(),
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false
      }
    });
    // Before anything reads or writes a table: is this database new
    // enough for this build? Runs pre-auth deliberately —
    // roamkeep_schema_version() is anon-callable precisely so the answer
    // arrives before we have asked anyone to sign in to a database we
    // then refuse to use.
    setMsg('Checking your family server…');
    if (!(await checkSchemaCompatible())) return;

    // Terms before anything is collected. Deliberately after the schema
    // check — there is no point asking someone to agree to use an app
    // that is about to tell them it cannot run against their database.
    //
    // Gated on the VERSION, not a boolean, so materially changed terms
    // ask again on next open. Existing members upgrading into this
    // release see it once, which is the intent: they have not agreed to
    // anything yet either.
    if ((await loadTermsAccepted()) < TERMS_VERSION) {
      await askTerms();
    }

    setMsg('Checking session…');

    S.sb.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT') {
        S.authHandled = false;
        S.user = null;
        show('s-auth');
        return;
      }
      // supabase-js refreshes the JWT automatically every ~55 min.
      // Mirror the new pair into the native plugin's prefs so the
      // broadcast receiver uses a valid token next time it fires.
      if ((event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') && session) {
        pushNativeTokens();
        return;
      }
      if ((event === 'SIGNED_IN' || event === 'INITIAL_SESSION') && session?.user && !S.authHandled) {
        S.authHandled = true;
        S.user = session.user;
        setMsg('Loading your Keep…');
        S.sb.from('keep_members').select('*,keeps(id,code,name)')
          .eq('user_id', S.user.id).limit(1)
          .then(({ data, error }) => {
            if (error) { fatal('Error loading Keep: ' + error.message); return; }
            if (data && data.length > 0) {
              const m = data[0];
              S.keepId = m.keep_id;
              S.keepCode = m.keeps.code;
              S.keepName = m.keeps.name;
              S.myId = m.id;
              // Fire-and-forget: no-ops unless this user is the owner and
              // the URL is still unset. Never gates the app opening.
              ensureProjectUrl();
              launchApp();
            } else {
              initAvPickers();
              show('s-keep'); applyPendingJoinCode();
            }
          })
          .catch(e => fatal('Error: ' + e.message));
      }
    });

    const { data } = await S.sb.auth.getSession();
    if (!data.session) show('s-auth');
  }

  // Service worker is for the PWA only.
  // Inside a Capacitor APK, assets live in the APK bundle — caching
  // them in a SW gives zero benefit and guarantees stale-file bugs
  // on every APK upgrade (the old cache intercepts fetches for
  // index.html / app.js and returns the previous build).
  // Runs regardless of whether a backend is configured, so a PWA sitting
  // on the Connect screen still installs correctly.
  async function initServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    if (isNative()) {
      // Recover any device that installed a SW from a pre-fix APK.
      try {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map(r => r.unregister()));
        if (window.caches) {
          const keys = await caches.keys();
          await Promise.all(keys.map(k => caches.delete(k)));
        }
      } catch (_) { /* best-effort */ }
    } else {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  }

  boot();
})();
