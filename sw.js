// Offline support: once the page has loaded over https it keeps working with no
// network. Serves from cache right away and refreshes the cache in the background.
const CACHE = 'qrbeam-v1';
const FILES = [
  './', 'index.html', 'app.js', 'beam.js', 'scan-worker.js',
  'vendor/qrcode.js', 'vendor/jsQR.js', 'manifest.webmanifest', 'icon-180.png', 'icon-512.png',
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(caches.open(CACHE).then(async (cache) => {
    const hit = await cache.match(e.request, { ignoreSearch: true });
    const fresh = fetch(e.request).then((r) => {
      if (r.ok) cache.put(e.request, r.clone());
      return r;
    }).catch(() => hit);
    return hit || fresh;
  }));
});
