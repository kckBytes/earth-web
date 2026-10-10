// Offline shell: the app and its textures are cached on first visit. Clouds come live from the
// network (cross-origin, not cached here); without a connection the app falls back to tex/clouds.jpg.
const V = 'earth-v3';                 // app shell; 'earth-data' (frames, weather) is managed by the app
const SHELL = ['./', 'index.html', 'app.js', 'flow.js', 'palettes.js', 'streaks.js', 'labels.js', 'globe.vert', 'globe.frag',
  'streak.vert', 'streak.frag', 'manifest.webmanifest',
  'tex/lights.jpg', 'tex/water.jpg', 'tex/clouds.jpg', 'icons/icon-180.png', 'icons/icon-192.png'];
self.addEventListener('install', e => e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys()
  .then(ks => Promise.all(ks.filter(k => k !== V && k !== 'earth-data').map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (u.origin !== location.origin || e.request.method !== 'GET') return;
  const isCode = /\.(html|js|frag|vert|webmanifest)$/.test(u.pathname) || u.pathname.endsWith('/');
  if (isCode) {   // code: network first so updates arrive, cache as fallback
    e.respondWith(fetch(e.request).then(r => { const c = r.clone(); caches.open(V).then(x => x.put(e.request, c)); return r; })
      .catch(() => caches.match(e.request)));
  } else {        // textures: cache first (they never change)
    e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(r => {
      const c = r.clone(); caches.open(V).then(x => x.put(e.request, c)); return r; })));
  }
});
