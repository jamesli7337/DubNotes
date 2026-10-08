/**
 * App-chrome light/dark theme (never the paper — that's per page, in the
 * notebook data). The preference lives in localStorage; the resolved theme is
 * `<html data-theme="light|dark">`, which the inline script in index.html
 * already set before first paint and this module keeps current.
 *
 * Every change is announced as a window `themechange` event. Nothing needs it
 * today: chrome is styled through CSS tokens, and colours drawn on paper come
 * from the paper itself (canvas/freehand.ts paperOverlay), never the theme.
 */
export type ThemePref = 'system' | 'light' | 'dark';
export type Theme = 'light' | 'dark';

/** Shared with the inline script in index.html — keep the two in step. */
const STORAGE_KEY = 'dubnotes-theme';

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

export function getThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'system' || v === 'light' || v === 'dark') return v;
  } catch {
    /* storage blocked: fall through to the default */
  }
  return 'system';
}

function resolveTheme(pref: ThemePref): Theme {
  if (pref === 'system') return darkQuery.matches ? 'dark' : 'light';
  return pref;
}

/** Sets `data-theme` and the status-bar colour to match `pref`. */
function applyTheme(pref: ThemePref): void {
  const root = document.documentElement;
  root.dataset.theme = resolveTheme(pref);
  // the browser/status-bar tint follows the app surface, whatever it resolves to now
  const surface = getComputedStyle(root).getPropertyValue('--surface').trim();
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta && surface) meta.content = surface;
}

function announce(): void {
  window.dispatchEvent(new CustomEvent('themechange', { detail: { theme: document.documentElement.dataset.theme } }));
}

export function setThemePref(pref: ThemePref): void {
  try {
    localStorage.setItem(STORAGE_KEY, pref);
  } catch {
    /* storage blocked: still applies for this session */
  }
  applyTheme(pref);
  announce();
}

// the OS flipping light/dark only matters while following the system
darkQuery.addEventListener('change', () => {
  const pref = getThemePref();
  if (pref !== 'system') return;
  applyTheme(pref);
  announce();
});

// sync once at startup (the inline script set data-theme, not the meta tag)
applyTheme(getThemePref());
