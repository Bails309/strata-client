// Strata Client Service Worker – offline shell cache
const CACHE_NAME = 'strata-shell-v2';
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/favicon.png',
  '/logo-dark.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Never cache API or WebSocket requests
  if (url.pathname.startsWith('/api')) return;

  // Network-first for navigation, cache-then-network for static assets
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('/index.html'))
    );
  } else {
    event.respondWith(
      caches.match(request).then((cached) => {
        return cached || fetch(request).catch((err) => {
          console.debug('[SW] Fetch failed for:', request.url, err);
          return null; // Gracefully handle missing assets
        });
      })
    );
  }
});
