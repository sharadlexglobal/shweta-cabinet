// Bumped on every release. A fresh name means the whole shell is fetched again
// as one set, so the page and the code that runs it can never be from different
// versions.
const CACHE = 'shweta-cabinet-v8';
const SHELL = ['/', '/styles.css', '/app.js', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  // Bypass any HTTP cache so a stale copy cannot slip into a new release, and
  // let the whole thing fail rather than install a half-built shell.
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      cache.addAll(SHELL.map((url) => new Request(url, { cache: 'reload' })))
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isShell(url) {
  return SHELL.includes(url.pathname) || url.pathname === '/index.html';
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Leave anything that is not ours alone: fonts, stored files and the API are
  // none of this cache's business, and copying big media would fill the phone.
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate' || isShell(url)) {
    // The shell always comes from one install, so its parts always match.
    event.respondWith(
      caches.match(request.mode === 'navigate' ? '/' : request)
        .then((cached) => cached || fetch(request))
    );
    return;
  }

  event.respondWith(
    fetch(request)
      .then((response) => {
        // Only a good answer is worth keeping. Caching an error page would turn
        // one bad morning into a broken app for days.
        if (response.ok && response.type === 'basic') {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
        }
        return response;
      })
      .catch(() => caches.match(request))
  );
});
