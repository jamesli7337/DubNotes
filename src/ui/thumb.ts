import { drawBackground, drawElement } from '../canvas/elements';
import { drawStroke } from '../canvas/freehand';
import { drawTemplate } from '../canvas/templates';
import { DEFAULT_PAPER, PAGE_H, PAGE_W } from '../const';
import { store } from '../store';
import type { Notebook } from '../types';
import { isStroke } from '../util';

/**
 * Renders a small static preview of a notebook's first page (template,
 * background, strokes + elements). `onReady` fires if an image wasn't decoded
 * yet, so the caller can render again.
 */
export function renderThumb(nb: Notebook, wPx = 168, onReady?: () => void): HTMLCanvasElement {
  const scale = wPx / PAGE_W;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const c = document.createElement('canvas');
  c.width = Math.round(wPx * dpr);
  c.height = Math.round(PAGE_H * scale * dpr);
  const ctx = c.getContext('2d');
  if (!ctx) return c;
  ctx.scale(dpr * scale, dpr * scale);
  try {
    const first = store.pagesOf(nb.id)[0];
    drawTemplate(ctx, first ? first.paper : DEFAULT_PAPER, PAGE_W, PAGE_H);
    if (first?.background) drawBackground(ctx, first.background, PAGE_W, PAGE_H, onReady);
    if (first) {
      for (const it of store.itemsOf(first.id)) {
        if (isStroke(it)) drawStroke(ctx, it, first.paper);
        else drawElement(ctx, it, first.paper, 1, onReady);
      }
    }
  } catch {
    /* keep whatever managed to paint */
  }
  // hairline frame so an empty page still reads as a page
  ctx.strokeStyle = 'rgba(4, 21, 52, 0.14)';
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, PAGE_W - 2, PAGE_H - 2);
  return c;
}

/** Fills `host` with a thumbnail once the main thread is idle, so lists paint instantly. */
export function lazyThumb(host: HTMLElement, nb: Notebook, wPx = 168): void {
  let redrawn = false;
  const run = (): void => {
    host.replaceChildren(
      renderThumb(nb, wPx, () => {
        if (redrawn) return; // one repaint once images have decoded is enough
        redrawn = true;
        host.replaceChildren(renderThumb(nb, wPx));
      })
    );
  };
  const ric = (window as Window & { requestIdleCallback?: (cb: () => void, o?: object) => number })
    .requestIdleCallback;
  if (ric) ric(run, { timeout: 800 });
  else setTimeout(run, 0);
}
