// Roamkeep Service Worker
// Caches the app shell so it loads instantly and works offline.

const CACHE = 'roamkeep-v64';

const PRECACHE = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './supabase.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE).then(cache =>
      Promise.allSettled(PRECACHE.map(url => cache.add(url).catch(() => {})))
    )
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Only handle same-origin GET requests. Let the browser deal
  // with everything else (Supabase API, OSM tiles, fonts, etc.) —
  // SW-mediated cross-origin fetches have subtle CORS pitfalls
  // (opaque responses taint the canvas, etc.), and the browser
  // HTTP cache handles those correctly on its own.
  if (event.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;

  // App shell: cache-first, network fallback, keep cache warm.
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => cached);
    })
  );
});
