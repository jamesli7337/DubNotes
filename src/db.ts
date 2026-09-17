import { AUTO_COLOR } from './canvas/freehand';
import type {
  AiConversationEntry,
  Backup,
  BackupAsset,
  Divider,
  Folder,
  Notebook,
  Page,
  PageElement,
  Paper,
  PaperTemplate,
  PdfAsset,
  Stroke,
} from './types';

const DB_NAME = 'noteapp';
/** IndexedDB schema version: 2 added `elements`; 3 added `folders` + `dividers`; 4 added `assets`;
 * 5 added `aiConversations` (AI-mode chat history — deliberately outside the
 * backup format's store list, see ALL_STORES below); 6 added a
 * `branchedFromEntryId` index on `aiConversations` (branched AI-mode
 * threads — see getThreadEntries). */
const DB_VERSION = 6;

/**
 * Logical data-format version, independent of the IndexedDB schema version.
 * History:
 *   1 — Notebook.template ('blank' | 'lined' | 'grid'); pages had no paper.
 *   2 — template moved onto each Page as `paper` { template, spacing, color };
 *       'lined' renamed to 'ruled'; 'dot' added.
 *   3 — Stroke.color may be the "auto" token (resolved per page at render time)
 *       in addition to a hex value; the old fixed-black pen swatch is gone.
 *   4 — page elements (text / image / shape) stored alongside strokes, in their
 *       own `elements` store and a top-level `elements` array in backups.
 *   5 — Page.background (optional rendered page image, e.g. an imported PDF
 *       page) and the "tape" element kind. No migration needed: both are
 *       optional additions.
 *   6 — folders and dividers (own stores / backup arrays); Notebook gained
 *       `folderId` (null = root), `order` (manual position in its folder) and
 *       optional `cover`. Migration fills folderId/order on older notebooks.
 *   7 — assets: an imported PDF is stored once (`assets` store / backup array,
 *       bytes as base64) and Page.background may reference it as
 *       `{ assetId, page }`, rendered on demand. v5-style `{ src }` backgrounds
 *       remain valid; nothing to migrate.
 *   8 — TextElement gained optional `bg` (a tint painted behind the text,
 *       used by AI-mode replies). Additive; nothing to migrate.
 *
 * AiConversationEntry's own fields (including `branchedFromEntryId` /
 * `questionText`, added for branched AI-mode threads — schema v6 above)
 * don't bump this: `aiConversations` is outside the backup format entirely
 * (see ALL_STORES), so nothing about its shape affects Backup's shape.
 */
export const FORMAT_VERSION = 8;

/** The hex value the pen's first swatch used before it became the "auto" token. */
const OLD_BLACK_SWATCH = '#1f2530';

type LegacyNotebook = Omit<Notebook, 'folderId' | 'order'> & {
  template?: string;
  folderId?: string | null;
  order?: number;
};
type MaybeMigratedPage = Omit<Page, 'paper'> & { paper?: Paper };
type MaybeMigratedElement = Omit<PageElement, 'rotation'> & { rotation?: number };

interface MigratableData {
  notebooks: LegacyNotebook[];
  pages: MaybeMigratedPage[];
  strokes: Stroke[];
  elements: MaybeMigratedElement[];
  folders: Folder[];
  dividers: Divider[];
}

function legacyPaper(template: string | undefined): Paper {
  const t: PaperTemplate = template === 'lined' ? 'ruled' : template === 'grid' ? 'grid' : 'blank';
  return { template: t, spacing: 'medium', color: 'white' };
}

export interface MigrationResult {
  /** page ids whose `paper` was (re)computed — persist via putPage */
  pagesChanged: string[];
  /** page ids with a migrated stroke colour — persist via replacePageStrokes */
  strokePagesChanged: string[];
  /** page ids with a normalised element — persist via replacePageElements */
  elementPagesChanged: string[];
  /** notebook ids that gained folderId / order — persist via putNotebook */
  notebooksChanged: string[];
}

/**
 * Upgrades pre-v4 records in place. Idempotent.
 *   - v1 → v2: copies each notebook's old `template` onto every one of its pages
 *     as a `paper` object, and drops the notebook field. Pages that already have
 *     `paper` are left alone.
 *   - v2 → v3: strokes whose `color` exactly equals the old fixed-black swatch
 *     become the `"auto"` token.
 *   - v3 → v4: elements are new; a backup without an `elements` array simply has
 *     none (the caller defaults it to `[]`). Any element missing `rotation`
 *     gets `0`, so every renderer/hit-test can rely on the field.
 *   - v5 → v6: notebooks without `folderId` go to the root (`null`); notebooks
 *     without `order` are numbered most-recently-edited first, so the list
 *     looks exactly as it did before manual ordering existed. Folders whose
 *     parent no longer exists, and notebooks/dividers whose folder no longer
 *     exists, are moved to the root.
 */
export function migrateToCurrent(d: MigratableData): MigrationResult {
  const templateByNotebook = new Map<string, string | undefined>();
  for (const n of d.notebooks) {
    templateByNotebook.set(n.id, n.template);
    delete n.template;
  }
  const pagesChanged: string[] = [];
  for (const p of d.pages) {
    if (!p.paper) {
      p.paper = legacyPaper(templateByNotebook.get(p.notebookId));
      pagesChanged.push(p.id);
    }
  }

  const strokePagesChanged = new Set<string>();
  for (const s of d.strokes) {
    if (s.color === OLD_BLACK_SWATCH) {
      s.color = AUTO_COLOR;
      strokePagesChanged.add(s.pageId);
    }
  }

  const elementPagesChanged = new Set<string>();
  for (const e of d.elements) {
    if (typeof e.rotation !== 'number' || !Number.isFinite(e.rotation)) {
      e.rotation = 0;
      elementPagesChanged.add(e.pageId);
    }
  }

  const folderIds = new Set(d.folders.map((f) => f.id));
  for (const f of d.folders) if (f.parentId != null && !folderIds.has(f.parentId)) f.parentId = null;
  for (const dv of d.dividers) if (dv.folderId != null && !folderIds.has(dv.folderId)) dv.folderId = null;

  const notebooksChanged = new Set<string>();
  const unordered = d.notebooks.filter((n) => typeof n.order !== 'number' || !Number.isFinite(n.order));
  unordered.sort((a, b) => b.updatedAt - a.updatedAt);
  unordered.forEach((n, i) => {
    n.order = i;
    notebooksChanged.add(n.id);
  });
  for (const n of d.notebooks) {
    if (n.folderId === undefined || (n.folderId != null && !folderIds.has(n.folderId))) {
      n.folderId = null;
      notebooksChanged.add(n.id);
    }
  }

  return {
    pagesChanged,
    strokePagesChanged: [...strokePagesChanged],
    elementPagesChanged: [...elementPagesChanged],
    notebooksChanged: [...notebooksChanged],
  };
}

let dbp: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('notebooks')) {
        db.createObjectStore('notebooks', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('pages')) {
        db.createObjectStore('pages', { keyPath: 'id' }).createIndex('notebookId', 'notebookId');
      }
      if (!db.objectStoreNames.contains('strokes')) {
        db.createObjectStore('strokes', { keyPath: 'id' }).createIndex('pageId', 'pageId');
      }
      if (!db.objectStoreNames.contains('elements')) {
        db.createObjectStore('elements', { keyPath: 'id' }).createIndex('pageId', 'pageId');
      }
      if (!db.objectStoreNames.contains('folders')) {
        db.createObjectStore('folders', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('dividers')) {
        db.createObjectStore('dividers', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('assets')) {
        db.createObjectStore('assets', { keyPath: 'id' }).createIndex('notebookId', 'notebookId');
      }
      if (!db.objectStoreNames.contains('aiConversations')) {
        db.createObjectStore('aiConversations', { keyPath: 'id' }).createIndex('notebookId', 'notebookId');
      }
      // v6: branched AI-mode threads — an entry's `branchedFromEntryId` looks
      // up every entry in the thread it started (see getThreadEntries). The
      // store already exists on an upgrade from v5, so the index is added to
      // it via the upgrade transaction rather than createObjectStore, which
      // only applies to a store being created fresh in this same upgrade.
      const aiConversations = req.transaction!.objectStore('aiConversations');
      if (!aiConversations.indexNames.contains('branchedFromEntryId')) {
        aiConversations.createIndex('branchedFromEntryId', 'branchedFromEntryId');
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function reqP<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

function txDone(t: IDBTransaction): Promise<void> {
  return new Promise((res, rej) => {
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}

/**
 * Deletes every record matching `key` on `indexName`. Returns a promise that
 * resolves once the cursor has exhausted all matches — callers that also `put`
 * records under the same keys in the same transaction (e.g. `replacePageStrokes`,
 * rewriting a record whose id is unchanged) must await this first, or the put can
 * race the cursor's own delete/continue chain and the record ends up dropped
 * instead of replaced.
 */
function deleteByIndex(store: IDBObjectStore, indexName: string, key: IDBValidKey): Promise<void> {
  return new Promise((resolve, reject) => {
    const cur = store.index(indexName).openCursor(IDBKeyRange.only(key));
    cur.onsuccess = () => {
      const c = cur.result;
      if (c) {
        c.delete();
        c.continue();
      } else {
        resolve();
      }
    };
    cur.onerror = () => reject(cur.error);
  });
}

export interface LoadedData {
  notebooks: Notebook[];
  pages: Page[];
  strokes: Stroke[];
  elements: PageElement[];
  folders: Folder[];
  dividers: Divider[];
}

/** Everything the in-memory model holds. Assets (PDF bytes) are deliberately not loaded here; they're fetched on demand. */
const MODEL_STORES = ['notebooks', 'pages', 'strokes', 'elements', 'folders', 'dividers'] as const;
const ALL_STORES = [...MODEL_STORES, 'assets'] as const;

export async function loadAll(): Promise<LoadedData> {
  const db = await openDB();
  const t = db.transaction([...MODEL_STORES], 'readonly');
  const [notebooks, pages, strokes, elements, folders, dividers] = await Promise.all([
    reqP(t.objectStore('notebooks').getAll() as IDBRequest<Notebook[]>),
    reqP(t.objectStore('pages').getAll() as IDBRequest<Page[]>),
    reqP(t.objectStore('strokes').getAll() as IDBRequest<Stroke[]>),
    reqP(t.objectStore('elements').getAll() as IDBRequest<PageElement[]>),
    reqP(t.objectStore('folders').getAll() as IDBRequest<Folder[]>),
    reqP(t.objectStore('dividers').getAll() as IDBRequest<Divider[]>),
  ]);
  return { notebooks, pages, strokes, elements, folders, dividers };
}

export async function putNotebook(n: Notebook): Promise<void> {
  const db = await openDB();
  const t = db.transaction('notebooks', 'readwrite');
  t.objectStore('notebooks').put(n);
  return txDone(t);
}

export async function putFolder(f: Folder): Promise<void> {
  const db = await openDB();
  const t = db.transaction('folders', 'readwrite');
  t.objectStore('folders').put(f);
  return txDone(t);
}

export async function deleteFolderRecord(id: string): Promise<void> {
  const db = await openDB();
  const t = db.transaction('folders', 'readwrite');
  t.objectStore('folders').delete(id);
  return txDone(t);
}

export async function putDivider(d: Divider): Promise<void> {
  const db = await openDB();
  const t = db.transaction('dividers', 'readwrite');
  t.objectStore('dividers').put(d);
  return txDone(t);
}

export async function deleteDividerRecord(id: string): Promise<void> {
  const db = await openDB();
  const t = db.transaction('dividers', 'readwrite');
  t.objectStore('dividers').delete(id);
  return txDone(t);
}

// ------------------------------------------------------------------ assets
/** Writes an asset immediately (not through the debounced autosave — the bytes are large and written once). */
export async function putAsset(a: PdfAsset): Promise<void> {
  const db = await openDB();
  const t = db.transaction('assets', 'readwrite');
  t.objectStore('assets').put(a);
  return txDone(t);
}

export async function getAsset(id: string): Promise<PdfAsset | undefined> {
  const db = await openDB();
  const t = db.transaction('assets', 'readonly');
  return reqP(t.objectStore('assets').get(id) as IDBRequest<PdfAsset | undefined>);
}

// ------------------------------------------------------------ AI conversation
/** Writes one AI-mode chat entry immediately — same reasoning as putAsset: it carries an image, written once, not through the debounced autosave. */
export async function putAiEntry(e: AiConversationEntry): Promise<void> {
  const db = await openDB();
  const t = db.transaction('aiConversations', 'readwrite');
  t.objectStore('aiConversations').put(e);
  return txDone(t);
}

/** A notebook's AI-mode chat history, oldest first — main-conversation and thread entries mixed; callers split on `branchedFromEntryId` (see AiMode.loadConversation). */
export async function getAiEntries(notebookId: string): Promise<AiConversationEntry[]> {
  const db = await openDB();
  const t = db.transaction('aiConversations', 'readonly');
  const rows = await reqP(
    t.objectStore('aiConversations').index('notebookId').getAll(IDBKeyRange.only(notebookId)) as IDBRequest<
      AiConversationEntry[]
    >
  );
  return rows.sort((a, b) => a.createdAt - b.createdAt);
}

/** One branched thread's own entries, oldest first — everything sharing `branchedFromEntryId` (the id of the main-conversation entry it branched from; see AiConversationEntry's doc comment). */
export async function getThreadEntries(branchedFromEntryId: string): Promise<AiConversationEntry[]> {
  const db = await openDB();
  const t = db.transaction('aiConversations', 'readonly');
  const rows = await reqP(
    t.objectStore('aiConversations').index('branchedFromEntryId').getAll(IDBKeyRange.only(branchedFromEntryId)) as IDBRequest<
      AiConversationEntry[]
    >
  );
  return rows.sort((a, b) => a.createdAt - b.createdAt);
}

/** Clears one notebook's AI-mode chat history ("clear conversation" in the panel). */
export async function clearAiEntries(notebookId: string): Promise<void> {
  const db = await openDB();
  const t = db.transaction('aiConversations', 'readwrite');
  await deleteByIndex(t.objectStore('aiConversations'), 'notebookId', notebookId);
  return txDone(t);
}

function bytesToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function base64ToBytes(b64: string): ArrayBuffer {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out.buffer;
}

export async function putPage(p: Page): Promise<void> {
  const db = await openDB();
  const t = db.transaction('pages', 'readwrite');
  t.objectStore('pages').put(p);
  return txDone(t);
}

/** Replaces every stroke belonging to a page in one transaction. */
export async function replacePageStrokes(pageId: string, strokes: Stroke[]): Promise<void> {
  const db = await openDB();
  const t = db.transaction('strokes', 'readwrite');
  const store = t.objectStore('strokes');
  // must finish before the puts below: some of `strokes` may reuse ids that are
  // about to be deleted (e.g. a migrated or otherwise-rewritten stroke) — see
  // deleteByIndex's doc comment.
  await deleteByIndex(store, 'pageId', pageId);
  for (const s of strokes) store.put(s);
  return txDone(t);
}

/** Replaces every element belonging to a page in one transaction. */
export async function replacePageElements(pageId: string, elements: PageElement[]): Promise<void> {
  const db = await openDB();
  const t = db.transaction('elements', 'readwrite');
  const store = t.objectStore('elements');
  await deleteByIndex(store, 'pageId', pageId); // same-key rewrites — see deleteByIndex
  for (const e of elements) store.put(e);
  return txDone(t);
}

export async function deletePageCascade(pageId: string): Promise<void> {
  const db = await openDB();
  const t = db.transaction(['pages', 'strokes', 'elements'], 'readwrite');
  t.objectStore('pages').delete(pageId);
  // no same-key put follows either delete; txDone awaits them
  void deleteByIndex(t.objectStore('strokes'), 'pageId', pageId);
  void deleteByIndex(t.objectStore('elements'), 'pageId', pageId);
  return txDone(t);
}

export async function deleteNotebookCascade(notebookId: string): Promise<void> {
  const db = await openDB();

  // Collect page ids first (readonly), then delete everything in one write txn
  // without awaiting between requests (which would close the transaction).
  const ro = db.transaction('pages', 'readonly');
  const pageIds: string[] = await new Promise((res, rej) => {
    const ids: string[] = [];
    const cur = ro.objectStore('pages').index('notebookId').openCursor(IDBKeyRange.only(notebookId));
    cur.onsuccess = () => {
      const c = cur.result;
      if (c) {
        ids.push((c.value as Page).id);
        c.continue();
      } else {
        res(ids);
      }
    };
    cur.onerror = () => rej(cur.error);
  });

  // aiConversations is deliberately not in ALL_STORES (kept out of backups/import-clear),
  // so it's added explicitly here — a deleted notebook must still take its chat history with it.
  const t = db.transaction([...ALL_STORES, 'aiConversations'], 'readwrite');
  t.objectStore('notebooks').delete(notebookId);
  const pages = t.objectStore('pages');
  const strokes = t.objectStore('strokes');
  const elements = t.objectStore('elements');
  for (const pid of pageIds) {
    pages.delete(pid);
    // no same-key put follows either delete; txDone awaits them
    void deleteByIndex(strokes, 'pageId', pid);
    void deleteByIndex(elements, 'pageId', pid);
  }
  void deleteByIndex(t.objectStore('assets'), 'notebookId', notebookId);
  void deleteByIndex(t.objectStore('aiConversations'), 'notebookId', notebookId);
  return txDone(t);
}

export async function exportAll(): Promise<Backup> {
  const { notebooks, pages, strokes, elements, folders, dividers } = await loadAll();
  const db = await openDB();
  const raw = await reqP(db.transaction('assets', 'readonly').objectStore('assets').getAll() as IDBRequest<PdfAsset[]>);
  const assets: BackupAsset[] = raw.map(({ data, ...meta }) => ({ ...meta, dataBase64: bytesToBase64(data) }));
  return {
    app: 'noteapp',
    version: FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    notebooks,
    pages,
    strokes,
    elements,
    folders,
    dividers,
    assets,
  };
}

export async function importAll(b: Backup): Promise<void> {
  if (!b || b.app !== 'noteapp' || !Array.isArray(b.notebooks)) {
    throw new Error('That file is not a DubNotes backup.');
  }
  const notebooks = b.notebooks as LegacyNotebook[];
  const pages = b.pages ?? [];
  const strokes = b.strokes ?? [];
  const elements = b.elements ?? []; // pre-v4 backups have no elements
  const folders = b.folders ?? []; // pre-v6 backups have no folders / dividers
  const dividers = b.dividers ?? [];
  const assets: PdfAsset[] = (b.assets ?? []).map(({ dataBase64, ...meta }) => ({
    ...meta,
    data: base64ToBytes(dataBase64),
  })); // pre-v7 backups have no assets
  migrateToCurrent({ notebooks, pages, strokes, elements, folders, dividers }); // upgrade older backups in place

  const db = await openDB();
  const t = db.transaction([...ALL_STORES], 'readwrite');
  for (const name of ALL_STORES) t.objectStore(name).clear();
  for (const n of notebooks) t.objectStore('notebooks').put(n);
  for (const p of pages) t.objectStore('pages').put(p);
  for (const s of strokes) t.objectStore('strokes').put(s);
  for (const e of elements) t.objectStore('elements').put(e);
  for (const f of folders) t.objectStore('folders').put(f);
  for (const d of dividers) t.objectStore('dividers').put(d);
  for (const a of assets) t.objectStore('assets').put(a);
  return txDone(t);
}
