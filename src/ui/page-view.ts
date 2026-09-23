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
   * Repaints from the store. Safe to call as often as the caller likes — it's
   * the same full-page paint `PageCanvas.rebuild` does for its own cache, and
   * the pane only calls it when the page it's showing actually changed.
   */
  refresh(): void {
    const ctx = this.ctx;
    const c = this.canvas;
    if (!ctx || !c) return;
    const dpr = this.deviceScale();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
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

  /**
   * The device-pixel multiplier actually used for the backing store: DPR,
   * reduced as far as MAX_SIDE/MAX_AREA require. Independent of `scale`'s own
   * CSS layout, so overshooting the limits costs sharpness and nothing else.
   */
  private deviceScale(): number {
    const w = this.pw * this.scale;
    const h = this.ph * this.scale;
    const bySide = Math.min(MAX_SIDE / w, MAX_SIDE / h);
    const byArea = Math.sqrt(MAX_AREA / (w * h));
    return Math.max(0.5, Math.min(DPR, bySide, byArea));
  }

  private resize(): void {
    const c = this.canvas;
    if (!c) return;
    const dpr = this.deviceScale();
    c.width = Math.max(1, Math.round(this.pw * this.scale * dpr));
    c.height = Math.max(1, Math.round(this.ph * this.scale * dpr));
    c.style.width = `${this.pw * this.scale}px`;
    c.style.height = `${this.ph * this.scale}px`;
  }
}
