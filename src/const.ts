/** Default logical page size (portrait) — stroke coordinates live in this
 *  space on every device, so a notebook drawn on one screen renders
 *  identically on another. Individual pages can override this (see
 *  `Page.w`/`Page.h` and the `pageW`/`pageH` helpers below) — a PDF page
 *  imported at a different aspect ratio (e.g. a landscape slide) gets sized
 *  to match it instead of being forced into this fixed portrait box. */
export const PAGE_W = 820;
export const PAGE_H = 1060;

/** Backing-store scale, capped so huge notebooks stay within memory. */
export const DPR = Math.min(Math.max(window.devicePixelRatio || 1, 1), 3);

import type { Page, Paper } from './types';

/** Paper for a brand-new page when there is no preceding page to copy. */
export const DEFAULT_PAPER: Paper = { template: 'blank', spacing: 'medium', color: 'white' };

/** A page's own width/height, falling back to the default portrait size for
 *  every page that never had a custom size set (i.e. every page except one
 *  created from a PDF import with a non-default aspect ratio — see
 *  importPdf/importPdfPages in pdf-import.ts). Always read a page's
 *  dimensions through these rather than the PAGE_W/PAGE_H constants
 *  directly, anywhere a specific page is in scope. */
export function pageW(page: Page): number {
  return page.w ?? PAGE_W;
}
export function pageH(page: Page): number {
  return page.h ?? PAGE_H;
}

/**
 * Largest backing-store side, and largest total backing-store area, any page
 * canvas will ask for. iOS Safari silently hands back a blank (or refuses to
 * allocate a) canvas past its own internal limits, and a page zoomed in hard
 * can ask for far more than that — `pw * DPR * quality` is 7380px across at
 * quality 3 / DPR 3. Past these bounds the backing store stops following
 * `quality` and the page simply renders softer, which is the right failure: a
 * slightly blurry page beats a blank one.
 */
const MAX_SIDE = 4096;
const MAX_AREA = 12e6;

/**
 * Backing-store pixels per laid-out CSS pixel for a `w × h` (CSS px) canvas:
 * `DPR × quality`, reduced as far as MAX_SIDE/MAX_AREA require. Shared so
 * every page canvas in the app — the main view's PageCanvas, and the split
 * pane's PageView — hits the same ceiling, and so overshooting it costs
 * sharpness rather than a canvas iOS silently hands back blank.
 *
 * This is a *per-canvas* ceiling only. A caller holding several canvases at
 * once (the main view's mount window) also has to budget across them; see
 * NotebookView.pageQuality.
 */
export function canvasPixelFactor(w: number, h: number, quality = 1): number {
  if (!(w > 0) || !(h > 0)) return 1;
  const bySide = Math.min(MAX_SIDE / w, MAX_SIDE / h);
  const byArea = Math.sqrt(MAX_AREA / (w * h));
  return Math.max(0.5, Math.min(DPR * quality, bySide, byArea));
}
