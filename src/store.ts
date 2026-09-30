import {
  deleteDividerRecord,
  deleteFolderRecord,
  deleteNotebookCascade,
  deletePageCascade,
  loadAll,
  migrateToCurrent,
  putDivider,
  putFolder,
  putNotebook,
  putPage,
  replacePageElements,
  replacePageStrokes,
} from './db';
import { DEFAULT_PAPER } from './const';
import type { Divider, Folder, Notebook, NotebookCover, Page, PageElement, PageItem, Paper, Stroke } from './types';
import { itemBounds, type Rect } from './canvas/geom';
import { isStroke, uid } from './util';

/** One row of a folder's list: a notebook or a divider, in manual order. */
export type FolderItem = { kind: 'notebook'; nb: Notebook } | { kind: 'divider'; divider: Divider };

/**
 * Board persistence grid, in board units. An item is filed in the chunk its
 * bounding-box origin falls in, and a chunk is one `Page` record — so an
 * autosave rewrites only the items near whatever was just drawn rather than
 * the whole board (`replacePageStrokes` replaces a record wholesale).
 *
 * Large on purpose: chunks are a write-batching device, not a render or query
 * structure, so a coarse grid keeps the number of `Page` records (and the
 * per-record flush overhead) low. Querying is the spatial index's job below.
 */
export const BOARD_CHUNK = 2048;

/**
 * Board spatial index cell, in board units — the grid painting and hit-testing
 * actually query. Much finer than a chunk: a redraw asks for the items
 * overlapping the visible rect, and a cell far larger than a stroke would drag
 * in most of the board.
 */
const BOARD_CELL = 512;

const cellKey = (cx: number, cy: number): string => `${cx},${cy}`;

/** Every index cell an axis-aligned box touches. */
function cellsForRect(r: Rect): string[] {
  const out: string[] = [];
  const x0 = Math.floor(r.x / BOARD_CELL);
  const x1 = Math.floor((r.x + r.w) / BOARD_CELL);
  const y0 = Math.floor(r.y / BOARD_CELL);
  const y1 = Math.floor((r.y + r.h) / BOARD_CELL);
  for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) out.push(cellKey(cx, cy));
  return out;
}

/** One board's live query structures, rebuilt from its chunks on load. */
interface BoardIndex {
  /** every item on the board by id — what a cell lookup resolves against */
  items: Map<string, PageItem>;
  /** index cell -> ids of the items whose bounds touch it */
  cells: Map<string, Set<string>>;
  /** id -> the cells it was registered in, so a removal is exact */
  placed: Map<string, string[]>;
  /**
   * Item-exact union of every item's bounds — not cell-granular, so it is
   * usable for zoom-to-fit as well as for clamping. Maintained incrementally:
   * adding an item is a cheap union, while removing or moving one can *shrink*
   * the box and so only marks it stale. The recompute is O(items) but happens
   * once per mutation batch, not per read — and reads are per pan frame.
   */
  bounds: Rect | null;
  boundsStale: boolean;
}

const byCreated = (a: PageItem, b: PageItem): number =>
  a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * In-memory source of truth for the whole app. Every mutation updates the maps
 * synchronously and schedules a debounced flush of just the touched records to
 * IndexedDB. `flushNow()` forces an immediate write (used on visibilitychange).
 */
class Store {
  readonly notebooks = new Map<string, Notebook>();
  readonly pages = new Map<string, Page>();
  readonly folders = new Map<string, Folder>();
  readonly dividers = new Map<string, Divider>();
  private readonly strokesByPage = new Map<string, Stroke[]>();
  private readonly elementsByPage = new Map<string, PageElement[]>();
  /** Per-board query structures, keyed by notebook id — see BoardIndex. Built in `init`, maintained by add/remove below. Ordinary notebooks never appear here. */
  private readonly boards = new Map<string, BoardIndex>();

  private dirtyNb = new Set<string>();
  private dirtyPg = new Set<string>();
  private dirtyStrokes = new Set<string>();
  private dirtyElements = new Set<string>();
  private dirtyFolder = new Set<string>();
  private dirtyDivider = new Set<string>();
  private delNb = new Set<string>();
  private delPg = new Set<string>();
  private delFolder = new Set<string>();
  private delDivider = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<void> = Promise.resolve();

  async init(): Promise<void> {
    this.notebooks.clear();
    this.pages.clear();
    this.folders.clear();
    this.dividers.clear();
    this.strokesByPage.clear();
    this.elementsByPage.clear();
    const { notebooks, pages, strokes, elements, folders, dividers } = await loadAll();

    // Upgrade any older records (template -> per-page paper; black swatch ->
    // auto token; element defaults; folder/order fields) before they enter the
    // model; persist what changed to disk.
    const migration = migrateToCurrent({ notebooks, pages, strokes, elements, folders, dividers });
    for (const id of migration.pagesChanged) this.dirtyPg.add(id);
    for (const id of migration.strokePagesChanged) this.dirtyStrokes.add(id);
    for (const id of migration.elementPagesChanged) this.dirtyElements.add(id);
    for (const id of migration.notebooksChanged) this.dirtyNb.add(id);

    for (const n of notebooks) this.notebooks.set(n.id, n);
    for (const p of pages) this.pages.set(p.id, p);
    for (const f of folders) this.folders.set(f.id, f);
    for (const d of dividers) this.dividers.set(d.id, d);
    for (const s of strokes) {
      const arr = this.strokesByPage.get(s.pageId);
      if (arr) arr.push(s);
      else this.strokesByPage.set(s.pageId, [s]);
    }
    for (const e of elements) {
      const arr = this.elementsByPage.get(e.pageId);
      if (arr) arr.push(e);
      else this.elementsByPage.set(e.pageId, [e]);
    }
    for (const arr of this.strokesByPage.values()) arr.sort(byCreated);
    for (const arr of this.elementsByPage.values()) arr.sort(byCreated);

    // Boards get their spatial index built once, here: every chunk's items are
    // already in the per-page maps above, and nothing else walks a whole board.
    this.boards.clear();
    for (const n of notebooks) {
      if (n.kind !== 'board') continue;
      const idx = this.boardIndex(n.id);
      for (const p of pages) {
        if (p.notebookId !== n.id) continue;
        for (const it of this.itemsOf(p.id)) this.indexBoardItem(idx, it);
      }
    }
    if (
      migration.pagesChanged.length ||
      migration.strokePagesChanged.length ||
      migration.elementPagesChanged.length ||
      migration.notebooksChanged.length
    ) {
      this.schedule();
    }
  }

  // ---------------------------------------------------------------- notebooks
  /** Every notebook, most recently edited first (the "resume" card). */
  notebookList(): Notebook[] {
    return [...this.notebooks.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** New notebooks go to the top of their folder's list. `paper`, if given, becomes the starting page's paper (instead of DEFAULT_PAPER) — every later page still inherits from whichever page precedes it, same as always (see addPage). */
  createNotebook(name: string, folderId: string | null = null, paper?: Paper, kind: 'pages' | 'board' = 'pages'): Notebook {
    const now = Date.now();
    const nb: Notebook = {
      id: uid(),
      name: name.trim() || (kind === 'board' ? 'Untitled board' : 'Untitled notebook'),
      folderId,
      order: this.topOrder(folderId),
      createdAt: now,
      updatedAt: now,
    };
    if (kind === 'board') nb.kind = 'board';
    this.notebooks.set(nb.id, nb);
    this.dirtyNb.add(nb.id);
    if (kind === 'board') {
      // The origin chunk exists from the start and holds the board's paper —
      // see boardPaper. Every later chunk copies it, so the board reads as one
      // continuous sheet however far it grows.
      this.boardIndex(nb.id);
      const origin = this.ensureChunk(nb.id, 0, 0);
      if (paper) origin.paper = { ...paper };
    } else {
      const page = this.addPage(nb.id);
      if (paper) page.paper = { ...paper };
    }
    this.schedule();
    return nb;
  }

  /** True for a board — the one thing callers branch on. */
  isBoard(notebookId: string): boolean {
    return this.notebooks.get(notebookId)?.kind === 'board';
  }

  setCover(id: string, cover: NotebookCover | undefined): void {
    const n = this.notebooks.get(id);
    if (!n) return;
    if (cover) n.cover = cover;
    else delete n.cover;
    n.updatedAt = Date.now();
    this.dirtyNb.add(id);
    this.schedule();
  }

  /** Moves a notebook to another folder (top of that folder's list). */
  moveNotebook(id: string, folderId: string | null): void {
    const n = this.notebooks.get(id);
    if (!n || n.folderId === folderId) return;
    n.folderId = folderId;
    n.order = this.topOrder(folderId);
    this.dirtyNb.add(id);
    this.schedule();
  }

  // ------------------------------------------------------------------ folders
  /** Direct subfolders, by name. */
  folderList(parentId: string | null): Folder[] {
    return [...this.folders.values()]
      .filter((f) => f.parentId === parentId)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Root → … → the folder itself. */
  folderPath(id: string | null): Folder[] {
    const path: Folder[] = [];
    let cur = id ? this.folders.get(id) : undefined;
    while (cur) {
      path.unshift(cur);
      cur = cur.parentId ? this.folders.get(cur.parentId) : undefined;
    }
    return path;
  }

  /** Number of notebooks in a folder and all of its subfolders. */
  notebookCount(folderId: string | null): number {
    let n = 0;
    for (const nb of this.notebooks.values()) if (nb.folderId === folderId) n++;
    for (const f of this.folderList(folderId)) n += this.notebookCount(f.id);
    return n;
  }

  createFolder(name: string, parentId: string | null = null): Folder {
    const now = Date.now();
    const f: Folder = { id: uid(), name: name.trim() || 'Untitled folder', parentId, createdAt: now, updatedAt: now };
    this.folders.set(f.id, f);
    this.dirtyFolder.add(f.id);
    this.schedule();
    return f;
  }

  renameFolder(id: string, name: string): void {
    const f = this.folders.get(id);
    if (!f) return;
    f.name = name.trim() || f.name;
    f.updatedAt = Date.now();
    this.dirtyFolder.add(id);
    this.schedule();
  }

  /** Removes a folder; everything in it (notebooks, dividers, subfolders) moves up to its parent. */
  deleteFolder(id: string): void {
    const f = this.folders.get(id);
    if (!f) return;
    const parent = f.parentId;
    for (const nb of this.notebooks.values()) {
      if (nb.folderId === id) {
        nb.folderId = parent;
        this.dirtyNb.add(nb.id);
      }
    }
    for (const d of this.dividers.values()) {
      if (d.folderId === id) {
        d.folderId = parent;
        this.dirtyDivider.add(d.id);
      }
    }
    for (const sub of this.folders.values()) {
      if (sub.parentId === id) {
        sub.parentId = parent;
        this.dirtyFolder.add(sub.id);
      }
    }
    this.folders.delete(id);
    this.dirtyFolder.delete(id);
    this.delFolder.add(id);
    this.renumber(parent);
    this.schedule();
  }

  // ----------------------------------------------------- folder list order
  /** Notebooks and dividers of one folder, in manual order. */
  folderItems(folderId: string | null): FolderItem[] {
    const items: FolderItem[] = [];
    for (const nb of this.notebooks.values()) if (nb.folderId === folderId) items.push({ kind: 'notebook', nb });
    for (const divider of this.dividers.values()) {
      if (divider.folderId === folderId) items.push({ kind: 'divider', divider });
    }
    return items.sort((a, b) => orderOf(a) - orderOf(b) || createdOf(a) - createdOf(b));
  }

  /** Adds a labelled divider at the end of a folder's list, or just above a notebook. */
  createDivider(folderId: string | null, label: string, aboveNotebookId?: string): Divider {
    const above = aboveNotebookId ? this.notebooks.get(aboveNotebookId) : undefined;
    const items = this.folderItems(folderId);
    const last = items.length ? orderOf(items[items.length - 1]) : -1;
    const d: Divider = {
      id: uid(),
      folderId,
      label: label.trim() || 'Divider',
      order: above ? above.order - 0.5 : last + 1,
      createdAt: Date.now(),
    };
    this.dividers.set(d.id, d);
    this.dirtyDivider.add(d.id);
    this.renumber(folderId);
    this.schedule();
    return d;
  }

  renameDivider(id: string, label: string): void {
    const d = this.dividers.get(id);
    if (!d) return;
    d.label = label.trim() || d.label;
    this.dirtyDivider.add(id);
    this.schedule();
  }

  deleteDivider(id: string): void {
    if (!this.dividers.delete(id)) return;
    this.dirtyDivider.delete(id);
    this.delDivider.add(id);
    this.schedule();
  }

  /** Swaps a notebook or divider with its neighbour in the folder list (`dir` −1 = up, 1 = down). */
  moveItem(id: string, dir: -1 | 1): boolean {
    const folderId = this.notebooks.get(id)?.folderId ?? this.dividers.get(id)?.folderId;
    const target = this.notebooks.get(id) ?? this.dividers.get(id);
    if (!target) return false;
    const items = this.folderItems(folderId ?? null);
    const i = items.findIndex((it) => idOf(it) === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= items.length) return false;
    const other = items[j].kind === 'notebook' ? items[j].nb : items[j].divider;
    [target.order, other.order] = [other.order, target.order];
    this.markOrderDirty(target.id);
    this.markOrderDirty(other.id);
    this.renumber(folderId ?? null);
    this.schedule();
    return true;
  }

  /** The order value that puts a new item at the top of a folder's list. */
  private topOrder(folderId: string | null): number {
    const items = this.folderItems(folderId);
    return items.length ? orderOf(items[0]) - 1 : 0;
  }

  /** Re-assigns 0, 1, 2… down a folder's list so fractional / negative orders don't accumulate. */
  private renumber(folderId: string | null): void {
    this.folderItems(folderId).forEach((it, i) => {
      const rec = it.kind === 'notebook' ? it.nb : it.divider;
      if (rec.order !== i) {
        rec.order = i;
        this.markOrderDirty(rec.id);
      }
    });
  }

  private markOrderDirty(id: string): void {
    if (this.notebooks.has(id)) this.dirtyNb.add(id);
    else if (this.dividers.has(id)) this.dirtyDivider.add(id);
  }

  renameNotebook(id: string, name: string): void {
    const n = this.notebooks.get(id);
    if (!n) return;
    n.name = name.trim() || n.name;
    n.updatedAt = Date.now();
    this.dirtyNb.add(id);
    this.schedule();
  }

  deleteNotebook(id: string): void {
    for (const p of this.pagesOf(id)) {
      this.pages.delete(p.id);
      this.strokesByPage.delete(p.id);
      this.elementsByPage.delete(p.id);
      this.dirtyPg.delete(p.id);
      this.dirtyStrokes.delete(p.id);
      this.dirtyElements.delete(p.id);
      this.delPg.delete(p.id);
    }
    this.notebooks.delete(id);
    this.boards.delete(id);
    this.dirtyNb.delete(id);
    this.delNb.add(id);
    this.schedule();
  }

  // -------------------------------------------------------------------- pages
  pageById(id: string): Page | undefined {
    return this.pages.get(id);
  }

  pagesOf(notebookId: string): Page[] {
    return [...this.pages.values()]
      .filter((p) => p.notebookId === notebookId)
      .sort((a, b) => a.index - b.index);
  }

  addPage(notebookId: string, at?: number): Page {
    const now = Date.now();
    const siblings = this.pagesOf(notebookId);
    const index = at ?? siblings.length;
    const prev = siblings[index - 1]; // the page this one will follow
    const page: Page = {
      id: uid(),
      notebookId,
      index,
      paper: prev ? { ...prev.paper } : { ...DEFAULT_PAPER },
      createdAt: now,
      updatedAt: now,
    };
    this.insertPage(page, page.index);
    return page;
  }

  /** Updates paper for one page, or every page in its notebook when scope is 'all'. */
  setPaper(pageId: string, patch: Partial<Paper>, scope: 'page' | 'all'): void {
    const page = this.pages.get(pageId);
    if (!page) return;
    const targets = scope === 'all' ? this.pagesOf(page.notebookId) : [page];
    const now = Date.now();
    for (const p of targets) {
      p.paper = { ...p.paper, ...patch };
      p.updatedAt = now;
      this.dirtyPg.add(p.id);
    }
    this.bump(page.notebookId);
    this.schedule();
  }

  /** Re-inserts a page object (keeping its id) at a position; used by undo/redo. */
  insertPage(page: Page, index: number): void {
    this.pages.set(page.id, page);
    this.delPg.delete(page.id);
    this.reindex(page.notebookId, page.id, index);
    this.dirtyPg.add(page.id);
    this.bump(page.notebookId);
    this.schedule();
  }

  deletePage(id: string): void {
    const p = this.pages.get(id);
    if (!p) return;
    this.pages.delete(id);
    this.strokesByPage.delete(id);
    this.elementsByPage.delete(id);
    this.dirtyPg.delete(id);
    this.dirtyStrokes.delete(id);
    this.dirtyElements.delete(id);
    this.delPg.add(id);
    this.reindex(p.notebookId);
    this.bump(p.notebookId);
    this.schedule();
  }

  /** Moves a page one step earlier/later among its notebook's pages. False (no-op) at either end. */
  movePage(pageId: string, dir: -1 | 1): boolean {
    const page = this.pages.get(pageId);
    if (!page) return false;
    const siblings = this.pagesOf(page.notebookId);
    const i = siblings.findIndex((p) => p.id === pageId);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= siblings.length) return false;
    this.reindex(page.notebookId, pageId, j);
    this.bump(page.notebookId);
    this.schedule();
    return true;
  }

  /** Moves a page to an arbitrary position among its notebook's pages (drag-and-drop reorder). False (no-op) if it's already at `toIndex`. */
  reorderPage(pageId: string, toIndex: number): boolean {
    const page = this.pages.get(pageId);
    if (!page) return false;
    const siblings = this.pagesOf(page.notebookId);
    const target = Math.max(0, Math.min(toIndex, siblings.length - 1));
    if (target === page.index) return false;
    this.reindex(page.notebookId, pageId, target);
    this.bump(page.notebookId);
    this.schedule();
    return true;
  }

  /**
   * Duplicates a page — paper, background, and every stroke/element (each
   * re-keyed with a fresh id, deep-copied where an array is mutated in place
   * later) — and inserts the copy immediately after the original. Item
   * `createdAt`s are reassigned sequentially (source order preserved) rather
   * than copied verbatim, so z-order survives even if originals share a
   * millisecond timestamp.
   */
  duplicatePage(pageId: string): Page | undefined {
    const src = this.pages.get(pageId);
    if (!src) return undefined;
    const now = Date.now();
    const copy: Page = {
      id: uid(),
      notebookId: src.notebookId,
      index: src.index + 1,
      paper: { ...src.paper },
      createdAt: now,
      updatedAt: now,
    };
    if (src.background) copy.background = { ...src.background };
    if (src.w !== undefined) copy.w = src.w;
    if (src.h !== undefined) copy.h = src.h;
    this.insertPage(copy, copy.index);

    this.itemsOf(pageId).forEach((it, i) => {
      const createdAt = now + i;
      if (isStroke(it)) {
        this.addStroke({ ...it, id: uid(), pageId: copy.id, notebookId: copy.notebookId, createdAt, points: it.points.map((p) => [...p]) });
      } else {
        const el: PageElement = { ...it, id: uid(), pageId: copy.id, notebookId: copy.notebookId, createdAt };
        if (el.kind === 'shape' && el.pts) el.pts = el.pts.map((p) => [...p]);
        this.addElement(el);
      }
    });
    return copy;
  }

  /** Sets or clears a page's background image (imported PDF page). */
  setBackground(pageId: string, background: Page['background']): void {
    const p = this.pages.get(pageId);
    if (!p) return;
    if (background) p.background = background;
    else delete p.background;
    p.updatedAt = Date.now();
    this.dirtyPg.add(pageId);
    this.bump(p.notebookId);
    this.schedule();
  }

  /** Sets a page's own size (page units), overriding the app's default portrait size — see `Page.w`/`Page.h`'s doc comment. Used by PDF import to match a source page's aspect ratio. */
  setPageSize(pageId: string, w: number, h: number): void {
    const p = this.pages.get(pageId);
    if (!p) return;
    p.w = w;
    p.h = h;
    p.updatedAt = Date.now();
    this.dirtyPg.add(pageId);
    this.bump(p.notebookId);
    this.schedule();
  }

  /** A page with no committed content yet — no strokes, no elements, no background. */
  isBlankPage(pageId: string): boolean {
    return (
      this.strokesOf(pageId).length === 0 &&
      this.elementsOf(pageId).length === 0 &&
      !this.pages.get(pageId)?.background
    );
  }

  /**
   * Keeps a blank page at the end of a notebook: appends one if the last page
   * has content (or the notebook has no pages). It never removes pages — a
   * blank that was already generated stays even if the page before it is
   * cleared again; only the user deletes pages. Returns true when a page was
   * added. Callers own re-render; this is never recorded as an undo op.
   */
  enforceTrailingBlank(notebookId: string): boolean {
    const pages = this.pagesOf(notebookId);
    if (pages.length === 0 || !this.isBlankPage(pages[pages.length - 1].id)) {
      this.addPage(notebookId);
      return true;
    }
    return false;
  }

  private reindex(notebookId: string, ensureId?: string, ensureAt?: number): void {
    let list = [...this.pages.values()]
      .filter((p) => p.notebookId === notebookId)
      .sort((a, b) => a.index - b.index);
    if (ensureId != null && ensureAt != null) {
      const target = this.pages.get(ensureId);
      list = list.filter((p) => p.id !== ensureId);
      if (target) list.splice(Math.max(0, Math.min(ensureAt, list.length)), 0, target);
    }
    list.forEach((p, i) => {
      if (p.index !== i) {
        p.index = i;
        this.dirtyPg.add(p.id);
      }
    });
  }

  // ------------------------------------------------------------------- boards
  private boardIndex(notebookId: string): BoardIndex {
    let idx = this.boards.get(notebookId);
    if (!idx) {
      idx = { items: new Map(), cells: new Map(), placed: new Map(), bounds: null, boundsStale: false };
      this.boards.set(notebookId, idx);
    }
    return idx;
  }

  /**
   * Files an item into every index cell its bounds touch, replacing any
   * previous placement. Idempotent, so it doubles as the "this item moved or
   * resized" path: `unindexBoardItem` first, then re-file against fresh bounds.
   */
  private indexBoardItem(idx: BoardIndex, item: PageItem): void {
    // A re-file (the item moved or resized) can shrink the board's extent, so
    // it can only invalidate; a genuinely new item can only grow it, which is
    // a union and needs no rescan.
    const isRefile = idx.placed.has(item.id);
    this.unindexBoardItem(idx, item.id);
    idx.items.set(item.id, item);
    const b = itemBounds(item);
    if (isRefile) {
      idx.boundsStale = true;
    } else if (idx.bounds) {
      const x1 = Math.max(idx.bounds.x + idx.bounds.w, b.x + b.w);
      const y1 = Math.max(idx.bounds.y + idx.bounds.h, b.y + b.h);
      idx.bounds.x = Math.min(idx.bounds.x, b.x);
      idx.bounds.y = Math.min(idx.bounds.y, b.y);
      idx.bounds.w = x1 - idx.bounds.x;
      idx.bounds.h = y1 - idx.bounds.y;
    } else if (!idx.boundsStale) {
      idx.bounds = { ...b };
    }
    const cells = cellsForRect(b);
    idx.placed.set(item.id, cells);
    for (const key of cells) {
      const set = idx.cells.get(key);
      if (set) set.add(item.id);
      else idx.cells.set(key, new Set([item.id]));
    }
  }

  /** Removes an item from the cells it was actually placed in — never a scan. */
  private unindexBoardItem(idx: BoardIndex, id: string): void {
    const cells = idx.placed.get(id);
    if (cells) {
      for (const key of cells) {
        const set = idx.cells.get(key);
        if (!set) continue;
        set.delete(id);
        if (!set.size) idx.cells.delete(key);
      }
    }
    if (idx.placed.delete(id)) idx.boundsStale = true; // removing can shrink the box
    idx.items.delete(id);
  }

  /**
   * The chunk record an item at `(x, y)` belongs to, created on first use.
   *
   * Deliberately not `addPage`: that scans every page in the app to pick an
   * index and then renumbers all of the notebook's siblings, which for a board
   * (whose chunks have no order and are never shown) is both meaningless and
   * O(all pages) per new chunk.
   */
  private ensureChunk(notebookId: string, col: number, row: number): Page {
    const id = `${notebookId}:${col},${row}`;
    const existing = this.pages.get(id);
    if (existing) return existing;
    const now = Date.now();
    const origin = this.pages.get(`${notebookId}:0,0`);
    const page: Page = {
      id,
      notebookId,
      index: 0, // boards have no page order; nothing reads this
      paper: origin ? { ...origin.paper } : { ...DEFAULT_PAPER },
      col,
      row,
      createdAt: now,
      updatedAt: now,
    };
    this.pages.set(id, page);
    this.dirtyPg.add(id);
    return page;
  }

  /** The chunk id an item whose bounds start at `(x, y)` is stored under, creating the chunk if this is the first item to land there. */
  boardChunkAt(notebookId: string, x: number, y: number): string {
    return this.ensureChunk(notebookId, Math.floor(x / BOARD_CHUNK), Math.floor(y / BOARD_CHUNK)).id;
  }

  /** A board's paper, held by its origin chunk (see createNotebook). */
  boardPaper(notebookId: string): Paper {
    return this.pages.get(`${notebookId}:0,0`)?.paper ?? { ...DEFAULT_PAPER };
  }

  /** Sets the paper for a whole board — every chunk, so chunks created later inherit it too. */
  setBoardPaper(notebookId: string, patch: Partial<Paper>): void {
    const now = Date.now();
    for (const p of this.pages.values()) {
      if (p.notebookId !== notebookId) continue;
      p.paper = { ...p.paper, ...patch };
      p.updatedAt = now;
      this.dirtyPg.add(p.id);
    }
    this.ensureChunk(notebookId, 0, 0); // a board with no chunks yet still needs somewhere to keep it
    this.bump(notebookId);
    this.schedule();
  }

  /**
   * Every item whose bounds overlap `rect`, in z-order. This is what a board
   * repaint and every hit-test go through — the cell grid keeps it proportional
   * to what is on screen rather than to the size of the board.
   */
  boardItemsIn(notebookId: string, rect: Rect): PageItem[] {
    const idx = this.boards.get(notebookId);
    if (!idx) return [];
    const seen = new Set<string>();
    const out: PageItem[] = [];
    for (const key of cellsForRect(rect)) {
      const ids = idx.cells.get(key);
      if (!ids) continue;
      for (const id of ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        const it = idx.items.get(id);
        // a cell can only ever be a superset of the rect, so confirm the
        // overlap before handing the item to a caller that will paint it
        if (!it) continue;
        const b = itemBounds(it);
        if (b.x + b.w < rect.x || b.x > rect.x + rect.w || b.y + b.h < rect.y || b.y > rect.y + rect.h) continue;
        out.push(it);
      }
    }
    return out.sort(byCreated);
  }

  /** One board item by id, straight from the registry — no scan. */
  boardItem(notebookId: string, id: string): PageItem | undefined {
    return this.boards.get(notebookId)?.items.get(id);
  }

  /** How many items a board holds — for the debug readout and for deciding whether a board is empty. */
  boardItemCount(notebookId: string): number {
    return this.boards.get(notebookId)?.items.size ?? 0;
  }

  /**
   * The board's occupied extent: the item-exact union of every item's bounds,
   * cached and recomputed only when a removal or a move could have shrunk it
   * (see BoardIndex.bounds). Item-exact rather than cell-granular so it also
   * serves zoom-to-fit, not just pan-clamping. Null when the board is empty —
   * which the pan clamp reads as "unbounded", not as a zero-size box.
   */
  boardBounds(notebookId: string): Rect | null {
    const idx = this.boards.get(notebookId);
    if (!idx) return null;
    if (idx.boundsStale) {
      idx.boundsStale = false;
      idx.bounds = null;
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const it of idx.items.values()) {
        const b = itemBounds(it);
        if (b.x < x0) x0 = b.x;
        if (b.y < y0) y0 = b.y;
        if (b.x + b.w > x1) x1 = b.x + b.w;
        if (b.y + b.h > y1) y1 = b.y + b.h;
      }
      if (x0 !== Infinity) idx.bounds = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }
    // a copy: the stored box is mutated in place as items are added, so
    // handing out the reference would change under a caller that kept it
    return idx.bounds ? { ...idx.bounds } : null;
  }

  /**
   * Re-files an item whose geometry changed in place (a move or a resize).
   * Phase 1 has no tool that does this — a partial erase replaces items rather
   * than mutating them, so it goes through add/remove — but the index has to
   * stay correct for the ones that will, and doing it here keeps that knowledge
   * in one place.
   */
  reindexBoardItem(notebookId: string, item: PageItem): void {
    const idx = this.boards.get(notebookId);
    if (idx) this.indexBoardItem(idx, item);
  }

  // ------------------------------------------------------------------ strokes
  strokesOf(pageId: string): Stroke[] {
    return this.strokesByPage.get(pageId) ?? [];
  }

  addStroke(s: Stroke): void {
    const board = this.boards.get(s.notebookId);
    if (board) this.indexBoardItem(board, s);
    const arr = this.strokesByPage.get(s.pageId);
    if (arr) {
      arr.push(s);
      arr.sort(byCreated);
    } else {
      this.strokesByPage.set(s.pageId, [s]);
    }
    this.dirtyStrokes.add(s.pageId);
    this.bump(s.notebookId);
    this.schedule();
  }

  removeStrokes(pageId: string, ids: Set<string>): Stroke[] {
    const arr = this.strokesByPage.get(pageId);
    if (!arr) return [];
    const removed: Stroke[] = [];
    const keep = arr.filter((s) => {
      if (ids.has(s.id)) {
        removed.push(s);
        return false;
      }
      return true;
    });
    this.strokesByPage.set(pageId, keep);
    if (removed.length) {
      const board = this.boards.get(removed[0].notebookId);
      if (board) for (const r of removed) this.unindexBoardItem(board, r.id);
      this.dirtyStrokes.add(pageId);
      this.bump(removed[0].notebookId);
      this.schedule();
    }
    return removed;
  }

  // ----------------------------------------------------------------- elements
  elementsOf(pageId: string): PageElement[] {
    return this.elementsByPage.get(pageId) ?? [];
  }

  addElement(e: PageElement): void {
    const board = this.boards.get(e.notebookId);
    if (board) this.indexBoardItem(board, e);
    const arr = this.elementsByPage.get(e.pageId);
    if (arr) {
      arr.push(e);
      arr.sort(byCreated);
    } else {
      this.elementsByPage.set(e.pageId, [e]);
    }
    this.dirtyElements.add(e.pageId);
    this.bump(e.notebookId);
    this.schedule();
  }

  removeElements(pageId: string, ids: Set<string>): PageElement[] {
    const arr = this.elementsByPage.get(pageId);
    if (!arr) return [];
    const removed: PageElement[] = [];
    const keep = arr.filter((e) => {
      if (ids.has(e.id)) {
        removed.push(e);
        return false;
      }
      return true;
    });
    this.elementsByPage.set(pageId, keep);
    if (removed.length) {
      const board = this.boards.get(removed[0].notebookId);
      if (board) for (const r of removed) this.unindexBoardItem(board, r.id);
      this.dirtyElements.add(pageId);
      this.bump(removed[0].notebookId);
      this.schedule();
    }
    return removed;
  }

  // ------------------------------------------------ mixed items (selection)
  /** Everything on a page in z-order: strokes and elements interleaved by `createdAt`. */
  itemsOf(pageId: string): PageItem[] {
    const s = this.strokesOf(pageId);
    const e = this.elementsOf(pageId);
    if (!e.length) return s;
    if (!s.length) return e;
    return [...s, ...e].sort(byCreated);
  }

  addItems(items: PageItem[]): void {
    for (const it of items) {
      if (isStroke(it)) this.addStroke(it);
      else this.addElement(it);
    }
  }

  /**
   * Removes by id from one page — or, when `pageId` names a *board* chunk, from
   * wherever on that board those ids actually live.
   *
   * A board selection routinely spans chunks (a chunk is 2048 board units, a
   * lasso is not), and a chunk is only a persistence detail. Resolving the ids
   * through the board's own index here is what lets one gesture stay one undo
   * step: every `Op` carries a single `pageId`, and the inverse (`addItems`)
   * already routes per item via each item's own `pageId`, so this is the one
   * side that needed to stop being page-keyed. A page notebook has no board
   * index, so it never takes this branch.
   */
  removeItems(pageId: string, ids: Set<string>): PageItem[] {
    const idx = this.boardIndexForPage(pageId);
    if (!idx) return [...this.removeStrokes(pageId, ids), ...this.removeElements(pageId, ids)];
    const byPage = new Map<string, Set<string>>();
    for (const id of ids) {
      const it = idx.items.get(id);
      const home = it ? it.pageId : pageId;
      const bucket = byPage.get(home);
      if (bucket) bucket.add(id);
      else byPage.set(home, new Set([id]));
    }
    const out: PageItem[] = [];
    for (const [home, group] of byPage) {
      out.push(...this.removeStrokes(home, group), ...this.removeElements(home, group));
    }
    return out;
  }

  /** The board index owning `pageId`, or null when that page isn't a board chunk. */
  private boardIndexForPage(pageId: string): BoardIndex | null {
    const nbId = this.pages.get(pageId)?.notebookId;
    return (nbId && this.boards.get(nbId)) || null;
  }

  /**
   * Swaps items in place by id (same page), keeping z-order. Unknown ids are ignored.
   *
   * On a board this is also where a move/resize/rotate lands, and the swapped-in
   * items carry new geometry — so each one is re-filed in the spatial index that
   * painting and hit-testing actually read. Without that the index would keep
   * pointing at the pre-drag cells and an item would stop being findable where it
   * now visibly is. The item's `pageId` deliberately does *not* follow it across
   * chunk boundaries: a chunk is only a persistence detail (see `Page.col`/`row`),
   * nothing reads it to paint, and keeping it stable is what lets a board's
   * move/resize reuse the page path's `replace-items` op — and so the existing
   * undo/redo — with no board-specific handling at all.
   */
  replaceItems(pageId: string, items: PageItem[]): void {
    // Same reasoning as removeItems: on a board the swapped-in items may belong
    // to several chunks, so each goes back to its own rather than to whichever
    // one the op happened to name.
    if (this.boardIndexForPage(pageId)) {
      const byPage = new Map<string, PageItem[]>();
      for (const it of items) {
        const arr = byPage.get(it.pageId);
        if (arr) arr.push(it);
        else byPage.set(it.pageId, [it]);
      }
      if (byPage.size > 1 || !byPage.has(pageId)) {
        for (const [home, group] of byPage) this.replaceOnPage(home, group);
        return;
      }
    }
    this.replaceOnPage(pageId, items);
  }

  private replaceOnPage(pageId: string, items: PageItem[]): void {
    const byId = new Map(items.map((it) => [it.id, it]));
    const strokes = this.strokesByPage.get(pageId);
    const elements = this.elementsByPage.get(pageId);
    let nb: string | null = null;
    let touchedStrokes = false;
    let touchedElements = false;
    if (strokes) {
      for (let i = 0; i < strokes.length; i++) {
        const next = byId.get(strokes[i].id);
        if (next && isStroke(next)) {
          strokes[i] = next;
          touchedStrokes = true;
          nb = next.notebookId;
        }
      }
    }
    if (elements) {
      for (let i = 0; i < elements.length; i++) {
        const next = byId.get(elements[i].id);
        if (next && !isStroke(next)) {
          elements[i] = next;
          touchedElements = true;
          nb = next.notebookId;
        }
      }
    }
    if (touchedStrokes) this.dirtyStrokes.add(pageId);
    if (touchedElements) this.dirtyElements.add(pageId);
    if (nb) {
      const board = this.boards.get(nb);
      if (board) for (const it of items) if (board.items.has(it.id)) this.indexBoardItem(board, it);
      this.bump(nb);
      this.schedule();
    }
  }

  // ------------------------------------------------------------- persistence
  private bump(notebookId: string): void {
    const n = this.notebooks.get(notebookId);
    if (n) {
      n.updatedAt = Date.now();
      this.dirtyNb.add(notebookId);
    }
  }

  private schedule(): void {
    if (this.timer != null) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), 700);
  }

  flushNow(): void {
    if (this.timer != null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    void this.flush();
  }

  private flush(): Promise<void> {
    this.timer = null;
    const nb = [...this.dirtyNb];
    this.dirtyNb.clear();
    const pg = [...this.dirtyPg];
    this.dirtyPg.clear();
    const sp = [...this.dirtyStrokes];
    this.dirtyStrokes.clear();
    const ep = [...this.dirtyElements];
    this.dirtyElements.clear();
    const fo = [...this.dirtyFolder];
    this.dirtyFolder.clear();
    const dv = [...this.dirtyDivider];
    this.dirtyDivider.clear();
    const dnb = [...this.delNb];
    this.delNb.clear();
    const dpg = [...this.delPg];
    this.delPg.clear();
    const dfo = [...this.delFolder];
    this.delFolder.clear();
    const ddv = [...this.delDivider];
    this.delDivider.clear();

    this.chain = this.chain.then(async () => {
      try {
        for (const id of dnb) await deleteNotebookCascade(id);
        for (const id of dpg) await deletePageCascade(id);
        for (const id of dfo) await deleteFolderRecord(id);
        for (const id of ddv) await deleteDividerRecord(id);
        for (const id of fo) {
          const f = this.folders.get(id);
          if (f) await putFolder(f);
        }
        for (const id of dv) {
          const d = this.dividers.get(id);
          if (d) await putDivider(d);
        }
        for (const id of nb) {
          const n = this.notebooks.get(id);
          if (n) await putNotebook(n);
        }
        for (const id of pg) {
          const p = this.pages.get(id);
          if (p) await putPage(p);
        }
        for (const id of sp) {
          if (this.pages.has(id)) await replacePageStrokes(id, this.strokesOf(id));
        }
        for (const id of ep) {
          if (this.pages.has(id)) await replacePageElements(id, this.elementsOf(id));
        }
      } catch (err) {
        console.error('[noteapp] autosave failed', err);
      }
    });
    return this.chain;
  }
}

const orderOf = (it: FolderItem): number => (it.kind === 'notebook' ? it.nb.order : it.divider.order);
const createdOf = (it: FolderItem): number => (it.kind === 'notebook' ? it.nb.createdAt : it.divider.createdAt);
const idOf = (it: FolderItem): string => (it.kind === 'notebook' ? it.nb.id : it.divider.id);

export const store = new Store();
