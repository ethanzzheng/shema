/**
 * Minimal app-shell service worker.
 *
 * Caches ONLY immutable static assets (hashed /_next/static files, icons,
 * manifest). Everything else — pages, WebSocket upgrades, the live audio
 * stream — goes straight to the network, untouched. Never add runtime
 * caching for the live stream.
 */
const CACHE = 'shema-shell-v1';
const SHELL = ['/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== location.origin) return;

  const isShellAsset =
    url.pathname.startsWith('/_next/static/') || SHELL.includes(url.pathname);
  if (!isShellAsset) return; // live data: straight to network

  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(request);
      if (hit) return hit;
      const res = await fetch(request);
      if (res.ok) cache.put(request, res.clone());
      return res;
    }),
  );
});
