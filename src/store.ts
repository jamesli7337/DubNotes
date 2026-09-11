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
import { isStroke, uid } from './util';

/** One row of a folder's list: a notebook or a divider, in manual order. */
export type FolderItem = { kind: 'notebook'; nb: Notebook } | { kind: 'divider'; divider: Divider };

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

  /** New notebooks go to the top of their folder's list. */
  createNotebook(name: string, folderId: string | null = null): Notebook {
    const now = Date.now();
    const nb: Notebook = {
      id: uid(),
      name: name.trim() || 'Untitled notebook',
      folderId,
      order: this.topOrder(folderId),
      createdAt: now,
      updatedAt: now,
    };
    this.notebooks.set(nb.id, nb);
    this.dirtyNb.add(nb.id);
    this.addPage(nb.id);
    this.schedule();
    return nb;
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
    this.dirtyNb.delete(id);
    this.delNb.add(id);
    this.schedule();
  }

  // -------------------------------------------------------------------- pages
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

  // ------------------------------------------------------------------ strokes
  strokesOf(pageId: string): Stroke[] {
    return this.strokesByPage.get(pageId) ?? [];
  }

  addStroke(s: Stroke): void {
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

  removeItems(pageId: string, ids: Set<string>): PageItem[] {
    return [...this.removeStrokes(pageId, ids), ...this.removeElements(pageId, ids)];
  }

  /** Swaps items in place by id (same page), keeping z-order. Unknown ids are ignored. */
  replaceItems(pageId: string, items: PageItem[]): void {
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
