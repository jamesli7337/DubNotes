# DubNotes data format

All data lives on-device in IndexedDB database **`noteapp`**, currently at
**schema version `7`**: object stores `notebooks`, `pages`, `strokes`,
`elements`, `folders`, `dividers`, `assets`, `aiConversations`, `aiChats`,
`meta` (schema `4` added `assets`; `5` added `aiConversations`; `6` was a
since-removed branched-AI-thread feature's index on `aiConversations` — kept
rather than reverted, since downgrading a version number a browser may have
already upgraded past would break it from opening at all; `7` added `aiChats`
and a `chatId` index on `aiConversations`). The logical **format
version** is tracked separately as `FORMAT_VERSION` in
[`src/db.ts`](src/db.ts) and is currently **`11`** — see "AI conversation"
below for why `aiConversations`/`aiChats` don't bump it.

A notebook is one of two shapes: the original **paged** notebook, or a
**board** — one unbounded canvas whose `Page` records are storage chunks the
user never sees. Both keep their items in the same `strokes` / `elements`
stores, so nothing about backup, import or the cascade deletes is
board-specific. See "Notebook.kind and boards".

## Entities

### Notebook

| field       | type            | notes                                             |
| ----------- | --------------- | ------------------------------------------------- |
| `id`        | string          | uuid                                              |
| `name`      | string          |                                                   |
| `kind`      | `'pages' \| 'board'`? | what this notebook *is*; absent = `'pages'` (v9) |
| `folderId`  | string \| null  | containing folder; `null` = library root (v6)     |
| `order`     | number          | manual position in its folder's list, ascending (v6) |
| `cover`     | `{ color, pattern? }`? | optional cover: CSS colour + built-in pattern (v6) |
| `createdAt` | number          | epoch ms                                          |
| `updatedAt` | number          | epoch ms, bumped on any change                    |

Stored in the `notebooks` object store, keyed by `id`.

`cover.pattern` is one of `dots | grid | stripes | waves | chevron`; patterns
are drawn procedurally in the cover colour, so no image data is stored.

`kind` is absent on every notebook written before v9, which is why "absent"
means `'pages'` rather than the field being backfilled — see "Notebook.kind
and boards" for what `'board'` changes.

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
| `w`, `h`     | number?         | this page's own size in page units, when it differs from the default 820×1060 — set only for a page imported from a PDF page with a non-default aspect ratio. Read through `pageW()` / `pageH()` ([`src/const.ts`](src/const.ts)), never directly, so the fallback lives in one place |
| `col`, `row` | number?         | board chunks only: which cell of the board's storage grid this record holds (v9). Present together or not at all; a page in a paged notebook has neither |
| `createdAt`  | number          | epoch ms                                |
| `updatedAt`  | number          | epoch ms                                |

Stored in the `pages` object store, keyed by `id`, with an index on `notebookId`.

**`background`** is drawn over the paper fill and under everything else; it is
never ink and cannot be selected or erased. A page with a background counts as
*content* for the trailing-blank rule and the library page count. Two forms,
which are fitted differently (see `drawBackground` in
[`src/canvas/elements.ts`](src/canvas/elements.ts)):

- `{ src }` (v5): a `data:` URL of a pre-rendered page image, fitted *inside*
  the page and centred, with paper showing around it. Still valid; nothing in
  the app writes these any more.
- `{ assetId, page }` (v7): page number `page` (1-based) of the PDF stored as
  asset `assetId`, rendered on demand when the page scrolls into view (a small
  in-memory cache of rendered pages; nothing rasterised is stored). Drawn
  **full-bleed** — scaled to cover the page and centre-cropped — so a scan has
  no border; a page whose aspect ratio is far from the page box loses a little
  off the edges to the crop, which is why PDF import also sets `Page.w`/`h`.
  This is what PDF import writes now.

### Notebook.kind and boards (v9)

`Notebook.kind` is `'board'` for an unbounded canvas, and absent (meaning
`'pages'`) for the original paged notebook — so nothing written before v9 needs
migrating.

A board has no pages. Its items carry **global board coordinates** and are
never remapped; what the `pages` store holds for a board is a set of
**storage chunks**:

| | |
| --- | --- |
| chunk id | `<notebookId>:<col>,<row>` — derived, not a uuid |
| grid | `BOARD_CHUNK` = 2048 board units ([`src/store.ts`](src/store.ts)) |
| which chunk | `col = floor(x / 2048)`, `row = floor(y / 2048)`, from the item's **bounding-box origin** |
| `index` | always `0`; a board's chunks have no order and nothing reads it |
| `paper` | every chunk carries the same `Paper`; the board's own setting is read from the origin chunk `<notebookId>:0,0`, which exists from creation |

A chunk is **purely a write-batching device**. `replacePageStrokes` /
`replacePageElements` rewrite one record wholesale, so a single record per board
would rewrite the entire board on every autosave; chunking keeps a save
proportional to what was just drawn. It is *not* a coordinate space and not a
query structure:

- items in a chunk keep their global board coordinates — nothing is relative to
  the chunk;
- which chunk an item is filed under is decided once, when it is created, and
  never affects how it draws or hit-tests;
- an item that is **moved** keeps its original chunk rather than migrating, which
  is what lets a board's move/resize reuse the same ops a page's does. A chunk
  therefore does not bound the items it stores.

What the board actually queries — the viewport cull and every hit test — is an
in-memory spatial index (a finer 512-unit cell grid, `BOARD_CELL`), rebuilt from
the chunks on load. **Nothing about the index is stored.**

Because a board's items live in the same `strokes` / `elements` stores as any
other item, keyed by their chunk's page id, backup export/import and
`deleteNotebookCascade` need no board-specific handling at all.

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

### AI conversation (schema v7)

A notebook has any number of AI chats; each turn belongs to one.

**Chat** (`aiChats` store, keyed by `id`, index on `notebookId`):

| field        | type    | notes                                                |
| ------------ | ------- | ----------------------------------------------------- |
| `id`         | string  | uuid                                                  |
| `notebookId` | string  | owning notebook; deleted with it                      |
| `title`      | string  | the chat's first transcript, truncated; `''` until it has one |
| `createdAt`  | number  | epoch ms                                              |
| `updatedAt`  | number  | epoch ms; bumped per saved turn — the switcher's order |

**Turn** (`aiConversations` store, keyed by `id`, indexes on `notebookId` and `chatId`):

| field        | type    | notes                                                |
| ------------ | ------- | ----------------------------------------------------- |
| `id`         | string  | uuid                                                  |
| `notebookId` | string  | owning notebook; deleted with it                      |
| `chatId`     | string  | owning chat; deleted with it                          |
| `pageId`     | string  | the page the turn was captured from — label only, the page's own content is untouched |
| `thumbnail`  | string  | `data:` URL — a small JPEG of the question crop (pre-v7 entries: the whole-page capture) |
| `transcript` | string? | Gemini's text rendering of the question; absent on errors and pre-v7 entries |
| `text`       | string  | Gemini's reply (or an error message)                  |
| `isError`    | boolean | true if `text` is an error, not a real reply          |
| `createdAt`  | number  | epoch ms; also the panel's display order              |

Later turns in a chat send its earlier turns as text-only history (each
turn's `transcript` + `text`); a turn without a transcript is never sent. The
v7 upgrade put each notebook's existing turns into one chat titled "Earlier
chat". Which chat is open is remembered per notebook in `localStorage`
(`noteapp.aichat.<notebookId>`), not here.

Both stores are read/written directly by `src/ai-mode.ts` (`getAiChats` /
`putAiChat` / `putAiTurn` / `getAiEntries` / `deleteAiChat` in `src/db.ts`),
not through the `Store` class other data goes through. **Deliberately
excluded from `ALL_STORES`**, so they're untouched by backup export/import
(`Backup` has no field for either) — it's chat history, not notebook content,
and importing a backup should not silently wipe every notebook's AI
conversations. Still deleted along with their notebook
(`deleteNotebookCascade`); a single chat is deleted from the AI panel
("Delete chat").

**Trailing-blank invariant:** every **paged** notebook always ends with exactly
one blank page (a page with no strokes). The app appends or removes trailing
blank pages to maintain this after every content change; these structural
adjustments are not undoable. A blank page in the *middle* of a notebook is left
untouched. A board is exempt — it has no pages to keep a blank one after, and
its chunk records are created on demand by whatever lands in them.

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
- The **Paper** menu edits these three settings with a **this page / all pages**
  scope. (Deleting a page is not here — that lives in the page manager.)
- A **board** has one paper for the whole canvas: every chunk record carries the
  same `Paper`, written to all of them at once, so a chunk created later inherits
  it and the board reads as one surface. It is read back from the origin chunk.

### Stroke

| field        | type         | notes                                   |
| ------------ | ------------ | --------------------------------------- |
| `id`         | string       | uuid                                    |
| `pageId`     | string       | owning page                             |
| `notebookId` | string       | owning notebook                         |
| `tool`       | `'pen' \| 'highlighter'` |                             |
| `color`      | string       | a CSS colour, **or** the token `"auto"` |
| `size`       | number       | nib width in page units                 |
| `points`     | `number[][]` | raw input samples, each `[x, y, pressure]`; page units on a page (820×1060 unless the page carries its own `w`/`h`), global board units on a board |
| `createdAt`  | number       | epoch ms, also the draw order           |

Stored in the `strokes` object store, keyed by `id`, with an index on `pageId`.
A stroke belongs to the page the pointer went down on. Strokes are clipped to the
page **visually** (the page element is `overflow: hidden`); point data is not
truncated. On a board `pageId` names a storage chunk rather than a page, and
nothing clips: the canvas is unbounded.

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

### Elements (text, image, shape, tape, bubble, connector)

Non-ink content lives in the `elements` object store, keyed by `id`, with an
index on `pageId`. Every element is a **box in page units** and shares these
fields:

| field        | type     | notes                                                        |
| ------------ | -------- | ------------------------------------------------------------ |
| `id`         | string   | uuid                                                         |
| `pageId`     | string   | owning page                                                  |
| `notebookId` | string   | owning notebook                                              |
| `kind`       | `'text' \| 'image' \| 'shape' \| 'tape' \| 'bubble' \| 'connector'` |                      |
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

// v10/v11 — boards only, written by mind-map mode; see below
interface BubbleElement    { kind: 'bubble'; outline: 'ellipse' | 'roundrect';
                             color: string; size: number /* outline width */;
                             members: string[] /* ids of the items it owns */ }
interface ConnectorElement { kind: 'connector';
                             a: { bubbleId: string; node: 'n' | 'e' | 's' | 'w' };
                             b: { bubbleId: string; node: 'n' | 'e' | 's' | 'w' };
                             color: string; size: number /* line width */;
                             ax: number; ay: number; bx: number; by: number /* cached endpoints */ }
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
- A **bubble** (v10) is the clean outline a loop drawn around content snaps into
  in mind-map mode. Its own box *is* the outline — an ellipse inscribed in it, or
  a rounded rectangle filling it (corner radius derived from the box, not
  stored) — so no separate polygon is kept. `rotation` is always `0`: everything
  about a bubble reads its plain box, so rotating one is forbidden rather than
  supported. Its `createdAt` is deliberately set *below* its members' so the
  outline paints under the handwriting it was drawn around.
- `BubbleElement.members` is **advisory**: erasing a member or undoing past its
  creation can leave ids pointing at items that no longer exist, so every reader
  resolves them through the store and silently drops what is gone. Direct
  members only — a nested bubble keeps its own list, resolved transitively when
  the outer one moves. Membership is exclusive, and the innermost bubble
  containing an item owns it.
- A **connector** (v11) links two bubbles. What is authoritative is the two
  anchors (`a`/`b`: a bubble id and which of its four side nodes);
  `ax`/`ay`/`bx`/`by` and the element's own `x`/`y`/`w`/`h` are a **cache** of
  where those anchors currently resolve to and the bounding box of that pair.
  They are stored anyway because the board's spatial index and viewport cull work
  on an item's bounds, and a connector with none would never repaint or would be
  found nowhere near where it is drawn. They are re-derived whenever either
  bubble moves, inside the same undo step as the move. `rotation` is always `0` —
  the box is a bounding box, not an oriented frame.
- Deleting a bubble deletes its connectors in the same step; a connector whose
  bubbles can no longer both be resolved is not drawn.
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
>
> **v8 → v9:** boards — `Notebook.kind` and `Page.col` / `row` (see
> "Notebook.kind and boards"). Both optional: a record with neither reads as an
> ordinary paged notebook, so there is nothing to migrate.
>
> **v9 → v10:** the `bubble` element kind. Additive, like `tape` at v5.
>
> **v10 → v11:** the `connector` element kind. Additive.

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
  "version": 11,                // FORMAT_VERSION at export time
  "exportedAt": "2026-01-01T00:00:00.000Z",
  "notebooks": [ /* Notebook[] — with folderId, order, maybe cover / kind */ ],
  "pages":     [ /* Page[] — each includes `paper`; maybe `background`, `w`/`h`, or `col`/`row` for a board's chunks */ ],
  "strokes":   [ /* Stroke[] */ ],
  "elements":  [ /* PageElement[] — text / image / shape / tape / bubble / connector */ ],
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
