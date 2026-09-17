import { drawBackground, drawElement, loadImage } from '../canvas/elements';
import type { Drawable } from '../canvas/freehand';
import { drawStroke } from '../canvas/freehand';
import { aabb, itemBounds, unionRects } from '../canvas/geom';
import { drawTemplate } from '../canvas/templates';
import { DEFAULT_PAPER, pageH, pageW } from '../const';
import { ensurePdfPage } from '../pdf-render';
import { store } from '../store';
import type { Notebook, Page } from '../types';
import { clamp, downloadBlob, isStroke, safeFileName } from '../util';

/** A vertical slice of the page, in page units — `top`/`bottom` clamped to `[0, pageH(page)]`. Omit for the whole page. */
export interface PageRegion {
  top: number;
  bottom: number;
}

/** Every image a page needs, decoded (and its PDF page rendered), so nothing exports as a placeholder. */
export async function preloadPageImages(page: Page): Promise<void> {
  const jobs: Promise<unknown>[] = [];
  const bg = page.background;
  if (bg?.assetId) jobs.push(ensurePdfPage(bg.assetId, bg.page).catch(() => undefined));
  else if (bg?.src) jobs.push(loadImage(bg.src).catch(() => undefined));
  for (const e of store.elementsOf(page.id)) if (e.kind === 'image') jobs.push(loadImage(e.src).catch(() => undefined));
  await Promise.all(jobs);
}

/**
 * Paints a page exactly as the notebook shows it (paper, background, strokes
 * and elements in z-order; tapes covering) into a fresh canvas at `scale`×.
 * With `region`, only that vertical slice is painted (canvas height matches
 * the slice, not the whole page) — everything above `region.top` is drawn at
 * a negative offset and falls outside the canvas, which clips it for free.
 */
export async function renderPageCanvas(page: Page, scale = 2, region?: PageRegion): Promise<HTMLCanvasElement> {
  await preloadPageImages(page);
  const pw = pageW(page);
  const ph = pageH(page);
  const top = region ? clamp(region.top, 0, ph) : 0;
  const bottom = region ? clamp(region.bottom, top, ph) : ph;
  const c = document.createElement('canvas');
  c.width = Math.round(pw * scale);
  c.height = Math.round((bottom - top) * scale);
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('Could not create a canvas.');
  ctx.scale(scale, scale);
  if (top) ctx.translate(0, -top);
  drawTemplate(ctx, page.paper, pw, ph);
  if (page.background) drawBackground(ctx, page.background, pw, ph);
  for (const it of store.itemsOf(page.id)) {
    if (isStroke(it)) drawStroke(ctx, it, page.paper);
    else drawElement(ctx, it, page.paper);
  }
  return c;
}

function toBlob(c: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    c.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode the image.'))), type, quality);
  });
}

/** Downloads one page (or a region of it) as a PNG or JPEG at 2× size. */
export async function exportPageImage(
  nb: Notebook,
  page: Page,
  format: 'png' | 'jpeg',
  region?: PageRegion
): Promise<void> {
  const c = await renderPageCanvas(page, 2, region);
  const blob = format === 'png' ? await toBlob(c, 'image/png') : await toBlob(c, 'image/jpeg', 0.92);
  downloadBlob(`${safeFileName(nb.name)} - page ${page.index + 1}.${format === 'png' ? 'png' : 'jpg'}`, blob);
}

/**
 * Rasterizes a page region as base64 PNG data (no `data:` prefix) — for
 * sending over the network (AI mode), where a data URL would waste bytes
 * re-stating what `mimeType` already says. `scale` is lower than export's
 * default: legible for OCR-style reading without a large upload.
 */
export async function renderPageRegionImage(
  page: Page,
  region?: PageRegion,
  scale = 1.5
): Promise<{ base64: string; mimeType: string }> {
  const c = await renderPageCanvas(page, scale, region);
  const dataUrl = c.toDataURL('image/png');
  return { base64: dataUrl.slice(dataUrl.indexOf(',') + 1), mimeType: 'image/png' };
}

/**
 * Rasterizes just the given items — no paper template, no page background,
 * no other ink — on a plain white canvas cropped tightly to their own
 * combined bounding box (plus a little padding). Used by AI mode to send its
 * violet "question" ink as its own image, structurally separate from the
 * full-page context image, rather than relying on Gemini to visually pick
 * the right ink out of one mixed picture (see ai-mode.ts / api/gemini.ts).
 * `itemIds` must be non-empty.
 */
export async function renderItemsImage(
  page: Page,
  itemIds: Set<string>,
  scale = 1.5
): Promise<{ base64: string; mimeType: string }> {
  const items = store.itemsOf(page.id).filter((it) => itemIds.has(it.id));
  const pad = 24;
  const bounds = unionRects(items.map(itemBounds))!;
  const c = document.createElement('canvas');
  c.width = Math.round((bounds.w + pad * 2) * scale);
  c.height = Math.round((bounds.h + pad * 2) * scale);
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('Could not create a canvas.');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.scale(scale, scale);
  ctx.translate(pad - bounds.x, pad - bounds.y);
  for (const it of items) {
    if (isStroke(it)) drawStroke(ctx, it, page.paper);
    else drawElement(ctx, it, page.paper);
  }
  const dataUrl = c.toDataURL('image/png');
  return { base64: dataUrl.slice(dataUrl.indexOf(',') + 1), mimeType: 'image/png' };
}

/**
 * Rasterizes raw in-memory strokes that were never added to `store` — a
 * blank white canvas cropped tightly to their own combined bounds, same
 * approach as `renderItemsImage` but for strokes that don't (and won't)
 * belong to any page: the branched-thread handwriting pad (see
 * ai-thread.ts) draws scratch ink purely for one transcription, then
 * discards it, so there's no `pageId`/`store` to read from. `strokes` must
 * be non-empty. Paper is fixed to `DEFAULT_PAPER` (white) purely to resolve
 * `AUTO_COLOR` if a stroke ever used it — the pad always inks a literal
 * colour, never "auto", so this never actually matters in practice.
 */
export async function renderStrokesImage(strokes: Drawable[], scale = 1.5): Promise<{ base64: string; mimeType: string }> {
  const pad = 24;
  const bounds = unionRects(strokes.map((s) => aabb(s.points, s.size / 2)))!;
  const c = document.createElement('canvas');
  c.width = Math.round((bounds.w + pad * 2) * scale);
  c.height = Math.round((bounds.h + pad * 2) * scale);
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('Could not create a canvas.');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.scale(scale, scale);
  ctx.translate(pad - bounds.x, pad - bounds.y);
  for (const s of strokes) drawStroke(ctx, s, DEFAULT_PAPER);
  const dataUrl = c.toDataURL('image/png');
  return { base64: dataUrl.slice(dataUrl.indexOf(',') + 1), mimeType: 'image/png' };
}
