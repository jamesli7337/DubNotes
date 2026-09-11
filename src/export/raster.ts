import { drawBackground, drawElement, loadImage } from '../canvas/elements';
import { drawStroke } from '../canvas/freehand';
import { drawTemplate } from '../canvas/templates';
import { PAGE_H, PAGE_W } from '../const';
import { ensurePdfPage } from '../pdf-render';
import { store } from '../store';
import type { Notebook, Page } from '../types';
import { downloadBlob, isStroke, safeFileName } from '../util';

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
 */
export async function renderPageCanvas(page: Page, scale = 2): Promise<HTMLCanvasElement> {
  await preloadPageImages(page);
  const c = document.createElement('canvas');
  c.width = Math.round(PAGE_W * scale);
  c.height = Math.round(PAGE_H * scale);
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('Could not create a canvas.');
  ctx.scale(scale, scale);
  drawTemplate(ctx, page.paper, PAGE_W, PAGE_H);
  if (page.background) drawBackground(ctx, page.background, PAGE_W, PAGE_H);
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

/** Downloads one page as a PNG or JPEG at 2× the page size. */
export async function exportPageImage(nb: Notebook, page: Page, format: 'png' | 'jpeg'): Promise<void> {
  const c = await renderPageCanvas(page, 2);
  const blob = format === 'png' ? await toBlob(c, 'image/png') : await toBlob(c, 'image/jpeg', 0.92);
  downloadBlob(`${safeFileName(nb.name)} - page ${page.index + 1}.${format === 'png' ? 'png' : 'jpg'}`, blob);
}
