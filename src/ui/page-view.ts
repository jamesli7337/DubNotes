import { drawBackground, drawElement } from '../canvas/elements';
import { drawStroke } from '../canvas/freehand';
import { drawTemplate } from '../canvas/templates';
import { DPR, pageH, pageW } from '../const';
import { store } from '../store';
import type { Page } from '../types';
import { isStroke } from '../util';

/**
 * Largest backing-store side, and largest total backing-store area, this will
 * ask a canvas for. iOS Safari silently hands back a blank (or refuses to
 * allocate a) canvas past its own internal limits, and a page zoomed in hard
 * inside a large pane can ask for far more than that — `pw * scale * DPR` is
 * 7380px across at scale 3 / DPR 3. Past these bounds the backing store stops
 * following `scale` and the page simply renders softer, which is the right
 * failure: a slightly blurry reference page beats a blank one.
 */
const MAX_SIDE = 4096;
const MAX_AREA = 12e6;

/**
 * Backing-store pixels per laid-out CSS pixel for a `w × h` (CSS px) canvas:
 * `DPR × quality`, reduced as far as MAX_SIDE/MAX_AREA require. Shared so
 * every canvas the split pane allocates — notebook pages and PDF pages alike
 * — hits the same ceiling, and so overshooting it costs sharpness rather than
 * a canvas iOS silently hands back blank.
 */
export function canvasPixelFactor(w: number, h: number, quality = 1): number {
  if (!(w > 0) || !(h > 0)) return 1;
  const bySide = Math.min(MAX_SIDE / w, MAX_SIDE / h);
  const byArea = Math.sqrt(MAX_AREA / (w * h));
  return Math.max(0.5, Math.min(DPR * quality, bySide, byArea));
}

/**
 * A page rendered read-only into an arbitrary container: the paper template,
 * its background (an imported PDF page or image) and every committed item in
 * z-order, painted once into a single canvas.
 *
 * Deliberately *not* a PageCanvas: it attaches no listeners, reads no
 * `toolState`, shares no camera or selection overlay, and never writes to the
 * store — so nothing it does can reach the page the user is actually editing.
 * It's the same paint loop `renderThumb`/`renderPageCanvas` already use, made
 * remountable and re-renderable at a caller-chosen scale.
 *
 * `scale` is a CSS scale: the canvas lays out at `pageW * scale` CSS px. The
 * device-pixel multiplier on top of that is this class's own business (see
 * MAX_SIDE/MAX_AREA), so callers never have to think about DPR.
 */
export class PageView {
  readonly page: Page;
  /** this page's own size in page units — read once, a page's size never changes after creation */
  private readonly pw: number;
  private readonly ph: number;

  private scale = 1;
  /**
   * Backing-store resolution multiplier, on top of `scale` — see setQuality.
   * Separate from `scale` because a camera-scrolled host (the split pane's
   * scroller) lays its pages out in *world* units and lets one CSS transform
   * do the visual scaling, so only the pixel density needs to track zoom.
   */
  private quality = 1;
  private host: HTMLElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;

  constructor(page: Page) {
    this.page = page;
    this.pw = pageW(page);
    this.ph = pageH(page);
  }

  /** The page's own size in page units — what a caller fits against before choosing a scale. */
  get pageWidth(): number {
    return this.pw;
  }
  get pageHeight(): number {
    return this.ph;
  }

  /** The laid-out size at the current scale, in CSS px. */
  get width(): number {
    return this.pw * this.scale;
  }
  get height(): number {
    return this.ph * this.scale;
  }

  mount(host: HTMLElement): void {
    if (this.canvas) return;
    const c = document.createElement('canvas');
    c.className = 'pane__canvas';
    this.canvas = c;
    this.ctx = c.getContext('2d');
    host.appendChild(c);
    this.host = host;
    this.resize();
    this.refresh();
  }

  unmount(): void {
    this.canvas?.remove();
    this.canvas = null;
    this.ctx = null;
    this.host = null;
  }

  /** Re-lays out the canvas at `s` and repaints it. A no-op if the scale hasn't moved. */
  setScale(s: number): void {
    if (s === this.scale) return;
    this.scale = s;
    if (!this.canvas) return;
    this.resize();
    this.refresh();
  }

  /**
   * Re-renders the backing store at `q` × device pixels per laid-out pixel,
   * leaving the CSS size alone. This is what a camera-scrolled host uses
   * instead of `setScale`: its pages are laid out in world units and scaled
   * visually by one CSS transform on the camera, so zooming must change the
   * *resolution* the page is drawn at without changing its layout size.
   *
   * Costly (a full repaint at a new canvas size), so callers should apply it
   * once a zoom gesture has settled rather than per frame. A no-op if `q`
   * hasn't moved. MAX_SIDE/MAX_AREA still cap the result, so an extreme `q`
   * costs sharpness rather than a failed allocation.
   */
  setQuality(q: number): void {
    if (q === this.quality) return;
    this.quality = q;
    if (!this.canvas) return;
    this.resize();
    this.refresh();
  }

  /**
   * Repaints from the store. Safe to call as often as the caller likes — it's
   * the same full-page paint `PageCanvas.rebuild` does for its own cache, and
   * the pane only calls it when the page it's showing actually changed.
   */
  refresh(): void {
    const ctx = this.ctx;
    const c = this.canvas;
    if (!ctx || !c) return;
    const f = this.pixelFactor();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.setTransform(f, 0, 0, f, 0, 0);
    // `onReady` fires only when something wasn't decoded/rendered yet (a PDF
    // page still rasterising, an image still decoding) — once it lands, this
    // repaint picks it up and registers nothing further, so there's no loop.
    const onReady = (): void => this.refresh();
    try {
      drawTemplate(ctx, this.page.paper, this.pw, this.ph);
      if (this.page.background) drawBackground(ctx, this.page.background, this.pw, this.ph, onReady);
      for (const it of store.itemsOf(this.page.id)) {
        if (isStroke(it)) drawStroke(ctx, it, this.page.paper);
        else drawElement(ctx, it, this.page.paper, 1, onReady);
      }
    } catch {
      /* keep whatever managed to paint */
    }
  }

  private pixelFactor(): number {
    return canvasPixelFactor(this.pw * this.scale, this.ph * this.scale, this.quality);
  }

  private resize(): void {
    const c = this.canvas;
    if (!c) return;
    const f = this.pixelFactor();
    c.width = Math.max(1, Math.round(this.pw * this.scale * f));
    c.height = Math.max(1, Math.round(this.ph * this.scale * f));
    c.style.width = `${this.pw * this.scale}px`;
    c.style.height = `${this.ph * this.scale}px`;
  }
}
