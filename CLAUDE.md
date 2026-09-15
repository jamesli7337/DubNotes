# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

DubNotes: an installable PWA for handwritten notes (iPad + Apple Pencil, also usable with mouse). Vite + TypeScript, **no UI framework** — everything is hand-built DOM manipulation. All user data lives on-device in IndexedDB; nothing is synced except the optional per-page AI mode, which sends a rasterized image of what's written to a Gemini proxy.

## Commands

```bash
npm install          # first time only
npm run dev           # dev server at http://localhost:5173 (also runs predev: icon gen + pdf.js wasm copy)
npm run build          # tsc typecheck (no emit) + vite build -> dist/
npm run preview        # serve the built dist/ bundle
npm run icons          # regenerate public/icons/ PNGs from scratch
```

There is no test suite and no lint script configured. `npm run build` (which runs `tsc` with `noEmit`) is the correctness gate — always run it after changes and treat type errors as build failures. Because there's no automated test runner, real verification means actually launching the app and driving it (see "Verifying behavior" below).

## Architecture

### No framework, direct DOM

There's no React/Vue/etc. Screens are mounted by calling a `mount*` function with a container element (`mountLibrary(app, folderId)`, `mountNotebook(app, notebookId)` in `src/ui/`). These build DOM nodes directly (helpers in `src/ui/dom.ts`), wire event listeners, and re-render by mutating/rebuilding subtrees on state change — there is no virtual DOM or reactive binding layer.

### Routing

`src/main.ts` is the entire router: a hash-based switch in `route()` matching `#/nb/<id>` (notebook), `#/f/<id>` (folder), or else the library root. `hashchange` re-runs `route()`. `base: '/DubNotes/'` in `vite.config.ts` is baked in for GitHub Pages' sub-path hosting — change it (or back to `'./'`) if deploying elsewhere; see the README's Deploy section.

### State: one in-memory Store, debounced IndexedDB flush

`src/store.ts` exports a singleton `Store` holding every notebook/page/folder/divider/stroke/element in `Map`s — this is the single in-memory source of truth the whole UI reads from directly. Every mutation updates the maps synchronously (so UI reads are always instantly consistent) and marks touched records dirty; a debounced (~0.7s) flush in `src/db.ts` writes only the dirty records to IndexedDB. `flushNow()` forces an immediate write and is called on `visibilitychange`/`pagehide` so nothing is lost on backgrounding. `src/db.ts` also owns the IndexedDB schema/version and the migration chain that upgrades older records on load — see `DATA_FORMAT.md` for the full entity shapes, schema/format version history, and migration notes before changing any stored shape.

### Canvas layer (`src/canvas/`)

Each page is its own `<canvas>` managed by `page-canvas.ts`, which owns Pointer Events handling for every tool (draw, erase, lasso/tap select, drag transforms, in-place text editing), a cache canvas for committed strokes (so a live stroke redraw only repaints that one stroke, not the whole page), and per-page clipping. Supporting modules:
- `selection.ts` — the selection overlay: move/resize/rotate/delete handles for the active selection. Note: the on-canvas handles live inside the page's zoom-transformed subtree and position in page-local units for free via that CSS transform, **except** the delete button and the lasso callout, which are deliberately detached to `document.body` with `position: fixed` and manually computed screen coordinates — anything inside `.page-frame`'s `transform: scale(...)` is trapped in a nested stacking context and can never out-rank the fixed app-bar/dock regardless of its own z-index. Follow this same escape pattern for any other overlay element that must render above the dock.
- `elements.ts` — text/image/shape rendering and text wrapping.
- `geom.ts` — point-in-polygon, bounds, frame/rotation transforms (`rotateAround` etc.), shared by selection and guide math.
- `recognize.ts` — stroke → straight-line fitting for pen line-snap; line/arrow box geometry.
- `guide.ts` — ruler/protractor overlays and edge snapping (view-only, never persisted).
- `freehand.ts` — wraps `perfect-freehand` to produce a `Path2D`.
- `templates.ts` — paper background rendering (blank/ruled/grid/dot), color-aware.

### Tools & UI state

`src/tools.ts` holds current tool selection, colors, and sizes, persisted to `localStorage` (separate from the IndexedDB note data). `src/ui/notebook.ts` is the largest UI file: the notebook screen, toolbar/dock rendering per active tool, incremental page list, undo/redo stack. When adding a new per-tool dock option, follow the existing pattern of a `switch (toolState.kind)` in `renderTools()`.

### AI mode

A per-page toggle (`src/ai-mode.ts`) that, while active, rasterizes newly-written page regions and POSTs them to `/api/gemini` (`api/gemini.ts`, a Vercel serverless function — the only piece that needs Vercel specifically, since its secrets live there as project env vars) via `src/ai-render.ts`. Replies come back as ordinary violet-tinted text elements on the page. Because AI mode forces all ink to one fixed violet color regardless of tool color selection (see `PageCanvas.aiInkColor`), UI code that shows color pickers should generally hide them while AI mode is active for the current page (existing precedent: `notebook.ts`'s `aiColorsHidden()`) — but tools that recolor *existing* permanent content (e.g. lasso's recolor-selection swatches) are intentionally exempted, since that's unrelated to what new ink gets forced to.

### Export & import

`src/export/pdf.ts` (vector PDF via `pdf-lib`, lazy-loaded on export) and `src/export/raster.ts` (PNG/JPEG) render a page/notebook out. `src/pdf-import.ts` + `src/pdf-render.ts` bring a PDF in as a notebook, storing the file once and rendering pages on demand via `pdf.js` (lazy-loaded, wasm copied into `public/` by `scripts/copy-pdfjs-wasm.mjs` in `predev`/`prebuild`).

## Working conventions

- **Vanilla TypeScript only** — do not introduce a framework, state library, or build-step abstraction not already present.
- **Strict scope**: implement exactly what's asked; do not opportunistically refactor, add abstractions, or touch unrelated code in the same change.
- When a task explicitly asks for investigation/root-cause analysis before a fix, report the root cause before making changes.
- Run `npm run build` after any change and treat any `tsc` error as blocking.
- If other pre-existing issues are noticed while working but are out of scope, list them at the end of a report rather than fixing them.

### Verifying behavior

There is no automated UI test suite. Real verification means driving the actual app in a browser: run `npm run dev` and use a headless-Chrome CDP harness (small numbered scripts run against `cdp.mjs`) to script real pointer/touch interactions and assert on live DOM/canvas state — treat this the same as manually testing the feature would be treated in a framework-based app. Two known blind spots of CDP-synthetic events worth remembering when a report can't be reproduced:
- **`touch-action` gesture disambiguation** (tap vs. scroll/pan) is resolved by native gesture recognition on a real touchscreen before any pointer event fires; CDP's `Input.dispatch*` bypasses that entirely, so a missing `touch-action: none` on a small interactive element inside a pannable ancestor (`touch-action: pan-x pan-y`) can be a real device-only bug.
- Bugs that depend on scroll position relative to `position: fixed` chrome (app-bar/dock) need a scripted scroll to a specific offset to reproduce — a test that never scrolls won't find them.

Keep any throwaway CDP scripts and Chrome profile directories in the scratchpad directory, not the repo, and clean them up when done. Never kill Chrome by a blanket/name-based command (e.g. `taskkill /IM chrome.exe`) — only by the specific PID your own script spawned, since other Chrome instances may be running.

## Deployment

Static site deploys to GitHub Pages (`.github/workflows/deploy.yml`, builds on push to `main`) or Cloudflare Pages; the Gemini proxy (`api/gemini.ts`) is Vercel-specific regardless of where the static site itself is hosted. See the README's "Deploy for free" section for the full setup, required env vars (`GEMINI_API_KEY`, `GEMINI_PROXY_SECRET`, `VITE_GEMINI_PROXY_SECRET`, `VITE_GEMINI_ENDPOINT`), and the `base` path caveat (`/DubNotes/` is GitHub-Pages-specific; other hosts need `base: './'`).
