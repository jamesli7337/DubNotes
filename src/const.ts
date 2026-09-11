/** Logical page size. Stroke coordinates live in this space on every device,
 *  so a notebook drawn on one screen renders identically on another. */
export const PAGE_W = 820;
export const PAGE_H = 1060;

/** Backing-store scale, capped so huge notebooks stay within memory. */
export const DPR = Math.min(Math.max(window.devicePixelRatio || 1, 1), 3);

import type { Paper } from './types';

/** Paper for a brand-new page when there is no preceding page to copy. */
export const DEFAULT_PAPER: Paper = { template: 'blank', spacing: 'medium', color: 'white' };
