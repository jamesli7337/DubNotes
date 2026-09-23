import { DPR } from '../const';
import { clamp } from '../util';
import { el } from './dom';

/**
 * A read-only, continuously scrolling column of pages for the split pane —
 * the same shape as the main notebook view (a vertical run of pages under one
 * camera transform, with pinch-zoom and one-finger pan), built separately
 * rather than by instantiating `NotebookView` a second time.
 *
 * Where the pages come from is a `PageSource` (see page-sources.ts): a
 * notebook's own pages, or a reference PDF's. Nothing below that interface
 * knows the difference.
 *
 * Deliberately *not* coupled to NotebookView: its camera/gesture code is
 * tangled with the dock, the selection overlay, the lasso callout, AI mode and
 * a window-level key handler, none of which a read-only pane wants, and all of
 * which assume a single instance. The behaviour is matched here instead — same
 * zoom limits, same fit-to-width default, same rubber-band-and-momentum feel —
 * over a much smaller surface: no tool state, no undo, no selection, no
 * palm-rejection (nothing here draws), and one canvas per page rather than
 * `PageCanvas`'s two.
 *
 * Two rules shape the implementation:
 *
 *  - **No per-frame layout reads.** Page positions come from a layout computed
 *    once per zoom/page-set change (`relayout`), not from `offsetTop`; the
 *    viewport rect is cached and re-read only when it can actually have
 *    changed (a gesture starting, a resize, the pane being dragged). A pan
 *    frame therefore touches nothing but arithmetic and one `transform`.
 *  - **Re-rendering is incremental.** A zoom changes every mounted page's
 *    backing-store resolution, which is a full repaint each; those are queued
 *    and drained one per animation frame (`drainQuality`) so a four-page
 *    window never repaints them all in one go.
 */

/** Matches the main view's own zoom bounds, so the pane feels like the notebook. */
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;
/** Gap between pages, in world units — the main view's `.page-wrap` margin. */
const PAGE_GAP = 22;
/** Padding above the first page and below the last, in world units. */
const PAD = 16;
/** Margin subtracted from the pane's width when fitting a page to it. */
const FIT_INSET = 16;
/** Pages kept mounted on each side of the visible run. */
const MOUNT_NEIGHBOURS = 1;
/** Re-render mounted pages once a zoom gesture has been quiet this long. */
const SETTLE_MS = 180;
/**
 * Backing-store budget per mounted page, in device pixels. Zooming in wants
 * `DPR × zoom` pixels per world unit for a crisp page, but at max zoom on a
 * 3× screen that is ~48 MB *per page* and the mount window holds several — so
 * the quality passed to each page is capped to keep any one page near this
 * budget (~17 MB). Past that point zooming still magnifies, just without
 * gaining resolution; the alternative is tiling, which this doesn't do.
 */
const MAX_PAGE_PIXELS = 4.2e6;
/** Momentum: per-frame velocity decay, and the speed below which it stops. */
const FRICTION = 0.94;
const MIN_SPEED = 0.015;
/** How hard a drag past the content bounds resists, and how fast it springs back. */
const RUBBER = 0.35;
const SPRING = 0.18;

/** Where the pane is scrolled to, in a form that survives pages being added or removed. */
export interface ScrollAnchor {
  /** the page at the top of the viewport */
  pageId: string;
  /** world units from that page's own top down to the camera */
  offset: number;
  zoom: number;
}

export interface ScrollerHooks {
  /** The page most in view changed — for the header's "3 / 12" label. */
  onCurrentPage: (index: number, total: number) => void;
  /** The camera settled somewhere new; the pane persists the anchor. Already debounced by gesture end. */
  onAnchorChanged: () => void;
}

/** One page as the scroller sees it: an identity for anchoring, and a world-space size to lay out. */
export interface SourcePage {
  id: string;
  w: number;
  h: number;
}

/** What the scroller holds onto for a mounted page; the source decides how it actually paints. */
export interface PageHandle {
  /** Re-render at `q` device pixels per world unit. Called on a settled zoom, one page per frame. */
  setQuality: (q: number) => void;
  /** Repaint at the current quality — the content changed underneath. */
  refresh: () => void;
  unmount: () => void;
}

/**
 * Where the scroller's pages come from. Everything above this line — the
 * camera, the gestures, the layout, the mount window, the anchoring — is the
 * same whether the column is a notebook's own pages or a reference PDF's;
 * only the page list and how a page paints differ, and that is all this is.
 */
export interface PageSource {
  /** The column, top to bottom. Re-read whenever `revision()` moves. */
  pages(): SourcePage[];
  /**
   * A cheap change token. The scroller compares it before re-reading `pages()`
   * (which may be expensive), so it can be polled on every committed op. A
   * source whose page list never changes can just return a constant.
   */
  revision(): number;
  /** Builds the DOM for one page inside `host`, which is already sized to the page's world box. */
  mount(page: SourcePage, host: HTMLElement, quality: number): PageHandle;
  /** Background colour to show under a page before it has painted. */
  background(page: SourcePage): string;
}

interface Slot {
  page: SourcePage;
  /** world-space box, recomputed by relayout() */
  top: number;
  left: number;
  w: number;
  h: number;
  wrap: HTMLElement | null;
  handle: PageHandle | null;
}

export class PageScroller {
  private readonly source: PageSource;
  private readonly hooks: ScrollerHooks;

  private host: HTMLElement | null = null;
  private cameraEl: HTMLElement | null = null;

  private slots: Slot[] = [];
  private contentW = 0;
  private contentH = 0;

  private readonly camera = { x: 0, y: 0, zoom: 1 };
  /** cached viewport size — re-read only on resize or at a gesture's start, never per frame */
  private viewW = 0;
  private viewH = 0;
  /** cached viewport origin in client coords, for turning touch points into local ones */
  private viewLeft = 0;
  private viewTop = 0;

  private currentIndex = -1;
  /** the source's revision as of the last page-list check — the gate in syncPages. */
  private lastRevision = Number.NaN;

  private pinch: { d0: number; z0: number; cx: number; cy: number } | null = null;
  private panTouch: { id: number; x: number; y: number; t: number; vx: number; vy: number } | null = null;
  private panMouse: { id: number; x: number; y: number; camX: number; camY: number } | null = null;
  private momentumRaf = 0;

  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  /** mounted pages still waiting to be re-rendered at the settled zoom */
  private qualityQueue: Slot[] = [];
  private qualityRaf = 0;

  private resizeObserver: ResizeObserver | null = null;

  constructor(source: PageSource, hooks: ScrollerHooks) {
    this.source = source;
    this.hooks = hooks;
  }

  get currentPageId(): string | null {
    return this.slots[this.currentIndex]?.page.id ?? null;
  }

  // ------------------------------------------------------------------ mount

  mount(host: HTMLElement, anchor?: ScrollAnchor | null): void {
    this.host = host;
    const cam = el('div', { class: 'pscroll-camera' });
    host.appendChild(cam);
    this.cameraEl = cam;

    this.slots = this.source.pages().map((page) => this.newSlot(page));
    this.lastRevision = this.source.revision();

    this.measure();
    // fit-to-width by default, exactly as the main view starts (min(1, …),
    // then the shared zoom clamp) — a restored anchor overrides it
    const first = this.slots[0];
    const fit = first ? Math.min(1, (this.viewW - FIT_INSET) / first.w) || 1 : 1;
    // a non-positive saved zoom means "no zoom was ever recorded" — the case
    // for a split saved before the pane scrolled — so fall back to the fit
    const wanted = anchor && anchor.zoom > 0 ? anchor.zoom : fit;
    this.camera.zoom = clamp(wanted, ZOOM_MIN, ZOOM_MAX);
    this.relayout();

    if (anchor) this.scrollToAnchor(anchor);
    else this.camera.y = this.minY();
    this.camera.x = this.clampX(this.camera.x);
    this.camera.y = clamp(this.camera.y, this.minY(), this.maxY());

    this.bindGestures(host);
    this.resizeObserver = new ResizeObserver(() => this.onResize());
    this.resizeObserver.observe(host);

    this.applyCamera();
    this.applyQuality(); // first render at the starting zoom, all at once (nothing is mounted yet)
  }

  unmount(): void {
    this.stopMomentum();
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = null;
    if (this.qualityRaf) cancelAnimationFrame(this.qualityRaf);
    this.qualityRaf = 0;
    this.qualityQueue = [];
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    for (const s of this.slots) this.unmountSlot(s);
    this.slots = [];
    this.cameraEl?.remove();
    this.cameraEl = null;
    this.host = null;
  }

  /**
   * The pane moved without resizing (a floating-window drag), so the cached
   * viewport origin is stale. Cheaper and more precise than reading the rect
   * on every gesture event.
   */
  invalidateRect(): void {
    this.measure();
  }

  /**
   * A page shown here was just edited in the main view — repaint it if it's
   * mounted. Also the pane's main heartbeat for structural change: the
   * notebook calls this after every committed op, so the (near-free, see
   * the source's revision) page-list check rides along with it.
   */
  refreshIfShowing(pageId: string): void {
    this.syncPages();
    const s = this.slots.find((x) => x.page.id === pageId);
    s?.handle?.refresh();
  }

  private newSlot(page: SourcePage): Slot {
    return { page, top: 0, left: 0, w: page.w, h: page.h, wrap: null, handle: null };
  }

  /**
   * Reconciles the column against the store — pages added, deleted or
   * reordered, including the blank page the notebook appends automatically
   * once you draw on its last one.
   *
   * The store has no change notification, and `store.pagesOf` scans every page
   * in the app, so this is gated on `Notebook.updatedAt`: `store.bump()` moves
   * it on every mutation to this notebook, so an unchanged value means nothing
   * here moved and the scan is skipped outright. That makes it cheap enough to
   * hang off every committed op.
   *
   * Surviving pages keep their existing `Slot`, and so their already-rendered
   * canvas — appending a page or reordering the column never re-renders what
   * was already on screen. The scroll position is re-anchored to whichever
   * page was at the top of the viewport; if *that* page is the one that went
   * away, it falls back to whatever now occupies its old place in the order,
   * so deleting a page doesn't fling the pane back to the top.
   *
   * Returns whether anything actually changed.
   */
  syncPages(): boolean {
    if (!this.host) return false;
    const rev = this.source.revision();
    if (rev === this.lastRevision) return false; // nothing touched the source at all
    this.lastRevision = rev;

    const pages = this.source.pages();
    const same = pages.length === this.slots.length && pages.every((p, i) => this.slots[i].page.id === p.id);
    if (same) return false; // a stroke, not a page-list change

    // where we are now, before anything moves
    const topBefore = this.topSlot();
    const anchorId = topBefore?.page.id ?? null;
    const anchorOffset = topBefore ? this.camera.y - topBefore.top : 0;
    const anchorOrder = topBefore ? this.slots.indexOf(topBefore) : 0;

    const existing = new Map(this.slots.map((s) => [s.page.id, s]));
    const next = pages.map((page) => {
      const kept = existing.get(page.id);
      if (!kept) return this.newSlot(page);
      existing.delete(page.id);
      return kept;
    });
    for (const gone of existing.values()) this.unmountSlot(gone);
    this.slots = next;
    this.relayout();

    const survived = anchorId ? this.slots.find((s) => s.page.id === anchorId) : undefined;
    const fallback = this.slots[clamp(anchorOrder, 0, Math.max(0, this.slots.length - 1))];
    const target = survived ?? fallback;
    this.camera.y = target ? target.top + (survived ? anchorOffset : 0) : this.minY();
    this.camera.x = this.clampX(this.camera.x);
    this.camera.y = clamp(this.camera.y, this.minY(), this.maxY());

    this.currentIndex = -1; // the total changed, so make updateMounted re-report the label
    this.applyCamera();
    // the anchor moved without a gesture, so nothing else would persist it
    this.hooks.onAnchorChanged();
    return true;
  }

  /** Where the pane is scrolled to, for persisting. */
  anchor(): ScrollAnchor | null {
    const top = this.topSlot();
    if (!top) return null;
    return { pageId: top.page.id, offset: this.camera.y - top.top, zoom: this.camera.zoom };
  }

  // ----------------------------------------------------------------- layout

  /** Re-reads the viewport box. Called on mount, on resize, at each gesture's start, and when the pane is moved. */
  private measure(): void {
    const h = this.host;
    if (!h) return;
    const r = h.getBoundingClientRect();
    this.viewW = r.width;
    this.viewH = r.height;
    this.viewLeft = r.left;
    this.viewTop = r.top;
  }

  /**
   * Recomputes every page's world-space box and positions its wrapper. Page
   * boxes never change with zoom (the camera transform handles that), so this
   * only has to run when the page set changes — but it is cheap and also the
   * single place the content extent is derived, so mount and resize call it
   * too. Wrappers are absolutely positioned from these numbers, which is what
   * lets the hot path avoid `offsetTop` entirely.
   */
  private relayout(): void {
    let y = PAD;
    let widest = 0;
    for (const s of this.slots) {
      s.top = y;
      s.h = s.page.h;
      s.w = s.page.w;
      widest = Math.max(widest, s.w);
      y += s.h + PAGE_GAP;
    }
    this.contentW = widest;
    this.contentH = Math.max(0, y - PAGE_GAP) + PAD;
    for (const s of this.slots) {
      s.left = (widest - s.w) / 2;
      if (s.wrap) this.placeWrap(s);
    }
  }

  private placeWrap(s: Slot): void {
    if (!s.wrap) return;
    s.wrap.style.left = `${s.left}px`;
    s.wrap.style.top = `${s.top}px`;
    s.wrap.style.width = `${s.w}px`;
    s.wrap.style.height = `${s.h}px`;
  }

  private minY(): number {
    return -PAD / this.camera.zoom;
  }

  private maxY(): number {
    return Math.max(this.minY(), this.contentH - this.viewH / this.camera.zoom);
  }

  /** True when the content is wider than the viewport, i.e. there is anything to pan horizontally. */
  private hasXRange(): boolean {
    return this.contentW * this.camera.zoom > this.viewW + 0.5;
  }

  private clampX(x: number): number {
    if (!this.hasXRange()) {
      // nothing to pan: park it so the column sits centred
      return this.contentW / 2 - this.viewW / (2 * this.camera.zoom);
    }
    return clamp(x, 0, this.contentW - this.viewW / this.camera.zoom);
  }

  // ----------------------------------------------------------------- camera

  /**
   * The hot path: one transform write, then the mount window and the current-
   * page label, both derived from the cached layout with no DOM reads.
   */
  private applyCamera(): void {
    const cam = this.cameraEl;
    if (!cam) return;
    const { x, y, zoom } = this.camera;
    cam.style.transform = `scale(${zoom}) translate(${-x}px, ${-y}px)`;
    this.updateMounted();
  }

  private setZoom(z: number, anchorX?: number, anchorY?: number): void {
    const next = clamp(z, ZOOM_MIN, ZOOM_MAX);
    if (next === this.camera.zoom) return;
    const ax = anchorX ?? this.viewW / 2;
    const ay = anchorY ?? this.viewH / 2;
    // keep the point under the fingers put: worldX = x + screenX / zoom
    const wx = this.camera.x + ax / this.camera.zoom;
    const wy = this.camera.y + ay / this.camera.zoom;
    this.camera.zoom = next;
    this.camera.x = wx - ax / next;
    this.camera.y = wy - ay / next;
    this.camera.x = this.clampX(this.camera.x);
    this.camera.y = clamp(this.camera.y, this.minY(), this.maxY());
    this.applyCamera();
    this.settle();
  }

  private scrollToAnchor(a: ScrollAnchor): void {
    const s = this.slots.find((x) => x.page.id === a.pageId);
    if (!s) return;
    this.camera.y = s.top + a.offset;
  }

  /** The page at the top of the viewport — the anchor's reference. */
  private topSlot(): Slot | null {
    const y = this.camera.y;
    for (const s of this.slots) if (s.top + s.h > y) return s;
    return this.slots[this.slots.length - 1] ?? null;
  }

  // --------------------------------------------------- mounting and quality

  /**
   * Mounts the pages overlapping the viewport plus MOUNT_NEIGHBOURS on each
   * side, unmounts the rest, and updates the current-page label. Pure
   * arithmetic over the cached layout — no `getBoundingClientRect`, no
   * `offsetTop`.
   */
  private updateMounted(): void {
    if (!this.slots.length) {
      if (this.currentIndex !== -1) {
        this.currentIndex = -1;
        this.hooks.onCurrentPage(-1, 0);
      }
      return;
    }
    const { y, zoom } = this.camera;
    const viewTop = y;
    const viewBottom = y + this.viewH / zoom;

    let first = -1;
    let last = -1;
    let bestIdx = -1;
    let bestVisible = 0;
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (s.top + s.h > viewTop && s.top < viewBottom) {
        if (first < 0) first = i;
        last = i;
        const visible = Math.min(s.top + s.h, viewBottom) - Math.max(s.top, viewTop);
        if (visible > bestVisible) {
          bestVisible = visible;
          bestIdx = i;
        }
      }
    }
    if (first < 0) {
      // nothing overlaps (mid-rubber-band, or an empty notebook) — keep the
      // nearest page mounted rather than tearing everything down
      first = last = clamp(this.topSlot() ? this.slots.indexOf(this.topSlot()!) : 0, 0, Math.max(0, this.slots.length - 1));
      bestIdx = first;
    }
    const from = Math.max(0, first - MOUNT_NEIGHBOURS);
    const to = Math.min(this.slots.length - 1, last + MOUNT_NEIGHBOURS);

    for (let i = 0; i < this.slots.length; i++) {
      if (i >= from && i <= to) this.mountSlot(this.slots[i]);
      else this.unmountSlot(this.slots[i]);
    }

    if (bestIdx >= 0 && bestIdx !== this.currentIndex) {
      this.currentIndex = bestIdx;
      this.hooks.onCurrentPage(bestIdx, this.slots.length);
    }
  }

  private mountSlot(s: Slot): void {
    if (s.handle || !this.cameraEl) return;
    const wrap = el('div', { class: 'pscroll-page' });
    wrap.style.background = this.source.background(s.page);
    s.wrap = wrap;
    this.placeWrap(s);
    this.cameraEl.appendChild(wrap);
    s.handle = this.source.mount(s.page, wrap, this.pageQuality());
  }

  private unmountSlot(s: Slot): void {
    s.handle?.unmount();
    s.handle = null;
    s.wrap?.remove();
    s.wrap = null;
  }

  /**
   * Device pixels per world unit to render a page at: the camera's zoom,
   * capped so no single page's backing store blows past MAX_PAGE_PIXELS (see
   * its own comment). Returned relative to DPR, as a PageHandle quality.
   */
  private pageQuality(): number {
    const s = this.slots[Math.max(0, this.currentIndex)] ?? this.slots[0];
    const area = s ? s.w * s.h : 1;
    const maxFactor = Math.sqrt(MAX_PAGE_PIXELS / area);
    return clamp(this.camera.zoom, ZOOM_MIN, Math.max(ZOOM_MIN, maxFactor / DPR));
  }

  /** Queues every mounted page for a re-render at the settled zoom, drained one per frame. */
  private applyQuality(): void {
    const q = this.pageQuality();
    this.qualityQueue = this.slots.filter((s) => s.handle != null);
    if (!this.qualityQueue.length) return;
    const drain = (): void => {
      this.qualityRaf = 0;
      const s = this.qualityQueue.shift();
      // it may have been unmounted between frames (the user kept scrolling)
      if (s?.handle) s.handle.setQuality(q);
      if (this.qualityQueue.length) this.qualityRaf = requestAnimationFrame(drain);
    };
    if (this.qualityRaf) cancelAnimationFrame(this.qualityRaf);
    this.qualityRaf = requestAnimationFrame(drain);
  }

  private settle(): void {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      // backstop for a page-list change that arrived without an op the
      // notebook would have told us about; gated, so it costs nothing when
      // nothing moved
      this.syncPages();
      this.applyQuality();
      this.hooks.onAnchorChanged();
    }, SETTLE_MS);
  }

  private onResize(): void {
    const prevW = this.viewW;
    this.measure();
    if (!this.viewW || !this.viewH) return;
    // a pane that changed width keeps its fit-to-width relationship, the same
    // way the main view re-fits when its own box changes
    if (prevW > 0 && Math.abs(this.viewW - prevW) > 1) {
      const first = this.slots[0];
      if (first) {
        const wasFit = Math.abs(this.camera.zoom - clamp(Math.min(1, (prevW - FIT_INSET) / first.w) || 1, ZOOM_MIN, ZOOM_MAX)) < 0.001;
        if (wasFit) this.camera.zoom = clamp(Math.min(1, (this.viewW - FIT_INSET) / first.w) || 1, ZOOM_MIN, ZOOM_MAX);
      }
    }
    this.camera.x = this.clampX(this.camera.x);
    this.camera.y = clamp(this.camera.y, this.minY(), this.maxY());
    this.applyCamera();
    this.settle();
  }

  // --------------------------------------------------------------- gestures

  /**
   * One-finger pan, two-finger pinch, wheel, and mouse-drag pan — all bound to
   * the pane's own viewport. They cannot reach the notebook: the pane is a
   * sibling of `.nb-scroll`, not a descendant, so NotebookView's listeners
   * never see these events at all.
   */
  private bindGestures(host: HTMLElement): void {
    const dist = (t: TouchList): number => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const localX = (cx: number): number => cx - this.viewLeft;
    const localY = (cy: number): number => cy - this.viewTop;

    host.addEventListener(
      'touchstart',
      (e) => {
        this.stopMomentum();
        this.measure(); // once per gesture, not per frame
        if (e.touches.length >= 2) {
          this.panTouch = null;
          const mx = localX((e.touches[0].clientX + e.touches[1].clientX) / 2);
          const my = localY((e.touches[0].clientY + e.touches[1].clientY) / 2);
          this.pinch = { d0: dist(e.touches), z0: this.camera.zoom, cx: mx, cy: my };
        } else if (e.touches.length === 1 && !this.pinch) {
          this.beginPan(e.touches[0]);
        }
        e.preventDefault();
      },
      { passive: false }
    );

    host.addEventListener(
      'touchmove',
      (e) => {
        e.preventDefault();
        if (this.pinch) {
          if (e.touches.length < 2) return;
          const p = this.pinch;
          const mx = localX((e.touches[0].clientX + e.touches[1].clientX) / 2);
          const my = localY((e.touches[0].clientY + e.touches[1].clientY) / 2);
          this.setZoom((p.z0 * dist(e.touches)) / p.d0, mx, my);
          if (this.hasXRange()) this.camera.x -= (mx - p.cx) / this.camera.zoom;
          this.camera.y -= (my - p.cy) / this.camera.zoom;
          this.camera.x = this.clampX(this.camera.x);
          this.camera.y = clamp(this.camera.y, this.minY(), this.maxY());
          this.applyCamera();
          p.cx = mx;
          p.cy = my;
          return;
        }
        const p = this.panTouch;
        if (!p || e.touches.length !== 1 || e.touches[0].identifier !== p.id) return;
        const t = e.touches[0];
        const now = performance.now();
        const dt = Math.max(1, now - p.t);
        const dx = (t.clientX - p.x) / this.camera.zoom;
        const dy = (t.clientY - p.y) / this.camera.zoom;
        // rubber-band past the ends, same resistance the main view uses
        const rawX = this.camera.x - dx;
        const rawY = this.camera.y - dy;
        const cx = this.clampX(rawX);
        const cy = clamp(rawY, this.minY(), this.maxY());
        this.camera.x = this.hasXRange() ? cx + (rawX - cx) * RUBBER : cx;
        this.camera.y = cy + (rawY - cy) * RUBBER;
        this.applyCamera();
        p.vx = p.vx * 0.8 + (dx / dt) * 0.2;
        p.vy = p.vy * 0.8 + (dy / dt) * 0.2;
        p.x = t.clientX;
        p.y = t.clientY;
        p.t = now;
      },
      { passive: false }
    );

    const endTouch = (e: TouchEvent): void => {
      if (e.touches.length >= 2) return;
      if (e.touches.length === 1) {
        this.pinch = null;
        this.beginPan(e.touches[0]);
        return;
      }
      const p = this.panTouch;
      this.pinch = null;
      this.panTouch = null;
      if (p) {
        const vx = this.hasXRange() ? p.vx : 0;
        if (Math.hypot(vx, p.vy) > MIN_SPEED) this.startMomentum(vx, p.vy);
        else this.settleBack();
      } else {
        this.settleBack();
      }
      this.settle();
    };
    host.addEventListener('touchend', endTouch);
    host.addEventListener('touchcancel', endTouch);

    host.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.stopMomentum();
        if (e.ctrlKey || e.metaKey) {
          this.setZoom(this.camera.zoom * Math.exp(-e.deltaY * 0.002), localX(e.clientX), localY(e.clientY));
          return;
        }
        this.camera.x = this.clampX(this.camera.x + e.deltaX / this.camera.zoom);
        this.camera.y = clamp(this.camera.y + e.deltaY / this.camera.zoom, this.minY(), this.maxY());
        this.applyCamera();
        this.settle();
      },
      { passive: false }
    );

    // mice have no pan gesture of their own — drag to pan, as the main view's
    // hand tool does for the same reason
    host.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'mouse') return;
      this.stopMomentum();
      this.measure();
      this.panMouse = { id: e.pointerId, x: e.clientX, y: e.clientY, camX: this.camera.x, camY: this.camera.y };
      try {
        host.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    });
    host.addEventListener('pointermove', (e) => {
      const p = this.panMouse;
      if (!p || e.pointerId !== p.id) return;
      this.camera.x = this.clampX(p.camX - (e.clientX - p.x) / this.camera.zoom);
      this.camera.y = clamp(p.camY - (e.clientY - p.y) / this.camera.zoom, this.minY(), this.maxY());
      this.applyCamera();
    });
    const endMouse = (e: PointerEvent): void => {
      if (this.panMouse?.id !== e.pointerId) return;
      this.panMouse = null;
      this.settle();
    };
    host.addEventListener('pointerup', endMouse);
    host.addEventListener('pointercancel', endMouse);
  }

  private beginPan(t: Touch): void {
    this.panTouch = { id: t.identifier, x: t.clientX, y: t.clientY, t: performance.now(), vx: 0, vy: 0 };
  }

  /** Eases an overscrolled camera back inside its bounds with no coasting velocity. */
  private settleBack(): void {
    const cx = this.clampX(this.camera.x);
    const cy = clamp(this.camera.y, this.minY(), this.maxY());
    if (Math.abs(cx - this.camera.x) > 0.5 || Math.abs(cy - this.camera.y) > 0.5) this.startMomentum(0, 0);
  }

  /** Coast, then spring back into bounds — the main view's momentum, minus its scrollbar/callout bookkeeping. */
  private startMomentum(vx: number, vy: number): void {
    this.stopMomentum();
    let dx = vx;
    let dy = vy;
    let last = performance.now();
    const step = (): void => {
      const now = performance.now();
      const dt = Math.min(32, Math.max(1, now - last));
      last = now;
      dx *= FRICTION;
      dy *= FRICTION;
      this.camera.x -= dx * dt;
      this.camera.y -= dy * dt;
      const cx = this.clampX(this.camera.x);
      const cy = clamp(this.camera.y, this.minY(), this.maxY());
      const offX = this.camera.x - cx;
      const offY = this.camera.y - cy;
      if (offX !== 0 || offY !== 0) {
        // outside the bounds: kill the coast and spring back instead
        dx = dy = 0;
        this.camera.x = cx + offX * (1 - SPRING);
        this.camera.y = cy + offY * (1 - SPRING);
      }
      this.applyCamera();
      const resting = Math.hypot(dx, dy) < MIN_SPEED && Math.abs(this.camera.x - cx) < 0.5 && Math.abs(this.camera.y - cy) < 0.5;
      if (resting) {
        this.camera.x = cx;
        this.camera.y = cy;
        this.applyCamera();
        this.momentumRaf = 0;
        this.settle();
        return;
      }
      this.momentumRaf = requestAnimationFrame(step);
    };
    this.momentumRaf = requestAnimationFrame(step);
  }

  private stopMomentum(): void {
    if (this.momentumRaf) cancelAnimationFrame(this.momentumRaf);
    this.momentumRaf = 0;
  }
}
