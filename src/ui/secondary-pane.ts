import { store } from '../store';
import type { Page } from '../types';
import { clamp } from '../util';
import { el } from './dom';
import { icon } from './icon';
import { PageView } from './page-view';

/**
 * The read-only secondary pane: a second page (from any notebook) or a
 * reference image shown beside the notebook you're drawing in, for comparing
 * notes or keeping a periodic table on screen.
 *
 * Everything here is read-only by construction. The pane owns a `PageView`
 * (which attaches no listeners and never writes to the store), its own
 * scale/offset, and its own persistence — it shares no camera, no tool state,
 * no undo stack and no selection overlay with `NotebookView`. The only thing
 * flowing the other way is `refreshIfShowing`, so a page edited in the main
 * view repaints here too.
 *
 * A split belongs to the notebook it was opened in: state is keyed by that
 * notebook's id, so leaving and coming back restores it and opening any other
 * notebook shows nothing. Only the header's × clears it.
 */

// ------------------------------------------------------------- persistence

const LS_PREFIX = 'noteapp.split.';
/** Where a "pick a notebook" trip through the library parks its state — see pendingSplitPick. */
const PENDING_KEY = 'noteapp.split.pending';

const IDB_NAME = 'noteapp-split';
const IDB_VERSION = 1;
/** Reference images live here, keyed by host notebook id — deliberately outside
 *  store.ts / the `noteapp` database, so they're never part of a notebook's
 *  pages, its backup, or anything the main app persists. */
const IDB_STORE = 'images';

export type SplitKind = 'page' | 'image';

interface FloatRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface SavedSplit {
  type: SplitKind;
  /** page splits only: which notebook and which of its pages is showing */
  notebookId?: string;
  pageId?: string;
  floating: boolean;
  float: FloatRect;
}

const DEFAULT_FLOAT: FloatRect = { x: 80, y: 120, w: 420, h: 560 };

function loadSaved(hostId: string): SavedSplit | null {
  try {
    const raw = localStorage.getItem(LS_PREFIX + hostId);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<SavedSplit>;
    if (v.type !== 'page' && v.type !== 'image') return null;
    const f = v.float;
    return {
      type: v.type,
      notebookId: typeof v.notebookId === 'string' ? v.notebookId : undefined,
      pageId: typeof v.pageId === 'string' ? v.pageId : undefined,
      floating: v.floating === true,
      float:
        f && [f.x, f.y, f.w, f.h].every((n) => typeof n === 'number' && Number.isFinite(n))
          ? { x: f.x, y: f.y, w: f.w, h: f.h }
          : { ...DEFAULT_FLOAT },
    };
  } catch {
    return null;
  }
}

function saveSaved(hostId: string, s: SavedSplit): void {
  try {
    localStorage.setItem(LS_PREFIX + hostId, JSON.stringify(s));
  } catch {
    /* ignore — a lost split is not worth failing an edit over */
  }
}

function clearSaved(hostId: string): void {
  try {
    localStorage.removeItem(LS_PREFIX + hostId);
  } catch {
    /* ignore */
  }
}

let dbPromise: Promise<IDBDatabase | null> | null = null;
function openImageDb(): Promise<IDBDatabase | null> {
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase | null>((resolve) => {
      let req: IDBOpenDBRequest;
      try {
        req = indexedDB.open(IDB_NAME, IDB_VERSION);
      } catch {
        resolve(null);
        return;
      }
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(IDB_STORE)) req.result.createObjectStore(IDB_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
  }
  return dbPromise;
}

async function putSplitImage(hostId: string, blob: Blob): Promise<void> {
  const db = await openImageDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(blob, hostId);
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => resolve();
  });
}

async function getSplitImage(hostId: string): Promise<Blob | null> {
  const db = await openImageDb();
  if (!db) return null;
  return new Promise<Blob | null>((resolve) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(hostId);
    req.onsuccess = () => resolve((req.result as Blob | undefined) ?? null);
    req.onerror = () => resolve(null);
  });
}

async function deleteSplitImage(hostId: string): Promise<void> {
  const db = await openImageDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete(hostId);
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => resolve();
  });
}

// ---------------------------------------------------- library "pick" round trip

interface PendingPick {
  /** the notebook the pick was started from, and the one it returns to */
  from: string;
  /** set by the library once a notebook is tapped */
  chosen?: string;
}

function readPending(): PendingPick | null {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<PendingPick>;
    if (typeof v.from !== 'string') return null;
    return { from: v.from, chosen: typeof v.chosen === 'string' ? v.chosen : undefined };
  } catch {
    return null;
  }
}

function writePending(p: PendingPick | null): void {
  try {
    if (p) sessionStorage.setItem(PENDING_KEY, JSON.stringify(p));
    else sessionStorage.removeItem(PENDING_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * The library asks this on every mount: non-null means "you are in pick-for-
 * split mode". Self-heals if the notebook the pick came from has since been
 * deleted, so a stale record can't strand the library in picking mode.
 */
export function pendingSplitPick(): PendingPick | null {
  const p = readPending();
  if (!p) return null;
  if (!store.notebooks.has(p.from)) {
    writePending(null);
    return null;
  }
  return p;
}

/** The library's Cancel button: abandon the pick and go back, leaving any already-saved split alone. */
export function cancelSplitPick(): void {
  const p = pendingSplitPick();
  writePending(null);
  if (p) location.hash = `#/nb/${p.from}`;
}

/** The library's "tap a notebook while picking": record the choice and return to the notebook it came from. */
export function chooseSplitNotebook(notebookId: string): void {
  const p = pendingSplitPick();
  if (!p) return;
  writePending({ from: p.from, chosen: notebookId });
  location.hash = `#/nb/${p.from}`;
}

// --------------------------------------------------------------------- pane

/** Zoom bounds inside the pane. Independent of the notebook's own camera. */
const SCALE_MIN = 0.1;
const SCALE_MAX = 5;
/** How much of the content must stay inside the stage when panning. */
const KEEP_VISIBLE = 48;
/** Smallest the floating window may be dragged down to. */
const FLOAT_MIN_W = 220;
const FLOAT_MIN_H = 200;
/** Re-render the page at the settled zoom once a gesture has been quiet this long. */
const SETTLE_MS = 180;

export interface PaneHooks {
  /**
   * The pane appeared, vanished, or changed between docked and floating —
   * i.e. `.nb-scroll`'s own box just changed size without a window `resize`
   * to announce it. NotebookView re-lays-out anything it sizes against that
   * box by hand (the shared drag-preview canvas).
   */
  onLayout: () => void;
}

export class SecondaryPane {
  private readonly hostNotebookId: string;
  private readonly container: HTMLElement;
  private readonly hooks: PaneHooks;

  private state: SavedSplit | null = null;

  private root: HTMLElement | null = null;
  private stage: HTMLElement | null = null;
  private content: HTMLElement | null = null;
  private titleEl: HTMLElement | null = null;
  private navEl: HTMLElement | null = null;
  private pageLabel: HTMLElement | null = null;
  private prevBtn: HTMLButtonElement | null = null;
  private nextBtn: HTMLButtonElement | null = null;
  private floatBtn: HTMLButtonElement | null = null;
  private resizeEl: HTMLElement | null = null;

  private view: PageView | null = null;
  private img: HTMLImageElement | null = null;
  /** object URL behind `img`, revoked whenever the image content is torn down */
  private imgUrl: string | null = null;

  /** live view transform inside the stage */
  private scale = 1;
  private ox = 0;
  private oy = 0;
  /** the scale `view` was last rendered at; the live transform carries `scale / renderScale` */
  private renderScale = 1;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;

  private pinch: { d0: number; s0: number; cx: number; cy: number } | null = null;
  private panTouch: { id: number; x: number; y: number } | null = null;
  private panMouse: { id: number; x: number; y: number; ox: number; oy: number } | null = null;

  private fileInput: HTMLInputElement | null = null;
  private stageObserver: ResizeObserver | null = null;
  /** set by destroy(); guards the awaits in restore()/openImage from building into a container that's already gone */
  private destroyed = false;

  constructor(hostNotebookId: string, container: HTMLElement, hooks: PaneHooks) {
    this.hostNotebookId = hostNotebookId;
    this.container = container;
    this.hooks = hooks;
  }

  get isOpen(): boolean {
    return this.root != null;
  }

  // ----------------------------------------------------------- open / restore

  /**
   * Called once when the notebook mounts: consumes a pick the library just
   * made, otherwise puts back whatever split this notebook had last time.
   */
  async restore(): Promise<void> {
    const pending = pendingSplitPick();
    if (pending && pending.from === this.hostNotebookId) {
      // Either the library sent a choice back, or we returned here without one
      // (Cancel, or a plain back-navigation) — either way the round trip is
      // over, so the record goes now and can't strand the library in pick mode.
      writePending(null);
      if (pending.chosen) {
        this.openPage(pending.chosen);
        return;
      }
    }

    const saved = loadSaved(this.hostNotebookId);
    if (!saved) return;

    if (saved.type === 'page') {
      // A target notebook or page deleted since this was saved drops the split
      // silently, rather than resurrecting it as an error state.
      const page = saved.pageId ? store.pageById(saved.pageId) : undefined;
      if (!saved.notebookId || !store.notebooks.has(saved.notebookId) || !page || page.notebookId !== saved.notebookId) {
        this.clearState();
        return;
      }
      this.state = saved;
      this.build();
      this.showPage(page);
      return;
    }

    const blob = await getSplitImage(this.hostNotebookId);
    if (this.destroyed) return;
    if (!blob) {
      this.clearState();
      return;
    }
    this.state = saved;
    this.build();
    this.showImage(blob);
  }

  /** "Split screen page": park the current notebook and send the library into pick mode. */
  startPagePick(): void {
    writePending({ from: this.hostNotebookId });
    location.hash = '#/';
  }

  /** "Split screen image": the native picker (Photo Library / Take Photo / Choose File on iOS). */
  startImagePick(): void {
    if (!this.fileInput) {
      this.fileInput = el('input', {
        type: 'file',
        accept: 'image/*',
        style: 'display:none',
        'aria-hidden': 'true',
      }) as HTMLInputElement;
      this.fileInput.addEventListener('change', () => {
        const file = this.fileInput?.files?.[0];
        if (this.fileInput) this.fileInput.value = '';
        if (file) void this.openImage(file);
      });
      this.container.append(this.fileInput);
    }
    this.fileInput.click();
  }

  /** Opens (or replaces) a page split showing `notebookId`'s first page. */
  private openPage(notebookId: string): void {
    const page = store.pagesOf(notebookId)[0];
    if (!page) return;
    const prev = this.state;
    this.teardownContent();
    if (prev?.type === 'image') void deleteSplitImage(this.hostNotebookId);
    this.state = {
      type: 'page',
      notebookId,
      pageId: page.id,
      floating: prev?.floating ?? false,
      float: prev?.float ?? { ...DEFAULT_FLOAT },
    };
    if (!this.root) this.build();
    this.showPage(page);
    this.persist();
  }

  /** Opens (or replaces) an image split. The file never reaches store.ts or the notebook's pages. */
  private async openImage(file: File): Promise<void> {
    const prev = this.state;
    this.teardownContent();
    this.state = {
      type: 'image',
      floating: prev?.floating ?? false,
      float: prev?.float ?? { ...DEFAULT_FLOAT },
    };
    if (!this.root) this.build();
    this.persist();
    await putSplitImage(this.hostNotebookId, file);
    if (this.destroyed) return;
    this.showImage(file);
  }

  // ------------------------------------------------------------------- chrome

  private build(): void {
    const root = el('div', { class: 'pane' });
    const head = el('div', { class: 'pane__head' });

    this.titleEl = el('span', { class: 'pane__title' });

    this.navEl = el('div', { class: 'pane__nav' });
    this.prevBtn = el('button', {
      class: 'iconbtn pane__navbtn',
      title: 'Previous page',
      'aria-label': 'Previous page in the split pane',
    }) as HTMLButtonElement;
    this.prevBtn.append(icon('chevron-left', 'sm'));
    this.prevBtn.addEventListener('click', () => this.step(-1));
    this.pageLabel = el('span', { class: 'pane__pagelabel' });
    this.nextBtn = el('button', {
      class: 'iconbtn pane__navbtn',
      title: 'Next page',
      'aria-label': 'Next page in the split pane',
    }) as HTMLButtonElement;
    this.nextBtn.append(icon('chevron-right', 'sm'));
    this.nextBtn.addEventListener('click', () => this.step(1));
    this.navEl.append(this.prevBtn, this.pageLabel, this.nextBtn);

    const actions = el('div', { class: 'pane__actions' });
    this.floatBtn = el('button', {
      class: 'iconbtn pane__floatbtn',
      title: 'Float this pane',
      'aria-label': 'Float this pane',
      'aria-pressed': 'false',
    }) as HTMLButtonElement;
    this.floatBtn.append(icon('split-float', 'sm'));
    this.floatBtn.addEventListener('click', () => this.setFloating(!this.state?.floating));

    const closeBtn = el('button', {
      class: 'iconbtn pane__close',
      title: 'Close split screen',
      'aria-label': 'Close split screen',
    }) as HTMLButtonElement;
    closeBtn.append(icon('close'));
    closeBtn.addEventListener('click', () => this.close());
    actions.append(this.floatBtn, closeBtn);

    head.append(this.titleEl, this.navEl, actions);
    this.bindHeaderDrag(head);

    this.stage = el('div', { class: 'pane__stage' });
    this.content = el('div', { class: 'pane__content' });
    this.stage.append(this.content);
    this.bindViewGestures(this.stage);

    this.resizeEl = el('div', { class: 'pane__resize', 'aria-hidden': 'true' });
    this.bindResize(this.resizeEl);

    root.append(head, this.stage, this.resizeEl);
    this.container.append(root);
    this.root = root;

    // the stage's own box changes with an orientation flip, the AI panel
    // opening, or a float resize — none of which fire a window `resize` the
    // fit below could hang off.
    this.stageObserver = new ResizeObserver(() => this.onStageResize());
    this.stageObserver.observe(this.stage);

    this.applyFloating();
    this.hooks.onLayout();
  }

  private applyFloating(): void {
    const root = this.root;
    const s = this.state;
    if (!root || !s) return;
    root.classList.toggle('pane--floating', s.floating);
    this.floatBtn?.setAttribute('aria-pressed', String(s.floating));
    if (this.floatBtn) this.floatBtn.title = s.floating ? 'Dock this pane' : 'Float this pane';
    if (this.resizeEl) this.resizeEl.hidden = !s.floating;
    if (s.floating) {
      const r = this.clampFloat(s.float);
      s.float = r;
      root.style.left = `${r.x}px`;
      root.style.top = `${r.y}px`;
      root.style.width = `${r.w}px`;
      root.style.height = `${r.h}px`;
    } else {
      root.style.left = root.style.top = root.style.width = root.style.height = '';
    }
  }

  private setFloating(floating: boolean): void {
    if (!this.state) return;
    this.state.floating = floating;
    this.applyFloating();
    this.persist();
    this.hooks.onLayout();
  }

  private clampFloat(r: FloatRect): FloatRect {
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const w = clamp(r.w, FLOAT_MIN_W, Math.max(FLOAT_MIN_W, vw));
    const h = clamp(r.h, FLOAT_MIN_H, Math.max(FLOAT_MIN_H, vh));
    return {
      w,
      h,
      // always leave the header reachable, whatever the viewport did since this was saved
      x: clamp(r.x, -(w - KEEP_VISIBLE), Math.max(0, vw - KEEP_VISIBLE)),
      y: clamp(r.y, 0, Math.max(0, vh - KEEP_VISIBLE)),
    };
  }

  // ------------------------------------------------------------------ content

  private showPage(page: Page): void {
    if (!this.content || !this.state) return;
    this.view = new PageView(page);
    // size it before the first mount, so stepping through pages never
    // allocates a full-size (820 × 1060 × DPR) backing store just to throw it
    // away one fit() later
    const st = this.stage;
    if (st?.clientWidth && st.clientHeight) {
      const s = clamp(
        Math.min(st.clientWidth / this.view.pageWidth, st.clientHeight / this.view.pageHeight),
        SCALE_MIN,
        SCALE_MAX
      );
      this.view.setScale(s);
      this.scale = this.renderScale = s;
    }
    this.view.mount(this.content);
    const nb = this.state.notebookId ? store.notebooks.get(this.state.notebookId) : undefined;
    if (this.titleEl) this.titleEl.textContent = nb?.name ?? 'Notebook';
    if (this.navEl) this.navEl.hidden = false;
    this.syncNav();
    this.fit();
  }

  private showImage(blob: Blob): void {
    if (!this.content) return;
    this.imgUrl = URL.createObjectURL(blob);
    const img = el('img', { class: 'pane__img', alt: 'Split screen reference image' }) as HTMLImageElement;
    img.draggable = false;
    img.src = this.imgUrl;
    img.addEventListener('load', () => {
      // natural size is the content's own "page units" here, so `scale` maps
      // straight onto it and nothing ever has to be re-rendered on zoom
      img.style.width = `${img.naturalWidth}px`;
      img.style.height = `${img.naturalHeight}px`;
      this.fit();
    });
    this.img = img;
    this.content.append(img);
    if (this.titleEl) this.titleEl.textContent = 'Image';
    if (this.navEl) this.navEl.hidden = true;
  }

  /** Steps the page split through its target notebook's pages. */
  private step(dir: -1 | 1): void {
    const s = this.state;
    if (!s || s.type !== 'page' || !s.notebookId) return;
    const pages = store.pagesOf(s.notebookId);
    const at = pages.findIndex((p) => p.id === s.pageId);
    const next = pages[at + dir];
    if (!next) return;
    this.view?.unmount();
    this.view = null;
    s.pageId = next.id;
    this.showPage(next);
    this.persist();
  }

  private syncNav(): void {
    const s = this.state;
    if (!s || s.type !== 'page' || !s.notebookId) return;
    const pages = store.pagesOf(s.notebookId);
    const at = pages.findIndex((p) => p.id === s.pageId);
    if (this.pageLabel) this.pageLabel.textContent = `${at + 1} / ${pages.length}`;
    if (this.prevBtn) this.prevBtn.disabled = at <= 0;
    if (this.nextBtn) this.nextBtn.disabled = at < 0 || at >= pages.length - 1;
  }

  /**
   * A page shown here was just edited in the main view (drawn on, erased,
   * undone) — repaint it. A no-op for an image split, or for any page this
   * pane isn't currently showing, so it's cheap to call on every op.
   */
  refreshIfShowing(pageId: string): void {
    if (this.state?.type !== 'page' || this.state.pageId !== pageId) return;
    this.view?.refresh();
  }

  // ------------------------------------------------------------- zoom and pan

  private get contentW(): number {
    return this.img ? this.img.naturalWidth : this.view?.pageWidth ?? 0;
  }
  private get contentH(): number {
    return this.img ? this.img.naturalHeight : this.view?.pageHeight ?? 0;
  }

  /** Fits the content to the stage and centres it — on open, on page change, and on a stage resize. */
  private fit(): void {
    const stage = this.stage;
    if (!stage) return;
    const cw = this.contentW;
    const ch = this.contentH;
    const sw = stage.clientWidth;
    const sh = stage.clientHeight;
    if (!cw || !ch || !sw || !sh) return;
    this.scale = clamp(Math.min(sw / cw, sh / ch), SCALE_MIN, SCALE_MAX);
    this.ox = (sw - cw * this.scale) / 2;
    this.oy = (sh - ch * this.scale) / 2;
    this.render();
    this.settleNow();
  }

  private onStageResize(): void {
    // keep the content usable after an orientation flip / dock-float switch
    // without fighting a zoom the user set deliberately
    if (Math.abs(this.scale - this.fitScale()) < 0.001) this.fit();
    else {
      this.clampOffset();
      this.render();
    }
  }

  private fitScale(): number {
    const stage = this.stage;
    const cw = this.contentW;
    const ch = this.contentH;
    if (!stage || !cw || !ch || !stage.clientWidth || !stage.clientHeight) return this.scale;
    return clamp(Math.min(stage.clientWidth / cw, stage.clientHeight / ch), SCALE_MIN, SCALE_MAX);
  }

  /** Writes the live transform. The canvas is only re-rendered once a gesture settles (see settle). */
  private render(): void {
    if (!this.content) return;
    const k = this.scale / this.renderScale;
    this.content.style.transform = `translate(${this.ox}px, ${this.oy}px) scale(${k})`;
  }

  /** Keeps at least KEEP_VISIBLE px of content inside the stage on each axis, so a pan can't lose it entirely. */
  private clampOffset(): void {
    const stage = this.stage;
    if (!stage) return;
    const w = this.contentW * this.scale;
    const h = this.contentH * this.scale;
    this.ox = clamp(this.ox, KEEP_VISIBLE - w, stage.clientWidth - KEEP_VISIBLE);
    this.oy = clamp(this.oy, KEEP_VISIBLE - h, stage.clientHeight - KEEP_VISIBLE);
  }

  /** Zooms about a stage-local point, keeping that point under the fingers. */
  private zoomAbout(next: number, px: number, py: number): void {
    const s = clamp(next, SCALE_MIN, SCALE_MAX);
    const k = s / this.scale;
    this.ox = px - (px - this.ox) * k;
    this.oy = py - (py - this.oy) * k;
    this.scale = s;
    this.clampOffset();
    this.render();
  }

  /** Re-renders the page at the settled zoom, so a zoomed-in page is sharp rather than an upscaled bitmap. */
  private settle(): void {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => this.settleNow(), SETTLE_MS);
  }

  private settleNow(): void {
    if (this.settleTimer) {
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
    // images need no re-render: `scale` already maps onto the natural size
    if (!this.view || Math.abs(this.scale / this.renderScale - 1) < 0.02) return;
    this.view.setScale(this.scale);
    this.renderScale = this.scale;
    this.render();
  }

  /**
   * Pinch-zoom and pan, bound to the pane's own stage. Nothing here can reach
   * the notebook's camera: `.pane` is a sibling of `.nb-scroll`, not a
   * descendant, so `NotebookView`'s own touch/wheel listeners never see these
   * events in the first place.
   */
  private bindViewGestures(stage: HTMLElement): void {
    const local = (clientX: number, clientY: number): { x: number; y: number } => {
      const r = stage.getBoundingClientRect();
      return { x: clientX - r.left, y: clientY - r.top };
    };
    const dist = (t: TouchList): number => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);

    stage.addEventListener(
      'touchstart',
      (e) => {
        if (e.touches.length >= 2) {
          this.panTouch = null;
          const mid = local(
            (e.touches[0].clientX + e.touches[1].clientX) / 2,
            (e.touches[0].clientY + e.touches[1].clientY) / 2
          );
          this.pinch = { d0: dist(e.touches), s0: this.scale, cx: mid.x, cy: mid.y };
        } else if (e.touches.length === 1 && !this.pinch) {
          this.panTouch = { id: e.touches[0].identifier, x: e.touches[0].clientX, y: e.touches[0].clientY };
        }
        e.preventDefault();
      },
      { passive: false }
    );

    stage.addEventListener(
      'touchmove',
      (e) => {
        e.preventDefault();
        if (this.pinch) {
          if (e.touches.length < 2) return; // hold position until the gesture really ends
          const p = this.pinch;
          const mid = local(
            (e.touches[0].clientX + e.touches[1].clientX) / 2,
            (e.touches[0].clientY + e.touches[1].clientY) / 2
          );
          this.zoomAbout((p.s0 * dist(e.touches)) / p.d0, p.cx, p.cy);
          this.ox += mid.x - p.cx;
          this.oy += mid.y - p.cy;
          p.cx = mid.x;
          p.cy = mid.y;
          this.clampOffset();
          this.render();
          return;
        }
        const p = this.panTouch;
        if (!p || e.touches.length !== 1 || e.touches[0].identifier !== p.id) return;
        this.ox += e.touches[0].clientX - p.x;
        this.oy += e.touches[0].clientY - p.y;
        p.x = e.touches[0].clientX;
        p.y = e.touches[0].clientY;
        this.clampOffset();
        this.render();
      },
      { passive: false }
    );

    const endTouch = (e: TouchEvent): void => {
      if (e.touches.length >= 2) return;
      if (e.touches.length === 1) {
        this.pinch = null;
        this.panTouch = { id: e.touches[0].identifier, x: e.touches[0].clientX, y: e.touches[0].clientY };
        return;
      }
      this.pinch = null;
      this.panTouch = null;
      this.settle();
    };
    stage.addEventListener('touchend', endTouch);
    stage.addEventListener('touchcancel', endTouch);

    stage.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const p = local(e.clientX, e.clientY);
        if (e.ctrlKey || e.metaKey) this.zoomAbout(this.scale * Math.exp(-e.deltaY * 0.002), p.x, p.y);
        else {
          this.ox -= e.deltaX;
          this.oy -= e.deltaY;
          this.clampOffset();
          this.render();
        }
        this.settle();
      },
      { passive: false }
    );

    // mice have no pan gesture of their own — drag to pan, same as the
    // notebook's own hand tool does for the same reason
    stage.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'mouse') return;
      this.panMouse = { id: e.pointerId, x: e.clientX, y: e.clientY, ox: this.ox, oy: this.oy };
      try {
        stage.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    });
    stage.addEventListener('pointermove', (e) => {
      const p = this.panMouse;
      if (!p || e.pointerId !== p.id) return;
      this.ox = p.ox + (e.clientX - p.x);
      this.oy = p.oy + (e.clientY - p.y);
      this.clampOffset();
      this.render();
    });
    const endMouse = (e: PointerEvent): void => {
      if (this.panMouse?.id !== e.pointerId) return;
      this.panMouse = null;
      this.settle();
    };
    stage.addEventListener('pointerup', endMouse);
    stage.addEventListener('pointercancel', endMouse);
  }

  // ------------------------------------------------------- float drag / resize

  private bindHeaderDrag(head: HTMLElement): void {
    let drag: { id: number; x: number; y: number; ox: number; oy: number } | null = null;
    head.addEventListener('pointerdown', (e) => {
      const s = this.state;
      if (!s?.floating) return;
      if ((e.target as HTMLElement).closest('button')) return; // the header's own buttons still work
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, ox: s.float.x, oy: s.float.y };
      try {
        head.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      e.preventDefault();
    });
    head.addEventListener('pointermove', (e) => {
      const s = this.state;
      if (!drag || e.pointerId !== drag.id || !s) return;
      s.float = this.clampFloat({
        ...s.float,
        x: drag.ox + (e.clientX - drag.x),
        y: drag.oy + (e.clientY - drag.y),
      });
      this.applyFloating();
    });
    const end = (e: PointerEvent): void => {
      if (!drag || e.pointerId !== drag.id) return;
      drag = null;
      this.persist();
    };
    head.addEventListener('pointerup', end);
    head.addEventListener('pointercancel', end);
  }

  private bindResize(grip: HTMLElement): void {
    let drag: { id: number; x: number; y: number; w: number; h: number } | null = null;
    grip.addEventListener('pointerdown', (e) => {
      const s = this.state;
      if (!s?.floating) return;
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, w: s.float.w, h: s.float.h };
      try {
        grip.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      e.preventDefault();
    });
    grip.addEventListener('pointermove', (e) => {
      const s = this.state;
      if (!drag || e.pointerId !== drag.id || !s) return;
      s.float = this.clampFloat({
        ...s.float,
        w: drag.w + (e.clientX - drag.x),
        h: drag.h + (e.clientY - drag.y),
      });
      this.applyFloating();
    });
    const end = (e: PointerEvent): void => {
      if (!drag || e.pointerId !== drag.id) return;
      drag = null;
      this.persist();
    };
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
  }

  // ------------------------------------------------------------------ teardown

  private persist(): void {
    if (this.state) saveSaved(this.hostNotebookId, this.state);
  }

  /** Drops this notebook's saved split entirely — the × button, and a target that no longer exists. */
  private clearState(): void {
    clearSaved(this.hostNotebookId);
    if (this.state?.type === 'image') void deleteSplitImage(this.hostNotebookId);
    this.state = null;
  }

  /** The header's × : end the split and forget it. The only thing that clears saved state. */
  private close(): void {
    const wasImage = this.state?.type === 'image';
    clearSaved(this.hostNotebookId);
    this.state = null;
    if (wasImage) void deleteSplitImage(this.hostNotebookId);
    this.teardownContent();
    this.teardownChrome();
    this.hooks.onLayout();
  }

  private teardownContent(): void {
    this.view?.unmount();
    this.view = null;
    this.img?.remove();
    this.img = null;
    if (this.imgUrl) {
      URL.revokeObjectURL(this.imgUrl);
      this.imgUrl = null;
    }
    if (this.settleTimer) {
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
    this.scale = this.renderScale = 1;
    this.ox = this.oy = 0;
  }

  private teardownChrome(): void {
    this.stageObserver?.disconnect();
    this.stageObserver = null;
    this.root?.remove();
    this.root = null;
    this.stage = this.content = this.titleEl = this.navEl = this.pageLabel = this.resizeEl = null;
    this.prevBtn = this.nextBtn = this.floatBtn = null;
  }

  /**
   * The notebook view is going away: take the pane down but leave the saved
   * state alone, so coming back to this same notebook puts it right back.
   */
  destroy(): void {
    this.destroyed = true;
    this.teardownContent();
    this.teardownChrome();
    this.fileInput?.remove();
    this.fileInput = null;
  }
}
