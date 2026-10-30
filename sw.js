// Service worker: precache everything so the game runs offline from the home screen.
// Bump VERSION whenever files change to roll out an update.
const VERSION = 'charger-v9';   // keep in step with BUILD in js/config.js
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './js/main.js',
  './js/config.js',
  './js/drivetrain.js',
  './js/vehicle.js',
  './js/carModel.js',
  './js/track.js',
  './js/controls.js',
  './js/audio.js',
  './js/engine-worklet.js',
  './js/hud.js',
  './js/effects.js',
  './js/sky.js',
  './js/textures.js',
  './js/scenery.js',
  './js/merge.js',
  './vendor/three.module.min.js',
  './vendor/cannon-es.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Network-first: always try for the latest files (bypassing the browser's HTTP cache, which on
// GitHub Pages holds files for 10 minutes), so an update shows up on the very next launch.
// Offline or on a very slow connection, fall back to the precached copy.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    try {
      const res = await Promise.race([
        fetch(req, { cache: 'no-cache' }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('slow')), 4000)),
      ]);
      if (res.ok) cache.put(req, res.clone());
      return res;
    } catch (err) {
      const cached = await cache.match(req, { ignoreSearch: true });
      if (cached) return cached;
      if (req.mode === 'navigate') return (await cache.match('./index.html')) || Response.error();
      return Response.error();
    }
  })());
});
