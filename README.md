# NoteApp

An installable web app (PWA) for **handwritten notes**, built for iPad + Apple Pencil
but equally usable with a mouse on the desktop.
Vite + TypeScript, no UI framework. All data lives on-device in IndexedDB.

## What's in this milestone

- **Library** – create / rename / delete notebooks. Names are entered through an
  in-app dialog (no `window.prompt`), so it works in webviews too.
- **Folders** – a folder tree at the top of the library; folders hold notebooks
  and other folders to any depth. Create (*New folder*, or *New subfolder* from
  a folder's ⋯ menu), rename, delete (contents move up a level — nothing is
  lost) and move notebooks with *Move to folder…* on a notebook's ⋯ menu. The
  URL remembers the folder (`#/f/<id>`) and *Back* from a notebook returns to
  its folder.
- **Dividers** – *Add divider above* on a notebook's ⋯ menu inserts a labelled
  marker into the folder's list, for visual grouping only. Rename, move up /
  down or delete it from its own ⋯ menu; notebooks have *Move up / Move down*
  too, so a folder's list is in the order you choose (new notebooks go on top).
- **Covers** – *Cover…* on a notebook's ⋯ menu picks a cover colour and one of
  five built-in patterns (dots, grid, stripes, waves, chevron). The cover shows
  behind the page preview on the library cards and colours the card's accent.
- **Notebook view** – one vertically scrolling column of pages.
- **Pen & mouse input** (Pointer Events) – you draw when `pointerType` is `"pen"`
  **or** `"mouse"`, using pressure where available; a finger drag (`pointerType`
  `"touch"`) scrolls the notebook. `touch-action` + `preventDefault` stop the
  long-press callout, text selection, the magnifier and pinch-zoom on the page.
- **Automatic pages** – there is no "add page" button. Every notebook always ends
  with a blank page; drawing on it appends the next blank page. Pages are never
  removed automatically — clearing a page again keeps the page that was added
  after it. A new page inherits the paper of the page before it. Delete a page
  from its per-page **Paper** menu. The automatic additions are not on the undo
  stack.
- **Vector strokes** – stored as `[x, y, pressure]` points, rendered with
  [`perfect-freehand`](https://github.com/steveruizok/perfect-freehand). Committed strokes
  are cached to an offscreen canvas, so each frame only the live stroke is repainted.
  A stroke belongs to the page it started on and is clipped to that page visually.
- **Tools** – pen and highlighter, each with 5 preset colours plus your own
  (see *Custom colours*) and its own remembered size. The dock shows the current size as a dot at the true on-page stroke
  width (capped, with the number for larger sizes); tapping it opens a slider
  popover anchored to the dot — a continuous drag (pen 0.5–12, highlighter 4–40
  page units) with ruler tick marks and a live numeric readout, and the dock dot
  tracks it as you drag. Undo / redo (buttons or ⌘/Ctrl+Z, ⌘/Ctrl+Shift+Z).
- **Eraser** – two modes, picked from the dropdown that opens when you tap the
  eraser button while it is already active (or tap the mode pill in the dock):
  **Whole stroke** removes any stroke you touch; **Partial** rubs out only the
  parts you touch, splitting the stroke into the pieces that remain. In both
  modes what you have touched shows translucent until you lift the pen, and
  each erase is one undo step. The mode is remembered. Shapes (placed or
  snapped) erase whole in either mode when you touch their outline — their
  inside doesn't count, so rubbing out ink inside a box leaves the box.
- **Lasso select** – draw around strokes, text, images or shapes to select them
  (a tap picks the single item under it). The dock offers three ways to draw the
  selection: a freehand loop, a **box** or a **circle** dragged from corner to
  corner; the choice is remembered. The selection gets a bounding box with
  move (drag the body), resize (corner/edge handles), rotate (single elements)
  and delete (×) handles. Copy / paste / duplicate from the dock or ⌘/Ctrl+C, V,
  D (in-app clipboard; pasting onto the source page nudges the copy); Delete /
  Backspace removes the selection. Pen and highlighter swatches in the dock
  recolour the selected strokes of that tool. Every change is one undo step.
- **Text** – tap to place a text box and type; tap outside to finish. Tap a box
  to edit it again, drag it to move it, and pull a corner handle to scale it —
  the type size scales with the box; the side handles change only the wrap
  width. Text uses the pen swatches (including auto ink).
- **Line-snap (pen only)** – hold the pen still at the end of a stroke that's
  already nearly straight and it snaps to a line; ordinary pauses on a stroke
  that isn't straight never trigger anything. The hold has two stages: after
  0.5 s a ghosted preview of the line appears over your ink as a "this is about
  to snap" cue (keep drawing and it re-fits as you go), then after 1.1 s the
  ink becomes the line itself, adjustable: while the pen is still down it drags
  the far end, and lifting leaves the line on the page with a handle at each
  end — drag either to change its length and angle (lifting after a handle
  drag commits it). Tapping anywhere else, starting a new stroke, switching
  tools or undoing also commits it. Committed lines are elements: lasso them to
  move, resize or rotate.
- **Shapes** – its own dock tool: pick rectangle, ellipse, arrow or triangle in
  the dock, then drag on the page to place one sized to the drag (an arrow runs
  from where you press to where you lift). The outline uses the pen's colour
  and width. The shape lands already selected, with the usual move / resize /
  rotate handles; it's an ordinary element from then on. Tap any existing
  shape (a snapped line included) while the tool is active to select it again
  and readjust it; dragging over a shape places a new one on top of it.
- **Ruler & protractor** – toggles at the end of the dock put a draggable,
  rotatable bar or semicircle on the page in view. The ruler spans the page
  width and reads in real units — centimetres and millimetres along the top,
  inches and sixteenths along the bottom; the protractor has a tick every
  degree, numbered every 10° on both an outer and a reverse inner scale, an
  origin mark at the middle of its baseline and guide rays every 10° from it —
  put the vertex of an angle on the origin, its first arm on the baseline, and
  read the other arm off the scale. A pen stroke that starts
  beside the ruler's edge (either long side) or the protractor's baseline runs
  perfectly straight along it. Drag the round grip to rotate; the ruler shows
  its angle while rotating and the protractor shows its degrees at all times.
  These are view aids only — never saved, never exported.
- **Laser pointer** – a tool for pointing while presenting: the trail glows red
  and fades out over about 3.5 s. It is drawn on the view only — never saved,
  exported or undoable.
- **Custom colours** – the *+* swatch at the end of the pen or highlighter row
  opens a picker (saturation/value square, hue strip, hex field). *Add colour*
  saves it to that tool's list (up to 8, newest first), shown after the presets
  as square swatches, and selects it. Pen custom colours also serve the text
  and Shapes tools and the lasso's recolour row. Hold (or right-click) a custom
  swatch to remove it.
  Lists are remembered on the device.
- **Images** – the *Insert image* button in the dock opens the photo picker
  (photos, PNGs, GIFs). The picture lands centred on the page in view as an
  element, already selected with the lasso tool, so you can drag it, scale it
  from a corner (proportions kept) or rotate it. Large photos are downscaled to
  1600 px on the long edge before they are stored inline.
- **Import file** – *Import file* on the Library screen opens the native Files
  picker (which includes Google Drive and other providers enabled as Files
  locations) and turns the chosen PDF into a new notebook, one page per PDF
  page — PDF is the only type accepted for now. The same import also runs when
  a PDF is shared *into* NoteApp: the web app manifest declares a
  `share_target`, so on platforms that support the Web Share Target API the
  installed app appears in the share / "Open in" sheet for a PDF in Files or
  Google Drive; the service worker receives the file and hands it to the
  importer, which opens the new notebook. That only works once the app is
  deployed over HTTPS and added to the home screen (the service worker isn't
  registered on the dev server), and only where the platform offers web share
  targets — Android and desktop Chrome do; iOS Safari does not yet. A progress
  dialog covers the import, so a large PDF never looks like a frozen screen.
  The PDF is stored once; each page is
  rendered (with [pdf.js](https://mozilla.github.io/pdf.js/)) on demand as it
  scrolls into view and shown as the page background — not ink, not
  selectable, not erasable — with every drawing tool working on top of it. A
  long PDF costs its own file size in storage and in backups, not one image
  per page; the first look at each page waits a moment for it to render.
- **Tape** – drag with the Tape tool to lay an opaque strip over anything
  (answers, labels, formulas). Tap a strip with any tool — or a finger — to peel
  it back and see what's under it; tap again to cover it. Peeled state is not
  saved, so a fresh open starts fully covered — handy for self-quizzing. Strips
  are elements: lasso to move, resize or delete.
- **Paper, per page** – each page has its own `template` (blank, ruled, grid, dot),
  line `spacing` (narrow, medium, wide) and `color` (white, cream, dark), edited
  from the page's **Paper** menu. *All pages* there copies this page's paper to
  every page in the notebook at once (and anything you pick afterwards applies to
  all of them too); *This page* narrows back to just this one. Templates
  are drawn into the page background, separate from strokes (not erasable, not
  exported as strokes); ruling colour adapts to the paper colour. See
  [`DATA_FORMAT.md`](DATA_FORMAT.md).
- **Export** – the *Export* button in the notebook bar offers the page in view
  or the whole notebook as a **PDF** (Letter-width; strokes, text, shapes and
  the paper template are vector, photos and imported PDF pages are embedded
  bitmaps, tapes are exported covering) and the page in view as a **PNG** or
  **JPEG** at 2× resolution. Text is set in Helvetica in the PDF. Built with
  [pdf-lib](https://pdf-lib.js.org/), loaded only when you export.
- **Zoom** – pinch with two fingers, ctrl/⌘ + scroll, or tap the percentage in
  the notebook bar for a slider with *Fit width / 100% / 200%* (50–300%). One
  finger still scrolls. Pages are CSS-scaled, so every tool maps pointer
  positions back into page space and stays accurate at any zoom; the dock's
  size dot previews the on-screen stroke width. Narrow screens start at
  fit-width.
- **Autosave** to IndexedDB – debounced (~0.7 s) and forced on `visibilitychange` /
  `pagehide`. `navigator.storage.persist()` is requested on load; the Library screen
  shows whether it was granted.
- **Backup** – Export writes every notebook/page (with paper)/stroke/element to
  one JSON file; Import replaces all current data with a backup file, migrating
  older files on the way in.
- **PWA** – `manifest.webmanifest`, offline service worker, `apple-touch-icon`,
  `display: standalone`.

Off-limits for now (intentionally not implemented): search, sync.

## Project layout

```
index.html               app shell + PWA meta tags
public/
  manifest.webmanifest
  sw.js                  runtime-caching service worker (offline)
  icons/                 generated PNG icons (192 / 512 / apple-touch 180)
scripts/gen-icons.mjs    zero-dep PNG icon generator (runs before dev/build)
src/
  main.ts                boot + hash router (#/, #/f/<folder>, #/nb/<id>)
  store.ts               in-memory model + debounced IndexedDB autosave
  db.ts                  IndexedDB wrapper, export/import
  types.ts               Notebook / Page / Paper / Stroke / PageElement / Backup shapes
  tools.ts               current tool selection + colours/sizes (localStorage)
  media.ts               photo / GIF file → downscaled inline data URL
  pdf-import.ts          PDF → notebook: stores the file once as an asset, one page per PDF page
  pdf-render.ts          renders stored-PDF pages on demand (pdf.js, lazy-loaded), small cache
  export/
    pdf.ts               page / notebook → vector PDF (pdf-lib, lazy-loaded)
    raster.ts            page → PNG / JPEG
  canvas/
    page-canvas.ts       per-page canvases, Pointer Events, cache + live redraw,
                         lasso / tap selection, drag transforms, in-place text editor
    selection.ts         the selection box overlay (move / resize / rotate / delete handles)
    elements.ts          text / image / shape rendering, text wrapping
    geom.ts              point-in-polygon, bounds, frame transforms
    recognize.ts         stroke → straight-line fitting (pen line-snap); line / arrow box geometry
    guide.ts             ruler + protractor overlays and edge snapping
    freehand.ts          perfect-freehand -> Path2D
    templates.ts         paper backgrounds (blank / ruled / grid / dot), colour-aware
  ui/
    library.ts           library screen: folder tree, notebook list with dividers, covers
    covers.ts            cover colour palette + procedural patterns
    notebook.ts          notebook screen, toolbar, incremental page list, undo/redo
    dialog.ts            reusable in-app modal (text prompt / confirm / alert)
    color.ts             hsv/hex helpers + the custom colour picker popover
    thumb.ts             library page-preview thumbnails
```

`DATA_FORMAT.md` documents the on-disk shapes, the per-page paper model, and the
migration run on load and on backup import.

## Run the dev server on your local network (to test on the iPad)

```bash
npm install          # first time only – also creates package-lock.json (commit it)
npm run dev
```

Vite prints something like:

```
  ➜  Local:   http://localhost:5173/
  ➜  Network: http://192.168.1.34:5173/
```

On the iPad (same Wi‑Fi) open the **Network** URL in Safari. Drawing, tools, pages and
autosave all work over plain HTTP.

To exercise a production bundle on the LAN:

```bash
npm run build
npm run preview      # -> http://192.168.1.34:4173/
```

### Testing the *installed* PWA (offline + Add to Home Screen)

iOS only registers a service worker over **HTTPS** (or `http://localhost`). A LAN IP is
plain HTTP, so the SW silently doesn't register there. To test install/offline on the iPad,
pick one:

- **Deploy** (below) and open the HTTPS URL – simplest.
- **Quick tunnel:** `npx cloudflared tunnel --url http://localhost:5173` and open the
  generated `https://…trycloudflare.com` URL on the iPad.
- **HTTPS dev server:** `npm i -D @vitejs/plugin-basic-ssl`, add `basicSsl()` to
  `vite.config.ts` `plugins`, run `npm run dev`, then trust the self-signed cert on the
  iPad (Settings → General → About → Certificate Trust Settings).

Once loaded over HTTPS: Safari → Share → **Add to Home Screen**. It launches full-screen
(`standalone`) and opens offline after the first visit.

## Deploy for free

`vite.config.ts` sets `base: '/NoteApp/'`, matching this repo's name — GitHub
Pages serves a project (non-`<user>.github.io`) repo at
`https://<user>.github.io/<repo>/`, so every built asset URL needs that
sub-path prefix baked in. Routing is hash-based, so no SPA redirect/404 config
is needed. **Forked or renamed the repo?** Change `base` to match (or back to
`base: './'`, which works at a domain root or any sub-path without knowing the
name in advance, if you'd rather not hardcode it) before deploying.

### GitHub Pages (via the included Action)

1. Push this repo to GitHub, on the `main` branch:
   ```
   git remote add origin https://github.com/<user>/<repo>.git
   git push -u origin main
   ```
   (skip this if it's already pushed — check with `git remote -v`).
2. On GitHub: repo → **Settings → Pages → Build and deployment → Source: GitHub
   Actions**. (One-time; GitHub Pages is off by default on a new repo.)
3. `.github/workflows/deploy.yml` (already in this repo) then builds with
   `npm run build` and publishes `dist` on every push to `main` — including the
   push in step 1. Check the **Actions** tab for its progress; the workflow's
   summary and the Pages settings page both show the live URL once it succeeds.
4. Site URL: `https://<user>.github.io/<repo>/` — for this repo (name
   `NoteApp`), that's `https://<user>.github.io/NoteApp/`, matching the `base`
   above. If your repo name differs from `NoteApp`, update `base` first (see
   above) or the deployed asset paths will 404.

Manual alternative: `npm run build && npx gh-pages -d dist`.

### Cloudflare Pages

1. Push the repo to GitHub/GitLab.
2. Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git**.
3. Build command `npm run build`, output directory `dist` (framework preset: Vite).
4. Deploys on push; each branch gets a preview URL. Custom domains are free.
   Cloudflare Pages serves from the domain root, so set `base` back to `'./'`
   first (see above) — `/NoteApp/` is GitHub-Pages-specific.

CLI alternative: `npm run build && npx wrangler pages deploy dist`.

### The Gemini endpoint (`/api/gemini`)

A Vercel serverless function at [api/gemini.ts](api/gemini.ts) reads a
handwritten page image and returns Gemini's reply text — the backend for the
in-app AI mode (see below). It's independent of where the static site itself
is hosted (GitHub Pages, Cloudflare Pages, wherever); this is the only piece
that needs Vercel specifically, because that's where its two secrets already
live as project environment variables.

**Deploy it:**
```
npx vercel --prod
```
(run from the repo root; `vercel.json` tells it to build `api/gemini.ts` as
a Node.js function with a 30s timeout — Gemini's response can take a few
seconds, longer than Vercel's default). This also builds and deploys the
static `dist` site to the same Vercel project, `base: '/NoteApp/'` and all —
harmless if you don't use that URL, but see the `base` note above if you
*do* want Vercel to serve the real site.

**Environment variables** (Vercel project → Settings → Environment Variables):

| Name | Where it's used | Notes |
|---|---|---|
| `GEMINI_API_KEY` | server-side only | Already set in this project. |
| `GEMINI_PROXY_SECRET` | server-side only | Set. Any string; the function rejects requests without a matching `X-NoteApp-Secret` header. |
| `VITE_GEMINI_PROXY_SECRET` | baked into the client bundle at build time | Set, to the **same value** as `GEMINI_PROXY_SECRET`. |
| `VITE_GEMINI_ENDPOINT` | baked into the client bundle at build time | Optional. Absolute URL of the function, e.g. `https://<project>.vercel.app/api/gemini` — needed whenever the static site is served from somewhere other than this Vercel project (GitHub Pages, Cloudflare Pages, …), since a relative `/api/gemini` would otherwise resolve against *that* host. Unset defaults to the relative path, which only works if Vercel is also serving the site itself. |

**Request/response contract:**
```
POST /api/gemini
Content-Type: application/json
X-NoteApp-Secret: <matches GEMINI_PROXY_SECRET>

{ "image": "<base64, no data: prefix>", "mimeType": "image/png" }
```
→ `200 { "text": "…" }` on success, or `4xx/5xx { "error": "…" }` — see
[api/gemini.ts](api/gemini.ts) for the exact status codes.

**On the shared secret**: this is a static site with no server of its own to
keep a real secret in. `VITE_GEMINI_PROXY_SECRET` gets compiled straight into
the shipped JS, so anyone who reads the bundle can extract it — it does *not*
stop a determined person from calling the endpoint directly. What it does
stop is opportunistic abuse: scanners and bots that hit `/api/*` paths
blindly, without ever loading or inspecting the app itself. Budget for the
API key accordingly (Vercel/Google usage alerts, not just this header) if
that distinction matters to you.

### AI mode

A per-page toggle (the bot icon in a page's header) turns that page into a
live handwritten conversation with NoteApp AI. While it's on (an active page gets
a violet border), writing below the last exchange and then pausing for ~2s
rasterizes just that region and sends it to `/api/gemini`; a send icon next
to the toggle submits the current turn immediately instead of waiting. The
reply comes back as an ordinary text box — tinted violet to read as "not your
ink," but otherwise as editable/undoable/deletable as anything else on the
page — placed below your writing, so the page reads top-to-bottom like a
transcript. Running out of room on the page continues the conversation on a
freshly appended one. A failed request (network, quota, a bad secret) inserts
a red-tinted error box in place of a reply rather than losing the turn.
Turning the toggle off just stops sending new turns; everything already
written stays as normal page content.

## Data & backups

- Everything is stored locally in IndexedDB database **`noteapp`** — with one
  exception: while AI mode is on for a page (see above), a rasterized image of
  what you write there is sent to NoteApp AI to get a reply. Nothing
  else leaves the device, and AI mode is off by default on every page.
- Clearing Safari website data, or removing the Home Screen app, can delete your notes.
  Use **Export** on the Library screen regularly; **Import** restores a backup
  (it replaces all current data).
