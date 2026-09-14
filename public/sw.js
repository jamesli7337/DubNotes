/* DubNotes service worker — runtime caching so the app opens offline.
 * Strategy: network-first for navigations (keeps the shell fresh),
 * cache-first for same-origin static assets (Vite fingerprints filenames,
 * so a cached asset is safe until the next deploy).
 *
 * CACHE convention: increment the version on EVERY change to this file
 * (v2 → v3 → …), whether or not the caching logic itself changed. The
 * activate step deletes every cache except the current one, so a bump is what
 * guarantees an updated worker starts from a clean cache rather than serving
 * whatever the previous version stored. History: v3 = share-target support. */
const CACHE = 'noteapp-v3';
/* A file shared into the app (manifest share_target) is parked here by the
 * fetch handler below and picked up once by the app (src/import-file.ts). */
const SHARE_CACHE = 'noteapp-share';
const SHARE_KEY = 'shared-file';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== SHARE_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // the share sheet POSTs the chosen file to ./share-target: stash it and send
  // the app to its start page flagged ?shared=1, where it imports the file
  if (req.method === 'POST' && url.pathname.endsWith('/share-target')) {
    event.respondWith(
      (async () => {
        const start = new URL(url.pathname.replace(/share-target$/, ''), url.origin);
        start.searchParams.set('shared', '1');
        try {
          const form = await req.formData();
          const file = form.get('file');
          if (file && typeof file !== 'string') {
            const cache = await caches.open(SHARE_CACHE);
            await cache.put(
              SHARE_KEY,
              new Response(file, {
                headers: {
                  'Content-Type': file.type || 'application/pdf',
                  'X-File-Name': encodeURIComponent(file.name || 'Shared.pdf'),
                },
              })
            );
          }
        } catch {
          /* nothing to import; the app just opens */
        }
        return Response.redirect(start.href, 303);
      })()
    );
    return;
  }

  if (req.method !== 'GET') return;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then((m) => m || caches.match('./index.html')))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        if (res.ok && (res.type === 'basic' || res.type === 'default')) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      });
    })
  );
});
