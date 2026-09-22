import { AiMode } from '../ai-mode';
import { AUTO_COLOR, resolveInkColor } from '../canvas/freehand';
import { itemBounds, rotateAround, unionRects, worldToScreen, type Camera, type Frame } from '../canvas/geom';
import type { GuideKind } from '../canvas/guide';
import { PageCanvas, TAPE_MIN } from '../canvas/page-canvas';
import type { Op } from '../canvas/page-canvas';
import { SelectionOverlay } from '../canvas/selection';
import { DEFAULT_PAPER, DPR, PAGE_W, pageH, pageW } from '../const';
import { store } from '../store';
import {
  addCustomColor,
  HI_COLORS,
  LASSO_SHAPES,
  PEN_COLORS,
  PLACED_SHAPES,
  removeCustomColor,
  saveToolState,
  sizeRange,
  toolState,
  type EraserMode,
  type LassoShape,
  type PlacedShape,
  type SizeRange,
  type ToolKind,
} from '../tools';
import { pickColor } from './color';
import { paperBg } from '../canvas/templates';
import type {
  Notebook,
  Page,
  PageElement,
  PageItem,
  Paper,
  PaperColor,
  PaperSpacing,
  PaperTemplate,
  Stroke,
} from '../types';
import { clamp, isStroke } from '../util';
import { loadImageFile } from '../media';
import { alertDialog, confirmDialog, openAnchoredModal, openModal, textPrompt, type Modal } from './dialog';
import { blockGestures, el } from './dom';
import { icon, type IconName } from './icon';

type ViewOp = Op | { kind: 'del-page'; page: Page; strokes: Stroke[]; elements: PageElement[] };
/** WebKit-only, non-standard: tags a Touch as a stylus contact — see bindZoomGestures and page-canvas.ts's own copy of this type. */
type WebKitTouch = Touch & { touchType?: 'direct' | 'stylus' };

/** Offset applied when pasting back onto the page the items were copied from. */
const PASTE_OFFSET = 24;

/** Size-slider magnetic snap: a dragged value within this much of a whole number lands exactly on it, so a whole size is easy to hit despite the slider's finer 0.1 step. */
const SIZE_SNAP_RADIUS = 0.25;

/** How long a press must be held, without much movement, before it arms a drag-to-reorder (page manager card, or a page in the main view). */
const LONG_PRESS_MS = 380;
/** Pointer movement, in px, allowed during the long-press window before it's treated as a scroll/tap instead of a hold. */
const LONG_PRESS_SLOP = 8;

/** The lasso's selection shapes, in dock order. */
const LASSO_OPTIONS: Record<LassoShape, { icon: IconName; label: string }> = {
  free: { icon: 'lasso', label: 'Freehand lasso' },
  box: { icon: 'shape-rect', label: 'Box select' },
  circle: { icon: 'shape-ellipse', label: 'Circle select' },
};

/** The Shapes tool's sub-options, in dock order. */
const SHAPE_OPTIONS: Record<PlacedShape, { icon: IconName; label: string }> = {
  rect: { icon: 'shape-rect', label: 'Rectangle' },
  ellipse: { icon: 'shape-ellipse', label: 'Ellipse' },
  arrow: { icon: 'shape-arrow', label: 'Arrow' },
  triangle: { icon: 'shape-triangle', label: 'Triangle' },
};
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;
/** Resting clearance kept above page 1 (screen px, at the current zoom — see minCameraY) so the page never rests touching or under the floating dock. Was `.nb-scroll`'s own CSS padding-top before the camera migration; now a pan-clamp bound instead, since content no longer sits in real scrollable flow. */
const TOP_CLEARANCE = 118;
/** Same idea below the last page (fraction of the viewport's own height, not zoom-scaled — see maxCameraY) — was `.nb-scroll`'s CSS padding-bottom. */
const BOTTOM_CLEARANCE_VH = 0.4;

export function mountNotebook(root: HTMLElement, notebookId: string): void {
  const nb = store.notebooks.get(notebookId);
  if (!nb) {
    location.hash = '#/';
    return;
  }
  new NotebookView(root, nb);
}

class NotebookView {
  private readonly root: HTMLElement;
  private nb: Notebook;

  private scrollEl!: HTMLElement;
  private toolsEl!: HTMLElement;
  /** Fixed-size row of tool icons + undo/redo — never changes with the active tool. */
  private toolsTopEl!: HTMLElement;
  /** Fixed-height row below it showing the active tool's own options (swatches, size, hints). */
  private toolsOptionsEl!: HTMLElement;
  private titleEl!: HTMLElement;
  private imageInput!: HTMLInputElement;
  private pdfInput!: HTMLInputElement;
  private undoBtn!: HTMLButtonElement;
  private redoBtn!: HTMLButtonElement;
  /** Single app-bar AI-mode controls, acting on whichever page is "current" (see setCurrentPage). */
  private aiToggleBtn!: HTMLButtonElement;
  private aiSendBtn!: HTMLButtonElement;
  /** The app bar's right-hand button group (everything but back/title) — queried in applyAiToolbarLockdown to disable every button there but aiToggleBtn/aiSendBtn while AI mode is on. */
  private appBarRightGroup!: HTMLElement;
  /** The dock's own Pen button — the one tool button AI mode leaves enabled (and turns violet); set fresh by renderTools each rebuild. */
  private penToolBtn!: HTMLButtonElement;
  /**
   * The single camera: `x`/`y` (world-space, pre-camera-transform "page-wrap
   * layout" units — see geom.ts's own Camera doc comment) is the point
   * currently at the viewport's top-left, `zoom` scales distances from
   * there. Applied to `cameraEl` as one CSS transform (applyCamera) instead
   * of native scroll mixed with a per-page CSS scale — replaces the old
   * `private zoom` field entirely; every former `this.zoom` read is now
   * `this.camera.zoom`. A stable object reference, mutated in place (not
   * reassigned) so every PageCanvas holding it always sees the current values.
   */
  private readonly camera: Camera = { x: 0, y: 0, zoom: 1 };
  /** `.nb-camera`: the single element the whole camera transform is applied to — every `.page-wrap` lives inside it. */
  private cameraEl!: HTMLElement;
  private pinch: { d0: number; z0: number; mx: number; my: number; cx: number; cy: number } | null = null;
  /**
   * One-finger pan (touch or pen — mouse panning is bindHandToolGestures'
   * own, hand-tool-only path). `vx`/`vy` (world units/ms) are a running
   * estimate of the finger's velocity, sampled each touchmove, used to kick
   * off momentum on lift — see startMomentum.
   */
  private pan: { touchId: number; lastX: number; lastY: number; lastT: number; vx: number; vy: number } | null = null;
  /** rAF handle for the momentum/rubber-band-snap-back animation — see startMomentum/stopMomentum. */
  private momentumRaf = 0;
  /** Hand tool, mouse only — touch/pen panning goes through the same one-finger-pan gesture as any other tool, see bindZoomGestures. */
  private handPan: { pointerId: number; x: number; y: number; camX: number; camY: number } | null = null;
  /** Recomputes the custom scrollbar thumb's size/position (see bindScrollbarThumb); called after anything that changes the camera or the notebook's total content height without itself going through applyCamera (syncPages). */
  private layoutScrollbarThumb: () => void = () => {};
  /** The cheap per-tick half of bindScrollbarThumb — just repositions the thumb via transform against already-cached size/range, called from every applyCamera(). */
  private repositionScrollbarThumb: () => void = () => {};
  /** The single, notebook-level selection box/handles overlay — see selection.ts's own doc comment for why there's one shared instance instead of one per page. */
  private overlay!: SelectionOverlay;
  /** Which page's selection the shared overlay is currently showing, if any — its onDragStart/onDrag/onDragEnd/onTap hooks route to this page's own PageCanvas. */
  private overlayPc: PageCanvas | null = null;
  /**
   * A shared, viewport-sized canvas (sibling of `.nb-camera`, like the
   * selection overlay) that a page's own live drag preview paints onto
   * instead of that page's own bounded view canvas — see PageCanvas's
   * showDragPreview hook doc comment for why. Sized/positioned to the
   * viewport, not any one page, so a dragged item stays visible regardless
   * of which page's screen area it's currently over.
   */
  private dragPreviewCanvas!: HTMLCanvasElement;
  private dragPreviewCtx: CanvasRenderingContext2D | null = null;

  private readonly pcByPage = new Map<string, PageCanvas>();
  private readonly wrapById = new Map<string, HTMLElement>();
  private readonly mounted = new Set<string>();
  private sizePopover: Modal | null = null;

  /** Tracks which page is most visible, for the "auto" ink swatch/dot preview — recomputed from the camera (updateVisiblePages) instead of a native-scroll-driven IntersectionObserver, since `.nb-scroll` no longer scrolls. */
  private readonly pageVisibility = new Map<string, number>();
  private currentPageId: string | null = null;
  private colorRefreshers: Array<() => void> = [];

  private readonly undoStack: ViewOp[] = [];
  private readonly redoStack: ViewOp[] = [];

  /** The page holding the current selection, if any (only one page at a time). */
  private selPc: PageCanvas | null = null;
  /** In-app clipboard: deep copies of the last copied items and where they came from. */
  private clipboard: PageItem[] = [];
  private clipboardPage: string | null = null;
  /**
   * Guards the paper-settings button against its own touch ghost-click: on a
   * touch device, dismissing the (non-anchored, centred) paper menu via a tap
   * on its backdrop still lets the browser's own compatibility `click` event
   * through afterward — unlike mousedown/mouseup, it isn't reliably
   * suppressed by calling preventDefault() on pointerdown (see openModal's
   * backdrop-dismiss handler). That synthetic click lands on whatever the
   * backdrop's removal just revealed — the paper button itself — and
   * reopens the menu it just closed. Sidesteps the same-icon `if already
   * open, close` toggle the anchored popovers use (this modal has no such
   * state to check, and shouldn't gain click-through-clearance semantics
   * just to work around this) by simply ignoring the button's click for a
   * brief window right after an outside-tap dismiss.
   */
  private paperMenuGuardUntil = 0;
  /** Same touch-ghost-click guard as paperMenuGuardUntil, for the page-manager button. */
  private pageMgrGuardUntil = 0;
  /** Ruler / protractor: view-only, lives on one page, re-shown when that page remounts. */
  private guideKind: GuideKind | null = null;
  private guidePageId: string | null = null;

  /**
   * Floating iOS-callout-style popover for a lasso selection (copy/cut/paste/
   * delete/duplicate) — see showSelectionCallout. `calloutPc` is which page's
   * selection it's currently showing for, so a *different* page's own
   * deselect event (firing after a fresh selection elsewhere already opened
   * the callout there — see onSelectionFrame) doesn't hide it out from under
   * the new one.
   */
  private calloutEl: HTMLElement | null = null;
  /** The visible pill inside calloutEl — a separate element so its `overflow: hidden` (which rounds the outer buttons' corners to match the pill) doesn't also clip the arrow, which lives on calloutEl itself. */
  private calloutPill: HTMLElement | null = null;
  private calloutPc: PageCanvas | null = null;
  /** The frame the callout is currently positioned against — re-placed (not re-shown) on scroll/resize, since neither changes the frame itself, only where it lands on screen. */
  private calloutFrame: Frame | null = null;

  /**
   * The tape resize/delete popover (see showTapePopover) — at most one open
   * at a time, same as the selection callout. Unlike every other anchored
   * popover in this app, a tape strip has no permanent DOM trigger to anchor
   * to (it's canvas-painted, not a real element), so `tapePopoverAnchor` is
   * one created on demand: an invisible, positioned, *actually hit-testable*
   * div sitting over the strip's own screen rect for as long as its popover
   * stays open — see showTapePopover's own doc comment for why that's what
   * makes openAnchoredModal's toggle-on-repeat-tap behaviour work here too.
   */
  private tapePopoverAnchor: HTMLElement | null = null;
  private tapePopoverModal: Modal | null = null;
  private tapePopoverPc: PageCanvas | null = null;
  private tapePopoverFrame: Frame | null = null;
  private tapePopoverTapeId: string | null = null;

  /** Bound so the same reference can be added to and removed from `window` — see the scroll/resize wiring in buildChrome and its cleanup in onLeave. */
  private readonly repositionCallout = (): void => {
    if (this.calloutEl && this.calloutPc && this.calloutFrame) {
      const pageRect = this.calloutPc.pageRect();
      if (pageRect) this.positionCallout(this.calloutEl, this.calloutFrame, pageRect, pageW(this.calloutPc.page));
    }
    if (this.tapePopoverAnchor && this.tapePopoverPc && this.tapePopoverFrame) {
      const pageRect = this.tapePopoverPc.pageRect();
      if (pageRect) this.positionTapeAnchor(this.tapePopoverAnchor, this.tapePopoverFrame, pageRect, pageW(this.tapePopoverPc.page));
    }
  };

  /** Sizes the shared drag-preview canvas to the current viewport — bound so the same reference can be added to and removed from `window`, same as repositionCallout. */
  private readonly layoutDragPreviewCanvas = (): void => {
    const w = this.scrollEl.clientWidth;
    const h = this.scrollEl.clientHeight;
    this.dragPreviewCanvas.width = w * DPR;
    this.dragPreviewCanvas.height = h * DPR;
    this.dragPreviewCanvas.style.width = `${w}px`;
    this.dragPreviewCanvas.style.height = `${h}px`;
  };

  private readonly onKey: (e: KeyboardEvent) => void;
  private readonly onLeave: () => void;

  private readonly aiMode: AiMode;

  constructor(root: HTMLElement, nb: Notebook) {
    this.root = root;
    this.nb = nb;
    this.aiMode = new AiMode(nb.id, {
      refreshPage: (pageId) => this.rebuildIfMounted(pageId),
      onActiveChanged: () => this.refreshAiControls(),
      onAiHistoryChanged: (pageId) => {
        if (pageId === this.currentPageId) this.syncHistory();
      },
    });
    void this.aiMode.loadConversation(); // async; resolves after buildChrome's mountPanel has run

    this.buildChrome();

    store.enforceTrailingBlank(this.nb.id);
    this.syncPages();
    // start fitted to the width on narrow screens, 100% otherwise — fit
    // against the first page's own width (a landscape-imported first page is
    // wider than the default, so it needs more shrinking to fit). Has to
    // wait until here (pages actually built into cameraEl by syncPages, not
    // just buildChrome's own DOM scaffolding) since setZoom's own clamping
    // needs a real content height to clamp against.
    const first = store.pagesOf(this.nb.id)[0];
    this.setZoom(Math.min(1, (this.scrollEl.clientWidth - 24) / (first ? pageW(first) : PAGE_W)) || 1); // applyCamera() (called from within) also runs the first updateVisiblePages()

    this.onKey = (e) => {
      if (!this.root.contains(this.scrollEl)) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const k = e.key.toLowerCase();
      if (!(e.metaKey || e.ctrlKey)) {
        if (e.key === 'Delete' || e.key === 'Backspace') {
          if (this.selPc?.hasSelection) {
            e.preventDefault();
            this.selPc.deleteSelection();
          }
        } else if (e.key === 'Escape') {
          this.selPc?.clearSelection();
        }
        return;
      }
      if (k === 'z' && !e.shiftKey) {
        e.preventDefault();
        this.undo();
      } else if ((k === 'z' && e.shiftKey) || k === 'y') {
        e.preventDefault();
        this.redo();
      } else if (k === 'c') {
        if (this.copySelection()) e.preventDefault();
      } else if (k === 'x') {
        if (this.cutSelection()) e.preventDefault();
      } else if (k === 'v') {
        if (this.pasteClipboard()) e.preventDefault();
      } else if (k === 'd') {
        if (this.duplicateSelection()) e.preventDefault();
      }
    };
    this.onLeave = () => {
      window.removeEventListener('keydown', this.onKey);
      window.removeEventListener('hashchange', this.onLeave);
      window.removeEventListener('resize', this.repositionCallout);
      window.removeEventListener('resize', this.layoutDragPreviewCanvas);
      this.hideSelectionCallout();
      this.hideTapePopover();
      this.deactivateAll(); // commit an open text edit before the canvases go away
      for (const id of this.mounted) this.pcByPage.get(id)?.unmount();
      this.stopMomentum();
      this.aiMode.destroyPanel();
      store.flushNow();
    };
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('hashchange', this.onLeave);
  }

  // --------------------------------------------------------------- chrome
  private buildChrome(): void {
    const view = el('div', { class: 'nb' });

    const bar = el('header', { class: 'nb-appbar' });

    const back = el('button', {
      class: 'iconbtn',
      title: 'Back to library',
      'aria-label': 'Back to library',
    });
    back.append(icon('arrow-left'));
    back.addEventListener('click', () => {
      location.hash = this.nb.folderId ? `#/f/${this.nb.folderId}` : '#/'; // back to the notebook's folder
    });

    this.titleEl = el('span', {
      class: 'nb-appbar__title',
      text: this.nb.name,
      title: 'Rename notebook',
    });
    this.titleEl.addEventListener('click', async () => {
      const name = await textPrompt({
        title: 'Rename notebook',
        value: this.nb.name,
        confirmText: 'Rename',
      });
      if (name == null) return;
      store.renameNotebook(this.nb.id, name);
      this.titleEl.textContent = this.nb.name;
    });

    this.undoBtn = el('button', {
      class: 'iconbtn',
      title: 'Undo',
      'aria-label': 'Undo',
    }) as HTMLButtonElement;
    this.undoBtn.append(icon('undo'));
    this.redoBtn = el('button', {
      class: 'iconbtn',
      title: 'Redo',
      'aria-label': 'Redo',
    }) as HTMLButtonElement;
    this.redoBtn.append(icon('redo'));
    this.undoBtn.addEventListener('click', () => this.undo());
    this.redoBtn.addEventListener('click', () => this.redo());

    this.aiToggleBtn = el('button', {
      class: 'iconbtn ai-toggle',
      title: 'DubNotes AI — read this page and reply',
      'aria-label': 'DubNotes AI',
      'aria-pressed': 'false',
    }) as HTMLButtonElement;
    this.aiToggleBtn.append(icon('ai'));
    this.aiToggleBtn.addEventListener('click', () => {
      // toggle() itself opens/closes the panel to match the resulting state — global, not tied to currentPageId
      this.aiMode.toggle();
    });

    this.aiSendBtn = el('button', {
      class: 'iconbtn ai-send',
      title: 'Send this turn to DubNotes AI now',
      'aria-label': 'Send this turn to DubNotes AI now',
      hidden: true,
    }) as HTMLButtonElement;
    this.aiSendBtn.append(icon('send'));
    this.aiSendBtn.addEventListener('click', () => {
      if (!this.currentPageId) return;
      // a snapped line can still be sitting uncommitted (adjustable handles,
      // not yet in the store) when Send is tapped — settle it first so this
      // turn's capture actually includes it. See PageCanvas.commitLine.
      this.pcByPage.get(this.currentPageId)?.commitLine();
      this.aiMode.sendNow(this.currentPageId);
    });

    // formerly a dock button ("insert actions" in the tools row); moved here
    // so it's reachable regardless of the active tool. Same file input/handler
    // as before, just relocated — functionality unchanged.
    const imgBtn = el('button', { class: 'iconbtn', title: 'Insert image', 'aria-label': 'Insert image' });
    imgBtn.append(icon('image'));
    imgBtn.addEventListener('click', () => this.imageInput.click());

    // appends a PDF's pages after the page in view, vs. the library's own
    // "Import file" which creates a whole new notebook from a PDF — same
    // underlying pdf-import.ts parsing, different insertion point.
    const pdfBtn = el('button', { class: 'iconbtn', title: 'Import PDF pages', 'aria-label': 'Import PDF pages' });
    pdfBtn.append(icon('import'));
    pdfBtn.addEventListener('click', () => this.pdfInput.click());

    const exportBtn = el('button', { class: 'iconbtn', title: 'Export', 'aria-label': 'Export' });
    exportBtn.append(icon('export'));
    exportBtn.addEventListener('click', () => this.openExportMenu(exportBtn));

    // formerly an inline "Paper" link on each page's own header; moved here
    // so it's reachable without scrolling to the page, and acts on whichever
    // page is currently in view (same page this bar's other per-page actions
    // — AI toggle/send — already target).
    const paperBtn = el('button', { class: 'iconbtn', title: 'Customize paper', 'aria-label': 'Customize paper' });
    paperBtn.append(icon('paper'));
    paperBtn.addEventListener('click', () => {
      if (Date.now() < this.paperMenuGuardUntil) return; // swallow the touch ghost-click right after a dismiss — see the field's own doc comment
      const page = this.currentPageId ? store.pages.get(this.currentPageId) : undefined;
      if (page) this.openPaperMenu(page);
    });

    // lists every page as a thumbnail: reorder / duplicate / delete, and jump
    // to one by tapping it. Page deletion now lives here (see openPageManager's
    // own doc comment) rather than in the paper-settings menu.
    const pagesBtn = el('button', { class: 'iconbtn', title: 'Manage pages', 'aria-label': 'Manage pages' });
    pagesBtn.append(icon('pages'));
    pagesBtn.addEventListener('click', () => {
      if (Date.now() < this.pageMgrGuardUntil) return; // same touch ghost-click guard as the paper button, see paperMenuGuardUntil
      void this.openPageManager();
    });

    // three grid zones (back | title | actions) so the title sits truly
    // centered in the bar regardless of how many buttons end up on each side
    // — undo/redo used to live in the right zone; now that they're in the
    // dock's top row instead, this keeps the bar from reading lopsided.
    const rightGroup = el('div', { class: 'nb-appbar__right' });
    rightGroup.append(this.aiToggleBtn, this.aiSendBtn, imgBtn, pdfBtn, exportBtn, pagesBtn, paperBtn);
    bar.append(back, this.titleEl, rightGroup);
    this.appBarRightGroup = rightGroup;

    // Notability-style dock: a fixed top row (tools + undo/redo, never reflows)
    // and a fixed-height options row below it for the active tool's own
    // controls, so switching tools never shifts the top row or the page below.
    this.toolsEl = el('div', { class: 'nb-dock nb-dock--collapsed' });
    this.toolsTopEl = el('div', { class: 'nb-dock__row nb-dock__row--tools' });
    this.toolsOptionsEl = el('div', { class: 'nb-dock__row nb-dock__row--options' });
    this.toolsEl.append(this.toolsTopEl, this.toolsOptionsEl);
    this.scrollEl = el('div', { class: 'nb-scroll' });
    this.cameraEl = el('div', { class: 'nb-camera' });
    this.dragPreviewCanvas = el('canvas', { class: 'nb-drag-preview' }) as HTMLCanvasElement;
    this.dragPreviewCtx = this.dragPreviewCanvas.getContext('2d');
    this.scrollEl.append(this.cameraEl, this.dragPreviewCanvas);
    window.addEventListener('resize', this.layoutDragPreviewCanvas);
    this.overlay = new SelectionOverlay(
      this.scrollEl,
      {
        onDragStart: () => this.overlayPc?.beginTransform(),
        onDrag: (f) => this.overlayPc?.updateTransform(f),
        onDragEnd: (f) => this.overlayPc?.endTransform(f),
        onTap: (x, y) => this.overlayPc?.tapSelection(x, y),
      },
      this.camera
    );
    blockGestures(this.scrollEl);
    this.bindZoomGestures();
    this.bindHandToolGestures();
    this.bindScrollbarThumb();
    // resizing changes where the selection lands on screen without changing
    // its frame — reposition the callout (if open) to match, same idea as
    // openModal's anchored popovers re-placing themselves on resize/
    // orientationchange. A bound method (not a local closure) so onLeave can
    // remove the same reference from `window` — otherwise every notebook
    // visit would leak one more resize listener onto it for the life of the
    // tab. (Panning/zooming reposition it directly from applyCamera instead
    // of a native 'scroll' event, which `.nb-scroll` no longer fires.)
    window.addEventListener('resize', this.repositionCallout);

    this.imageInput = el('input', {
      type: 'file',
      accept: 'image/*',
      style: 'display:none',
      'aria-hidden': 'true',
    }) as HTMLInputElement;
    this.imageInput.addEventListener('change', () => {
      const file = this.imageInput.files?.[0];
      this.imageInput.value = '';
      if (file) void this.insertImage(file);
    });

    this.pdfInput = el('input', {
      type: 'file',
      accept: 'application/pdf,.pdf',
      style: 'display:none',
      'aria-hidden': 'true',
    }) as HTMLInputElement;
    this.pdfInput.addEventListener('change', () => {
      const file = this.pdfInput.files?.[0];
      this.pdfInput.value = '';
      if (file) void this.importPdfPagesHere(file);
    });

    view.append(bar, this.toolsEl, this.scrollEl, this.imageInput, this.pdfInput);
    this.aiMode.mountPanel(view); // fixed-position, so it overlays regardless of where it sits in the DOM
    this.root.replaceChildren(view);
    // has to wait until scrollEl is actually attached and laid out —
    // clientWidth/Height (and so the canvas's own pixel size) read 0 before that.
    this.layoutDragPreviewCanvas();

    this.renderTools();
    this.syncHistory();
    this.refreshAiControls();
    // the initial fit-to-width setZoom() (see the constructor, right after
    // syncPages) has to wait until pages actually exist in `cameraEl` —
    // setZoom's own clamping needs a real content height to clamp against,
    // which is zero here (syncPages hasn't run yet).
  }

  // ----------------------------------------------------------------- camera
  /**
   * Writes the camera to `.nb-camera` as one CSS transform and settles
   * everything derived from it. `screenX = (worldX - camera.x) * camera.zoom`
   * (see geom.ts's own Camera doc comment) means the transform composes as
   * `scale(zoom) translate(-x, -y)` (CSS transform functions apply right to
   * left). `--zoom` is still set as a custom property purely for
   * `.guide__rot`'s counter-scale trick (guide.ts wasn't moved to a top-level
   * overlay the way SelectionOverlay was — it has no cross-page-drag concern
   * to escape a per-page stacking context for, so it's still nested per page
   * and still relies on inheriting an ambient scale, now from `.nb-camera`
   * instead of its own page's individual transform).
   */
  private applyCamera(): void {
    const { x, y, zoom } = this.camera;
    this.cameraEl.style.transform = `scale(${zoom}) translate(${-x}px, ${-y}px)`;
    this.scrollEl.style.setProperty('--zoom', String(zoom));
    this.repositionScrollbarThumb();
    this.overlay.update();
    this.repositionCallout();
    this.updateVisiblePages();
  }

  /**
   * Prepares the shared drag-preview canvas for `pc`'s own page-local unit
   * coordinates: clears it, then sets a transform so drawing with `pc`'s own
   * page-local units lands at the right screen position — the same
   * scale-then-translate the camera applies to `.nb-camera` via CSS, just
   * done with a canvas transform instead, and folding in `pc`'s own page
   * origin (that page's own offsetLeft/offsetTop within `.nb-camera`, i.e.
   * its world position) and DPR. See PageCanvas.showDragPreview's own doc
   * comment for why this exists instead of painting on `pc`'s own canvas.
   */
  private showDragPreview(pc: PageCanvas): CanvasRenderingContext2D | null {
    const ctx = this.dragPreviewCtx;
    if (!ctx) return null;
    const pageEl = this.wrapById.get(pc.page.id)?.querySelector<HTMLElement>('.page');
    if (!pageEl) return null;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.dragPreviewCanvas.width, this.dragPreviewCanvas.height);
    const { x, y, zoom } = this.camera;
    const s = zoom * DPR;
    ctx.setTransform(s, 0, 0, s, (pageEl.offsetLeft - x) * s, (pageEl.offsetTop - y) * s);
    return ctx;
  }

  /** Clears the shared drag-preview canvas — see PageCanvas.hideDragPreview's own doc comment for when this is called. */
  private hideDragPreview(): void {
    this.dragPreviewCtx?.setTransform(1, 0, 0, 1, 0, 0);
    this.dragPreviewCtx?.clearRect(0, 0, this.dragPreviewCanvas.width, this.dragPreviewCanvas.height);
  }

  /** The least `camera.y` allowed: page 1's own top can be dragged down to at most this many *world* units below the viewport top — i.e. `TOP_CLEARANCE` screen px of resting clearance under the dock, at the current zoom. */
  private minCameraY(): number {
    return -TOP_CLEARANCE / this.camera.zoom;
  }

  /** The greatest `camera.y` allowed: the last page's own bottom can't be dragged more than `BOTTOM_CLEARANCE_VH` of screen height above the viewport's bottom. */
  private maxCameraY(): number {
    const viewH = this.scrollEl.clientHeight;
    const contentH = this.cameraEl.offsetHeight;
    const bottomClearance = window.innerHeight * BOTTOM_CLEARANCE_VH;
    return Math.max(this.minCameraY(), contentH - (viewH - bottomClearance) / this.camera.zoom);
  }

  /** Clamps a candidate camera position to the valid pan range — the hard bound a rubber-banded drag/momentum eases toward, not a per-tick position itself. */
  /** The world-space horizontal extent of all page content (leftmost/rightmost page edge) — `.nb-camera` itself always reports offsetWidth equal to the viewport (a plain block fills its container regardless of its children's actual width; unlike offsetHeight, width isn't content-driven), so it can't be used directly to find how much horizontal content there actually is. */
  private contentWorldXBounds(): { left: number; right: number } {
    let left = Infinity;
    let right = -Infinity;
    for (const wrap of this.wrapById.values()) {
      const pageEl = wrap.querySelector<HTMLElement>('.page');
      if (!pageEl) continue;
      left = Math.min(left, pageEl.offsetLeft);
      right = Math.max(right, pageEl.offsetLeft + pageEl.offsetWidth);
    }
    return left === Infinity ? { left: 0, right: 0 } : { left, right };
  }

  /** Clamps horizontally against the page content's own world-space bounds (not a fixed 0, which only happens to be correct at 100% zoom) — once zoomed in far enough that a page renders wider than the viewport, panning across it needs a real, positive-or-negative range either side of 0. Narrower than the viewport (the common case): centres it exactly instead of leaving any slack to pan into. */
  private clampCamera(x: number, y: number): { x: number; y: number } {
    const viewW = this.scrollEl.clientWidth;
    const z = this.camera.zoom;
    const { left, right } = this.contentWorldXBounds();
    const viewWorldW = viewW / z;
    const clampedX =
      right - left <= viewWorldW ? left - (viewWorldW - (right - left)) / 2 : clamp(x, left, right - viewWorldW);
    return { x: clampedX, y: clamp(y, this.minCameraY(), this.maxCameraY()) };
  }

  /** Whether the horizontal axis has any real pan range at all — false in the common case (page narrower than the viewport), where clampCamera above collapses left/right to one fixed point rather than a genuine [min, max]. The soft-clamp paths (one-finger rubber-band, pinch pan, momentum) use this to skip their elastic drag-then-spring-back treatment entirely on that axis: with no range, there's no edge to overscroll, so it should just stay put instead of drifting and snapping back. */
  private hasHorizontalRange(): boolean {
    const { left, right } = this.contentWorldXBounds();
    return right - left > this.scrollEl.clientWidth / this.camera.zoom;
  }

  /**
   * Keeps whatever's under `anchor` (viewport/client coordinates; defaults to
   * the scroller's own centre) fixed on screen across the zoom change: convert
   * the anchor to a world-space point using the *current* camera, change
   * `camera.zoom`, then solve for the `camera.x/y` that puts that same world
   * point back under the same screen anchor — closed-form, no DOM
   * measurement (contrast the old per-page `elementFromPoint` +
   * before/after `getBoundingClientRect()` approach this replaced).
   */
  private setZoom(z: number, anchor?: { x: number; y: number }): void {
    const next = clamp(Math.round(z * 100) / 100, ZOOM_MIN, ZOOM_MAX);
    const rect = this.scrollEl.getBoundingClientRect();
    const sx = anchor ? anchor.x - rect.left : this.scrollEl.clientWidth / 2;
    const sy = anchor ? anchor.y - rect.top : this.scrollEl.clientHeight / 2;
    const wx = sx / this.camera.zoom + this.camera.x;
    const wy = sy / this.camera.zoom + this.camera.y;
    this.camera.zoom = next;
    const clamped = this.clampCamera(wx - sx / next, wy - sy / next);
    this.camera.x = clamped.x;
    this.camera.y = clamped.y;
    this.refreshAutoColors(); // the size dot previews at the on-screen stroke width
    for (const pc of this.pcByPage.values()) pc.zoomChanged(); // a pending line's handles stay screen-sized
    this.layoutScrollbarThumb(); // zoom changes the thumb's size/range, not just its position
    this.applyCamera();
  }

  /** Starts (or restarts) the momentum + rubber-band-settle animation after a pan gesture lifts with residual velocity, or lands out of bounds with none. `vx`/`vy` are world units/ms. */
  private startMomentum(vx: number, vy: number): void {
    this.stopMomentum();
    const FRICTION = 0.0035; // higher = faster decay
    const SPRING = 0.22; // how hard an out-of-bounds position eases back per frame
    let lastT: number | null = null;
    const step = (t: number): void => {
      const dt = Math.min(lastT == null ? 16 : t - lastT, 48);
      lastT = t;
      const decay = Math.exp(-FRICTION * dt);
      vx *= decay;
      vy *= decay;
      let nx = this.camera.x - vx * dt;
      let ny = this.camera.y - vy * dt;
      const clamped = this.clampCamera(nx, ny);
      const overX = nx - clamped.x;
      const overY = ny - clamped.y;
      if (overX !== 0) {
        nx = clamped.x + overX * (1 - SPRING);
        vx *= 1 - SPRING;
      }
      if (overY !== 0) {
        ny = clamped.y + overY * (1 - SPRING);
        vy *= 1 - SPRING;
      }
      this.camera.x = nx;
      this.camera.y = ny;
      this.applyCamera();
      const settled = Math.hypot(vx, vy) < 0.005 && Math.abs(overX) < 0.4 && Math.abs(overY) < 0.4;
      if (!settled) {
        this.momentumRaf = requestAnimationFrame(step);
      } else {
        this.camera.x = clamped.x;
        this.camera.y = clamped.y;
        this.applyCamera();
        this.momentumRaf = 0;
      }
    };
    this.momentumRaf = requestAnimationFrame(step);
  }

  private stopMomentum(): void {
    if (this.momentumRaf) cancelAnimationFrame(this.momentumRaf);
    this.momentumRaf = 0;
  }

  /**
   * One-finger pan, two-finger pinch-zoom, and ctrl/⌘ + wheel zoom, all
   * driven entirely by our own JS now that `.nb-scroll` doesn't scroll
   * natively (see its own CSS comment) — replaces native one-finger
   * scrolling, which used to need no code here at all.
   *
   * The pinch session, once started, stays owned for as long as *any*
   * (non-stylus) touch remains — not just while the count reads exactly 2.
   * Real two-finger releases are rarely simultaneous (one finger lifts a
   * beat early), and a third finger can graze the glass mid-gesture;
   * re-deriving "are we pinching" from the instantaneous touch count on
   * every event used to mean that single frame at the wrong count stopped
   * preventDefault() entirely, handing the still-moving remaining touch to
   * native pan-x pan-y — occasionally flinging a completely different page
   * into view. Now, once `pinch` is set, touchmove keeps suppressing native
   * scroll at any count; it only actually applies the zoom/pan math while
   * exactly 2 (non-stylus) touches are live, and just holds position (still
   * swallowing the event) otherwise. A single remaining touch after a pinch
   * ends is picked back up as a one-finger pan rather than dropped.
   *
   * A stylus contact (WebKit tags a `Touch` with `touchType: 'stylus'`) is
   * never eligible as a pan or pinch touch, at start or mid-gesture — a
   * finger panning when the Apple Pencil comes down is two touches by count
   * alone, but treating that as a pinch corrupted the pan and raced
   * page-canvas.ts's own stylus-promotion path (startPress/capture) for the
   * same contact, aborting the pencil's stroke. If a stylus joins (or was
   * already present) once a pan/pinch is already active, the session ends
   * outright rather than just skipping that tick's math, leaving the
   * pencil's own contact uncontested.
   */
  private bindZoomGestures(): void {
    const s = this.scrollEl;
    const dist = (t: TouchList): number => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const hasStylus = (t: TouchList): boolean =>
      Array.from(t).some((touch) => (touch as WebKitTouch).touchType === 'stylus');
    const beginPan = (t: Touch): void => {
      this.pan = { touchId: t.identifier, lastX: t.clientX, lastY: t.clientY, lastT: performance.now(), vx: 0, vy: 0 };
    };
    s.addEventListener(
      'touchstart',
      (e) => {
        this.stopMomentum();
        if (hasStylus(e.touches)) {
          this.pan = null;
          this.pinch = null;
          return;
        }
        if (e.touches.length >= 2) {
          this.pan = null;
          const mx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
          const my = (e.touches[0].clientY + e.touches[1].clientY) / 2;
          this.pinch = { d0: dist(e.touches), z0: this.camera.zoom, mx, my, cx: mx, cy: my };
        } else if (e.touches.length === 1 && !this.pinch) {
          beginPan(e.touches[0]);
        }
      },
      { passive: true }
    );
    s.addEventListener(
      'touchmove',
      (e) => {
        if (hasStylus(e.touches)) {
          // the pencil joined (or was already down) mid-gesture: bail out of
          // both pan and pinch entirely — see doc comment above.
          this.pan = null;
          this.pinch = null;
          return;
        }
        if (this.pinch) {
          e.preventDefault(); // own the whole gesture until every touch lifts — see doc comment above
          if (e.touches.length < 2) return; // no 2-touch baseline right now: hold position, keep suppressing native scroll
          const p = this.pinch;
          const rawMx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
          const rawMy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
          // Low-pass the midpoint (exponential smoothing against p.cx/p.cy,
          // the previous frame's already-smoothed value) before using it for
          // either the zoom anchor or the pan delta below — real touch input
          // never reports a perfectly stationary midpoint even for a pinch
          // the user intends to hold centred, and that sub-pixel sensor noise
          // was landing directly in camera.x/y every frame, unfiltered,
          // reading as a visible side-to-side jiggle. An isolated noisy
          // sample now only nudges the tracked midpoint a fraction of the
          // way toward it; a real, sustained movement (many frames in the
          // same direction) still catches up within a couple of frames —
          // imperceptible at typical touchmove sampling rates.
          const MIDPOINT_SMOOTHING = 0.5;
          const mx = p.cx + (rawMx - p.cx) * MIDPOINT_SMOOTHING;
          const my = p.cy + (rawMy - p.cy) * MIDPOINT_SMOOTHING;
          this.setZoom((p.z0 * dist(e.touches)) / p.d0, { x: mx, y: my });
          // setZoom's own clamp above already hard-writes camera.x to the
          // single fixed point every frame when there's no horizontal range
          // (the common narrower-than-viewport case) — applying the
          // midpoint's x delta on top of that would just reintroduce a
          // small drift each frame instead of leaving it locked.
          if (this.hasHorizontalRange()) this.camera.x -= (mx - p.cx) / this.camera.zoom; // pan with the midpoint
          this.camera.y -= (my - p.cy) / this.camera.zoom;
          this.applyCamera();
          p.cx = mx;
          p.cy = my;
          return;
        }
        const p = this.pan;
        if (!p || e.touches.length !== 1 || e.touches[0].identifier !== p.touchId) return;
        e.preventDefault();
        const t = e.touches[0];
        const now = performance.now();
        const dt = Math.max(1, now - p.lastT);
        const dx = (t.clientX - p.lastX) / this.camera.zoom;
        const dy = (t.clientY - p.lastY) / this.camera.zoom;
        const raw = { x: this.camera.x - dx, y: this.camera.y - dy };
        const clamped = this.clampCamera(raw.x, raw.y);
        // rubber-band: resist past the content bounds rather than hard-stopping
        // — but only where there's a real edge to resist past; with no
        // horizontal range at all, clamped.x is a single fixed point with
        // nothing on either side, so it stays locked there instead of
        // drifting under the drag and springing back on release.
        this.camera.x = this.hasHorizontalRange() ? clamped.x + (raw.x - clamped.x) * 0.35 : clamped.x;
        this.camera.y = clamped.y + (raw.y - clamped.y) * 0.35;
        this.applyCamera();
        p.vx = p.vx * 0.8 + (dx / dt) * 0.2; // smoothed velocity estimate, for momentum on lift
        p.vy = p.vy * 0.8 + (dy / dt) * 0.2;
        p.lastX = t.clientX;
        p.lastY = t.clientY;
        p.lastT = now;
      },
      { passive: false }
    );
    const endTouch = (e: TouchEvent): void => {
      if (e.touches.length >= 2) return; // still pinching (or a 3rd finger grazed) — see the pinch-session doc comment above
      if (e.touches.length === 1 && !hasStylus(e.touches)) {
        // one finger remains after a pinch (or an extra graze) ends — pick it
        // back up as a pan instead of dropping input until the next touchstart
        this.pinch = null;
        beginPan(e.touches[0]);
        return;
      }
      if (e.touches.length > 0) return; // the one remaining touch is a stylus — leave it alone entirely
      const p = this.pan;
      this.pinch = null;
      this.pan = null;
      if (!p) return;
      // p.vx tracks the finger's raw horizontal speed regardless of whether
      // the drag above actually moved camera.x (it's locked when there's no
      // horizontal range) — feeding it to momentum unfiltered would still
      // coast the locked axis away from its fixed point and spring it back,
      // the same symptom one frame later.
      const vx = this.hasHorizontalRange() ? p.vx : 0;
      const speed = Math.hypot(vx, p.vy);
      if (speed > 0.02) this.startMomentum(vx, p.vy);
      else {
        const clamped = this.clampCamera(this.camera.x, this.camera.y);
        if (clamped.x !== this.camera.x || clamped.y !== this.camera.y) this.startMomentum(0, 0); // settle leftover rubber-band overshoot even with no coasting velocity
      }
    };
    s.addEventListener('touchend', endTouch);
    s.addEventListener('touchcancel', endTouch);
    s.addEventListener(
      'wheel',
      (e) => {
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          this.setZoom(this.camera.zoom * Math.exp(-e.deltaY * 0.002), { x: e.clientX, y: e.clientY });
          return;
        }
        // plain wheel now has to pan the camera itself — .nb-scroll no longer
        // scrolls natively at all (see its own CSS comment)
        e.preventDefault();
        this.stopMomentum();
        const clamped = this.clampCamera(this.camera.x + e.deltaX / this.camera.zoom, this.camera.y + e.deltaY / this.camera.zoom);
        this.camera.x = clamped.x;
        this.camera.y = clamped.y;
        this.applyCamera();
      },
      { passive: false }
    );
  }

  /**
   * Hand tool: drag anywhere to pan. Touch and pen already pan via the same
   * one-finger gesture bindZoomGestures recognizes for any tool (PageCanvas's
   * own onDown steps aside entirely for this tool, see its own comment
   * there, letting the touch reach here instead of being claimed for
   * drawing). Mice have no such gesture of their own, so this handles that
   * one case manually — scoped to `pointerType === 'mouse'` specifically, so
   * it never double-pans a touch or pen drag bindZoomGestures is already
   * panning.
   */
  private bindHandToolGestures(): void {
    const s = this.scrollEl;
    s.addEventListener('pointerdown', (e) => {
      if (toolState.kind !== 'hand' || e.pointerType !== 'mouse') return;
      this.stopMomentum();
      this.handPan = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, camX: this.camera.x, camY: this.camera.y };
      try {
        s.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    });
    s.addEventListener('pointermove', (e) => {
      const p = this.handPan;
      if (!p || e.pointerId !== p.pointerId) return;
      // Unlike touch-pan and wheel-pan, this path was landing the camera
      // straight from the pointer delta with no clampCamera call, so a mouse
      // drag with the hand tool could push it arbitrarily far past the
      // content's actual bounds with no snap-back on release — leaving
      // nothing on screen for a subsequent lasso (or anything else) to hit.
      const clamped = this.clampCamera(
        p.camX - (e.clientX - p.x) / this.camera.zoom,
        p.camY - (e.clientY - p.y) / this.camera.zoom
      );
      this.camera.x = clamped.x;
      this.camera.y = clamped.y;
      this.applyCamera();
    });
    const end = (e: PointerEvent): void => {
      if (this.handPan?.pointerId === e.pointerId) this.handPan = null;
    };
    s.addEventListener('pointerup', end);
    s.addEventListener('pointercancel', end);
  }

  /**
   * A custom draggable scrollbar thumb over `.nb-scroll`, tracking
   * `camera.y` — the only scrollbar affordance on any pointer type now (see
   * the CSS comment on `.nb-scrollbar-thumb`), since there's no more native
   * scrolling for a desktop mouse to drag a real browser scrollbar on.
   * Positioned as `position: fixed` against `scrollEl`'s own live rect (so
   * it tracks the dock/app-bar chrome around it without hardcoding their
   * heights), the same escape-the-camera-transform pattern the page manager's
   * own drag uses.
   */
  private bindScrollbarThumb(): void {
    const s = this.scrollEl;
    const thumb = el('div', { class: 'nb-scrollbar-thumb' });
    document.body.append(thumb);

    const MIN_THUMB = 32;
    const INSET = 6;

    // trackH/thumbH/panRange only change with the scroller's own geometry or
    // the camera's zoom (resize, zoom, page add/remove) — layout()
    // recomputes them and the thumb's base `top`. A plain pan never touches
    // any of that, so applyCamera's per-tick path only calls reposition(),
    // which reads these cached values and moves the thumb purely via
    // `transform`, keeping every pan-tick update on the compositor thread
    // instead of triggering layout/paint (the cause of the iOS ghosting a
    // fixed-vs-transform split fixed here previously).
    let trackH = 0;
    let thumbH = 0;
    let panRange = 0;

    const reposition = (): void => {
      if (thumb.hidden) return;
      const progress = panRange > 0 ? clamp((this.camera.y - this.minCameraY()) / panRange, 0, 1) : 0;
      thumb.style.transform = `translate3d(0, ${progress * (trackH - thumbH)}px, 0)`;
    };
    this.repositionScrollbarThumb = reposition;

    const layout = (): void => {
      const track = s.getBoundingClientRect();
      trackH = track.height - INSET * 2;
      const minY = this.minCameraY();
      const maxY = this.maxCameraY();
      panRange = Math.max(0, maxY - minY);
      if (panRange <= 1) {
        thumb.hidden = true;
        return;
      }
      thumb.hidden = false;
      const viewWorldH = s.clientHeight / this.camera.zoom;
      const shownFraction = clamp(viewWorldH / (panRange + viewWorldH), 0.02, 1);
      thumbH = Math.min(trackH, Math.max(MIN_THUMB, shownFraction * trackH));
      thumb.style.top = `${track.top + INSET}px`;
      thumb.style.height = `${thumbH}px`;
      // `left`, computed from track.right alone, rather than a `right` built
      // from `window.innerWidth - track.right` — that mixed two separate
      // measurements that can briefly disagree during iOS's app-switcher
      // transition (the window is reported at its real size while
      // `.nb-scroll` itself is transiently rendered narrower, or vice
      // versa), which is what put the thumb at screen centre after
      // backgrounding: `right` baked in whichever mismatch was live the
      // instant this ran, and nothing recomputed it once the mismatch
      // cleared. `left` needs no second measurement to disagree with.
      thumb.style.left = `${track.right - thumb.offsetWidth - INSET / 2}px`;
      reposition();
    };
    this.layoutScrollbarThumb = layout;
    window.addEventListener('resize', layout);
    // Backstops for the same class of bug: `.nb-scroll`'s own box can change
    // shape (briefly, or for real) without a matching `window.resize` ever
    // firing — iOS doesn't reliably dispatch one when returning from the
    // app switcher. The ResizeObserver catches any actual change to the
    // track's rendered box (including the transient narrowing during
    // backgrounding and the restore afterward); visibilitychange/pageshow
    // are the direct backstop for iOS specifically not firing resize on
    // return to foreground.
    new ResizeObserver(() => layout()).observe(s);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) layout();
    });
    window.addEventListener('pageshow', () => layout());
    layout();

    let drag: { pointerId: number; startY: number; startCamY: number; trackH: number; thumbH: number } | null = null;
    thumb.addEventListener('pointerdown', (e) => {
      // a pinch's second finger can land on the thumb's own hit strip —
      // refuse to start a competing drag of our own while bindZoomGestures
      // owns the gesture; see its own doc comment for how long that is.
      if (this.pinch) return;
      e.preventDefault();
      this.stopMomentum();
      const track = s.getBoundingClientRect();
      drag = {
        pointerId: e.pointerId,
        startY: e.clientY,
        startCamY: this.camera.y,
        trackH: track.height - INSET * 2,
        thumbH: thumb.getBoundingClientRect().height,
      };
      try {
        thumb.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    });
    thumb.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      // a pinch can start after this drag already grabbed a pointer (the
      // thumb's own pointerdown races bindZoomGestures' touchstart) — bail
      // out rather than keep fighting it over camera.y for the rest of the
      // gesture.
      if (this.pinch) {
        drag = null;
        return;
      }
      const range = drag.trackH - drag.thumbH;
      const camDelta = range > 0 ? ((e.clientY - drag.startY) / range) * panRange : 0;
      this.camera.y = clamp(drag.startCamY + camDelta, this.minCameraY(), this.maxCameraY());
      this.applyCamera();
    });
    const endDrag = (e: PointerEvent): void => {
      if (drag?.pointerId === e.pointerId) drag = null;
    };
    thumb.addEventListener('pointerup', endDrag);
    thumb.addEventListener('pointercancel', endDrag);
  }

  /**
   * Generic hold-then-drag reorder, shared by the page manager's cards and
   * the main view's pages: press `trigger` and hold it still (within
   * LONG_PRESS_SLOP) for LONG_PRESS_MS to arm a drag of `item` among its
   * siblings inside `scroller` (direct children matching `itemSelector`).
   * Below the long-press threshold, or if the pointer moves first, nothing
   * happens and `trigger`'s own tap/click behaviour (if any) fires as usual.
   *
   * Once armed, `item` floats as `position: fixed` (escaping `scroller`'s
   * own clipping/scrolling the same way selection.ts's fixed-position pieces
   * escape the zoomed page subtree) and follows the pointer, while a
   * same-sized placeholder marks its live slot in `scroller` and is shuffled
   * as the pointer crosses other items. Dropping calls `onDrop` with the
   * placeholder's final index among `scroller`'s matching children;
   * `onDragStart` (if given) fires once the drag actually begins, so a
   * caller whose trigger is also a tap/click target (e.g. "go to this page")
   * can suppress the click that would otherwise follow the drag's pointerup.
   */
  private bindLongPressReorder(opts: {
    trigger: HTMLElement;
    item: HTMLElement;
    scroller: HTMLElement;
    itemSelector: string;
    onDragStart?: () => void;
    onDrop: (finalIndex: number) => void;
  }): void {
    const { trigger, item, scroller, itemSelector, onDragStart, onDrop } = opts;
    let armTimer = 0;
    let dragCtx: { pointerId: number; placeholder: HTMLElement; offsetX: number; offsetY: number; lastClientY: number } | null =
      null;
    let autoscrollRaf = 0;
    const AUTOSCROLL_EDGE = 56;
    const AUTOSCROLL_SPEED = 12;
    // `scroller` is either `this.scrollEl` (the main notebook view, which
    // hasn't been a real scrolling element since the camera migration — see
    // its own CSS comment) or the page manager's own `.pagemgr__grid` (a
    // separate, still genuinely-scrollable surface the migration never
    // touched). Writing scrollTop on the former is now a silent no-op, which
    // is exactly what broke this for reordering pages in the main view.
    const isCameraScroller = scroller === this.scrollEl;

    const autoscrollTick = (): void => {
      if (!dragCtx) {
        autoscrollRaf = 0;
        return;
      }
      const r = scroller.getBoundingClientRect();
      const y = dragCtx.lastClientY;
      const dir = y < r.top + AUTOSCROLL_EDGE ? -1 : y > r.bottom - AUTOSCROLL_EDGE ? 1 : 0;
      if (dir !== 0) {
        if (isCameraScroller) {
          const next = this.clampCamera(this.camera.x, this.camera.y + (dir * AUTOSCROLL_SPEED) / this.camera.zoom);
          this.camera.y = next.y;
          this.applyCamera();
        } else {
          scroller.scrollTop += dir * AUTOSCROLL_SPEED;
        }
      }
      autoscrollRaf = requestAnimationFrame(autoscrollTick);
    };

    const beginDrag = (e: PointerEvent): void => {
      const rect = item.getBoundingClientRect();
      // also carries itemSelector's own class so it counts as a match in the
      // scroller.querySelectorAll(itemSelector) lists used for index math below
      // (a plain 'reorder-placeholder' div would silently vanish from every
      // one of those lists, breaking both the live hover-swap and the final
      // drop-index calculation)
      const placeholder = el('div', { class: `reorder-placeholder ${itemSelector.slice(1)}` });
      placeholder.style.width = `${rect.width}px`;
      placeholder.style.height = `${rect.height}px`;
      item.before(placeholder);
      document.body.append(item);
      item.classList.add('reorder-dragging');
      Object.assign(item.style, {
        position: 'fixed',
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        pointerEvents: 'none',
        zIndex: '10000',
      });
      dragCtx = {
        pointerId: e.pointerId,
        placeholder,
        offsetX: e.clientX - rect.left,
        offsetY: e.clientY - rect.top,
        lastClientY: e.clientY,
      };
      try {
        trigger.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      if (!autoscrollRaf) autoscrollRaf = requestAnimationFrame(autoscrollTick);
      onDragStart?.();
    };

    const endDrag = (commit: boolean): void => {
      const ctx = dragCtx;
      if (!ctx) return;
      dragCtx = null;
      if (autoscrollRaf) {
        cancelAnimationFrame(autoscrollRaf);
        autoscrollRaf = 0;
      }
      const finalIndex = [...scroller.querySelectorAll(itemSelector)].indexOf(ctx.placeholder);
      ctx.placeholder.replaceWith(item);
      item.classList.remove('reorder-dragging');
      item.style.cssText = '';
      if (commit && finalIndex >= 0) onDrop(finalIndex);
    };

    trigger.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || dragCtx) return;
      const startX = e.clientX;
      const startY = e.clientY;
      const pointerId = e.pointerId;
      const cleanup = (): void => {
        trigger.removeEventListener('pointermove', onMoveBeforeArm);
        trigger.removeEventListener('pointerup', onEndBeforeArm);
        trigger.removeEventListener('pointercancel', onEndBeforeArm);
      };
      const onMoveBeforeArm = (me: PointerEvent): void => {
        if (me.pointerId !== pointerId) return;
        if (Math.hypot(me.clientX - startX, me.clientY - startY) > LONG_PRESS_SLOP) {
          clearTimeout(armTimer);
          cleanup();
        }
      };
      const onEndBeforeArm = (me: PointerEvent): void => {
        if (me.pointerId !== pointerId) return;
        clearTimeout(armTimer);
        cleanup();
      };
      trigger.addEventListener('pointermove', onMoveBeforeArm);
      trigger.addEventListener('pointerup', onEndBeforeArm);
      trigger.addEventListener('pointercancel', onEndBeforeArm);
      armTimer = window.setTimeout(() => {
        cleanup();
        beginDrag(e);
      }, LONG_PRESS_MS);
    });

    trigger.addEventListener('pointermove', (e) => {
      if (!dragCtx || e.pointerId !== dragCtx.pointerId) return;
      dragCtx.lastClientY = e.clientY;
      item.style.left = `${e.clientX - dragCtx.offsetX}px`;
      item.style.top = `${e.clientY - dragCtx.offsetY}px`;
      const hovered = document.elementFromPoint(e.clientX, e.clientY)?.closest(itemSelector) as HTMLElement | null;
      if (hovered && hovered !== dragCtx.placeholder && hovered.parentElement === scroller) {
        const children = [...scroller.querySelectorAll(itemSelector)];
        if (children.indexOf(hovered) > children.indexOf(dragCtx.placeholder)) hovered.after(dragCtx.placeholder);
        else hovered.before(dragCtx.placeholder);
      }
    });

    const finish = (e: PointerEvent): void => {
      if (!dragCtx || e.pointerId !== dragCtx.pointerId) return;
      endDrag(true);
    };
    trigger.addEventListener('pointerup', finish);
    trigger.addEventListener('pointercancel', finish);
  }

  // --------------------------------------------------------------- export
  private openExportMenu(anchor: HTMLElement): void {
    const current = this.currentPageId ? store.pages.get(this.currentPageId) : undefined;
    const page = current ?? store.pagesOf(this.nb.id)[0];
    const n = page ? page.index + 1 : 1;
    const menu = el('div', { class: 'menu', role: 'menu' });
    let modal: Modal | null = null;
    const item = (label: string, run: () => Promise<void>): void => {
      const b = el('button', { class: 'menu__item menu__item--icon', role: 'menuitem' });
      b.append(icon('export', 'sm'), el('span', { text: label }));
      b.addEventListener('click', () => {
        modal?.close();
        void this.runExport(run);
      });
      menu.append(b);
    };
    if (page) {
      item(`Page ${n} as PDF`, async () => {
        const { exportPdf } = await import('../export/pdf');
        await exportPdf(this.nb, [page], `${this.nb.name} - page ${n}`);
      });
    }
    item('Whole notebook as PDF', async () => {
      const { exportPdf } = await import('../export/pdf');
      await exportPdf(this.nb, this.contentPages(), this.nb.name);
    });
    if (page) {
      item(`Page ${n} as PNG`, async () => {
        const { exportPageImage } = await import('../export/raster');
        await exportPageImage(this.nb, page, 'png');
      });
      item(`Page ${n} as JPEG`, async () => {
        const { exportPageImage } = await import('../export/raster');
        await exportPageImage(this.nb, page, 'jpeg');
      });
    }
    modal = openAnchoredModal(anchor, menu);
  }

  /** Every page except the automatic trailing blank one (when there is more than one page). */
  private contentPages(): Page[] {
    const pages = store.pagesOf(this.nb.id);
    if (pages.length > 1 && store.isBlankPage(pages[pages.length - 1].id)) return pages.slice(0, -1);
    return pages;
  }

  private async runExport(run: () => Promise<void>): Promise<void> {
    this.deactivateAll(); // commit any open text edit first so it is included
    const box = el('div', { class: 'dlg' });
    box.append(el('h2', { class: 'dlg__title', text: 'Exporting…' }), el('p', { class: 'dlg__msg', text: 'Preparing the file.' }));
    const progress = openModal(box, { dismissable: false });
    try {
      await run();
    } catch (err) {
      await alertDialog({ title: 'Export failed', message: (err as Error).message || undefined });
    } finally {
      progress.close();
    }
  }

  /**
   * Shows the dock's options row. Called when a tool is first selected (its
   * colour/size/etc. controls are probably what you tapped it for) — never on
   * a timer, an outside tap, or starting to draw, so once open it stays open
   * until you explicitly close it (see closeDockOptions/toggleDockOptions).
   */
  private openDockOptions(): void {
    this.toolsEl.classList.remove('nb-dock--collapsed');
  }

  /** Hides the options row; also drops the size popover, whose anchor button lives in it. */
  private closeDockOptions(): void {
    this.sizePopover?.close();
    this.toolsEl.classList.add('nb-dock--collapsed');
  }

  /** Re-tapping the already-active tool's icon toggles the options row, the only way it closes. */
  private toggleDockOptions(): void {
    if (this.toolsEl.classList.contains('nb-dock--collapsed')) this.openDockOptions();
    else this.closeDockOptions();
  }

  private renderTools(): void {
    this.sizePopover?.close(); // switching tools (or any dock rebuild) dismisses the size popover
    this.colorRefreshers = []; // old closures would target elements this rebuild is about to discard
    this.scrollEl.classList.toggle('nb-scroll--hand', toolState.kind === 'hand'); // grab cursor, mouse-drag-to-pan feedback
    // `top`: the fixed row (tool icons + undo/redo) — same content/size no
    // matter what's selected. `opts`: the fixed-height row below it, whose
    // *content* changes per tool but whose height (via CSS) never does, so
    // neither row ever shifts the page below when a tool is switched.
    const top = this.toolsTopEl;
    const opts = this.toolsOptionsEl;
    top.replaceChildren();
    opts.replaceChildren();

    const toolBtn = (kind: ToolKind, name: IconName, label: string) => {
      const b = el('button', {
        class: 'tool' + (toolState.kind === kind ? ' active' : ''),
        title: label,
        'aria-label': label,
      });
      b.append(icon(name));
      b.addEventListener('click', () => {
        if (toolState.kind === kind) {
          // re-tapping the already-active tool: eraser's icon doubles as its
          // mode dropdown (its own anchored popover, toggled the same way);
          // every other tool toggles its options row closed/open again.
          if (kind === 'eraser') this.openEraserMenu(b);
          else this.toggleDockOptions();
          return;
        }
        this.deactivateAll(); // finish any text edit, drop any selection
        toolState.kind = kind;
        saveToolState();
        this.renderTools();
        this.openDockOptions(); // a freshly selected tool's own options are worth surfacing
      });
      return b;
    };
    // kept so applyAiToolbarLockdown can leave just this one enabled (and
    // colour it violet) while AI mode is on — see its own doc comment.
    this.penToolBtn = toolBtn('pen', 'pen', 'Pen') as HTMLButtonElement;
    top.append(
      this.penToolBtn,
      toolBtn('highlighter', 'highlighter', 'Highlighter'),
      toolBtn('eraser', 'eraser', 'Eraser'),
      toolBtn('lasso', 'lasso', 'Lasso select'),
      toolBtn('text', 'text', 'Text'),
      toolBtn('shapes', 'shapes', 'Shapes'),
      toolBtn('tape', 'tape', 'Tape'),
      toolBtn('laser', 'laser', 'Laser pointer'),
      toolBtn('hand', 'hand', 'Hand — drag to pan with pen or mouse, like a finger'),
      el('span', { class: 'divider' })
    );

    switch (toolState.kind) {
      case 'eraser': {
        const partial = toolState.eraserMode === 'partial';
        const modeBtn = el('button', {
          class: 'mode-btn',
          title: 'Eraser mode',
          'aria-label': 'Eraser mode',
          'aria-haspopup': 'menu',
        });
        modeBtn.append(ERASER_MODES[toolState.eraserMode].label, icon('chevron-down'));
        modeBtn.addEventListener('click', () => this.openEraserMenu(modeBtn));
        opts.append(
          modeBtn,
          el('span', {
            class: 'hint',
            text: partial ? 'Rub out just the parts you touch.' : 'Drag the pencil across a stroke to erase it.',
          })
        );
        break;
      }
      case 'lasso':
        this.renderLassoTools(opts);
        break;
      case 'tape':
        opts.append(
          el('span', {
            class: 'hint',
            text: 'Drag to cover an area. Tap a strip to peel it back; tap again to cover it.',
          })
        );
        break;
      case 'laser':
        opts.append(el('span', { class: 'hint', text: 'Point and drag: the trail fades and is never saved.' }));
        break;
      case 'hand':
        opts.append(el('span', { class: 'hint', text: 'Drag anywhere — with the pen, a finger, or the mouse — to pan the page.' }));
        break;
      case 'text':
        opts.append(
          this.buildSwatches(
            PEN_COLORS,
            toolState.textColor,
            (c) => {
              toolState.textColor = c;
              saveToolState();
              this.renderTools();
            },
            'pen'
          ),
          el('span', { class: 'hint', text: 'Tap to place text. Tap a box to edit it.' })
        );
        break;
      case 'shapes': {
        // which shape a drag places, then the outline's colour and width (the pen's)
        const picker = el('div', { class: 'dock-group', role: 'radiogroup', 'aria-label': 'Shape' });
        for (const kind of PLACED_SHAPES) {
          const opt = SHAPE_OPTIONS[kind];
          const active = toolState.shapeKind === kind;
          const b = el('button', {
            class: 'tool' + (active ? ' active' : ''),
            title: opt.label,
            'aria-label': opt.label,
            role: 'radio',
            'aria-checked': active ? 'true' : 'false',
          });
          b.append(icon(opt.icon));
          b.addEventListener('click', () => {
            if (toolState.shapeKind === kind) return;
            toolState.shapeKind = kind;
            saveToolState();
            this.renderTools();
          });
          picker.append(b);
        }
        opts.append(
          picker,
          el('span', { class: 'divider' }),
          this.buildSwatches(
            PEN_COLORS,
            toolState.penColor,
            (c) => {
              toolState.penColor = c;
              saveToolState();
              this.renderTools();
            },
            'pen'
          ),
          this.buildSizeControl(true)
        );
        // a shape is selected (freshly placed, or tapped to readjust): give it
        // the same reliable Delete action the Lasso tool's own selection row
        // has, rather than leaving the on-canvas × as the only way to delete
        // it — that button can end up rendered under the floating dock (see
        // the delete-bug report) when the shape sits near the top of the page,
        // where a lasso-based deletion still has this dock button to fall
        // back on but a shapes-tool selection previously didn't.
        if (this.selPc?.hasSelection) {
          opts.append(el('span', { class: 'divider' }), this.actionBtn('delete', 'Delete', () => this.selPc?.deleteSelection()));
        }
        opts.append(el('span', { class: 'hint', text: 'Drag to place a shape sized to the drag. Tap a shape to adjust it.' }));
        break;
      }
      default: {
        const isPen = toolState.kind === 'pen';
        const swatches = this.buildSwatches(
          isPen ? PEN_COLORS : HI_COLORS,
          isPen ? toolState.penColor : toolState.hiColor,
          (c) => {
            if (isPen) toolState.penColor = c;
            else toolState.hiColor = c;
            saveToolState();
            this.renderTools();
          },
          isPen ? 'pen' : 'highlighter'
        );
        opts.append(swatches, this.buildSizeControl(isPen));
        // line-snap lives on the pen only: draw a straight-ish stroke, hold
        // still, and it becomes a line you can adjust by its ends
        if (isPen) {
          opts.append(el('span', { class: 'hint', text: 'Hold still at the end of a straight stroke to snap it to a line.' }));
        }
      }
    }

    // drawing aids + undo/redo — independent of the active tool, so they live
    // in the fixed top row alongside the tool icons (the divider ending the
    // block above already separates them from the tools). Insert-image used
    // to live here too; it's now in the app bar (see buildChrome).
    const guideBtn = (kind: GuideKind, name: IconName, label: string): HTMLElement => {
      const b = el('button', {
        class: 'tool' + (this.guideKind === kind ? ' active' : ''),
        title: label,
        'aria-label': label,
        'aria-pressed': this.guideKind === kind ? 'true' : 'false',
      });
      b.append(icon(name));
      b.addEventListener('click', () => this.toggleGuide(kind));
      return b;
    };
    top.append(guideBtn('ruler', 'ruler', 'Ruler'), guideBtn('protractor', 'protractor', 'Protractor'));
    top.append(el('span', { class: 'divider' }), this.undoBtn, this.redoBtn);
    // a rebuild discards and recreates every button above — reapply the AI
    // lockdown (and the pen's violet colouring) to the fresh ones right away.
    this.applyAiToolbarLockdown();
  }

  /** Reads a picked photo / GIF and drops it on the page in view, selected, with the lasso tool active. */
  private async insertImage(file: File): Promise<void> {
    const target = this.currentPageId ? this.pcByPage.get(this.currentPageId) : null;
    if (!target?.mounted) return;
    let loaded;
    try {
      loaded = await loadImageFile(file);
    } catch (err) {
      await alertDialog({ title: 'Could not insert image', message: (err as Error).message || undefined });
      return;
    }
    if (toolState.kind !== 'lasso') {
      this.deactivateAll();
      toolState.kind = 'lasso';
      saveToolState();
    }
    target.insertImage(loaded.src, loaded.w, loaded.h);
    this.renderTools();
  }

  /**
   * Imports a PDF's pages, appended right after the page in view, via the
   * same pdf-import.ts parsing the library's "Import file" uses for a
   * whole new notebook — this just targets "append to this notebook"
   * instead. A non-dismissable progress dialog covers the read + per-page
   * setup so a large PDF never looks like a frozen screen.
   */
  private async importPdfPagesHere(file: File): Promise<void> {
    const pages = store.pagesOf(this.nb.id);
    const current = this.currentPageId ? store.pages.get(this.currentPageId) : undefined;
    const afterIndex = current?.index ?? pages.length - 1;

    const box = el('div', { class: 'dlg' });
    const msg = el('p', { class: 'dlg__msg', text: 'Reading PDF…' });
    box.append(el('h2', { class: 'dlg__title', text: `Importing ${file.name}` }), msg);
    const progress = openModal(box, { dismissable: false });
    try {
      const { importPdfPages } = await import('../pdf-import'); // pdf.js is loaded only when needed
      await importPdfPages(file, this.nb.id, afterIndex, (done, total) => {
        msg.textContent = `Preparing page ${done} of ${total}…`;
      });
      progress.close();
      store.enforceTrailingBlank(this.nb.id); // an imported PDF page isn't blank, so this may add one back
      this.syncPages();
    } catch (err) {
      progress.close();
      await alertDialog({ title: 'Import failed', message: (err as Error).message || undefined });
    }
  }

  /** Anchored dropdown with the two eraser modes; the choice is remembered in tool state. */
  private openEraserMenu(anchor: HTMLElement): void {
    const menu = el('div', { class: 'menu', role: 'menu' });
    let modal: Modal | null = null;
    for (const mode of ['whole', 'partial'] as EraserMode[]) {
      const item = el('button', {
        class: 'menu__item' + (toolState.eraserMode === mode ? ' active' : ''),
        role: 'menuitemradio',
        'aria-checked': toolState.eraserMode === mode ? 'true' : 'false',
      });
      const label = el('span');
      label.append(ERASER_MODES[mode].label, el('span', { class: 'menu__sub', text: ERASER_MODES[mode].sub }));
      item.append(icon('check'), label);
      item.addEventListener('click', () => {
        toolState.eraserMode = mode;
        saveToolState();
        modal?.close();
        this.renderTools();
      });
      menu.append(item);
    }
    modal = openAnchoredModal(anchor, menu);
  }

  /** Shows the ruler / protractor on the page in view, or hides it if it's already shown. */
  private toggleGuide(kind: GuideKind): void {
    const prev = this.guidePageId ? this.pcByPage.get(this.guidePageId) : null;
    prev?.hideGuide();
    if (this.guideKind === kind) {
      this.guideKind = this.guidePageId = null;
    } else {
      const target = this.currentPageId ? this.pcByPage.get(this.currentPageId) : null;
      if (!target?.mounted) return;
      target.showGuide(kind);
      this.guideKind = kind;
      this.guidePageId = target.page.id;
    }
    this.renderTools();
  }

  /** A single icon button for a dock action row (Delete, Copy, Duplicate, Paste, …). */
  private actionBtn(name: IconName, label: string, onClick: () => void): HTMLElement {
    const b = el('button', { class: 'tool', title: label, 'aria-label': label });
    b.append(icon(name));
    b.addEventListener('click', onClick);
    return b;
  }

  /**
   * Lasso dock: the selection-shape picker and recolour swatches. Copy / cut /
   * paste / delete / duplicate used to live here too — they're in the
   * floating selection callout now (see showSelectionCallout), so this only
   * renders a hint (nothing selected) or the recolour swatches (something is).
   */
  private renderLassoTools(t: HTMLElement): void {
    const items = this.selPc?.selectedItems() ?? [];
    const action = this.actionBtn;

    // how the next selection is drawn: freehand, or a box / circle from corner to corner
    const picker = el('div', { class: 'dock-group', role: 'radiogroup', 'aria-label': 'Selection shape' });
    for (const shape of LASSO_SHAPES) {
      const opt = LASSO_OPTIONS[shape];
      const active = toolState.lassoShape === shape;
      const b = el('button', {
        class: 'tool' + (active ? ' active' : ''),
        title: opt.label,
        'aria-label': opt.label,
        role: 'radio',
        'aria-checked': active ? 'true' : 'false',
      });
      b.append(icon(opt.icon));
      b.addEventListener('click', () => {
        if (toolState.lassoShape === shape) return;
        toolState.lassoShape = shape;
        saveToolState();
        this.renderTools();
      });
      picker.append(b);
    }
    t.append(picker, el('span', { class: 'divider' }));

    if (!items.length) {
      const how = toolState.lassoShape === 'free' ? 'Draw around items' : 'Drag across items';
      t.append(el('span', { class: 'hint', text: `${how} to select them.` }));
      if (this.clipboard.length) t.append(action('paste', 'Paste', () => this.pasteClipboard()));
      return;
    }

    const strokes = items.filter(isStroke);
    const hasPen = strokes.some((s) => s.tool === 'pen');
    const hasHi = strokes.some((s) => s.tool === 'highlighter');
    if (hasPen || hasHi) t.append(el('span', { class: 'divider' }));
    if (hasPen) {
      t.append(this.buildSwatches(PEN_COLORS, null, (c) => this.selPc?.recolorSelection('pen', c), 'pen'));
    }
    if (hasHi) {
      t.append(
        this.buildSwatches(HI_COLORS, null, (c) => this.selPc?.recolorSelection('highlighter', c), 'highlighter')
      );
    }
  }

  /**
   * A row of colour swatches: the presets, then the tool's custom colours, then
   * an "add colour" button that opens the picker. The "auto" swatch paints
   * itself from the page in view. Long-press / right-click a custom swatch to
   * remove it.
   */
  private buildSwatches(
    colors: string[],
    current: string | null,
    onPick: (c: string) => void,
    tool?: 'pen' | 'highlighter'
  ): HTMLElement {
    const swatches = el('div', { class: 'dock-group' });
    const custom = tool ? (tool === 'pen' ? toolState.customPen : toolState.customHi) : [];
    const add = (c: string, isCustom: boolean): void => {
      const isAuto = c === AUTO_COLOR;
      const s = el('button', {
        class: 'swatch' + (isAuto ? ' swatch--auto' : '') + (isCustom ? ' swatch--custom' : '') + (c === current ? ' active' : ''),
        style: isAuto ? '' : `background:${c}`,
        title: isAuto ? 'Auto — adapts to paper' : isCustom ? `${c} (custom — hold to remove)` : c,
        'aria-label': isAuto ? 'Ink auto — adapts to paper' : `Ink ${c}`,
      });
      if (isAuto) {
        const paint = (): void => {
          s.style.background = resolveInkColor(AUTO_COLOR, this.currentPaper());
        };
        paint();
        this.colorRefreshers.push(paint);
      }
      s.addEventListener('click', () => onPick(c));
      if (isCustom && tool) {
        const remove = (e: Event): void => {
          e.preventDefault();
          removeCustomColor(tool, c);
          saveToolState();
          this.renderTools();
        };
        s.addEventListener('contextmenu', remove);
        let hold: ReturnType<typeof setTimeout> | null = null;
        s.addEventListener('pointerdown', () => {
          hold = setTimeout(() => remove(new Event('hold')), 600);
        });
        for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) {
          s.addEventListener(ev, () => {
            if (hold != null) clearTimeout(hold);
            hold = null;
          });
        }
      }
      swatches.append(s);
    };
    for (const c of colors) add(c, false);
    for (const c of custom) add(c, true);
    if (tool) {
      const plus = el('button', { class: 'swatch swatch--add', title: 'Add colour', 'aria-label': 'Add colour' });
      plus.append(icon('plus', 'sm'));
      plus.addEventListener('click', async () => {
        const seed = tool === 'pen' ? toolState.penColor : toolState.hiColor;
        const hex = await pickColor(plus, seed === AUTO_COLOR ? '#2563eb' : seed);
        if (!hex) return;
        addCustomColor(tool, hex);
        saveToolState();
        onPick(hex.toLowerCase()); // the new colour becomes the current one
      });
      swatches.append(plus);
    }
    return swatches;
  }

  // ------------------------------------------------------------ selection
  private onSelection(pc: PageCanvas, count: number): void {
    if (count > 0) {
      const prev = this.selPc;
      this.selPc = pc;
      if (prev && prev !== pc) prev.clearSelection(); // one selection at a time
    } else if (this.selPc === pc) {
      this.selPc = null;
    }
    // the dock shows selection actions for both: lasso's own action row, and
    // the Shapes tool's Delete action (see the 'shapes' case in renderTools) —
    // a shape select-to-readjust (or a fresh placement) needs its own re-render
    // to pick up the newly-selected/deselected state.
    if (toolState.kind === 'lasso' || toolState.kind === 'shapes') this.renderTools();
  }

  /**
   * A lasso selection's frame changed (selected, dragged, resized, rotated,
   * or cleared — `frame` is null then). Shows/repositions/hides the floating
   * callout accordingly; a no-op outside the lasso tool (the Shapes tool's
   * own selection keeps using the dock's Delete action, unchanged).
   */
  private onSelectionFrame(pc: PageCanvas, frame: Frame | null): void {
    if (frame && toolState.kind === 'lasso') {
      this.calloutPc = pc;
      this.showSelectionCallout(pc, frame);
    } else if (pc === this.calloutPc) {
      // only the page the callout is currently anchored to gets to hide it —
      // deselecting a *different* page (e.g. the previous one, when a fresh
      // selection elsewhere just replaced it) must not hide the new one.
      this.calloutPc = null;
      this.hideSelectionCallout();
    }
  }

  private hideSelectionCallout(): void {
    this.calloutEl?.remove();
    this.calloutEl = null;
    this.calloutPill = null;
    this.calloutFrame = null;
  }

  /** Rebuilds the callout's buttons in place (e.g. Paste appearing right after a Copy) without moving it. */
  private refreshSelectionCallout(): void {
    if (!this.calloutPill) return;
    this.renderCalloutButtons(this.calloutPill);
  }

  /** Text-label items, iOS-callout order — Duplicate, Cut, Copy, [Paste], Delete. */
  private renderCalloutButtons(container: HTMLElement): void {
    const items: Array<[string, () => void]> = [
      ['Duplicate', () => this.duplicateSelection()],
      ['Cut', () => this.cutSelection()],
      ['Copy', () => this.copySelection()],
    ];
    if (this.clipboard.length) items.push(['Paste', () => this.pasteClipboard()]);
    items.push(['Delete', () => this.selPc?.deleteSelection()]);
    this.fillCalloutButtons(container, items);
  }

  /**
   * The empty-lasso-selection variant (see showEmptyLassoCallout): nothing
   * is selected, so Duplicate/Cut/Copy/Delete would all be no-ops — only
   * Paste ever applies here. Unlike renderCalloutButtons (which hides Paste
   * when the clipboard is empty — fine there, since Duplicate/Cut/Copy/
   * Delete are always present alongside it), Paste is this pill's *only*
   * possible button, so hiding it on an empty clipboard would leave a
   * literally empty, invisible pill — defeating the point of always showing
   * a callout here. Shown-but-disabled instead, via the app's existing
   * `button:disabled` convention (see styles.css), same as e.g. the page
   * manager's boundary-disabled move buttons.
   */
  private renderEmptyCalloutButtons(container: HTMLElement): void {
    container.replaceChildren();
    const b = el('button', { class: 'sel-callout__btn', role: 'menuitem', text: 'Paste' }) as HTMLButtonElement;
    b.disabled = !this.clipboard.length;
    // this callout only ever shows for a just-lassoed empty region (see
    // showEmptyLassoCallout), so calloutFrame — read fresh here, not
    // captured at button-creation time — is exactly the "paste here" the
    // user pointed at, not just the original copied position
    b.addEventListener('click', () => this.pasteClipboard(this.calloutFrame ?? undefined));
    container.append(b);
  }

  private fillCalloutButtons(container: HTMLElement, items: Array<[string, () => void]>): void {
    container.replaceChildren();
    items.forEach(([label, onClick], i) => {
      if (i > 0) container.append(el('span', { class: 'sel-callout__divider' }));
      const b = el('button', { class: 'sel-callout__btn', role: 'menuitem', text: label });
      b.addEventListener('click', onClick);
      container.append(b);
    });
  }

  /**
   * Floating popover mimicking iOS's text-selection callout (rounded pill,
   * light background, dark text, small arrow) — the real system menu isn't
   * reachable for canvas content, so this stands in for it. Lives in
   * `document.body` (position: fixed), never inside the zoomed `.page`
   * subtree — an element there can't out-rank the dock's z-index no matter
   * its own value (see the dock's own comment on this same trap), and this
   * needs to float above everything the same way. Positioned from `frame`
   * (this page's own units) via `pc.pageRect()` (that page's live screen
   * rect) so it tracks scroll/zoom/drag for free, each time it's told the
   * frame changed.
   */
  private showSelectionCallout(pc: PageCanvas, frame: Frame): void {
    const pageRect = pc.pageRect();
    if (!pageRect) {
      this.hideSelectionCallout();
      return;
    }
    if (!this.calloutEl) {
      this.calloutEl = el('div', { class: 'sel-callout', role: 'menu' });
      this.calloutPill = el('div', { class: 'sel-callout__pill' });
      this.calloutEl.append(this.calloutPill);
      document.body.append(this.calloutEl);
    }
    this.renderCalloutButtons(this.calloutPill!);
    this.calloutFrame = frame;
    this.positionCallout(this.calloutEl, frame, pageRect, pageW(pc.page));
  }

  /**
   * A lasso drag over empty space (see PageCanvas's onEmptyLassoSelection) —
   * there's nothing selected, so Duplicate/Cut/Copy/Delete would all be
   * no-ops; only Paste ever makes sense here. Shown regardless of clipboard
   * state (even an empty pill) so lassoing empty space always gives a
   * consistent place to check/attempt paste, positioned near the lasso
   * itself rather than no UI at all.
   */
  private showEmptyLassoCallout(pc: PageCanvas, frame: Frame): void {
    const pageRect = pc.pageRect();
    if (!pageRect) {
      this.hideSelectionCallout();
      return;
    }
    this.calloutPc = pc;
    if (!this.calloutEl) {
      this.calloutEl = el('div', { class: 'sel-callout', role: 'menu' });
      this.calloutPill = el('div', { class: 'sel-callout__pill' });
      this.calloutEl.append(this.calloutPill);
      document.body.append(this.calloutEl);
    }
    this.renderEmptyCalloutButtons(this.calloutPill!);
    this.calloutFrame = frame;
    this.positionCallout(this.calloutEl, frame, pageRect, pageW(pc.page));
  }

  /**
   * Places the callout centred above `frame`'s (rotation-aware) bounding box,
   * flipping below if that would go off the top of the viewport. Hides it
   * outright (rather than clamping to an edge) if the selection has scrolled
   * fully out of view, and keeps it clear of the AI side panel when that's
   * open, shifting right past it rather than rendering underneath.
   */
  private positionCallout(callout: HTMLElement, frame: Frame, pageRect: DOMRect, pw: number): void {
    const box = frameScreenBox(frame, pageRect, pw);

    const GAP = 10; // between the callout (or its arrow tip) and the selection
    const MARGIN = 8; // keep clear of the viewport edge
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;

    // the selection has scrolled fully out of view — hide rather than clamp
    // to whichever edge it last crossed, which would otherwise leave a
    // callout floating there with nothing visible for it to point at
    const offscreen = box.right < 0 || box.left > vw || box.bottom < 0 || box.top > vh;
    callout.hidden = offscreen;
    if (offscreen) return;

    // offsetWidth/Height reflect the callout's own content size regardless of
    // its current left/top, so no need to move it away to measure first —
    // that would just add a visible jump on every reposition during a drag.
    const cw = callout.offsetWidth;
    const ch = callout.offsetHeight;

    const spaceAbove = box.top - GAP - ch;
    const below = spaceAbove < MARGIN;
    callout.classList.toggle('sel-callout--below', below);

    const top = below ? box.bottom + GAP : spaceAbove;
    let left = (box.left + box.right) / 2 - cw / 2;
    // the AI panel (position: fixed, left: 0, up to 340px wide) sits above
    // everything at a higher z-index than the callout — if it's open, keep
    // clear of it rather than centring underneath/behind it. Always safe to
    // read: closed, it's slid off-screen via transform, so its own rect's
    // right edge is off past the left of the viewport and this no-ops.
    const panelRight = document.querySelector('.ai-panel')?.getBoundingClientRect().right ?? -Infinity;
    const minLeft = Math.max(MARGIN, panelRight + MARGIN);
    left = Math.max(minLeft, Math.min(left, vw - cw - MARGIN));
    const clampedTop = Math.max(MARGIN, Math.min(top, vh - ch - MARGIN));

    callout.style.left = `${Math.round(left)}px`;
    callout.style.top = `${Math.round(clampedTop)}px`;
    // the arrow points at the selection's horizontal centre even when the
    // callout itself got clamped sideways away from directly above it
    const arrowX = Math.max(12, Math.min((box.left + box.right) / 2 - left, cw - 12));
    callout.style.setProperty('--sel-callout-arrow-x', `${Math.round(arrowX)}px`);
  }

  // ------------------------------------------------------------ tape popover
  /**
   * Resize + delete popover for one tape strip — opened by a tap/hold while
   * the tape tool itself is active (see PageCanvas.handleTapeTap/onTapeTap;
   * every other tool's tap on the same strip still peels/covers it,
   * unaffected by any of this). In addition to the existing lasso-based
   * select/resize/delete, not a replacement for it.
   *
   * Every other anchored popover in this app (eraser mode, size slider, …)
   * anchors to a real, permanent DOM button, which is what lets
   * openAnchoredModal's own "second call for the same anchor closes it
   * instead of opening another" toggle work — and also what exempts a repeat
   * tap on that button from openModal's generic outside-tap dismiss (see its
   * onOutside: it skips closing when the tap lands on the anchor itself,
   * since the anchor's own click handler is already about to toggle it).
   * A tape strip has neither: it's canvas-painted, not a real element, so
   * there's nothing a second tap could land "on" for that exemption to
   * apply — without it, a second tap would hit the canvas, get treated as
   * outside, close the popover, and then this code would immediately reopen
   * a fresh one in the same breath (net effect: it never appears to close).
   *
   * The fix is to give it a real anchor: `tapePopoverAnchor`, an invisible
   * div positioned over the strip's own screen rect for as long as its
   * popover is open. A second tap in that same spot now hits *it* — exempt
   * from outside-dismiss, and its own click handler re-runs
   * openAnchoredModal, which is what actually closes it. A tap on a
   * *different* tape (or blank page) still reaches the canvas as normal,
   * triggers the generic outside-dismiss for whatever was open, and this
   * method then opens fresh for the new one.
   */
  private showTapePopover(pc: PageCanvas, tapeId: string, frame: Frame): void {
    const pageRect = pc.pageRect();
    if (!pageRect) return;
    this.tapePopoverPc = pc;
    this.tapePopoverFrame = frame;
    this.tapePopoverTapeId = tapeId;

    let anchor = this.tapePopoverAnchor;
    if (!anchor) {
      anchor = el('div', { class: 'tape-popover-anchor' });
      document.body.append(anchor);
      this.tapePopoverAnchor = anchor;
      // the second-tap toggle path (see the doc comment above) — fires only
      // when a real tap lands on this anchor, which only happens once it's
      // actually positioned over the strip
      anchor.addEventListener('click', () => this.openTapePopoverModal(pc, tapeId, anchor!));
    }
    this.positionTapeAnchor(anchor, frame, pageRect, pageW(pc.page));
    this.openTapePopoverModal(pc, tapeId, anchor);
  }

  /** Opens (or, per openAnchoredModal's own toggle rule, closes) the popover for `anchor` — a null return there just means this call closed the existing one instead of opening; onClose below already settles the state either way. */
  private openTapePopoverModal(pc: PageCanvas, tapeId: string, anchor: HTMLElement): void {
    const modal = openAnchoredModal(anchor, this.buildTapePopoverPanel(pc, tapeId), {
      onClose: () => {
        if (this.tapePopoverTapeId !== tapeId) return; // a newer popover already replaced this one
        this.tapePopoverModal = null;
        anchor.remove();
        this.tapePopoverAnchor = null;
        this.tapePopoverPc = null;
        this.tapePopoverFrame = null;
        this.tapePopoverTapeId = null;
      },
    });
    if (modal) this.tapePopoverModal = modal;
  }

  /** Closes the tape popover (if any) the proper way — through the Modal's own close(), so its backdrop/card are actually torn down rather than just this method's bookkeeping (leaving the real popover UI orphaned in the DOM, still catching clicks, is what plain field-nulling here used to do). onClose above does the rest of the state cleanup once close() runs it. */
  private hideTapePopover(): void {
    this.tapePopoverModal?.close();
  }

  /** Positions the invisible tape-popover anchor over a tape's own (rotation-aware) screen rect — same box math as positionCallout, just applied to the anchor's box instead of a centred pill. */
  private positionTapeAnchor(anchor: HTMLElement, frame: Frame, pageRect: DOMRect, pw: number): void {
    const box = frameScreenBox(frame, pageRect, pw);
    anchor.style.left = `${Math.round(box.left)}px`;
    anchor.style.top = `${Math.round(box.top)}px`;
    anchor.style.width = `${Math.round(box.right - box.left)}px`;
    anchor.style.height = `${Math.round(box.bottom - box.top)}px`;
  }

  /**
   * Width/height sliders (live preview via pc.previewTapeResize, one undo
   * step per drag/keypress session via pc.beginTapeResize/commitTapeResize)
   * plus Delete — see showTapePopover.
   */
  private buildTapePopoverPanel(pc: PageCanvas, tapeId: string): HTMLElement {
    const menu = el('div', { class: 'menu tape-popover', role: 'menu' });
    const current = pc.tapeGeometry(tapeId);
    if (!current) return menu;

    let wInput!: HTMLInputElement;
    let hInput!: HTMLInputElement;
    const sizeRow = (label: string, value: number, max: number): { row: HTMLElement; input: HTMLInputElement } => {
      const row = el('div', { class: 'tape-popover__row' });
      row.append(el('span', { class: 'tape-popover__label', text: label }));
      const input = el('input', {
        type: 'range',
        min: String(TAPE_MIN),
        max: String(Math.max(Math.round(max), TAPE_MIN)),
        step: '1',
        value: String(Math.round(value)),
        class: 'tape-popover__range',
        'aria-label': `Tape ${label.toLowerCase()}`,
      }) as HTMLInputElement;
      const readout = el('span', { class: 'tape-popover__value', text: `${Math.round(value)}` });
      // the first `input` of a drag/keypress arms the undo snapshot; `change`
      // (fires once, on release — for a keyboard nudge, immediately) commits
      // it as one step and re-arms for the next interaction
      let dragging = false;
      input.addEventListener('input', () => {
        if (!dragging) {
          pc.beginTapeResize(tapeId);
          dragging = true;
        }
        readout.textContent = input.value;
        pc.previewTapeResize(tapeId, Number(wInput.value), Number(hInput.value));
      });
      input.addEventListener('change', () => {
        pc.commitTapeResize(tapeId);
        dragging = false;
      });
      row.append(input, readout);
      return { row, input };
    };

    const w = sizeRow('Width', current.w, pageW(pc.page));
    const h = sizeRow('Height', current.h, pageH(pc.page));
    wInput = w.input;
    hInput = h.input;
    menu.append(w.row, h.row);

    menu.append(el('span', { class: 'menu__divider' }));
    const del = el('button', { class: 'menu__item menu__item--icon danger', role: 'menuitem' });
    del.append(icon('delete', 'sm'), el('span', { text: 'Delete' }));
    del.addEventListener('click', () => {
      pc.deleteTape(tapeId);
      this.hideTapePopover();
    });
    menu.append(del);

    return menu;
  }

  /** Finishes any text edit and drops any selection on every page. */
  private deactivateAll(): void {
    for (const pc of this.pcByPage.values()) pc.deactivate();
    this.selPc = null;
  }

  private copySelection(): boolean {
    const items = this.selPc?.selectedItems() ?? [];
    if (!items.length || !this.selPc) return false;
    this.clipboard = items.map((it) => JSON.parse(JSON.stringify(it)) as PageItem);
    this.clipboardPage = this.selPc.page.id;
    if (toolState.kind === 'lasso') {
      this.renderTools(); // the dock's own "nothing selected" hint picks up Paste too
      this.refreshSelectionCallout(); // still open on the same selection — Paste now belongs in it
    }
    return true;
  }

  /** Copies the selection, then deletes it — the callout's "Cut". */
  private cutSelection(): boolean {
    if (!this.copySelection()) return false;
    this.selPc?.deleteSelection();
    return true;
  }

  /**
   * Pastes onto the page with the selection, else the page in view; nudged
   * when it's the source page. `at`, when given, is an explicit "paste
   * here" location (in that page's units) — only the empty-lasso callout's
   * Paste button passes one, since a just-lassoed empty region is the one
   * case with an unambiguous target spot. Every clipboard item is then
   * offset so their combined bounding box lands centred on `at`, instead of
   * the usual same-page nudge from the copied items' own stored position.
   * `at` is paired with calloutPc (not selPc/currentPageId) as the target
   * page — it's meaningless against any page but the one it was measured on.
   */
  private pasteClipboard(at?: Frame): boolean {
    if (!this.clipboard.length) return false;
    const target = at ? this.calloutPc : (this.selPc ?? (this.currentPageId ? this.pcByPage.get(this.currentPageId) : null));
    if (!target?.mounted) return false;
    let dx: number;
    let dy: number;
    if (at) {
      const box = unionRects(this.clipboard.map(itemBounds));
      dx = box ? at.x + at.w / 2 - (box.x + box.w / 2) : 0;
      dy = box ? at.y + at.h / 2 - (box.y + box.h / 2) : 0;
    } else {
      dx = dy = target.page.id === this.clipboardPage ? PASTE_OFFSET : 0;
    }
    const items = this.clipboard.map((it) => PageCanvas.cloneItem(it, target.page.id, this.nb.id, dx, dy));
    // pasting again (without an explicit target) lands the next copy one step further along
    if (!at && dx) this.clipboard = items.map((it) => JSON.parse(JSON.stringify(it)) as PageItem);
    target.pasteItems(items);
    return true;
  }

  private duplicateSelection(): boolean {
    const pc = this.selPc;
    const items = pc?.selectedItems() ?? [];
    if (!pc || !items.length) return false;
    pc.pasteItems(items.map((it) => PageCanvas.cloneItem(it, pc.page.id, this.nb.id, PASTE_OFFSET, PASTE_OFFSET)));
    return true;
  }

  /**
   * Collapsed size control: a "Size" button whose only content is a black
   * preview dot (true on-page size, capped) — always black, regardless of the
   * tool's ink colour, so the size reads clearly even for light colours that
   * would otherwise blend into the dock; the button's own outline (CSS) keeps
   * the control itself findable. Tapping it opens the slider in an anchored
   * popover; the dot keeps updating during drag.
   */
  private buildSizeControl(isPen: boolean): HTMLElement {
    const sizeNow = (): number => (isPen ? toolState.penSize : toolState.hiSize);

    const btn = el('button', { class: 'size-btn', 'aria-label': 'Size', title: 'Size' });
    const dot = el('span', { class: 'size-btn__dot' });
    btn.append(dot);

    const paintDot = (v: number): void => {
      const d = Math.min(v * this.pageScale(), 18); // 18px caps the dot inside the (now 32px) .size-btn box; bigger reads from the number
      dot.style.width = `${d}px`;
      dot.style.height = isPen ? `${d}px` : `${Math.max(3, d * 0.5)}px`;
      dot.style.borderRadius = isPen ? '50%' : '2px';
      dot.style.background = '#000';
      dot.style.opacity = isPen ? '1' : '0.5';
    };
    paintDot(sizeNow());
    // re-paints on zoom changes too (pageScale depends on the current zoom), not just colour
    this.colorRefreshers.push(() => paintDot(sizeNow()));

    btn.addEventListener('click', () => {
      const { panel, refreshTicks } = this.buildSizePanel(isPen, paintDot);
      this.sizePopover = openAnchoredModal(btn, panel, {
        onReposition: refreshTicks, // build/rebuild ticks once mounted, and on resize/orientation
        onClose: () => {
          this.sizePopover = null;
        },
      });
    });

    return btn;
  }

  /**
   * The slider panel shown inside the popover: a continuous range with a
   * magnetic snap to whole numbers (see SIZE_SNAP_RADIUS), a tick layer, and
   * the numeric readout. Drag updates `toolState`, the readout and the dock
   * dot via `onLiveSize` — never a dock re-render; saved on release.
   * `refreshTicks` (re)builds the tick layer from the input's real rendered size.
   */
  private buildSizePanel(
    isPen: boolean,
    onLiveSize: (v: number) => void
  ): { panel: HTMLElement; refreshTicks: () => void } {
    const range = sizeRange(isPen ? 'pen' : 'highlighter');
    const current = isPen ? toolState.penSize : toolState.hiSize;

    const panel = el('div', { class: 'size-panel' });
    const row = el('div', { class: 'size-slider' });
    const ticks = el('div', { class: 'size-slider__ticks', 'aria-hidden': 'true' });

    const input = el('input', {
      type: 'range',
      class: 'size-slider__range',
      min: String(range.min),
      max: String(range.max),
      step: '0.1',
      value: String(current),
      'aria-label': `${isPen ? 'Pen' : 'Highlighter'} size`,
    }) as HTMLInputElement;

    const valueEl = el('span', { class: 'size-slider__value' });
    valueEl.textContent = current.toFixed(1);

    input.addEventListener('input', () => {
      let v = clamp(parseFloat(input.value), range.min, range.max);
      const whole = Math.round(v);
      if (whole >= range.min && whole <= range.max && Math.abs(v - whole) <= SIZE_SNAP_RADIUS) {
        v = whole;
        input.value = String(v); // snaps the visible thumb to the tick, not just the stored value
      }
      if (isPen) toolState.penSize = v;
      else toolState.hiSize = v;
      valueEl.textContent = v.toFixed(1);
      onLiveSize(v);
    });
    input.addEventListener('change', () => saveToolState());

    row.append(ticks, input);
    panel.append(row, valueEl);
    return { panel, refreshTicks: () => buildSizeTicks(ticks, input, range) };
  }

  /** Page-unit → CSS-px factor the mounted page canvases render at (matches `toLocal`). Just `this.camera.zoom` — screen px per page unit is the same for every page regardless of its own size, since a page's on-screen width is always (its own width in page units) × zoom. */
  private pageScale(): number {
    return this.camera.zoom;
  }

  // ---------------------------------------------------------------- pages

  /**
   * Reconciles the rendered page list against the store: departed pages are torn
   * down, new pages are built and inserted at the right spot, and survivors keep
   * their mounted canvases untouched. Only the page-number label and paper
   * background are refreshed in place.
   */
  private syncPages(): void {
    const pages = store.pagesOf(this.nb.id);
    const wanted = new Set(pages.map((p) => p.id));

    for (const id of [...this.pcByPage.keys()]) {
      if (!wanted.has(id)) this.disposePage(id);
    }

    pages.forEach((page, i) => {
      const wrap = this.wrapById.get(page.id) ?? this.buildPageWrap(page);

      const at = this.cameraEl.children.item(i);
      if (at !== wrap) this.cameraEl.insertBefore(wrap, at);

      const label = wrap.querySelector('.page-head span');
      const text = `Page ${i + 1}`;
      if (label && label.textContent !== text) label.textContent = text;

      this.applyPaperBg(wrap, page);
    });
    this.layoutScrollbarThumb(); // adding/removing pages changes the pannable range/thumb size
    this.updateVisiblePages(); // ...and which pages are now in view
  }

  private buildPageWrap(page: Page): HTMLElement {
    const wrap = el('div', { class: 'page-wrap' });
    // this page's own size (--pw/--ph inherited by .page-frame/.page/.page
    // canvas — see styles.css) — a landscape-imported page lays out at its
    // own aspect ratio instead of the fixed portrait default
    wrap.style.setProperty('--pw', `${pageW(page)}px`);
    wrap.style.setProperty('--ph', `${pageH(page)}px`);

    const headEl = el('div', { class: 'page-head' });
    const headLabel = el('span', { text: `Page ${page.index + 1}` });
    headEl.append(headLabel);
    // grouped so `.page-head`'s space-between only ever sees two children —
    // the label and this group — regardless of how many action buttons live here
    // (the "Paper" link that used to open here moved to the app bar, top right)
    const headActions = el('div', { class: 'page-head__actions' });
    headEl.append(headActions);
    // holding the label arms a drag-to-reorder of this page among the
    // notebook's others — kept off headActions so it never fights the AI
    // toggle button's own tap
    this.bindLongPressReorder({
      trigger: headLabel,
      item: wrap,
      scroller: this.scrollEl,
      itemSelector: '.page-wrap',
      onDrop: (finalIndex) => {
        if (store.reorderPage(page.id, finalIndex)) this.syncPages();
      },
    });

    const pageEl = el('div', { class: 'page' });
    pageEl.dataset.pageId = page.id;
    pageEl.style.background = paperBg(page.paper);
    blockGestures(pageEl);
    this.aiMode.attachPage(page, headActions, pageEl);

    // the frame takes the zoomed size in layout; the page inside is CSS-scaled
    const frame = el('div', { class: 'page-frame' });
    frame.append(pageEl);
    wrap.append(headEl, frame);

    const pc = new PageCanvas(
      page,
      this.nb,
      {
        onOp: (op) => {
          // ink drawn while AI mode is active is ephemeral (see AiMode) — it
          // never enters the main undo history, only AiMode's own turn-scoped
          // stack sees it (see AiMode.handleOp). A snapped line lands as an
          // 'add-items' op like any other insertion, so it's only excluded
          // here when PageCanvas itself flagged it as AI ink (aiInk).
          const isAiInk = this.aiMode.isActive() && (op.kind === 'add-stroke' || (op.kind === 'add-items' && op.aiInk));
          if (!isAiInk) this.pushOp(op);
          this.aiMode.handleOp(op);
        },
        onSelection: (p, n) => this.onSelection(p, n),
        onSelectionFrame: (p, frame) => this.onSelectionFrame(p, frame),
        onEmptyLassoSelection: (p, frame) => this.showEmptyLassoCallout(p, frame),
        onTapeTap: (p, tapeId, frame) => this.showTapePopover(p, tapeId, frame),
        isAiActive: () => this.aiMode.isActive(),
        refreshPage: (pageId) => this.rebuildIfMounted(pageId),
        adoptCrossPageLasso: (pageId, ids, lassoPath) => {
          if (this.mounted.has(pageId)) this.pcByPage.get(pageId)?.adoptCrossPageLasso(ids, lassoPath);
        },
        showSelection: (p, frame, opts) => {
          this.overlayPc = p;
          this.overlay.show(frame, opts, { origin: { x: pageEl.offsetLeft, y: pageEl.offsetTop }, pw: pageW(p.page), ph: pageH(p.page) });
        },
        updateSelection: (p, frame) => {
          if (this.overlayPc === p) this.overlay.update(frame);
        },
        hideSelection: (p) => {
          if (this.overlayPc === p) {
            this.overlay.hide();
            this.overlayPc = null;
          }
        },
        showDragPreview: (p) => this.showDragPreview(p),
        hideDragPreview: () => this.hideDragPreview(),
      },
      this.camera
    );
    this.pcByPage.set(page.id, pc);
    this.wrapById.set(page.id, wrap);
    return wrap;
  }

  private disposePage(id: string): void {
    this.aiMode.forgetPage(id);
    const wrap = this.wrapById.get(id);
    if (wrap) wrap.remove();
    const pc = this.pcByPage.get(id);
    pc?.unmount();
    if (pc && this.selPc === pc) this.selPc = null;
    if (pc && this.overlayPc === pc) {
      this.overlay.hide();
      this.overlayPc = null;
    }
    if (pc && this.tapePopoverPc === pc) this.hideTapePopover();
    if (id === this.guidePageId) this.guideKind = this.guidePageId = null;
    this.pcByPage.delete(id);
    this.wrapById.delete(id);
    this.mounted.delete(id);
    this.pageVisibility.delete(id);
    // Don't leave the dock resolving auto ink against a page that no longer
    // exists, even for one tick — pick the next most visible page right away.
    if (this.currentPageId === id) this.setCurrentPage(this.bestVisiblePage());
  }

  private applyPaperBg(wrap: HTMLElement, page: Page): void {
    const pageEl = wrap.querySelector<HTMLElement>('.page');
    if (!pageEl) return;
    const bg = paperBg(page.paper);
    if (pageEl.style.background !== bg) pageEl.style.background = bg;
  }

  /** Re-applies a single page's paper: background now, cache canvas if it is mounted. */
  private refreshPagePaper(page: Page): void {
    const wrap = this.wrapById.get(page.id);
    if (wrap) this.applyPaperBg(wrap, page);
    if (this.mounted.has(page.id)) this.pcByPage.get(page.id)?.paperChanged();
  }

  /**
   * Mounts/unmounts each page's PageCanvas based on whether it's within the
   * camera's own visible range (plus a preload margin), and tracks each
   * page's visible fraction for "current page" purposes — replaces a pair of
   * IntersectionObserver instances that used to do both jobs for free, since
   * those require a real scrolling `root`, which `.nb-scroll` no longer is
   * (see its own CSS comment). Called from applyCamera (every pan/zoom
   * change) and syncPages (page add/remove/reorder).
   */
  private updateVisiblePages(): void {
    const viewH = this.scrollEl.clientHeight;
    const margin = 1200 / this.camera.zoom; // world units — same preload buffer the old IntersectionObserver used (rootMargin '1200px 0px')
    const loadTop = this.camera.y - margin;
    const loadBottom = this.camera.y + viewH / this.camera.zoom + margin;
    const viewTop = this.camera.y;
    const viewBottom = this.camera.y + viewH / this.camera.zoom;
    for (const [id, wrap] of this.wrapById) {
      const pageEl = wrap.querySelector<HTMLElement>('.page');
      const pc = this.pcByPage.get(id);
      if (!pageEl || !pc) continue;
      const pTop = pageEl.offsetTop;
      const pBottom = pTop + pageEl.offsetHeight;
      if (pBottom > loadTop && pTop < loadBottom) {
        pc.mount(pageEl);
        this.mounted.add(id);
        if (this.guideKind && id === this.guidePageId) pc.showGuide(this.guideKind);
      } else if (this.mounted.has(id)) {
        pc.unmount();
        if (!pc.mounted) this.mounted.delete(id);
      }
      const visibleH = Math.max(0, Math.min(pBottom, viewBottom) - Math.max(pTop, viewTop));
      const ratio = pageEl.offsetHeight > 0 ? visibleH / pageEl.offsetHeight : 0;
      if (ratio > 0) this.pageVisibility.set(id, ratio);
      else this.pageVisibility.delete(id);
    }
    // Keep the last page when nothing is visible for a moment (e.g. mid-layout).
    const best = this.bestVisiblePage();
    if (best) this.setCurrentPage(best);
  }

  /** The visible page with the greatest intersection ratio, or null if none is on screen. */
  private bestVisiblePage(): string | null {
    let best: string | null = null;
    let bestRatio = 0;
    for (const [id, ratio] of this.pageVisibility) {
      if (ratio > bestRatio) {
        bestRatio = ratio;
        best = id;
      }
    }
    return best;
  }

  /** Sets the "current" page and repaints auto-ink dock elements if it changed. */
  private setCurrentPage(id: string | null): void {
    if (id === this.currentPageId) return;
    this.currentPageId = id;
    this.refreshAutoColors();
    this.refreshAiControls();
  }

  /** Reflects AI mode's global state on the single app-bar toggle + send buttons, and on undo/redo (which switch to AI-scoped history while active). */
  private refreshAiControls(): void {
    const active = this.aiMode.isActive();
    this.aiToggleBtn.classList.toggle('active', active);
    this.aiToggleBtn.setAttribute('aria-pressed', String(active));
    this.aiSendBtn.hidden = !active;
    this.applyAiToolbarLockdown();
    this.syncHistory();
  }

  /**
   * While AI mode is on, every toolbar/app-bar button is genuinely disabled
   * (not just dimmed) except the pen, Undo/Redo, the AI toggle and the Send
   * button — AI mode is meant to be a focused "just draw, undo/redo, and
   * send" surface, not a place to also switch tools, insert images, manage
   * pages, etc. `button:disabled` already renders greyed-out and inert (see
   * styles.css), so this only needs to set the attribute on the right
   * elements. Undo/redo are left alone here and handled by syncHistory
   * instead (it already owns their disabled state the rest of the time), so
   * they keep reflecting AiMode's own per-page canUndo/canRedo rather than
   * being force-disabled like everything else. Reapplied on every dock
   * rebuild too (renderTools), since that discards and recreates all of
   * these as fresh elements.
   */
  private applyAiToolbarLockdown(): void {
    const active = this.aiMode.isActive();
    if (active) this.sizePopover?.close(); // its trigger is about to be disabled too
    this.penToolBtn?.classList.toggle('tool--ai', active);
    for (const b of this.toolsTopEl.querySelectorAll('button')) {
      if (b === this.penToolBtn || b === this.undoBtn || b === this.redoBtn) continue;
      (b as HTMLButtonElement).disabled = active;
    }
    for (const b of this.toolsOptionsEl.querySelectorAll('button')) {
      (b as HTMLButtonElement).disabled = active;
    }
    for (const b of this.appBarRightGroup.querySelectorAll('button')) {
      if (b === this.aiToggleBtn || b === this.aiSendBtn) continue;
      (b as HTMLButtonElement).disabled = active;
    }
  }

  /** Paper of the page currently in view, for resolving the "auto" ink token. */
  private currentPaper(): Paper {
    const current = this.currentPageId ? store.pages.get(this.currentPageId) : undefined;
    return current?.paper ?? store.pagesOf(this.nb.id)[0]?.paper ?? DEFAULT_PAPER;
  }

  /** Repaints every dock element whose colour depends on the current page's paper. */
  private refreshAutoColors(): void {
    for (const fn of this.colorRefreshers) fn();
  }

  // ----------------------------------------------------------- paper menu
  /**
   * Template/spacing/colour/scope are all staged in `draft`/`scope` — picking
   * an option only updates the segmented control's own selected-state (see
   * segmented()) and this local state, nothing is written to the store or
   * rendered onto the page until Confirm. Closing the menu any other way
   * (outside tap, Escape, navigating away) discards the draft with no effect,
   * since nothing was ever applied to discard.
   */
  private openPaperMenu(page: Page): void {
    const TEMPLATES: PaperTemplate[] = ['blank', 'ruled', 'grid', 'dot'];
    const SPACINGS: PaperSpacing[] = ['narrow', 'medium', 'wide'];
    const COLORS: PaperColor[] = ['white', 'cream', 'dark'];

    let scope: 'page' | 'all' = 'all';
    let draft: Paper = { ...page.paper };

    // spacing only means something once there's ruling to space — dim it for
    // blank, but keep the stored value so it comes back for ruled/grid/dot
    const spacingRow = segmented(
      ['Narrow', 'Medium', 'Wide'],
      SPACINGS.indexOf(draft.spacing),
      (i) => {
        draft = { ...draft, spacing: SPACINGS[i] };
      }
    );
    setSegmentedDisabled(spacingRow, draft.template === 'blank');

    const templateRow = segmented(
      ['Blank', 'Ruled', 'Grid', 'Dot'],
      TEMPLATES.indexOf(draft.template),
      (i) => {
        draft = { ...draft, template: TEMPLATES[i] };
        setSegmentedDisabled(spacingRow, TEMPLATES[i] === 'blank');
      }
    );

    const wrap = el('div', { class: 'dlg paper-menu' });
    wrap.append(
      el('h2', { class: 'dlg__title', text: `Page ${page.index + 1} paper` }),
      field('Template', templateRow),
      field('Line spacing', spacingRow),
      field(
        'Paper color',
        segmented(['White', 'Cream', 'Dark'], COLORS.indexOf(draft.color), (i) => {
          draft = { ...draft, color: COLORS[i] };
        })
      ),
      field(
        'Apply to',
        segmented(['This page', 'All pages'], 1, (i) => {
          scope = i === 0 ? 'page' : 'all';
        })
      )
    );

    const confirmBtn = el('button', { class: 'primary dlg__wide', text: 'Confirm' });
    wrap.append(confirmBtn);

    const modal = openModal(wrap, {
      // see paperMenuGuardUntil's own doc comment: arms on every close, not
      // just a backdrop-tap dismiss, since the Confirm button's own ghost
      // click can't land on the paper button anyway — simplest to just always set it.
      onClose: () => {
        this.paperMenuGuardUntil = Date.now() + 400;
      },
    });
    confirmBtn.addEventListener('click', () => {
      store.setPaper(page.id, draft, scope);
      if (scope === 'all') for (const p of store.pagesOf(this.nb.id)) this.refreshPagePaper(p);
      else this.refreshPagePaper(page);
      this.refreshAutoColors();
      modal.close();
    });
  }

  /**
   * Deletes a page (undo-tracked). Was previously unreferenced — a "Delete
   * page" button in openPaperMenu was removed on request, leaving this ready
   * to rewire; the page manager (openPageManager) is now that place, per the
   * same request.
   */
  private removePage(page: Page): void {
    const strokes = store.strokesOf(page.id).map((s) => ({ ...s }));
    const elements = store.elementsOf(page.id).map((e) => ({ ...e }));
    store.deletePage(page.id);
    this.pushOp({ kind: 'del-page', page: { ...page }, strokes, elements });
    this.syncPages();
  }

  /** Runs the "one trailing blank page" invariant; reconciles pages if it changed structure. */
  private enforceAndMaybeRerender(): void {
    if (store.enforceTrailingBlank(this.nb.id)) this.syncPages();
  }

  /** Scrolls to a page and marks it "current" right away (rather than waiting for the scroll to settle and the view-intersection observer to catch up). */
  private goToPage(pageId: string): void {
    const wrap = this.wrapById.get(pageId);
    const pageEl = wrap?.querySelector<HTMLElement>('.page');
    if (pageEl) {
      this.stopMomentum();
      const clamped = this.clampCamera(this.camera.x, pageEl.offsetTop);
      this.camera.y = clamped.y;
      this.applyCamera();
    }
    this.setCurrentPage(pageId);
  }

  /**
   * Full-screen page manager: every page as a thumbnail, in order — reorder
   * (hold a thumbnail to drag it, or the up/down arrows), duplicate, delete,
   * or tap one to jump to it. Thumbnails are rendered once per open and
   * cached in `thumbs` for the rest of the session — reordering/deleting
   * just redraws the list from the cache; only a freshly duplicated page
   * renders new pixels.
   */
  private async openPageManager(): Promise<void> {
    const { renderPageCanvas } = await import('../export/raster'); // pulls in the (lazy) export/render code only when this opens
    // rendered wider than the CSS grid's minimum column (150px) since the
    // thumbnail box stretches to fill wider columns on a big screen —
    // the canvas would otherwise upscale and look soft
    const THUMB_W = 260;
    const thumbs = new Map<string, HTMLCanvasElement>();

    const wrap = el('div', { class: 'pagemgr' });
    const head = el('div', { class: 'pagemgr__head' });
    head.append(el('h2', { class: 'pagemgr__title', text: 'Pages' }));
    const closeBtn = el('button', { class: 'iconbtn', title: 'Close', 'aria-label': 'Close' });
    closeBtn.append(icon('close'));
    head.append(closeBtn);
    const grid = el('div', { class: 'pagemgr__grid' });
    wrap.append(head, grid);

    const modal = openModal(wrap, {
      cardClass: 'modal-card--pages',
      onClose: () => {
        this.pageMgrGuardUntil = Date.now() + 400; // see pageMgrGuardUntil's own doc comment
      },
    });
    closeBtn.addEventListener('click', () => modal.close());

    const actionBtn = (name: IconName, label: string, disabled: boolean, run: () => void): HTMLButtonElement => {
      const b = el('button', { class: 'iconbtn', title: label, 'aria-label': label }) as HTMLButtonElement;
      b.append(icon(name));
      b.disabled = disabled;
      b.addEventListener('click', run);
      return b;
    };

    const render = (): void => {
      const pages = store.pagesOf(this.nb.id);
      grid.replaceChildren();
      pages.forEach((page, i) => {
        const card = el('div', { class: 'pagemgr__card' });

        const thumbBtn = el('button', {
          class: 'pagemgr__thumbbtn',
          title: `Go to page ${i + 1}`,
          'aria-label': `Go to page ${i + 1}`,
        });
        const thumbBox = el('span', { class: 'pagemgr__thumb' });
        thumbBox.style.aspectRatio = `${pageW(page)} / ${pageH(page)}`; // a landscape-imported page thumbnails at its own shape, not the default portrait box
        thumbBtn.append(thumbBox, el('span', { class: 'pagemgr__num', text: `Page ${i + 1}` }));
        let suppressClick = false;
        thumbBtn.addEventListener('click', () => {
          if (suppressClick) {
            suppressClick = false;
            return;
          }
          modal.close();
          this.goToPage(page.id);
        });
        this.bindLongPressReorder({
          trigger: thumbBtn,
          item: card,
          scroller: grid,
          itemSelector: '.pagemgr__card',
          onDragStart: () => {
            suppressClick = true;
          },
          onDrop: (finalIndex) => {
            if (store.reorderPage(page.id, finalIndex)) {
              this.syncPages();
              render();
            }
          },
        });

        const cached = thumbs.get(page.id);
        if (cached) {
          thumbBox.append(cached);
        } else {
          void renderPageCanvas(page, THUMB_W / pageW(page))
            .then((c) => {
              c.className = 'pagemgr__canvas';
              thumbs.set(page.id, c);
              thumbBox.replaceChildren(c);
            })
            .catch(() => {
              /* a page whose background image fails to decode just keeps a blank thumbnail */
            });
        }

        const actions = el('div', { class: 'pagemgr__actions' });
        actions.append(
          actionBtn('arrow-up', 'Move page up', i === 0, () => {
            store.movePage(page.id, -1);
            this.syncPages();
            render();
          }),
          actionBtn('arrow-down', 'Move page down', i === pages.length - 1, () => {
            store.movePage(page.id, 1);
            this.syncPages();
            render();
          }),
          actionBtn('duplicate', 'Duplicate page', false, () => {
            store.duplicatePage(page.id);
            store.enforceTrailingBlank(this.nb.id);
            this.syncPages();
            render();
          }),
          actionBtn('delete', 'Delete page', false, async () => {
            const ok = await confirmDialog({
              title: `Delete page ${i + 1}?`,
              message: 'Its strokes and content will be removed from this notebook.',
              confirmText: 'Delete page',
              danger: true,
            });
            if (!ok) return;
            thumbs.delete(page.id);
            this.removePage(page);
            render();
          })
        );

        card.append(thumbBtn, actions);
        grid.append(card);
      });
    };
    render();
  }

  // -------------------------------------------------------------- history
  private pushOp(op: ViewOp): void {
    this.undoStack.push(op);
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack.length = 0;
    this.syncHistory();
    this.enforceAndMaybeRerender();
  }

  /** While AI mode is active on the current page, Undo/Redo act on that
   * turn's own ephemeral ink stack instead of the notebook's normal
   * content — see AiMode.undo/redo. Either way, a tape popover's sliders
   * reflect a snapshot of one specific tape's geometry — undo/redo can
   * change (or remove) it out from under the popover with no pointer event
   * to trigger the usual outside-tap dismiss, so it's closed unconditionally
   * here rather than risk it going stale. */
  private undo(): void {
    if (this.currentPageId && this.aiMode.isActive()) {
      if (this.aiMode.canUndo(this.currentPageId)) this.hideTapePopover();
      this.aiMode.undo(this.currentPageId);
      return;
    }
    const op = this.undoStack.pop();
    if (!op) return;
    this.hideTapePopover();
    this.invert(op);
    this.redoStack.push(op);
    this.syncHistory();
    this.enforceAndMaybeRerender();
  }

  private redo(): void {
    if (this.currentPageId && this.aiMode.isActive()) {
      if (this.aiMode.canRedo(this.currentPageId)) this.hideTapePopover();
      this.aiMode.redo(this.currentPageId);
      return;
    }
    const op = this.redoStack.pop();
    if (!op) return;
    this.hideTapePopover();
    this.forward(op);
    this.undoStack.push(op);
    this.syncHistory();
    this.enforceAndMaybeRerender();
  }

  private invert(op: ViewOp): void {
    switch (op.kind) {
      case 'add-stroke':
        store.removeStrokes(op.pageId, new Set([op.stroke.id]));
        this.rebuildIfMounted(op.pageId);
        break;
      case 'erase':
        for (const s of op.strokes) store.addStroke({ ...s });
        this.rebuildIfMounted(op.pageId);
        break;
      case 'add-items':
        store.removeItems(op.pageId, new Set(op.items.map((it) => it.id)));
        this.rebuildIfMounted(op.pageId);
        break;
      case 'remove-items':
        store.addItems(op.items.map((it) => ({ ...it })));
        this.rebuildIfMounted(op.pageId);
        break;
      case 'replace-items':
        store.replaceItems(op.pageId, op.before.map((it) => ({ ...it })));
        this.rebuildIfMounted(op.pageId);
        break;
      case 'edit':
        store.removeItems(op.pageId, new Set(op.added.map((it) => it.id)));
        store.addItems(op.removed.map((it) => ({ ...it })));
        this.rebuildIfMounted(op.pageId);
        break;
      case 'move-page':
        store.removeItems(op.toPageId, new Set(op.after.map((it) => it.id)));
        store.addItems(op.before.map((it) => ({ ...it })));
        this.rebuildIfMounted(op.fromPageId);
        this.rebuildIfMounted(op.toPageId);
        break;
      case 'del-page':
        store.insertPage({ ...op.page }, op.page.index);
        for (const s of op.strokes) store.addStroke({ ...s });
        for (const e of op.elements) store.addElement({ ...e });
        this.syncPages();
        break;
    }
  }

  private forward(op: ViewOp): void {
    switch (op.kind) {
      case 'add-stroke':
        store.addStroke({ ...op.stroke });
        this.rebuildIfMounted(op.pageId);
        break;
      case 'erase':
        store.removeStrokes(op.pageId, new Set(op.strokes.map((s) => s.id)));
        this.rebuildIfMounted(op.pageId);
        break;
      case 'add-items':
        store.addItems(op.items.map((it) => ({ ...it })));
        this.rebuildIfMounted(op.pageId);
        break;
      case 'remove-items':
        store.removeItems(op.pageId, new Set(op.items.map((it) => it.id)));
        this.rebuildIfMounted(op.pageId);
        break;
      case 'replace-items':
        store.replaceItems(op.pageId, op.after.map((it) => ({ ...it })));
        this.rebuildIfMounted(op.pageId);
        break;
      case 'edit':
        store.removeItems(op.pageId, new Set(op.removed.map((it) => it.id)));
        store.addItems(op.added.map((it) => ({ ...it })));
        this.rebuildIfMounted(op.pageId);
        break;
      case 'move-page':
        store.removeItems(op.fromPageId, new Set(op.before.map((it) => it.id)));
        store.addItems(op.after.map((it) => ({ ...it })));
        this.rebuildIfMounted(op.fromPageId);
        this.rebuildIfMounted(op.toPageId);
        break;
      case 'del-page':
        store.deletePage(op.page.id);
        this.syncPages();
        break;
    }
  }

  /** After undo/redo touched a page: drop any selection there (it may reference gone items) and repaint. */
  private rebuildIfMounted(pageId: string): void {
    if (this.mounted.has(pageId)) this.pcByPage.get(pageId)?.refresh();
  }

  /** Undo/redo button enabled state — reflects AiMode's turn-scoped stack while it's active on the current page (Undo/Redo are exceptions to the toolbar lockdown, see applyAiToolbarLockdown), the main stacks otherwise. */
  private syncHistory(): void {
    if (this.currentPageId && this.aiMode.isActive()) {
      this.undoBtn.disabled = !this.aiMode.canUndo(this.currentPageId);
      this.redoBtn.disabled = !this.aiMode.canRedo(this.currentPageId);
      return;
    }
    this.undoBtn.disabled = this.undoStack.length === 0;
    this.redoBtn.disabled = this.redoStack.length === 0;
  }
}

const ERASER_MODES: Record<EraserMode, { label: string; sub: string }> = {
  whole: { label: 'Whole stroke', sub: 'Removes any stroke you touch' },
  partial: { label: 'Partial', sub: 'Removes only the parts you touch' },
};

/** A page-unit Frame's (rotation-aware) bounding box, in fixed screen px — shared by positionCallout and positionTapeAnchor. */
function frameScreenBox(frame: Frame, pageRect: DOMRect, pw: number): { left: number; top: number; right: number; bottom: number } {
  const scale = pageRect.width / pw;
  const cx = frame.x + frame.w / 2;
  const cy = frame.y + frame.h / 2;
  const corners = [
    [frame.x, frame.y],
    [frame.x + frame.w, frame.y],
    [frame.x + frame.w, frame.y + frame.h],
    [frame.x, frame.y + frame.h],
  ].map(([x, y]) => rotateAround(x, y, cx, cy, frame.rot));
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of corners) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return {
    left: pageRect.left + minX * scale,
    top: pageRect.top + minY * scale,
    right: pageRect.left + maxX * scale,
    bottom: pageRect.top + maxY * scale,
  };
}

/** A row of mutually-exclusive pill buttons; calls `onPick` with the chosen index. */
function segmented(labels: string[], activeIndex: number, onPick: (i: number) => void): HTMLElement {
  const row = el('div', { class: 'seg' });
  const btns: HTMLButtonElement[] = [];
  labels.forEach((label, i) => {
    const b = el('button', {
      type: 'button',
      class: 'seg__btn' + (i === activeIndex ? ' active' : ''),
      text: label,
    }) as HTMLButtonElement;
    b.addEventListener('click', () => {
      for (const x of btns) x.classList.remove('active');
      b.classList.add('active');
      onPick(i);
    });
    btns.push(b);
    row.append(b);
  });
  return row;
}

function field(label: string, control: HTMLElement): HTMLElement {
  const f = el('div', { class: 'dlg__field' });
  f.append(el('span', { class: 'dlg__flabel', text: label }), control);
  return f;
}

/** Dims a `segmented()` row without removing it — its buttons pick up the shared button:disabled style. */
function setSegmentedDisabled(row: HTMLElement, disabled: boolean): void {
  for (const b of row.querySelectorAll<HTMLButtonElement>('.seg__btn')) b.disabled = disabled;
}

/** Smallest of 1 / 2 / 5 whose spacing over `usablePx` is at least 8px (else 5). */
function tickStep(span: number, usablePx: number): number {
  const pxPerUnit = usablePx / span;
  for (const s of [1, 2, 5]) if (s * pxPerUnit >= 8) return s;
  return 5;
}

/**
 * (Re)fills a positioned tick layer. Geometry comes from the input itself — its
 * actual rendered width and the `--size-thumb-w` custom property — so ticks stay
 * aligned to the thumb centre (thumb-width inset at both ends) even if the track
 * has been squeezed. Step adapts to keep minor ticks >= 8px apart; a major tick
 * every 5 steps.
 */
function buildSizeTicks(layer: HTMLElement, input: HTMLInputElement, range: SizeRange): void {
  const trackW = input.getBoundingClientRect().width;
  if (!trackW) return;
  const thumb = parseFloat(getComputedStyle(input).getPropertyValue('--size-thumb-w')) || 16;
  const usable = trackW - thumb;
  const span = range.max - range.min;
  const step = tickStep(span, usable);
  const majorEvery = step * 5;

  layer.replaceChildren();
  for (let v = Math.ceil(range.min / step) * step; v <= range.max + 1e-9; v += step) {
    const x = thumb / 2 + ((v - range.min) / span) * usable;
    const major = Math.abs(v % majorEvery) < 1e-9;
    const tick = el('span', {
      class: major ? 'size-slider__tick size-slider__tick--major' : 'size-slider__tick',
    });
    tick.style.left = `${x}px`;
    layer.append(tick);
  }
}
