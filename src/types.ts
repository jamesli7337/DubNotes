/** Per-page paper. `template` is drawn separately from content and never stored
 *  as strokes; ruling/background colours are derived from `color` at render time. */
export type PaperTemplate = 'blank' | 'ruled' | 'grid' | 'dot';
export type PaperSpacing = 'narrow' | 'medium' | 'wide';
export type PaperColor = 'white' | 'cream' | 'dark';

export interface Paper {
  template: PaperTemplate;
  spacing: PaperSpacing;
  color: PaperColor;
}

/** A single ink stroke, stored as raw input points: [x, y, pressure]. */
export interface Stroke {
  id: string;
  pageId: string;
  notebookId: string;
  tool: 'pen' | 'highlighter';
  color: string;
  size: number;
  points: number[][];
  createdAt: number;
}

/**
 * Non-ink page content. Every element is a box in page units (`x`, `y` is the
 * top-left corner *before* rotation; `rotation` is radians about the box centre)
 * and shares the page's z-order with strokes via `createdAt`.
 */
interface ElementBase {
  id: string;
  pageId: string;
  notebookId: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  createdAt: number;
}

export interface TextElement extends ElementBase {
  kind: 'text';
  text: string;
  /** a CSS colour or the "auto" token, resolved like stroke ink */
  color: string;
  /** page units; scales with the box */
  fontSize: number;
  /**
   * Optional tint painted behind the text (a CSS colour, e.g. `rgba(...)`) —
   * absent for ordinary user-typed text. Used for AI-mode replies so they read
   * as "not the user's ink" at a glance; never resolved through
   * `resolveInkColor` like `color` is, since it's meant to stay constant
   * regardless of paper colour. (v8)
   */
  bg?: string;
}

export interface ImageElement extends ElementBase {
  kind: 'image';
  /** data: URL — the image is stored inline so backups stay self-contained */
  src: string;
}

export type ShapeKind = 'line' | 'arrow' | 'rect' | 'ellipse' | 'triangle';

export interface ShapeElement extends ElementBase {
  kind: 'shape';
  shape: ShapeKind;
  color: string;
  /** outline width in page units */
  size: number;
  /** polygon shapes (triangle): vertices as fractions of the box, `[[0..1, 0..1], …]` */
  pts?: number[][];
}

/**
 * A strip that covers whatever is under it, for self-quizzing: tap to peel it
 * back and reveal, tap again to cover. Whether it is currently peeled is view
 * state only — every tape is covering again after a reload.
 */
export interface TapeElement extends ElementBase {
  kind: 'tape';
  color: string;
}

/**
 * A mind-map bubble (v10): the clean outline a loop drawn around content snaps
 * into, which then owns what the loop enclosed. Boards only — nothing in a
 * paged notebook creates one.
 *
 * The element's own box **is** the outline: an ellipse inscribed in it, or a
 * rounded rectangle filling it. That is deliberate — every existing box helper
 * (`itemBounds`, `elementCorners`, `pointInElement`, the board's spatial index)
 * applies unchanged, and there is no second polygon to keep in step with the
 * box. `bubblePolygon` (canvas/geom.ts) is the one place that turns the box
 * into a ring, for hit-testing and containment.
 *
 * `rotation` is always 0: membership, the outline and the move set all read the
 * plain box, so rotating a bubble is forbidden rather than supported — see
 * `transformItems` (which pins it) and `selectionView` (which hides the grip).
 */
export interface BubbleElement extends ElementBase {
  kind: 'bubble';
  /** which clean shape the drawn loop was fitted to */
  outline: 'ellipse' | 'roundrect';
  /** a CSS colour or the "auto" token, resolved like stroke ink */
  color: string;
  /** outline width in board units */
  size: number;
  /**
   * What this bubble owns, by item id — **advisory**, never authoritative on
   * its own. Erasing a member or undoing past its creation leaves ids here
   * pointing at items that no longer exist, so every read resolves them
   * through the store and silently drops what is gone (see
   * `BoardCanvas.bubbleMoveSet`); stale ids are pruned the next time the
   * bubble is written for a real reason.
   *
   * Direct members only. A nested bubble keeps its own list, and an outer
   * bubble's move resolves them transitively.
   */
  members: string[];
}

/** Which side of a bubble a connector is anchored to — the four revealed nodes. */
export type BubbleNode = 'n' | 'e' | 's' | 'w';

/**
 * A line joining two mind-map bubbles (v11). Boards only.
 *
 * What is *authoritative* is the two anchors: a bubble id and which of its
 * nodes. `ax`/`ay`/`bx`/`by` are a cache of where those anchors currently
 * resolve to, and `x`/`y`/`w`/`h` the bounding box of that pair — both derived,
 * both stored anyway, because the board's spatial index and its viewport
 * culling work on an item's bounds and a connector with no bounds of its own
 * would be invisible to them (and so would never repaint, or would be found
 * nowhere near where it is drawn). `restitchConnectors` is the one place that
 * recomputes them, and it runs inside the same transform — and the same
 * `replace-items` op — as the move that invalidated them.
 *
 * `rotation` is always 0: the box is a bounding box, not an oriented frame.
 */
export interface ConnectorElement extends ElementBase {
  kind: 'connector';
  a: { bubbleId: string; node: BubbleNode };
  b: { bubbleId: string; node: BubbleNode };
  /** a CSS colour or the "auto" token, resolved like stroke ink */
  color: string;
  /** line width in board units */
  size: number;
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

export type PageElement =
  | TextElement
  | ImageElement
  | ShapeElement
  | TapeElement
  | BubbleElement
  | ConnectorElement;

/** Anything that lives on a page and can be selected: a stroke or an element. */
export type PageItem = Stroke | PageElement;

/**
 * What is shown under a page's ink: either a pre-rendered image (`src`, format
 * v5) or one page of a stored PDF asset rendered on demand (v7).
 */
export type PageBackground = { src: string; assetId?: undefined } | { assetId: string; page: number; src?: undefined };

/** A file stored once per notebook (currently only imported PDFs), rendered on demand. */
export interface PdfAsset {
  id: string;
  notebookId: string;
  kind: 'pdf';
  name: string;
  pages: number;
  /** the PDF bytes */
  data: ArrayBuffer;
}

/** How an asset travels in a backup file: the bytes as base64. */
export interface BackupAsset extends Omit<PdfAsset, 'data'> {
  dataBase64: string;
}

/**
 * One of a notebook's AI-mode chats — a separate conversation whose turns
 * (`AiConversationEntry.chatId`) are sent to Gemini as each other's history.
 * Not part of the backup format, same as its entries.
 */
export interface AiChat {
  id: string;
  notebookId: string;
  /** the first transcript, truncated; '' until a turn has one */
  title: string;
  createdAt: number;
  /** bumped by every persisted turn — the switcher's order and the default chat */
  updatedAt: number;
}

/**
 * One resolved turn of an AI-mode conversation — the captured question (as a
 * thumbnail), its transcript and Gemini's reply, or an error in its place.
 * Stored per chat, independent of any page's content; not part of the backup
 * format (see DATA_FORMAT.md) since it's chat history, not page data.
 */
export interface AiConversationEntry {
  id: string;
  notebookId: string;
  /** the `AiChat` this turn belongs to */
  chatId: string;
  /** the (first) page the turn was captured from — only used to label the entry; the page itself is untouched */
  pageId: string;
  /** every page a multi-page turn was captured from, in page order — label only; absent on single-page entries from before turns spanned pages */
  pageIds?: string[];
  /** data: URL — a small JPEG of the turn's question crops, stacked one per page (entries from before chats existed hold the whole-page capture instead) */
  thumbnail: string;
  /** Gemini's text rendering of the question (plus the page content it refers
   * to) — what stands in for this turn's images in later turns' history.
   * Absent on error turns and on entries from before chats existed, which are
   * therefore never sent as history. */
  transcript?: string;
  text: string;
  isError: boolean;
  createdAt: number;
}

export interface Page {
  id: string;
  notebookId: string;
  index: number;
  paper: Paper;
  /** fitted inside the page, centred, drawn over the paper and under all content */
  background?: PageBackground;
  /** This page's own size in page units, when it differs from the app's
   *  default portrait page (see PAGE_W/PAGE_H in const.ts) — set for a page
   *  imported from a PDF page with a non-default aspect ratio, so it can be
   *  full-bleed without cropping. Undefined (the common case) means the
   *  default size; read through `pageW`/`pageH` (const.ts), never these
   *  fields directly, so the fallback stays in one place. */
  w?: number;
  h?: number;
  /**
   * Board chunks only (v9): which cell of the board's persistence grid this
   * record holds, `col = floor(x / BOARD_CHUNK)`. Present together or not at
   * all; a page in an ordinary notebook has neither.
   *
   * A chunk exists purely so a board's items are written in bounded batches —
   * `replacePageStrokes` rewrites every stroke of one record, so a single
   * record per board would rewrite the whole board on every autosave. It is
   * *not* a coordinate space: items in a chunk keep their global board
   * coordinates, and which chunk an item lands in is decided once, from its
   * bounding box origin, and never affects how it draws or hit-tests.
   */
  col?: number;
  row?: number;
  createdAt: number;
  updatedAt: number;
}

/** Built-in cover patterns; drawn procedurally in the cover colour (no image assets). */
export type CoverPattern = 'dots' | 'grid' | 'stripes' | 'waves' | 'chevron';

export interface NotebookCover {
  /** CSS colour */
  color: string;
  pattern?: CoverPattern;
}

export interface Notebook {
  id: string;
  name: string;
  /**
   * What this notebook *is* (v9). Absent (the overwhelming case) means the
   * original paged notebook, so nothing older needs migrating.
   *
   * A `'board'` is one unbounded canvas instead of a run of pages: its items
   * carry global board coordinates and are never remapped, and its `Page`
   * records are storage chunks (see `Page.col`/`row`), not things the user
   * ever sees or orders.
   */
  kind?: 'pages' | 'board';
  /** containing folder; `null` = the library root (v6) */
  folderId: string | null;
  /** manual position within its folder's list, ascending (v6) */
  order: number;
  cover?: NotebookCover;
  createdAt: number;
  updatedAt: number;
}

/** A folder holds notebooks and other folders (v6). */
export interface Folder {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * A labelled marker between notebooks in a folder's list, for visual grouping
 * only — it contains nothing (v6). Shares the folder's `order` sequence with
 * its notebooks.
 */
export interface Divider {
  id: string;
  folderId: string | null;
  label: string;
  order: number;
  createdAt: number;
}

/** Shape of the single-file JSON export/import. */
export interface Backup {
  app: 'noteapp';
  version: number;
  exportedAt: string;
  notebooks: Notebook[];
  pages: Page[];
  strokes: Stroke[];
  /** absent in backups older than format v4 */
  elements?: PageElement[];
  /** absent in backups older than format v6 */
  folders?: Folder[];
  dividers?: Divider[];
  /** absent in backups older than format v7 */
  assets?: BackupAsset[];
}
