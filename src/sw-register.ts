/** Registers the offline service worker. Skipped in `vite dev` so hot reload
 *  is never served from cache. Note: iOS only registers a SW over HTTPS
 *  (or http://localhost) — a plain-HTTP LAN address will silently no-op. */
export function registerSW(): void {
  if (import.meta.env.DEV) return;
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {
      /* offline support just won't be available */
    });
  });
}
