import { drawBackground, drawElement } from '../canvas/elements';
import { drawStroke } from '../canvas/freehand';
import { drawTemplate } from '../canvas/templates';
import { DEFAULT_PAPER, PAGE_H, PAGE_W, pageH, pageW } from '../const';
import { store } from '../store';
import type { Notebook } from '../types';
import { isStroke } from '../util';

/**
 * Renders a small static preview of a notebook's first page (template,
 * background, strokes + elements), sized to that page's own aspect ratio
 * (a landscape-imported first page thumbnails wide/short, not squeezed into
 * a portrait box). `onReady` fires if an image wasn't decoded yet, so the
 * caller can render again.
 */
export function renderThumb(nb: Notebook, wPx = 168, onReady?: () => void): HTMLCanvasElement {
  const first = store.pagesOf(nb.id)[0];
  const pw = first ? pageW(first) : PAGE_W;
  const ph = first ? pageH(first) : PAGE_H;
  const scale = wPx / pw;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const c = document.createElement('canvas');
  c.width = Math.round(wPx * dpr);
  c.height = Math.round(ph * scale * dpr);
  const ctx = c.getContext('2d');
  if (!ctx) return c;
  ctx.scale(dpr * scale, dpr * scale);
  try {
    drawTemplate(ctx, first ? first.paper : DEFAULT_PAPER, pw, ph);
    if (first?.background) drawBackground(ctx, first.background, pw, ph, onReady);
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
  ctx.strokeRect(1, 1, pw - 2, ph - 2);
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
