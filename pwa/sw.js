/**
 * Service Worker de LeeMe PWA: precaché completa y scope dinámico para GitHub Pages / LAN.
 */
const CACHE_NAME = 'leeme-pwa-v8';

const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon.svg',
  './js/storage/db.js',
  './js/parsers/zip-reader.js',
  './js/parsers/epub-parser.js',
  './js/offline-api.js',
  './js/ui/graph.js',
  './js/ui/reader.js',
  './js/app.js',
  './js/worker/analyzer-worker.js',
  './js/worker/spanish-nlp.js',
  './js/worker/pdf-parser.js',
  './js/worker/kindle-parser.js',
  './js/worker/ml-tfidf.js',
  './js/worker/ml-summarizer.js',
  './js/worker/ml-concepts.js',
  './js/worker/ml-kmeans.js',
  './js/worker/ml-characters.js',
  './js/worker/ml-graph.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(ASSETS_TO_CACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  const scopePath = new URL(self.registration.scope).pathname;
  if (!url.pathname.startsWith(scopePath)) return;
  if (url.pathname.includes('/cert/')) return;

  const isAppShell = req.mode === 'navigate'
    || url.pathname.endsWith('.html')
    || url.pathname.endsWith('.js')
    || url.pathname.endsWith('.css')
    || url.pathname.endsWith('.webmanifest')
    || url.pathname === scopePath;

  if (isAppShell) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req).then((cached) => {
          if (cached) return cached;
          if (req.mode === 'navigate') return caches.match('./index.html');
          return new Response('', { status: 504, statusText: 'Offline' });
        }))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => new Response('', { status: 504, statusText: 'Offline' }));
    })
  );
});
