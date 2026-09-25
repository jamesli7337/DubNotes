/** Registers the offline service worker. Skipped in `vite dev` so hot reload
 *  is never served from cache. Note: iOS only registers a SW over HTTPS
 *  (or http://localhost) — a plain-HTTP LAN address will silently no-op. */
export function registerSW(): void {
  if (import.meta.env.DEV) return;
  if (!('serviceWorker' in navigator)) return;
  const register = (): void => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch((err) => {
      // offline support just won't be available — surface why rather than swallowing it
      console.warn('Service worker registration failed:', err);
    });
  };
  // main.ts calls this after `await store.init()`, by which point 'load' has
  // usually already fired — waiting on the event unconditionally would mean
  // never registering at all.
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}
