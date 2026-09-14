# DubNotes data format

All data lives on-device in IndexedDB database **`noteapp`**, currently at
**schema version `5`**: object stores `notebooks`, `pages`, `strokes`,
`elements`, `folders`, `dividers`, `assets`, `aiConversations`, `meta` (schema
`4` added `assets`; `5` added `aiConversations`). The logical **format
version** is tracked separately as `FORMAT_VERSION` in
[`src/db.ts`](src/db.ts) and is currently **`8`** — see "AI conversation"
below for why `aiConversations` doesn't bump it.

## Entities

### Notebook

| field       | type            | notes                                             |
| ----------- | --------------- | ------------------------------------------------- |
| `id`        | string          | uuid                                              |
| `name`      | string          |                                                   |
| `folderId`  | string \| null  | containing folder; `null` = library root (v6)     |
| `order`     | number          | manual position in its folder's list, ascending (v6) |
| `cover`     | `{ color, pattern? }`? | optional cover: CSS colour + built-in pattern (v6) |
| `createdAt` | number          | epoch ms                                          |
| `updatedAt` | number          | epoch ms, bumped on any change                    |

Stored in the `notebooks` object store, keyed by `id`.

`cover.pattern` is one of `dots | grid | stripes | waves | chevron`; patterns
are drawn procedurally in the cover colour, so no image data is stored.

> **v1 → v2:** the `template` field was removed from Notebook and moved onto each
> Page as `paper` (see migration below).

### Folder (v6)

| field       | type           | notes                                  |
| ----------- | -------------- | -------------------------------------- |
| `id`        | string         | uuid                                   |
| `name`      | string         |                                        |
| `parentId`  | string \| null | parent folder; `null` = library root   |
| `createdAt` | number         | epoch ms                               |
| `updatedAt` | number         | epoch ms                               |

Stored in the `folders` object store, keyed by `id`. Folders nest to any
depth. Deleting a folder moves everything inside it (notebooks, dividers,
subfolders) to its parent — nothing is deleted with it.

### Divider (v6)

| field       | type           | notes                                            |
| ----------- | -------------- | ------------------------------------------------ |
| `id`        | string         | uuid                                             |
| `folderId`  | string \| null | the folder whose list it appears in              |
| `label`     | string         |                                                  |
| `order`     | number         | position in that list, same sequence as notebooks |
| `createdAt` | number         | epoch ms                                         |

Stored in the `dividers` object store, keyed by `id`. A divider is a labelled
marker between notebooks — visual grouping only; it contains nothing, and
deleting it affects no notebook.

**List order:** within a folder, notebooks and dividers share one manual
`order` sequence (0, 1, 2 …, renumbered after every insert / move). New
notebooks go to the top; "move up / move down" swaps neighbours.

### Page

| field        | type            | notes                                   |
| ------------ | --------------- | --------------------------------------- |
| `id`         | string          | uuid                                    |
| `notebookId` | string          | owning notebook                         |
| `index`      | number          | 0-based position within the notebook    |
| `paper`      | `Paper`         | per-page paper settings (see below)     |
| `background` | `{ src }`?      | optional rendered page image (v5)       |
| `createdAt`  | number          | epoch ms                                |
| `updatedAt`  | number          | epoch ms                                |

Stored in the `pages` object store, keyed by `id`, with an index on `notebookId`.

**`background`** is drawn over the paper fill and under everything else,
fitted inside the 820×1060 page and centred; it is never ink and cannot be
selected or erased. A page with a background counts as *content* for the
trailing-blank rule and the library page count. Two forms:

- `{ src }` (v5): a `data:` URL of a pre-rendered page image. Still valid.
- `{ assetId, page }` (v7): page number `page` (1-based) of the PDF stored as
  asset `assetId`, rendered on demand when the page scrolls into view (a small
  in-memory cache of rendered pages; nothing rasterised is stored). This is
  what PDF import writes now.

### Asset (v7)

| field        | type          | notes                                      |
| ------------ | ------------- | ------------------------------------------ |
| `id`         | string        | uuid                                       |
| `notebookId` | string        | owning notebook; deleted with it           |
| `kind`       | `'pdf'`       |                                            |
| `name`       | string        | original file name                         |
| `pages`      | number        | page count                                 |
| `data`       | ArrayBuffer   | the PDF bytes (in a backup: `dataBase64`)  |

Stored in the `assets` object store, keyed by `id`, with an index on
`notebookId`. Assets are **not** loaded into memory on start; they are read
when a page needs rendering. Backups carry each asset once, base64-encoded, so
a 100-page PDF costs its own file size rather than one image per page.

### AI conversation (schema v5)

| field        | type    | notes                                                |
| ------------ | ------- | ----------------------------------------------------- |
| `id`         | string  | uuid                                                  |
| `notebookId` | string  | owning notebook; deleted with it                      |
| `pageId`     | string  | the page the turn was captured from — label only, the page's own content is untouched |
| `thumbnail`  | string  | `data:` URL of the captured region, reused from what was sent to Gemini |
| `text`       | string  | Gemini's reply, cleaned of Markdown (or an error message) |
| `isError`    | boolean | true if `text` is an error, not a real reply          |
| `createdAt`  | number  | epoch ms; also the panel's display order              |

Stored in the `aiConversations` object store, keyed by `id`, with an index on
`notebookId`; read/written directly by `src/ai-mode.ts` (`putAiEntry` /
`getAiEntries` / `clearAiEntries` in `src/db.ts`), not through the `Store`
class other data goes through. **Deliberately excluded from `ALL_STORES`**,
so it is untouched by backup export/import (`Backup` has no
`aiConversations` field) — it's chat history, not notebook content, and
importing a backup should not silently wipe every notebook's AI
conversations. It's still deleted along with its notebook
(`deleteNotebookCascade`), and clearable per notebook from the AI panel
("Clear conversation").

**Trailing-blank invariant:** every notebook always ends with exactly one blank
page (a page with no strokes). The app appends or removes trailing blank pages to
maintain this after every content change; these structural adjustments are not
undoable. A blank page in the *middle* of a notebook is left untouched.

### Paper (per page)

```ts
interface Paper {
  template: 'blank' | 'ruled' | 'grid' | 'dot';
  spacing: 'narrow' | 'medium' | 'wide'; // ruling / dot pitch
  color: 'white' | 'cream' | 'dark';
}
```

- The template is **drawn separately from content** — into the page's committed-ink
  cache canvas, never stored as strokes, never exported as strokes.
- Background fill and ruling colour are **derived from `color`** at render time
  (see `PAPER_INK` in [`src/canvas/templates.ts`](src/canvas/templates.ts)), so
  ruling stays visible on dark paper.
- A new page copies the `paper` of the page before it; the first page of a new
  notebook uses `DEFAULT_PAPER` (`{ template: 'blank', spacing: 'medium', color: 'white' }`).
- The per-page **Paper** menu edits these three settings with a **this page /
  all pages** scope, and also holds **delete page**.

### Stroke

| field        | type         | notes                                   |
| ------------ | ------------ | --------------------------------------- |
| `id`         | string       | uuid                                    |
| `pageId`     | string       | owning page                             |
| `notebookId` | string       | owning notebook                         |
| `tool`       | `'pen' \| 'highlighter'` |                             |
| `color`      | string       | a CSS colour, **or** the token `"auto"` |
| `size`       | number       | nib width in page units                 |
| `points`     | `number[][]` | raw input samples, each `[x, y, pressure]` in the fixed 820×1060 page space |
| `createdAt`  | number       | epoch ms, also the draw order           |

Stored in the `strokes` object store, keyed by `id`, with an index on `pageId`.
A stroke belongs to the page the pointer went down on. Strokes are clipped to the
page **visually** (the page element is `overflow: hidden`); point data is not
truncated.

**`color: "auto"`** (the pen's first swatch) is stored as the literal string
`"auto"`, never resolved to a hex value at rest. It is resolved to a concrete
colour only at render time, from the *page the stroke lives on* — see
`resolveInkColor()` in [`src/canvas/freehand.ts`](src/canvas/freehand.ts):
dark ink (`#1f2530`) on white/cream paper, light ink (`#f5f4ef`) on dark paper.
Every place that paints a stroke (the live in-progress stroke, the committed
cache, and thumbnail rendering) calls the same resolver, so a stroke's visible
colour always tracks its page's current paper colour, including after the paper
is changed later. `HI_COLORS` (highlighter) has no `"auto"` entry — only the pen
palette does.

> **v2 → v3:** added the `"auto"` colour token (see migration below). No field
> shape changes.

### Elements (text, image, shape)

Non-ink content lives in the `elements` object store, keyed by `id`, with an
index on `pageId`. Every element is a **box in page units** and shares these
fields:

| field        | type     | notes                                                        |
| ------------ | -------- | ------------------------------------------------------------ |
| `id`         | string   | uuid                                                         |
| `pageId`     | string   | owning page                                                  |
| `notebookId` | string   | owning notebook                                              |
| `kind`       | `'text' \| 'image' \| 'shape' \| 'tape'` |                                      |
| `x`, `y`     | number   | top-left corner of the box **before** rotation               |
| `w`, `h`     | number   | box size                                                     |
| `rotation`   | number   | radians, about the box centre (`0` for most elements)        |
| `createdAt`  | number   | epoch ms; also the z-order, shared with strokes              |

Per kind:

```ts
interface TextElement  { kind: 'text';  text: string; color: string; fontSize: number; bg?: string }
interface ImageElement { kind: 'image'; src: string /* data: URL, stored inline */ }
interface ShapeElement { kind: 'shape'; shape: 'line' | 'arrow' | 'rect' | 'ellipse' | 'triangle';
                         color: string; size: number /* outline width */;
                         pts?: number[][] /* triangle: vertices as fractions of the box */ }
interface TapeElement  { kind: 'tape';  color: string }   // v5
```

- A **tape** is an opaque strip that covers whatever is under it (for
  self-quizzing). Whether a strip is currently *peeled back* is view state
  only — it is not stored, so every strip is covering again after a reload.
- **Images** store their pixels inline as a `data:` URL (downscaled to at most
  1600 px on the long edge when inserted), so a backup file is self-contained.

- **z-order** is one sequence per page: strokes and elements are painted
  interleaved in `createdAt` order, so whatever was added last is on top.
- `color` on text and shapes takes the same values as a stroke's — a CSS colour
  or `"auto"` — and is resolved through the same `resolveInkColor()`.
- Text wraps inside `w`; `h` is recomputed from the wrapped text whenever the
  text or the box changes, and `fontSize` scales with the box on a corner drag.
- `TextElement.bg` (v8) is an optional tint painted as a rounded card behind
  the text, extending slightly beyond the box. Unlike `color`, it is a literal
  CSS colour only — never `"auto"`, never resolved per-paper — since it's
  meant to stand out from the page consistently. Set by AI mode's replies;
  absent on ordinary user-typed text.
- A line/arrow runs along the box's horizontal centre-line, from `x` to
  `x + w`; its angle is the box `rotation`.
- Elements are **selected, moved, resized, copied and deleted** through the
  lasso tool alongside strokes; all of that is undoable.

> **v3 → v4:** elements added (new object store, new top-level backup array).
> Backups without an `elements` array are read as having none.
>
> **v4 → v5:** `Page.background` and the `tape` element kind. Both optional;
> nothing to migrate.
>
> **v5 → v6:** folders, dividers, `Notebook.folderId` / `order` / `cover`
> (see migration below).
>
> **v6 → v7:** `assets` (stored PDFs), `Page.background = { assetId, page }`,
> and the `triangle` shape. All additive; nothing to migrate.
>
> **v7 → v8:** `TextElement.bg` (optional tint, used by AI-mode replies).
> Additive; nothing to migrate.

## Migration

Run on **every load** (`store.init`) and on **backup import** (`importAll`), by
`migrateToCurrent()` in [`src/db.ts`](src/db.ts). It is idempotent.

Pre-v2 → v2:

1. For each notebook, read its old `template` (`'blank' | 'lined' | 'grid'`) and
   delete the field.
2. For each page without a `paper` object, set
   `paper = { template, spacing: 'medium', color: 'white' }` where `template` is
   the owning notebook's old template mapped as `lined → ruled`, `grid → grid`,
   anything else → `blank`.

Pre-v3 → v3:

3. For each stroke whose `color` is exactly `"#1f2530"` (the old fixed-black pen
   swatch), set `color = "auto"`.

Pre-v4 → v4:

4. A missing `elements` array (backups) or store (IndexedDB schema `1`, created
   on open by the schema upgrade) means no elements. Any element record without
   a numeric `rotation` gets `rotation = 0`.

Pre-v6 → v6:

5. A notebook without `folderId` goes to the root (`null`); one whose folder no
   longer exists does too. Notebooks without `order` are numbered
   most-recently-edited first (0, 1, 2 …) so the list looks as it did before
   manual ordering. A missing `folders` / `dividers` array means none; folders
   whose parent is missing, and dividers whose folder is missing, move to the
   root.

On load, records changed by the migration are marked dirty and flushed back to
IndexedDB (pages via `putPage`, notebooks via `putNotebook`, strokes via
`replacePageStrokes`, elements via `replacePageElements`, grouped by page), so
the upgrade is written through on first run.

## Backup file

`Export` writes a single JSON file; `Import` **replaces** all current data with a
backup (after migrating it).

```jsonc
{
  "app": "noteapp",
  "version": 8,                 // FORMAT_VERSION at export time
  "exportedAt": "2026-01-01T00:00:00.000Z",
  "notebooks": [ /* Notebook[] — with folderId, order, maybe cover */ ],
  "pages":     [ /* Page[]  — each includes `paper`, maybe `background` */ ],
  "strokes":   [ /* Stroke[] */ ],
  "elements":  [ /* PageElement[] — text / image / shape / tape */ ],
  "folders":   [ /* Folder[] */ ],
  "dividers":  [ /* Divider[] */ ],
  "assets":    [ /* BackupAsset[] — stored PDFs, `dataBase64` */ ]
}
```

Import accepts any `version` as long as `app === "noteapp"`; older files are
upgraded by `migrateToCurrent()` before they are written.

## Reserved for a later pass

Nothing pending. Any new entity or field bumps `FORMAT_VERSION` and gets a
migration step above.
