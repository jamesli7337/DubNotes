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
