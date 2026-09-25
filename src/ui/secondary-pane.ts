import { store } from '../store';
import { clamp } from '../util';
import { el } from './dom';
import { icon } from './icon';
import { PageScroller, type ScrollAnchor } from './page-scroller';
import { ImagePageSource, NotebookPageSource, PdfPageSource } from './page-sources';

/**
 * The read-only secondary content beside the notebook you're drawing in, in
 * two shapes:
 *
 *  - a **pane split** — another notebook's pages, or a reference PDF — as a
 *    continuously scrolling read-only column in a pane docked beside the
 *    notebook. Both run the same `PageScroller`, so they scroll, zoom and
 *    scrollbar identically; only their `PageSource` differs. The header's
 *    minimise button detaches the pane into a floating window and its expand
 *    button docks it back.
 *  - an **image overlay**: a reference image (a periodic table, a diagram)
 *    floating *over* the notebook, pinned to the viewport rather than to any
 *    page, so it holds its spot on screen while the pages scroll and zoom
 *    underneath it. It never splits the screen — the notebook keeps its full
 *    width — and only the image's own box takes pointer events, so drawing
 *    and every notebook gesture carry on untouched everywhere else.
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
/** A split's binary payload — a reference image or a reference PDF — keyed by
 *  host notebook id. Deliberately outside store.ts / the `noteapp` database,
 *  so it is never part of a notebook's pages, its backup, or anything the main
 *  app persists. (The store name is historical: it held only images first, and
 *  renaming it would mean an upgrade path for no behavioural gain. There is at
 *  most one split per notebook, so one record per key is always enough.) */
const IDB_STORE = 'images';

export type SplitKind = 'page' | 'image' | 'pdf';

interface FloatRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface SavedSplit {
  type: SplitKind;
  /** page splits only: which notebook is showing, and which page is at the top of the pane */
  notebookId?: string;
  pageId?: string;
  /**
   * Page and PDF splits: where the scroller is and at what zoom. Absent on
   * records written before the pane became a continuous scroller — those carry
   * only `pageId`, which restore() turns into an anchor at that page's top, so
   * an older split reopens on the page it was left on.
   */
  anchor?: ScrollAnchor;
  /** PDF and image splits: the file's own name, shown in the pane header. */
  fileName?: string;
  floating: boolean;
  float: FloatRect;
}

const DEFAULT_FLOAT: FloatRect = { x: 80, y: 120, w: 420, h: 560 };

/** Split kinds whose payload lives in the pane's own IndexedDB store, so switching away from or closing one has a blob to delete. */
function hasBlob(type: SplitKind | undefined): boolean {
  return type === 'image' || type === 'pdf';
}

function loadSaved(hostId: string): SavedSplit | null {
  try {
    const raw = localStorage.getItem(LS_PREFIX + hostId);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<SavedSplit> & { pdfName?: unknown };
    if (v.type !== 'page' && v.type !== 'image' && v.type !== 'pdf') return null;
    const f = v.float;
    const a = v.anchor;
    const anchor =
      a && typeof a.pageId === 'string' && Number.isFinite(a.offset) && Number.isFinite(a.zoom)
        ? { pageId: a.pageId, offset: a.offset, zoom: a.zoom }
        : undefined;
    return {
      type: v.type,
      notebookId: typeof v.notebookId === 'string' ? v.notebookId : undefined,
      pageId: typeof v.pageId === 'string' ? v.pageId : undefined,
      anchor,
      // `pdfName` is what PDF splits wrote before images needed a name too
      fileName: typeof v.fileName === 'string' ? v.fileName : typeof v.pdfName === 'string' ? v.pdfName : undefined,
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

async function putSplitBlob(hostId: string, blob: Blob): Promise<void> {
  const db = await openImageDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(blob, hostId);
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => resolve();
  });
}

async function getSplitBlob(hostId: string): Promise<Blob | null> {
  const db = await openImageDb();
  if (!db) return null;
  return new Promise<Blob | null>((resolve) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(hostId);
    req.onsuccess = () => resolve((req.result as Blob | undefined) ?? null);
    req.onerror = () => resolve(null);
  });
}

async function deleteSplitBlob(hostId: string): Promise<void> {
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
 * A pick is a single round trip within one page load — notebook → library →
 * the same notebook — driven entirely by hash navigation, so it never
 * legitimately outlives the document that started it. `sessionStorage`,
 * though, does: it survives a reload and an iOS home-screen app being
 * relaunched into its restored session. A pick abandoned that way (the app
 * was closed while the library was waiting for a notebook to be tapped) came
 * back as a library permanently stuck in pick mode, with Import, Export,
 * Restore, New notebook and every card action disabled and every notebook tap
 * bouncing into the pick's host notebook instead of opening the one tapped.
 * Clearing it here, once, as the module initialises, ends the round trip with
 * the load that began it. The module is imported by both the notebook and the
 * library and initialises before either can mount, and a pick can only be
 * written by a `SecondaryPane` this module has already created, so this can
 * never discard a pick that is still in flight.
 */
writePending(null);

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

/**
 * `accept` for the image picker. Explicit extensions *and* the wildcard, on
 * purpose, and in that order.
 *
 * A bare `image/*` is enough in desktop browsers, but on iOS the accept list
 * is mapped to UTIs to decide what the **Files** browser leaves selectable,
 * and the wildcard alone is unreliable there — worst in an installed
 * home-screen PWA, where the standalone WKWebView file picker has repeatedly
 * shipped builds that grey out everything in Files for a wildcard-only accept
 * even though the same page in Safari is fine. Concrete extensions map to
 * concrete UTIs and are honoured consistently in both; keeping `image/*` last
 * preserves the Photo Library / Take Photo entries that the wildcard is what
 * actually offers.
 *
 * Deliberately still images only — no `* / *` escape hatch.
 */
export const IMAGE_ACCEPT = '.png,.jpg,.jpeg,.heic,.heif,.webp,.gif,.bmp,.tif,.tiff,image/*';

/** Same PWA-safe extension-plus-MIME form as IMAGE_ACCEPT, for the PDF picker. */
const PDF_ACCEPT = '.pdf,application/pdf';


/** How much of the floating pane must stay inside the viewport. */
const KEEP_VISIBLE = 48;
/** Smallest the floating pane may be dragged down to. */
const FLOAT_MIN_W = 220;
const FLOAT_MIN_H = 200;


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
  /** the scroller's viewport element, inside the pane's chrome */
  private stage: HTMLElement | null = null;
  private titleEl: HTMLElement | null = null;
  private pageLabel: HTMLElement | null = null;
  private floatBtn: HTMLButtonElement | null = null;
  private resizeEl: HTMLElement | null = null;

  /** The continuous read-only page column for a page split (see page-scroller.ts). */
  private scroller: PageScroller | null = null;
  /** debounce for persisting the scroll anchor, so a flick doesn't write on every settle */
  private anchorSaveTimer: ReturnType<typeof setTimeout> | null = null;

  /** the parsed PDF, when this split is a PDF */
  private pdfSource: PdfPageSource | null = null;
  /** the decoded picture, when this split is an image */
  private imageSource: ImagePageSource | null = null;
  /** the transient notice shown by `toast`, and its dismissal timer */
  private toastEl: HTMLElement | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;

  private fileInput: HTMLInputElement | null = null;
  /** set by destroy(); guards the awaits in restore()/openImage from building into a container that's already gone */
  private destroyed = false;

  constructor(hostNotebookId: string, container: HTMLElement, hooks: PaneHooks) {
    this.hostNotebookId = hostNotebookId;
    this.container = container;
    this.hooks = hooks;
  }

  /** True while either shape is showing — the docked/floating page pane, or the image overlay. */
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
      // Only the whole target notebook going away drops the split — the pane
      // shows every page now, so one deleted page is no reason to discard it.
      if (!saved.notebookId || !store.notebooks.has(saved.notebookId)) {
        this.clearState();
        return;
      }
      this.state = saved;
      this.build();
      // The saved anchor's page may itself have been deleted since. Rather
      // than dropping the split, open at the top of the notebook — keeping
      // the saved zoom, which is still perfectly valid.
      //
      // Older records predate the scroller and carry only `pageId`; anchoring
      // at that page's own top (zoom 0 → the scroller's fit-to-width default)
      // reopens them exactly where they were left.
      const wanted = saved.anchor ?? (saved.pageId ? { pageId: saved.pageId, offset: 0, zoom: 0 } : null);
      const anchorPage = wanted ? store.pageById(wanted.pageId) : undefined;
      const usable = wanted && anchorPage && anchorPage.notebookId === saved.notebookId;
      if (usable) {
        this.showPages(wanted);
      } else {
        const top = store.pagesOf(saved.notebookId)[0];
        this.showPages(top ? { pageId: top.id, offset: 0, zoom: wanted?.zoom ?? 0 } : null);
      }
      return;
    }

    const blob = await getSplitBlob(this.hostNotebookId);
    if (this.destroyed) return;
    if (!blob) {
      this.clearState();
      return;
    }

    if (saved.type === 'pdf') {
      this.state = saved;
      this.build();
      await this.showPdfPages(await blob.arrayBuffer(), saved.anchor ?? null);
      return;
    }

    // A record written while images were a frameless overlay carries
    // `floating: true` and that overlay's own frame rect, which is exactly
    // what a floating pane wants — so those reopen as a floating pane at the
    // position and size they were left at, with no migration step.
    this.state = saved;
    this.build();
    await this.showImagePages(blob, saved.anchor ?? null);
  }

  /** "Split screen page": park the current notebook and send the library into pick mode. */
  startPagePick(): void {
    writePending({ from: this.hostNotebookId });
    location.hash = '#/';
  }

  /** "Split screen image": the native picker (Photo Library / Take Photo / Choose File on iOS). */
  startImagePick(): void {
    this.pick(IMAGE_ACCEPT, (f) => void this.openImage(f));
  }

  /** "Split screen PDF": the native picker, PDFs only. */
  startPdfPick(): void {
    this.pick(PDF_ACCEPT, (f) => void this.openPdf(f));
  }

  /**
   * One hidden `<input type=file>`, rebuilt per pick because its `accept`
   * differs between the two. Recreated rather than mutated: iOS caches the
   * picker configuration per element in some versions, and a stale accept is
   * exactly the class of bug IMAGE_ACCEPT exists to avoid.
   */
  private pick(accept: string, onFile: (file: File) => void): void {
    this.fileInput?.remove();
    const input = el('input', {
      type: 'file',
      accept,
      style: 'display:none',
      'aria-hidden': 'true',
    }) as HTMLInputElement;
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      input.value = '';
      if (file) onFile(file);
    });
    this.container.append(input);
    this.fileInput = input;
    input.click();
  }

  /** Opens (or replaces) a page split, scrolled to the top of `notebookId`. */
  private openPage(notebookId: string): void {
    const page = store.pagesOf(notebookId)[0];
    if (!page) return;
    const prev = this.state;
    this.teardownContent();
    if (hasBlob(prev?.type)) void deleteSplitBlob(this.hostNotebookId);
    this.state = {
      type: 'page',
      notebookId,
      pageId: page.id,
      // an image overlay has no docked/floating notion of its own, so a page
      // split opened in its place starts docked rather than inheriting `true`
      floating: prev?.type === 'page' ? prev.floating : false,
      float: prev?.float ?? { ...DEFAULT_FLOAT },
    };
    if (!this.root) this.build();
    this.showPages(null);
    this.persist();
  }

  /**
   * Opens (or replaces) the image overlay. The file never reaches store.ts or
   * the notebook's pages — only the pane's own IndexedDB store.
   *
   * An image replaces a page split outright (one split per notebook), which
   * means the docked pane and its chrome go away entirely and the notebook
   * takes its full width back — hence the teardownChrome + onLayout here.
   */
  private async openImage(file: File): Promise<void> {
    const prev = this.state;
    this.teardownContent();
    this.state = {
      type: 'image',
      fileName: file.name.replace(/\.[^.]+$/, '') || 'Image',
      // opens docked, same side as the other two; the header's minimise
      // button is what turns it into a floating window
      floating: prev?.type === 'page' ? prev.floating : false,
      float: prev?.float ?? { ...DEFAULT_FLOAT },
    };
    if (!this.root) this.build();
    else this.applyFloating();
    this.persist();
    await putSplitBlob(this.hostNotebookId, file);
    if (this.destroyed) return;
    if (!(await this.showImagePages(file, null))) this.toast("Couldn't open that image");
  }

  /**
   * Opens (or replaces) the PDF overlay. Like the image, it replaces whatever
   * split the notebook had, and its bytes go only into the pane's own
   * IndexedDB store — never `store.ts`, never the app's asset store, and so
   * never into a notebook's backup.
   */
  private async openPdf(file: File): Promise<void> {
    const prev = this.state;
    this.teardownContent();
    this.state = {
      type: 'pdf',
      fileName: file.name.replace(/\.pdf$/i, '') || 'PDF',
      // opens docked, on the same side as a note split; the header's
      // minimise button is what turns it into a floating window
      floating: prev?.type === 'page' ? prev.floating : false,
      float: prev?.float ?? { ...DEFAULT_FLOAT },
    };
    if (!this.root) this.build();
    else this.applyFloating();
    this.persist();
    const bytes = await file.arrayBuffer();
    if (this.destroyed) return;
    await putSplitBlob(this.hostNotebookId, new Blob([bytes], { type: 'application/pdf' }));
    if (this.destroyed) return;
    if (!(await this.showPdfPages(bytes, null))) this.toast("Couldn't open that PDF");
  }

  // ------------------------------------------------------------------- chrome

  private build(): void {
    const root = el('div', { class: 'pane' });
    const head = el('div', { class: 'pane__head' });

    this.titleEl = el('span', { class: 'pane__title' });

    // just a read-out now that the pane scrolls continuously — the prev/next
    // buttons it replaced had nothing left to do
    this.pageLabel = el('span', { class: 'pane__pagelabel' });

    const actions = el('div', { class: 'pane__actions' });
    // Minimise / expand: docked, it detaches the pane into a floating window;
    // floating, it docks it back. Shared by both pane splits, so a PDF and a
    // note behave identically here. The icon and label are set by
    // applyFloating, which knows which way round it currently is.
    this.floatBtn = el('button', {
      class: 'iconbtn pane__floatbtn',
      'aria-pressed': 'false',
    }) as HTMLButtonElement;
    this.floatBtn.addEventListener('click', () => this.setFloating(!this.state?.floating));

    const closeBtn = el('button', {
      class: 'iconbtn pane__close',
      title: 'Close split screen',
      'aria-label': 'Close split screen',
    }) as HTMLButtonElement;
    closeBtn.append(icon('close'));
    closeBtn.addEventListener('click', () => this.close());
    actions.append(this.floatBtn, closeBtn);

    head.append(this.titleEl, this.pageLabel, actions);
    this.bindHeaderDrag(head);

    // the scroller owns everything inside the stage — its own camera element,
    // its page column, and its own gestures (see page-scroller.ts)
    this.stage = el('div', { class: 'pane__stage' });

    this.resizeEl = el('div', { class: 'pane__resize', 'aria-hidden': 'true' });
    this.bindResize(this.resizeEl);

    root.append(head, this.stage, this.resizeEl);
    this.container.append(root);
    this.root = root;

    this.applyFloating();
    this.hooks.onLayout();
  }

  private applyFloating(): void {
    const root = this.root;
    const s = this.state;
    if (!root || !s) return;
    root.classList.toggle('pane--floating', s.floating);
    if (this.floatBtn) {
      const label = s.floating ? 'Dock this pane' : 'Minimise to a floating window';
      this.floatBtn.setAttribute('aria-pressed', String(s.floating));
      this.floatBtn.title = label;
      this.floatBtn.setAttribute('aria-label', label);
      // `split` (two docked columns) reads as "put it back"; `minimize` as
      // "shrink it out of the way". Both already exist — no new icon needed.
      this.floatBtn.replaceChildren(icon(s.floating ? 'split' : 'minimize', 'sm'));
    }
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
    // The scroller caches its own viewport rect rather than reading it each
    // gesture frame; a floating drag moves the pane without resizing it, so
    // its ResizeObserver never fires and only this can tell it the cache is
    // stale. (A resize is covered both ways.)
    this.scroller?.invalidateRect();
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

  /**
   * Puts the target notebook's whole page column into the pane as a
   * continuous, read-only scroller, positioned at `anchor` (or at the top when
   * there is none). The scroller owns the camera, the gestures and the page
   * mount/unmount window; the pane only feeds it an anchor and takes back the
   * header label and a "save me" signal.
   */
  private showPages(anchor: ScrollAnchor | null): void {
    const s = this.state;
    if (!this.stage || !s?.notebookId) return;
    const total = store.pagesOf(s.notebookId).length;
    this.scroller = new PageScroller(new NotebookPageSource(s.notebookId), {
      onCurrentPage: (index, count) => {
        // index < 0 means the column is empty, which only happens if every
        // page went away underneath us — show nothing rather than "0 / 0"
        if (this.pageLabel) this.pageLabel.textContent = index < 0 ? '' : `${index + 1} / ${count}`;
      },
      onAnchorChanged: () => this.saveAnchorSoon(),
    });
    this.scroller.mount(this.stage, anchor);
    const nb = store.notebooks.get(s.notebookId);
    if (this.titleEl) this.titleEl.textContent = nb?.name ?? 'Notebook';
    if (this.pageLabel && !this.pageLabel.textContent) this.pageLabel.textContent = `1 / ${total}`;
  }

  /**
   * Writes the scroll anchor back to the saved record. Debounced because the
   * scroller reports a settle at the end of every flick, and a page split's
   * record is otherwise only touched when something structural changes.
   */
  private saveAnchorSoon(): void {
    if (this.anchorSaveTimer) clearTimeout(this.anchorSaveTimer);
    this.anchorSaveTimer = setTimeout(() => {
      this.anchorSaveTimer = null;
      const s = this.state;
      const a = this.scroller?.anchor();
      if (!s || !a) return;
      s.anchor = a;
      // a page split also keeps `pageId` in step, so the existing validity
      // check on restore still works; a PDF's ids are page numbers and an
      // image's is a single constant, neither of which `pageId` should shadow
      if (s.type === 'page') s.pageId = a.pageId;
      this.persist();
    }, 300);
  }

  // ---------------------------------------------------------- image overlay

  /**
   * The floating reference image. `position: fixed` does the important work:
   * the overlay's containing block is the viewport, so it holds its spot on
   * screen for free while `.nb-camera`'s transform pans and zooms the pages
   * underneath — it follows the viewport, never a page. (Being fixed also
   * means `.nb-scroll`'s `overflow: hidden` can't clip it: that clipping only
   * reaches descendants whose containing block lies inside it.)
   *
   * It is a sibling of `.nb-scroll`, not a child, for the same reason the
   * page pane is — NotebookView's pinch/pan listeners are bound to
   * `.nb-scroll` itself, so events here never reach them. The element is
   * sized to the image exactly and nothing around it is interactive, so every
   * touch outside its own box still lands on the page canvas and draws.
   *
   * `fresh` marks a just-picked image, whose saved box is only a placeholder.
   */
  // -------------------------------------------------------- image in the pane

  /**
   * A reference image in the same pane as the other two splits, with the same
   * `PageScroller` inside it — a one-page column laid out at the picture's own
   * natural size. Fit-to-width, pinch zoom, pan and the pane's scrollbar are
   * therefore literally the same code the note and PDF splits run, which is
   * what replaced the bespoke frameless overlay this used to be.
   *
   * Resolves false if the blob isn't a decodable image.
   */
  private async showImagePages(blob: Blob, anchor: ScrollAnchor | null): Promise<boolean> {
    const s = this.state;
    if (!s) return false;

    const source = new ImagePageSource();
    const ok = await source.load(blob);
    if (this.destroyed) return false;
    if (!ok) {
      this.clearState();
      this.teardownChrome();
      this.hooks.onLayout();
      return false;
    }
    this.imageSource = source;
    if (!this.stage) return false;

    if (this.titleEl) this.titleEl.textContent = s.fileName ?? 'Image';
    this.scroller = new PageScroller(source, {
      onCurrentPage: () => {
        // a single page, so the "n / N" read-out has nothing to say
        if (this.pageLabel) this.pageLabel.textContent = '';
      },
      onAnchorChanged: () => this.saveAnchorSoon(),
    });
    this.scroller.mount(this.stage, anchor);
    return true;
  }


  // ---------------------------------------------------------- PDF in the pane

  /**
   * A reference PDF in the same pane the note split uses: docked beside the
   * notebook by default, with the identical `PageScroller` inside it, so
   * continuous scroll, pinch zoom, fit-to-width, the mount window, the
   * incremental re-render on settle and the pane's own scrollbar all come
   * from exactly the same code the note split runs.
   *
   * Minimising it is the pane's float mode (`pane--floating`) — a movable,
   * resizable window pinned to the viewport — and expanding docks it back.
   *
   * Resolves false if the bytes aren't a readable PDF, so the caller can
   * decide whether to say so: a file just picked is worth a notice, a saved
   * split whose blob went bad on restore isn't worth one at notebook-open
   * time.
   */
  private async showPdfPages(bytes: ArrayBuffer, anchor: ScrollAnchor | null): Promise<boolean> {
    const s = this.state;
    if (!s) return false;

    const source = new PdfPageSource(`split:${this.hostNotebookId}`);
    const ok = await source.load(bytes);
    if (this.destroyed) return false;
    if (!ok) {
      this.clearState();
      this.teardownChrome();
      this.hooks.onLayout();
      return false;
    }
    this.pdfSource = source;
    if (!this.stage) return false;

    if (this.titleEl) this.titleEl.textContent = s.fileName ?? 'PDF';
    this.scroller = new PageScroller(source, {
      onCurrentPage: (index, count) => {
        if (this.pageLabel) this.pageLabel.textContent = index < 0 ? '' : `${index + 1} / ${count}`;
      },
      onAnchorChanged: () => this.saveAnchorSoon(),
    });
    this.scroller.mount(this.stage, anchor);
    return true;
  }


  /**
   * A page shown here was just edited in the main view (drawn on, erased,
   * undone) — repaint it. A no-op for an image split, or for a page the
   * scroller doesn't currently have mounted, so it stays cheap to call on
   * every op the notebook commits.
   */
  refreshIfShowing(pageId: string): void {
    if (this.state?.type !== 'page') return;
    this.scroller?.refreshIfShowing(pageId);
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
    if (hasBlob(this.state?.type)) void deleteSplitBlob(this.hostNotebookId);
    this.state = null;
  }

  /**
   * The × — on the pane's header for a page split, on the image's own corner
   * for an overlay. Either way it ends the split *and* forgets it; it is the
   * only thing that clears the saved state.
   */
  private close(): void {
    const hadBlob = hasBlob(this.state?.type);
    const hadChrome = this.root != null;
    clearSaved(this.hostNotebookId);
    this.state = null;
    if (hadBlob) void deleteSplitBlob(this.hostNotebookId);
    this.teardownContent();
    this.teardownChrome();
    // only a docked/floating pane ever changed `.nb-scroll`'s box; removing
    // the overlay leaves the notebook's own layout exactly as it was
    if (hadChrome) this.hooks.onLayout();
  }

  private teardownContent(): void {
    this.scroller?.unmount();
    this.scroller = null;
    if (this.anchorSaveTimer) {
      clearTimeout(this.anchorSaveTimer);
      this.anchorSaveTimer = null;
    }
    this.pdfSource?.release();
    this.pdfSource = null;
    this.imageSource?.release();
    this.imageSource = null;
  }

  /**
   * A brief, non-blocking notice. Built here with inline styles rather than a
   * shared component because the app has no toast of its own and adding one
   * would mean a stylesheet rule; this is the only thing in the pane that
   * needs one. Never interactive (`pointer-events: none`), so it can't eat a
   * touch meant for the page underneath, and it sits above the dock but below
   * the AI panel and any modal.
   */
  private toast(message: string): void {
    this.toastEl?.remove();
    if (this.toastTimer) clearTimeout(this.toastTimer);
    const t = el('div', { class: 'split-toast', role: 'status', text: message });
    t.style.cssText = [
      'position:fixed',
      'left:50%',
      'transform:translateX(-50%)',
      'bottom:calc(32px + env(safe-area-inset-bottom))',
      'z-index:58',
      'pointer-events:none',
      'max-width:min(420px,86vw)',
      'padding:10px 18px',
      'border-radius:9999px',
      'background:rgba(16,24,43,0.92)',
      'color:#fff',
      'font-size:14px',
      'font-weight:600',
      'text-align:center',
      'box-shadow:0 6px 24px rgba(4,21,52,0.28)',
      'opacity:0',
      'transition:opacity 0.18s ease',
    ].join(';');
    this.container.append(t);
    this.toastEl = t;
    requestAnimationFrame(() => {
      t.style.opacity = '1';
    });
    this.toastTimer = setTimeout(() => {
      this.toastTimer = null;
      t.style.opacity = '0';
      setTimeout(() => {
        if (this.toastEl === t) this.toastEl = null;
        t.remove();
      }, 220);
    }, 2400);
  }

  private teardownChrome(): void {
    this.root?.remove();
    this.root = null;
    this.stage = this.titleEl = this.pageLabel = this.resizeEl = null;
    this.floatBtn = null;
  }

  /**
   * The notebook view is going away: take the pane down but leave the saved
   * state alone, so coming back to this same notebook puts it right back.
   */
  destroy(): void {
    this.destroyed = true;
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = null;
    this.toastEl?.remove();
    this.toastEl = null;
    this.teardownContent();
    this.teardownChrome();
    this.fileInput?.remove();
    this.fileInput = null;
  }
}
