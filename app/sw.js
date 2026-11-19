// Keeps a copy of the app's own files so Glasswave opens instantly and keeps
// working after the little launcher on your computer has gone back to sleep.
// Only this app's files are handled here; nothing from Spotify is stored.
const CACHE = 'glasswave-v7';
const FILES = ['/index.html', '/styles.css', '/icon.png', '/icon-192.png', '/icon-512.png', '/manifest.webmanifest',
  '/js/app.js', '/js/config.js', '/js/util.js', '/js/auth.js', '/js/api.js', '/js/demo.js', '/js/player.js', '/js/ui.js', '/js/views.js', '/js/theme.js', '/js/recs.js', '/js/library.js', '/js/local.js', '/js/lyrics.js', '/js/viz.js', '/js/hotkeys.js', '/js/smart.js'];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).catch(() => {}));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/__')) return;          // music files and lyrics go straight to the helper
  const page = e.request.mode === 'navigate';
  const key = page ? '/index.html' : url.pathname;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const fresh = await fetch(page ? '/index.html' : e.request, { cache: 'no-store' });   // newest files while the launcher is running
      if (fresh.ok) cache.put(key, fresh.clone());
      return fresh;
    } catch {
      return (await cache.match(key)) || Response.error();                                  // otherwise the saved copy
    }
  })());
});
