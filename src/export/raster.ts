import { drawBackground, drawElement, loadImage } from '../canvas/elements';
import { drawStroke } from '../canvas/freehand';
import { drawTemplate } from '../canvas/templates';
import { pageH, pageW } from '../const';
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
