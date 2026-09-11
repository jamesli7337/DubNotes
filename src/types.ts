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

export type PageElement = TextElement | ImageElement | ShapeElement | TapeElement;

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

export interface Page {
  id: string;
  notebookId: string;
  index: number;
  paper: Paper;
  /** fitted inside the page, centred, drawn over the paper and under all content */
  background?: PageBackground;
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
