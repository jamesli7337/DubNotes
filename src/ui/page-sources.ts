import { paperBg } from '../canvas/templates';
import { pageH, pageW } from '../const';
import { getPdfPage, isPdfPageFailed, pdfPageSizes, registerPdfBytes, releasePdfBytes } from '../pdf-render';
import { store } from '../store';
import { el } from './dom';
import { canvasPixelFactor, PageView } from './page-view';
import type { PageHandle, PageSource, SourcePage } from './page-scroller';

/**
 * The two things a `PageScroller` can scroll through. Everything about the
 * column itself — camera, gestures, layout, mount window, anchoring — lives in
 * page-scroller.ts and is shared; these only answer "what pages are there" and
 * "how does one paint".
 */

/** A no-op handle, for the (shouldn't-happen) case where a page vanishes between layout and mount. */
const NOOP_HANDLE: PageHandle = {
  setQuality: () => undefined,
  refresh: () => undefined,
  unmount: () => undefined,
};

// ------------------------------------------------------------ notebook pages

/**
 * A notebook's own pages, rendered read-only by `PageView`.
 *
 * `revision()` is `Notebook.updatedAt`, which `store.bump()` moves on every
 * mutation to that notebook. The store has no change notification and
 * `store.pagesOf` scans every page in the app, so that token is what lets the
 * scroller poll for page-list changes on each committed op for free.
 */
export class NotebookPageSource implements PageSource {
  readonly notebookId: string;

  constructor(notebookId: string) {
    this.notebookId = notebookId;
  }

  pages(): SourcePage[] {
    return store.pagesOf(this.notebookId).map((p) => ({ id: p.id, w: pageW(p), h: pageH(p) }));
  }

  revision(): number {
    return store.notebooks.get(this.notebookId)?.updatedAt ?? -1;
  }

  background(page: SourcePage): string {
    const p = store.pageById(page.id);
    return p ? paperBg(p.paper) : '#ffffff';
  }

  mount(page: SourcePage, host: HTMLElement, quality: number): PageHandle {
    const p = store.pageById(page.id);
    if (!p) return NOOP_HANDLE;
    const view = new PageView(p);
    view.setQuality(quality);
    view.mount(host);
    return {
      setQuality: (q) => view.setQuality(q),
      refresh: () => view.refresh(),
      unmount: () => view.unmount(),
    };
  }
}

// ----------------------------------------------------------------- PDF pages

/**
 * One page of a reference PDF, painted from the shared renderer.
 *
 * The canvas is laid out at the page's own world size and only its backing
 * store tracks zoom, exactly as `PageView` does — the scroller's camera
 * transform does all the visual scaling. `getPdfPage` returns the rasterised
 * page synchronously when it's ready and otherwise calls back once it is, so
 * the first paint can be a plain white page that fills itself in a moment
 * later without blocking the scroll.
 */
class PdfPageHandle implements PageHandle {
  private readonly key: string;
  private readonly pageNum: number;
  private readonly w: number;
  private readonly h: number;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private quality: number;
  private dead = false;

  constructor(key: string, pageNum: number, w: number, h: number, host: HTMLElement, quality: number) {
    this.key = key;
    this.pageNum = pageNum;
    this.w = w;
    this.h = h;
    this.quality = quality;
    this.canvas = el('canvas', { class: 'pane__canvas' }) as HTMLCanvasElement;
    this.ctx = this.canvas.getContext('2d');
    host.appendChild(this.canvas);
    this.resize();
    this.render();
  }

  setQuality(q: number): void {
    if (q === this.quality || this.dead) return;
    this.quality = q;
    this.resize();
    this.render();
  }

  refresh(): void {
    if (!this.dead) this.render();
  }

  unmount(): void {
    this.dead = true;
    this.canvas.remove();
  }

  private resize(): void {
    const f = canvasPixelFactor(this.w, this.h, this.quality);
    this.canvas.width = Math.max(1, Math.round(this.w * f));
    this.canvas.height = Math.max(1, Math.round(this.h * f));
    this.canvas.style.width = `${this.w}px`;
    this.canvas.style.height = `${this.h}px`;
  }

  private render(): void {
    const ctx = this.ctx;
    if (!ctx || this.dead) return;
    const f = canvasPixelFactor(this.w, this.h, this.quality);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(f, 0, 0, f, 0, 0);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, this.w, this.h);
    // `onReady` only fires when the page wasn't rasterised yet; once it lands
    // this repaint picks it up and registers nothing further, so there's no loop
    const src = getPdfPage(this.key, this.pageNum, () => this.render());
    if (src) {
      ctx.drawImage(src, 0, 0, src.width, src.height, 0, 0, this.w, this.h);
      return;
    }
    if (isPdfPageFailed(this.key, this.pageNum)) {
      ctx.fillStyle = '#e3e1da';
      ctx.fillRect(0, 0, this.w, this.h);
      ctx.fillStyle = '#79766c';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `${Math.round(this.w / 26)}px system-ui, sans-serif`;
      ctx.fillText("This page couldn't be rendered", this.w / 2, this.h / 2);
    }
  }
}

/**
 * A reference PDF's pages. Its bytes are handed to the shared renderer under
 * a pane-local key (see `registerPdfBytes`) rather than going into the app's
 * asset store, so the file stays the pane's own and never reaches a notebook
 * or a backup.
 *
 * World units here are PDF points — each page is laid out at its own natural
 * size, so a mixed-size document stays honest and fit-to-width still works.
 */
export class PdfPageSource implements PageSource {
  readonly key: string;
  private sizes: Array<{ w: number; h: number }> = [];
  private rev = 0;

  constructor(key: string) {
    this.key = key;
  }

  /** Parses the document and reads every page's size. Resolves false if it isn't a readable PDF. */
  async load(data: ArrayBuffer): Promise<boolean> {
    try {
      registerPdfBytes(this.key, data);
      this.sizes = await pdfPageSizes(this.key);
      this.rev++;
      return this.sizes.length > 0;
    } catch {
      releasePdfBytes(this.key);
      this.sizes = [];
      return false;
    }
  }

  get pageCount(): number {
    return this.sizes.length;
  }

  /** Drops the parsed document and its rendered pages — call when the overlay closes for good. */
  release(): void {
    releasePdfBytes(this.key);
    this.sizes = [];
    this.rev++;
  }

  pages(): SourcePage[] {
    // 1-based ids, matching the page numbers `getPdfPage` takes
    return this.sizes.map((s, i) => ({ id: String(i + 1), w: s.w, h: s.h }));
  }

  /** A loaded PDF's page list never changes, so this only moves across load/release. */
  revision(): number {
    return this.rev;
  }

  background(): string {
    return '#ffffff';
  }

  mount(page: SourcePage, host: HTMLElement, quality: number): PageHandle {
    const n = Number(page.id);
    if (!Number.isFinite(n)) return NOOP_HANDLE;
    return new PdfPageHandle(this.key, n, page.w, page.h, host, quality);
  }
}

// --------------------------------------------------------------- an image

/**
 * A reference image as a single-page column, so it runs through the same
 * `PageScroller` as a notebook's pages and a PDF's — one fit-to-width default,
 * one set of pinch/pan gestures, one scrollbar, one pane.
 *
 * Unlike the other two this paints no canvas: the page is an `<img>` laid out
 * at the picture's natural size in world units, and the scroller's camera
 * transform does the scaling. That means `quality` has nothing to do — the
 * browser resamples the decoded bitmap itself at whatever zoom the camera is
 * at, which is both sharper and cheaper than re-rasterising into a canvas on
 * every settle.
 */
export class ImagePageSource implements PageSource {
  readonly key = 'image';
  private url: string | null = null;
  private w = 0;
  private h = 0;
  private rev = 0;

  /** Decodes the blob and records its natural size. Resolves false if it isn't a usable image. */
  async load(blob: Blob): Promise<boolean> {
    this.release();
    const url = URL.createObjectURL(blob);
    const ok = await new Promise<boolean>((resolve) => {
      const probe = new Image();
      probe.onload = () => {
        this.w = probe.naturalWidth;
        this.h = probe.naturalHeight;
        resolve(probe.naturalWidth > 0 && probe.naturalHeight > 0);
      };
      probe.onerror = () => resolve(false);
      probe.src = url;
    });
    if (!ok) {
      URL.revokeObjectURL(url);
      return false;
    }
    this.url = url;
    this.rev++;
    return true;
  }

  /** Drops the object URL — call when the split closes for good. */
  release(): void {
    if (this.url) {
      URL.revokeObjectURL(this.url);
      this.url = null;
    }
    this.w = this.h = 0;
    this.rev++;
  }

  pages(): SourcePage[] {
    return this.url ? [{ id: this.key, w: this.w, h: this.h }] : [];
  }

  /** One page that never changes, so this only moves across load/release. */
  revision(): number {
    return this.rev;
  }

  background(): string {
    return '#ffffff';
  }

  mount(page: SourcePage, host: HTMLElement, _quality: number): PageHandle {
    void _quality; // the camera scales the <img>; there is no backing store to re-render
    if (!this.url) return NOOP_HANDLE;
    const img = el('img', { class: 'pscroll-img', alt: 'Reference image' }) as HTMLImageElement;
    img.draggable = false;
    img.style.width = `${page.w}px`;
    img.style.height = `${page.h}px`;
    img.src = this.url;
    host.appendChild(img);
    return {
      setQuality: () => undefined,
      refresh: () => undefined,
      unmount: () => img.remove(),
    };
  }
}
