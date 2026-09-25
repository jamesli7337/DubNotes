/* DubNotes service worker — offline support for the installed PWA.
 *
 * Strategy:
 *  - install: PRECACHE every fingerprinted JS/CSS chunk of this build (including
 *    lazily imported ones like pdf-import and the pdf.js worker) plus the
 *    pdfjs-wasm/ decoders, plus index.html. Lazy chunks used to be cached only
 *    if the user had
 *    happened to run that feature while online, so "Import PDF pages" failed
 *    offline with "Failed to fetch dynamically imported module". Precaching is
 *    all-or-nothing: if any asset can't be downloaded the install fails and the
 *    previous worker (with its complete, working cache) stays active.
 *  - navigations: network-first, so the shell stays fresh.
 *  - other same-origin GETs: cache-first, reading ONLY the current build's
 *    cache — Vite fingerprints filenames, and the un-fingerprinted
 *    pdfjs-wasm/*.wasm files live in this build's cache too, so a deploy
 *    replaces them instead of serving the old copy forever.
 *
 * CACHE is versioned by BUILD, a digest of this build's asset list that
 * vite.config.ts's sw-precache plugin stamps in at build time — so every deploy
 * gets a clean cache and `activate` deletes all the older ones.
 * The two /*__SW_*__*\/ tokens below are what that plugin rewrites; the values
 * here are the harmless `vite dev` defaults (dev never registers the worker). */
const BUILD = /*__SW_BUILD__*/ 'dev';
const PRECACHE = /*__SW_PRECACHE__*/ [];

const CACHE = `noteapp-${BUILD}`;
/* A file shared into the app (manifest share_target) is parked here by the
 * fetch handler below and picked up once by the app (src/import-file.ts). */
const SHARE_CACHE = 'noteapp-share';
const SHARE_KEY = 'shared-file';

/** Precache paths are relative to this worker's own URL (…/DubNotes/sw.js). */
const scoped = (path) => new URL(path, self.location.href).href;

/** Fetches one precache entry, bypassing the HTTP cache; rejects unless 2xx. */
async function fetchFresh(url) {
  let res;
  try {
    res = await fetch(url, { cache: 'reload' });
  } catch {
    res = await fetch(url); // some browsers reject the `cache` option
  }
  if (!res.ok) throw new Error(`precache ${url}: ${res.status}`);
  return res;
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // Reloading every entry is deliberate: the fingerprinted chunks don't
      // need it, but index.html and pdfjs-wasm/*.wasm keep the same URL across
      // deploys, so this is what makes a deploy actually replace them.
      await Promise.all(
        PRECACHE.map(async (path) => {
          const url = scoped(path);
          await cache.put(url, await fetchFresh(url));
        })
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Drop every previous build's cache so storage doesn't grow per deploy.
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE && k !== SHARE_CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
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
        .catch(async () => {
          const cache = await caches.open(CACHE);
          return (await cache.match(req)) || (await cache.match(scoped('index.html'))) || Response.error();
        })
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok && (res.type === 'basic' || res.type === 'default')) cache.put(req, res.clone());
      return res;
    })()
  );
});
