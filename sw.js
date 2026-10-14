// Offline support: once the page has loaded over https it keeps working with no
// network. Online, it fetches fresh files (so updates show up right away) and
// falls back to the cache when the network is missing or too slow.
const CACHE = 'qrbeam-v9';
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
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const net = fetch(e.request).then((r) => {
      if (r.ok) cache.put(e.request, r.clone());
      return r;
    });
    net.catch(() => {}); // a late failure after the cache already answered
    const slow = new Promise((resolve) => setTimeout(resolve, 2500));
    try {
      const r = await Promise.race([net, slow]);
      if (r) return r;
    } catch (err) { /* offline */ }
    const hit = await cache.match(e.request, { ignoreSearch: true });
    return hit || net;
  })());
});
