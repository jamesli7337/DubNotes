# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

DubNotes: an installable PWA for handwritten notes (iPad + Apple Pencil, also usable with mouse). Vite + TypeScript, **no UI framework** — everything is hand-built DOM manipulation. All user data lives on-device in IndexedDB; nothing is synced except AI mode, which sends rasterized images of what's written to a Gemini proxy.

## Commands

```bash
npm install          # first time only
npm run dev          # dev server at http://localhost:5173/DubNotes/ (predev: icon gen + pdf.js wasm copy)
npm run build        # tsc typecheck (no emit) + vite build -> dist/
npm run preview      # serve the built dist/ bundle (http://localhost:4173/DubNotes/)
npm run icons        # regenerate public/icons/ PNGs from scratch
```

There is no test suite and no lint script. `npm run build` (which runs `tsc --noEmit`) is the correctness gate — always run it after changes and treat type errors as build failures. Real verification means launching the app and driving it (see "Verifying behavior").

## Architecture

### No framework, direct DOM

Screens are mounted by calling a `mount*` function with a container element (`mountLibrary(app, folderId)`, `mountNotebook(app, notebookId)` in `src/ui/`). These build DOM nodes directly (helpers in `src/ui/dom.ts`), wire event listeners, and re-render by mutating/rebuilding subtrees — no virtual DOM, no reactive binding.

### Routing

`src/main.ts` is the entire router: a hash switch in `route()` matching `#/nb/<id>` (notebook), `#/f/<id>` (folder), else the library root. `hashchange` re-runs `route()`. `base: '/DubNotes/'` in `vite.config.ts` is baked in for GitHub Pages' sub-path hosting.

### State: one in-memory Store, debounced IndexedDB flush

`src/store.ts` exports a singleton `Store` holding every notebook/page/folder/divider/stroke/element in `Map`s — the single in-memory source of truth the whole UI reads directly. Every mutation updates the maps synchronously (so UI reads are always consistent) and marks records dirty; a debounced (~0.7s) flush writes only dirty records via `src/db.ts`. `flushNow()` forces an immediate write on `visibilitychange`/`pagehide`. `src/db.ts` owns the IndexedDB schema/version and the migration chain — read `DATA_FORMAT.md` before changing any stored shape.

Note `store.pagesOf()` scans every page in the app, and page insert/delete renumbers all siblings; both are hot paths worth respecting.

### Camera model (notebook view)

`.nb-scroll` is **not** a scrolling element. Pan/zoom is one explicit camera `{ x, y, zoom }` (see `canvas/geom.ts`) applied as a single CSS transform to `.nb-camera` (`applyCamera`). "World space" is each `.page`'s own `offsetLeft/offsetTop` inside `.nb-camera`, read straight off layout. Consequences:
- Gestures are all hand-rolled in `notebook.ts` (`bindZoomGestures`): one-finger pan, pinch, ctrl+wheel zoom, momentum + rubber-band clamping, and a palm-vs-Pencil rejection scheme (`palmTouchIds`, `stylusDown`, post-lift cooldown). Touch a gesture path only with a very good reason.
- The scrollbar is a custom thumb on `document.body` (`bindScrollbarThumb`), not a native one.
- Anything that must paint above the app-bar/dock — the lasso callout, the tape popover, the scrollbar thumb, drag ghosts — is appended to `document.body` with `position: fixed` and manually placed via the camera. Follow that pattern for any new overlay.

### Canvas layer (`src/canvas/`)

`page-canvas.ts` owns Pointer Events for every tool (draw, erase, lasso/tap select, drag transforms, in-place text editing). Each mounted page has **two** canvases: `cache` (template + committed items, repainted rarely) and `view` (blits the cache, then paints what's in flight). `NotebookView` mounts only pages near the viewport and re-rasterises them at a quality tracking the settled zoom (`setQuality` / `pageQuality` / `applyQuality`, one page per animation frame, capped per-canvas by `canvasPixelFactor` in `const.ts` and globally by a total pixel budget). A page mid-gesture refuses the re-render rather than clearing its canvas under a live stroke.

- `selection.ts` — a **single shared** `SelectionOverlay` owned by `NotebookView`, living in `.nb-scroll` (a sibling of `.nb-camera`), not one per page. `show()` is told which page's selection it is and positions everything through the shared camera, so a selection dragged across a page boundary never loses the paint-order fight. It has no delete affordance of its own; that's the callout's job.
- `elements.ts` — text/image/shape/tape rendering and text wrapping.
- `geom.ts` — the `Camera` type, world↔screen conversion, point-in-polygon, bounds, frame/rotation transforms.
- `recognize.ts` — stroke → straight-line fitting for pen line-snap.
- `guide.ts` — ruler/protractor overlays and edge snapping (view-only, never persisted).
- `freehand.ts` — wraps `perfect-freehand`; also owns the `"auto"` ink token resolved against paper colour.
- `templates.ts` — paper background rendering (blank/ruled/grid/dot), colour-aware.

### Tools & UI state

`src/tools.ts` holds current tool, colours and sizes, persisted to `localStorage` (separate from the IndexedDB note data). `src/ui/notebook.ts` is by far the largest UI file: notebook screen, per-tool dock, page list, camera, undo/redo. When adding a per-tool dock option, follow the existing `switch (toolState.kind)` in `renderTools()`.

### AI mode

`src/ai-mode.ts`. One **global on/off switch per notebook** (not per page): while active, ink drawn on any page is ephemeral, inks in a fixed violet, and never enters the main undo stack — AI mode keeps its own undo/redo history, **notebook-wide** like main's (one history across every page, in the order actions happened; undoing on an off-screen page doesn't scroll, same as main), cleared per page on Send and entirely when AI mode turns off. The eraser works in AI mode (whole and partial) but only on the current turn's AI ink, never saved page content (`PageCanvas.erasable`); its erases go into that AI history. Send rasterizes two structurally separate images (the violet question ink cropped to itself, plus the whole page as context, via `src/export/raster.ts`) and POSTs them to `/api/gemini` (`api/gemini.ts`, a Vercel serverless function — the only Vercel-specific piece, since its secrets are project env vars). Replies render in a **slide-out chat panel**, not as page content, and persist in the `aiConversations` store, which is deliberately outside the backup format. While active, `applyAiToolbarLockdown` genuinely disables every control but the pen, the eraser (and its whole/partial mode switch), undo/redo, send and the split button.

### Split screen (`src/ui/secondary-pane.ts`)

Read-only reference content beside the notebook you're drawing in, in two shapes:
- a **pane split** — another notebook's pages, a reference PDF, docked beside the notebook (or detached into a floating window via the header's minimise/expand);
- an **image overlay** — a reference image floating *over* the notebook, pinned to the viewport, never splitting the width.

`page-scroller.ts` is a self-contained read-only scrolling column (its own camera, gestures, mount window and quality drain) deliberately **not** built on `NotebookView`, whose camera code is tangled with the dock, selection, AI mode and a window-level key handler. What it scrolls comes from a `PageSource` (`page-sources.ts`): `NotebookPageSource` (pages via the read-only `PageView`, polling `Notebook.updatedAt` for changes) or `PdfPageSource`. Everything is read-only by construction — no tool state, no undo, no selection, no store writes. The only thing flowing back is `refreshIfShowing`, so a page edited in the main view repaints in the pane.

Persistence is per host notebook: a `SavedSplit` (kind, notebook/page, scroll anchor, float rect) in `localStorage` under `noteapp.split.<notebookId>`, and any binary payload (reference image or PDF bytes) in a **separate `noteapp-split` IndexedDB database** — deliberately outside the `noteapp` database, so a reference file is never part of a notebook's pages or its backup. Picking a notebook to split with parks state under `noteapp.split.pending` and routes through the library (`pendingSplitPick`/`chooseSplitNotebook`/`cancelSplitPick`, consumed in `library.ts`).

### PDF rendering & import

`src/pdf-import.ts` brings a PDF in as notebook pages, storing the file once in the `assets` store and referencing it per page as `background: { assetId, page }`. `src/pdf-render.ts` renders those on demand via lazy-loaded `pdf.js` (wasm copied into `public/` by `scripts/copy-pdfjs-wasm.mjs` in `predev`/`prebuild`), with a small LRU of rendered pages and a memo of pages that failed so a broken page isn't retried forever (`ensurePdfPage`, `getPdfPage`, `isPdfPageFailed`).

It also exposes a **bytes API** for PDFs that are *not* entries in the `assets` store — used by the split pane's reference PDFs, which live in the `noteapp-split` database instead: `registerPdfBytes(key, data)` makes an arbitrary buffer renderable by the same pipeline, `hasPdfBytes(key)` tests it, `releasePdfBytes(key)` frees the parsed document and its cached pages, and `pdfPageSizes(key)` returns each page's own size in PDF points (the pane lays pages out in those units directly, rather than fitting them to the app's page box the way an import does). A caller that registers bytes owns releasing them.

### Export

`src/export/pdf.ts` (vector PDF via `pdf-lib`, lazy-loaded) and `src/export/raster.ts` (PNG/JPEG, plus the region/item rasterizers AI mode uses).

### Service worker / offline

`public/sw.js` plus the `swPrecache` plugin in `vite.config.ts` and `src/sw-register.ts`.

- `sw.js` ships two placeholder tokens, `/*__SW_BUILD__*/ 'dev'` and `/*__SW_PRECACHE__*/ []`, which are the harmless dev defaults. At build time `swPrecache` (in `closeBundle`, after `public/` is copied) rewrites them with a digest of the build and the full asset list: `index.html`, every emitted `.js`/`.mjs`/`.css` chunk, and the un-fingerprinted `pdfjs-wasm/*.wasm` files. It throws if either token is missing — so **don't reformat those comment tokens**.
- Precaching is all-or-nothing and covers *lazily imported* chunks too; before it, "Import PDF pages" failed offline with a dynamic-import error unless you'd used the feature while online.
- Strategy: navigations network-first; other same-origin GETs cache-first, reading only the current build's cache. The cache name is versioned by that build digest, so a deploy gets a clean cache and `activate` deletes older ones. Because the digest lands in `sw.js` itself, the file's bytes change every deploy — which is what makes browsers pick up the new worker at all.
- `sw-register.ts` skips registration entirely in `vite dev` (so hot reload is never served from cache). iOS only registers a SW over HTTPS or `http://localhost` — a plain-HTTP LAN address silently no-ops.
- The worker also parks a file shared in via the manifest `share_target` in a `noteapp-share` cache, picked up once by `src/import-file.ts`.

## Working conventions

- **Vanilla TypeScript only** — do not introduce a framework, state library, or build-step abstraction not already present.
- **Strict scope**: implement exactly what's asked; do not opportunistically refactor or touch unrelated code in the same change.
- Don't add new icons, buttons or chrome as an implementation detail — touch only the named button/feature.
- When a task asks for investigation/root-cause analysis before a fix, report the root cause before making changes.
- Run `npm run build` after any change and treat any `tsc` error as blocking.
- If pre-existing out-of-scope issues are noticed, list them at the end of a report rather than fixing them.
- Other Claude sessions may be editing this repo in parallel — a broken build may not be yours; verify in a throwaway git worktree before "fixing" it.

### Verifying behavior

There is no automated UI test suite. Real verification means driving the app in a browser: run `npm run dev` and use a headless-Chrome CDP harness (small scripts run against a `cdp.mjs`) to script real pointer/touch interactions and assert on live DOM/canvas state. Remember the `/DubNotes/` base path — module imports in evaluated script are `/DubNotes/src/...`, and a hash-only navigation does **not** reload the app, so seeding IndexedDB then jumping to `#/nb/<id>` needs a cache-busting query to force a fresh `store.init()`.

Two known blind spots of CDP-synthetic events, worth remembering when a report can't be reproduced:
- **`touch-action` gesture disambiguation** (tap vs. pan) is resolved by native gesture recognition before any pointer event fires; CDP's `Input.dispatch*` bypasses that, so a missing `touch-action: none` on a small interactive element inside a pannable ancestor can be a real device-only bug.
- Bugs depending on scroll/camera position relative to `position: fixed` chrome need a scripted pan to a specific offset to reproduce.

**Assert store contents by reading IndexedDB, not the `store` singleton.** Vite serves two instances of a module — the app imports `/src/store.ts?t=<hmr-stamp>` while a dynamic `import()` from evaluated script gets `/src/store.ts` — so an eval-side `store` is a *different object* with its own empty maps, and assertions against it pass or fail depending on HMR state. Open the `noteapp` database directly (`indexedDB.open('noteapp')`, then `getAll()` on `strokes`/`pages`/…) and wait out the ~0.7s flush debounce first. That is also the only way to check what was actually persisted rather than what is merely in memory. Store *logic* can still be tested eval-side as long as one `evalJs` call does the whole thing — one instance, self-contained.

Keep throwaway CDP scripts and Chrome profile directories in the scratchpad directory, not the repo, and clean them up when done. Never kill Chrome by a blanket/name-based command (e.g. `taskkill /IM chrome.exe`) — only by the specific PID your own script spawned.

## Deployment

Static site deploys to GitHub Pages (`.github/workflows/deploy.yml`, builds on push to `main`) or Cloudflare Pages; the Gemini proxy (`api/gemini.ts`) is Vercel-specific regardless of where the static site is hosted. See the README's "Deploy for free" section for required env vars (`GEMINI_API_KEY`, `GEMINI_PROXY_SECRET`, `VITE_GEMINI_PROXY_SECRET`, `VITE_GEMINI_ENDPOINT`) and the `base` path caveat (`/DubNotes/` is GitHub-Pages-specific; other hosts need `base: './'`).
