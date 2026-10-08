import { AiMode } from '../ai-mode';
import { AUTO_COLOR, resolveInkColor, setPaperOverlayVars } from '../canvas/freehand';
import { itemBounds, rotateAround, unionRects, worldToScreen, type Camera, type Frame } from '../canvas/geom';
import type { GuideKind } from '../canvas/guide';
import { BoardCanvas, mindMapEnabled } from '../canvas/board-canvas';
import { cloneItems, type ItemSurface } from '../canvas/item-surface';
import { PageCanvas } from '../canvas/page-canvas';
import type { Op } from '../canvas/page-canvas';
import { SelectionOverlay } from '../canvas/selection';
import { DEFAULT_PAPER, DPR, PAGE_W, pageH, pageW } from '../const';
import { store } from '../store';
import {
  addCustomColor,
  LASSO_SHAPES,
  PLACED_SHAPES,
  removeSwatch,
  resetActiveColorsToPrimary,
  restorePreset,
  saveToolState,
  setSwatchOrder,
  setToolOrder,
  sizeRange,
  toolState,
  type EraserMode,
  type LassoShape,
  type PlacedShape,
  type SizeRange,
  type DockPosition,
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
import { alertDialog, confirmDialog, openAnchoredModal, openModal, textPrompt, type Modal, type PopoverDirection } from './dialog';
import { blockGestures, el } from './dom';
import { icon, type IconName } from './icon';
import { IMAGE_ACCEPT, SecondaryPane } from './secondary-pane';

type ViewOp =
  | Op
  | { kind: 'del-page'; page: Page; strokes: Stroke[]; elements: PageElement[] }
  /** page manager multi-select delete: one undo step; `items` in ascending original index */
  | { kind: 'del-pages'; items: Array<{ page: Page; strokes: Stroke[]; elements: PageElement[] }> }
  /** page manager multi-select move: the notebook's full page-id order before and after */
  | { kind: 'reorder-pages'; before: string[]; after: string[] };
/** WebKit-only, non-standard: tags a Touch as a stylus contact — see bindZoomGestures and page-canvas.ts's own copy of this type. */
type WebKitTouch = Touch & { touchType?: 'direct' | 'stylus' };

/** How long a press on a non-interactive part of the dock is held, without moving, before it picks the dock up. */
const DOCK_HOLD_MS = 350;
/** Pointer movement, in px, allowed during that hold before it's treated as something else (a pan) and abandoned. */
const DOCK_HOLD_SLOP = 8;
/** Anything inside the dock that has its own tap / drag / reorder handling — a press starting on one of these never starts a dock drag. */
const DOCK_INTERACTIVE =
  'button, input, select, textarea, a, label, [role="button"], [role="slider"], [draggable="true"], .tool, .swatch, .size-btn, .mode-btn, .iconbtn, .seg, .size-slider';

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
/**
 * Re-rasterise mounted pages once a zoom gesture has been quiet this long —
 * same value, and same reasoning, as the split pane's own SETTLE_MS
 * (page-scroller.ts): a page re-render is a canvas resize plus a full
 * repaint, far too costly to do per frame of a pinch.
 */
const QUALITY_SETTLE_MS = 180;
/**
 * Preload band around the viewport, as screen px — a page this far outside
 * the viewport is already mounted when it scrolls in, so there's no pop-in.
 * Divided by the zoom to reach world units, exactly as before.
 */
const MOUNT_MARGIN_PX = 1200;
/**
 * ...but never more than this many *world* units, however far zoomed out.
 * `MOUNT_MARGIN_PX / zoom` alone meant zooming out widened the band in world
 * terms without bound — at zoom 0.5 it reached 2400 world units either side
 * and kept ~6 pages mounted at once. This only bites below zoom ~0.86; at
 * 100% and above the band is unchanged, and at 0.5 it still preloads 700
 * screen px either way, which is most of a viewport ahead of the scroll.
 */
const MOUNT_MARGIN_MAX = 1400;
/** Hard ceiling on simultaneously mounted pages, whatever the band says — the pages nearest the viewport centre win. Bounds worst-case canvas memory on its own, independent of the pixel budget below. */
const MAX_MOUNTED_PAGES = 5;
/**
 * Total canvas backing-store budget across every mounted page, in device
 * pixels (~80 MB at 4 bytes each). Each page holds *two* canvases (cache and
 * view), so the per-page share is halved; canvasPixelFactor's own per-canvas
 * ceiling (MAX_AREA, in const.ts) still applies on top. iPad Safari discards
 * canvases well before its nominal limit, so this is set to leave plenty of
 * room for the split pane, the drag-preview surface and page thumbnails
 * alongside it.
 *
 * Halved from 40e6 together with MAX_AREA — see that constant for the
 * reasoning, the sharpness crossover, and the next rung down (10e6 here).
 * When this term binds it caps the total exactly: pageQuality solves for
 * `2 * area * pf^2 = PAGE_PIXEL_BUDGET`, so a full mount window of five pages
 * lands on 20e6 device px however far out the camera is.
 */
const PAGE_PIXEL_BUDGET = 20e6;
/**
 * Screen-px gap left between the dock's bottom edge and the top of page 1 when
 * the notebook is scrolled all the way up.
 *
 * This used to be a flat `TOP_CLEARANCE = 118` measured from `.nb-scroll`'s own
 * top, which left an uneven gap because the dock's height is not fixed: with
 * its options row collapsed the dock ended 122px down and the page began at
 * 200px — a 78px band of grey — while with a tool's options row open the dock
 * ended at 168px and the same 200px start left only 32px. The clearance is now
 * derived from where the dock actually ends (see refreshTopClearance), so the
 * gap is this value in both states.
 */
const TOP_GAP = 14;
/** Same idea below the last page (fraction of the viewport's own height, not zoom-scaled — see maxCameraY) — was `.nb-scroll`'s CSS padding-bottom. */
const BOTTOM_CLEARANCE_VH = 0.4;
/** How long after the pencil lifts a freshly-landing touch is still treated as a palm resettling rather than a deliberate pan/pinch/drag — see bindZoomGestures's own doc comment. Long enough to cover a palm re-seating itself as the hand moves between strokes, short enough that a deliberate finger-tap to scroll a moment after finishing writing still works right away. */
const PEN_COOLDOWN_MS = 400;
/** How long after a touch-driven pan or pinch begins a stylus contact showing up still counts as "the pencil landing a beat after the palm", rather than a genuinely separate later pen stroke — within this window the drift the palm caused gets rolled back, not just stopped in place. See bindZoomGestures's own doc comment. */
const PEN_RACE_WINDOW_MS = 250;

export function mountNotebook(root: HTMLElement, notebookId: string): void {
  const nb = store.notebooks.get(notebookId);
  if (!nb) {
    location.hash = '#/';
    return;
  }
  // Every note opens on its tool's primary colour. This has to happen on the
  // way *in*, not just on the way out (see the matching call in onLeave): a
  // reload or app relaunch straight into a note never fires the `hashchange`
  // onLeave listens for, and on a note-to-note jump main.ts's own `route` —
  // registered at boot, so ahead of any view's onLeave — mounts the new view
  // first, leaving the outgoing view's reset to land after this dock has
  // already rendered against the stale colour.
  resetActiveColorsToPrimary();
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
  /** `.nb-appbar`: the fixed, pointer-transparent row holding the two floating islands — measured by refreshTopClearance, since `.nb-scroll` now runs up behind it. */
  private appBarEl!: HTMLElement;
  /** Re-measures the clearance when the island row's size changes (resize, wrapping); disconnected in onLeave. */
  private appBarObserver: ResizeObserver | null = null;
  /** The dock's own Pen button — the one tool button AI mode leaves enabled (and turns violet); set fresh by renderTools each rebuild. */
  private penToolBtn!: HTMLButtonElement;
  /** The dock's own Eraser button — also left enabled by AI mode's lockdown; set fresh by renderTools each rebuild. */
  private eraserToolBtn!: HTMLButtonElement;
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
  /**
   * Board mode. A board is one unbounded canvas instead of a run of pages, so
   * every page-derived thing below either branches on this or is skipped
   * outright: the camera clamps, the page list, the mount window, the
   * scrollbar, the page manager, the trailing-blank rule, and which tools the
   * dock offers. The camera and gesture code itself is untouched — it only
   * ever calls clampCamera/hasHorizontalRange/setZoom/applyCamera, all of
   * which branch internally, so pan, pinch, momentum, rubber-banding and
   * palm/pen rejection are reused exactly as they are for pages.
   */
  private readonly isBoard: boolean;
  /** The board's single canvas, in board mode only. */
  private board: BoardCanvas | null = null;

  /** Resting clearance above page 1, in screen px — see refreshTopClearance, which keeps it in step with the dock's height. */
  private topClearance = TOP_GAP;
  /** Resting clearance below the last page, in screen px, when the dock is bottom-docked on a paged notebook — null otherwise, where `BOTTOM_CLEARANCE_VH` applies. */
  private bottomClearance: number | null = null;
  /** Re-measures the dock once its open/close animation has finished — see dockHeightChanged. */
  private dockSettleTimer: ReturnType<typeof setTimeout> | null = null;
  /** `.nb-camera`: the single element the whole camera transform is applied to — every `.page-wrap` lives inside it. */
  private cameraEl!: HTMLElement;
  private pinch: {
    d0: number;
    z0: number;
    mx: number;
    my: number;
    cx: number;
    cy: number;
    /** camera position (and zoom) when this pinch began, plus when — same palm-lands-before-the-pencil race as `pan.snapX/snapY/snapT`, see bindZoomGestures's own doc comment. */
    snapX: number;
    snapY: number;
    snapZoom: number;
    snapT: number;
  } | null = null;
  /**
   * One-finger pan (a finger specifically — a stylus contact is never
   * eligible here, and pen/mouse panning with the hand tool is
   * bindHandToolGestures' own path). `vx`/`vy` (world units/ms) are a running
   * estimate of the finger's velocity, sampled each touchmove, used to kick
   * off momentum on lift — see startMomentum.
   */
  private pan: {
    touchId: number;
    lastX: number;
    lastY: number;
    lastT: number;
    vx: number;
    vy: number;
    /** camera position when this pan began, plus when — see the palm-lands-before-the-pencil race in bindZoomGestures's own doc comment: if a stylus contact shows up within PEN_RACE_WINDOW_MS of this, the small drift a settling palm caused gets undone, not just halted. */
    snapX: number;
    snapY: number;
    snapT: number;
  } | null = null;
  /** rAF handle for the momentum/rubber-band-snap-back animation — see startMomentum/stopMomentum. */
  private momentumRaf = 0;
  /**
   * Backing-store quality every mounted page is currently rendered at (see
   * PageCanvas.setQuality). Tracks the settled zoom, capped by
   * PAGE_PIXEL_BUDGET across the whole mount window — recomputed by
   * applyQuality, and handed to each page as it mounts.
   */
  private renderQuality = 1;
  /** Debounce for applyQuality; pages are only re-rasterised once a zoom has stopped moving. */
  private qualitySettleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Mounted pages still waiting to be re-rendered at the settled quality, drained one per frame. */
  private qualityQueue: PageCanvas[] = [];
  private qualityRaf = 0;
  /**
   * Pointers currently down anywhere in the window. While any is, no page is
   * resized or repainted for quality and nothing is scheduled to retry — the
   * pass waits (`qualityHeld`) and runs once the last one lifts.
   */
  private readonly pointersDown = new Set<number>();
  /** A quality pass came due, or was cut short, while a pointer was down. */
  private qualityHeld = false;
  private readonly onAnyPointerDown = (e: PointerEvent): void => {
    this.pointersDown.add(e.pointerId);
  };
  private readonly onAnyPointerUp = (e: PointerEvent): void => {
    this.pointersDown.delete(e.pointerId);
    this.resumeQuality();
  };
  /** The window lost focus mid-press, so a pointerup may never arrive — don't let a stale id hold quality off for good. */
  private readonly onPointersLost = (): void => {
    this.pointersDown.clear();
    this.resumeQuality();
  };
  /**
   * Palm-vs-pen tracking, shared by bindZoomGestures, bindScrollbarThumb, and
   * SelectionOverlay (via isBlockedTouch) — see bindZoomGestures's own doc
   * comment for the full reasoning. A palm reports as an ordinary touch, so
   * nothing about it alone marks it as illegitimate; what does is *context*:
   * did it co-occur with the stylus, or land right around when the stylus
   * lifted.
   */
  /** Touch identifiers that were present at any point while a stylus contact was also present — palm contacts by definition. Blocked from starting or continuing a pan/pinch/box-drag/thumb-drag for as long as they stay down; removed once that same contact lifts (see endTouch and its pointerup/pointercancel-driven equivalents). */
  private readonly palmTouchIds = new Set<number>();
  /** Whether a stylus-tagged touch is down right now — refreshed from `e.touches` on every touchstart/touchmove/touchend, so it's always current even for callers with no TouchList of their own (the selection box, the scrollbar thumb). */
  private stylusDown = false;
  /** performance.now() of the stylus's most recent liftoff (0 = never lifted this session). */
  private stylusLiftAt = 0;
  /** Hand tool, pen and mouse — a finger pans through the same one-finger-pan gesture as any other tool instead, see bindZoomGestures. */
  private handPan: { pointerId: number; x: number; y: number; camX: number; camY: number } | null = null;
  /** Recomputes the custom scrollbar thumb's size/position (see bindScrollbarThumb); called after anything that changes the camera or the notebook's total content height without itself going through applyCamera (syncPages). */
  private layoutScrollbarThumb: () => void = () => {};
  /**
   * Undoes everything bindScrollbarThumb put outside this view: the thumb
   * element itself (it lives on `document.body`, so nothing else removes it)
   * and the four global subscriptions that keep it in sync. Set there, called
   * by onLeave — without it every notebook visit left another orphaned thumb
   * and another live listener behind for the life of the tab.
   */
  private destroyScrollbarThumb: () => void = () => {};
  /** The cheap per-tick half of bindScrollbarThumb — just repositions the thumb via transform against already-cached size/range, called from every applyCamera(). */
  private repositionScrollbarThumb: () => void = () => {};
  /** The single, notebook-level selection box/handles overlay — see selection.ts's own doc comment for why there's one shared instance instead of one per page. */
  private overlay!: SelectionOverlay;
  /** Which page's selection the shared overlay is currently showing, if any — its onDragStart/onDrag/onDragEnd/onTap hooks route to this page's own PageCanvas. */
  private overlayPc: ItemSurface | null = null;
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
  private selPc: ItemSurface | null = null;
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
  private calloutPc: ItemSurface | null = null;
  /** The frame the callout is currently positioned against — re-placed (not re-shown) on scroll/resize, since neither changes the frame itself, only where it lands on screen. */
  private calloutFrame: Frame | null = null;

  /** Bound so the same reference can be added to and removed from `window` — see the scroll/resize wiring in buildChrome and its cleanup in onLeave. */
  private readonly repositionCallout = (): void => {
    if (this.calloutEl && this.calloutPc && this.calloutFrame) {
      const basis = this.calloutPc.calloutBasis();
      if (basis) this.positionCallout(this.calloutEl, this.calloutFrame, basis.rect, basis.pw);
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

  /** `.nb-split`: the flex row holding `.nb-scroll` and, when one is open, the read-only secondary pane. */
  private splitEl!: HTMLElement;
  /** The read-only split pane (see secondary-pane.ts). Owns its own state and persistence; this view only tells it when a page it's showing changed, and takes it down on the way out. */
  private pane!: SecondaryPane;
  /** The app bar's split-screen button — exempt from applyAiToolbarLockdown, like the AI buttons themselves. */
  private splitBtn!: HTMLButtonElement;
  /** The board app bar's mind-map toggle. Boards only — null in a paged notebook, which has no such mode. */
  private mindMapBtn: HTMLButtonElement | null = null;

  constructor(root: HTMLElement, nb: Notebook) {
    this.root = root;
    this.nb = nb;
    this.isBoard = nb.kind === 'board';
    // the Shapes tool has no button anywhere, so a device that last left it active reopens on the pen
    if (toolState.kind === 'shapes') {
      toolState.kind = 'pen';
      saveToolState();
    }
    this.aiMode = new AiMode(nb.id, {
      refreshPage: (pageId) => this.rebuildIfMounted(pageId),
      onActiveChanged: () => this.refreshAiControls(),
      onAiHistoryChanged: (pageId) => {
        if (pageId === this.currentPageId) this.syncHistory();
      },
      // the left island's margin changes at once with `.ai-panel-open` (only the
      // panel itself slides), so its edge is already final when this runs
      onPanelToggled: () => {
        if (this.syncDockInline()) this.applyDockPosition();
      },
    });
    void this.aiMode.loadConversation(); // async; resolves after buildChrome's mountPanel has run

    this.buildChrome();

    if (!this.isBoard) store.enforceTrailingBlank(this.nb.id); // a board has no pages to keep a blank one after
    this.syncPages();
    // start fitted to the width on narrow screens, 100% otherwise — fit
    // against the first page's own width (a landscape-imported first page is
    // wider than the default, so it needs more shrinking to fit). Has to
    // wait until here (pages actually built into cameraEl by syncPages, not
    // just buildChrome's own DOM scaffolding) since setZoom's own clamping
    // needs a real content height to clamp against.
    if (this.isBoard) {
      // open on the board's content (or the origin, when it is empty) at 100%
      const b = store.boardBounds(this.nb.id);
      this.camera.x = b ? b.x + b.w / 2 - this.scrollEl.clientWidth / 2 : -this.scrollEl.clientWidth / 2;
      this.camera.y = b ? b.y + b.h / 2 - this.scrollEl.clientHeight / 2 : -this.scrollEl.clientHeight / 2;
      if (b) {
        // `.nb-scroll` runs up behind the islands: if centring left the content's
        // top edge under them (zoom is 1 here), slide it down to just clear them
        const inset = this.appBarEl.getBoundingClientRect().bottom - this.scrollEl.getBoundingClientRect().top + TOP_GAP;
        if (b.y - this.camera.y < inset) this.camera.y = b.y - inset;
      }
      this.setZoom(1);
    } else {
      const first = store.pagesOf(this.nb.id)[0];
      this.setZoom(Math.min(1, (this.scrollEl.clientWidth - 24) / (first ? pageW(first) : PAGE_W)) || 1); // applyCamera() (called from within) also runs the first updateVisiblePages()
    }

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
      window.removeEventListener('pointerdown', this.onAnyPointerDown, true);
      window.removeEventListener('pointerup', this.onAnyPointerUp, true);
      window.removeEventListener('pointercancel', this.onAnyPointerUp, true);
      window.removeEventListener('blur', this.onPointersLost);
      this.hideSelectionCallout();
      this.deactivateAll(); // commit an open text edit before the canvases go away
      for (const id of this.mounted) this.pcByPage.get(id)?.unmount();
      this.stopMomentum();
      this.stopQuality();
      this.board?.unmount();
      this.appBarObserver?.disconnect();
      this.appBarObserver = null;
      if (this.dockSettleTimer) clearTimeout(this.dockSettleTimer);
      this.dockSettleTimer = null;
      this.destroyScrollbarThumb();
      this.pane.destroy(); // takes the pane down but keeps its saved state, so coming back here restores it
      this.aiMode.destroyPanel();
      store.flushNow();
      resetActiveColorsToPrimary();
    };
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('hashchange', this.onLeave);
    // capture phase, so a handler that stops propagation can't hide a press from the quality gate
    window.addEventListener('pointerdown', this.onAnyPointerDown, true);
    window.addEventListener('pointerup', this.onAnyPointerUp, true);
    window.addEventListener('pointercancel', this.onAnyPointerUp, true);
    window.addEventListener('blur', this.onPointersLost);
  }

  // --------------------------------------------------------------- chrome
  private buildChrome(): void {
    const view = el('div', { class: 'nb' });

    // two floating islands (back + title | actions) in a fixed, pointer-transparent row
    const bar = el('div', { class: 'nb-appbar' });
    const leftIsland = el('div', { class: 'nb-appbar__island nb-appbar__left' });

    const back = el('button', {
      class: 'iconbtn',
      title: 'Back to library',
      'aria-label': 'Back to library',
    });
    back.append(icon('arrow-left'));
    back.addEventListener('click', () => {
      location.hash = this.nb.folderId ? `#/f/${this.nb.folderId}` : '#/'; // back to the notebook's folder
    });

    const typeWord = this.isBoard ? 'board' : 'notebook';
    this.titleEl = el('span', {
      class: 'nb-appbar__title',
      text: this.nb.name,
      title: `Rename ${typeWord}`,
    });
    this.titleEl.addEventListener('click', async () => {
      const name = await textPrompt({
        title: `Rename ${typeWord}`,
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
      this.pcByPage.get(this.currentPageId)?.commitShapeEdit();
      this.aiMode.sendNow(this.currentPageId);
    });

    // Split screen: show a second, read-only page (from any notebook) or a
    // reference image beside this one. Sits directly right of the AI button
    // and, like it, stays enabled while AI mode is on (see
    // applyAiToolbarLockdown) — the pane is read-only, so nothing it can do
    // interferes with the turn AI mode is capturing.
    this.splitBtn = el('button', {
      class: 'iconbtn',
      title: 'Split screen',
      'aria-label': 'Split screen',
    }) as HTMLButtonElement;
    this.splitBtn.append(icon('split'));
    this.splitBtn.addEventListener('click', () => this.openSplitMenu(this.splitBtn));

    // combined "Insert image" and "Import PDF pages" into one Import button
    // (same underlying inputs/handlers) — picking one opens the anchored menu
    // below instead of each having its own app-bar icon.
    const importBtn = el('button', { class: 'iconbtn', title: 'Import', 'aria-label': 'Import' });
    importBtn.append(icon('import'));
    importBtn.addEventListener('click', () => this.openInsertMenu(importBtn));

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
      const page = this.isBoard
        ? store.pages.get(`${this.nb.id}:0,0`) // the board's origin chunk holds its paper
        : this.currentPageId
          ? store.pages.get(this.currentPageId)
          : undefined;
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

    // the right island: the actions (undo/redo live in the dock's top row)
    const rightGroup = el('div', { class: 'nb-appbar__island nb-appbar__right' });
    // A board has no page list to manage, and AI mode and export land in later
    // phases — so those buttons are left out entirely rather than shown doing
    // nothing. Split stays (a board can host a reference pane exactly like a
    // notebook can), and so does Import, whose menu drops its PDF-pages entry
    // on a board and keeps Insert image (see openInsertMenu).
    if (this.isBoard) {
      // Mind-map mode: one switch for the whole board, remembered per board
      // (see mindMapEnabled). Boards only — a paged notebook has no bubbles,
      // so the button isn't built at all there rather than shown doing nothing.
      // `.mindmap-toggle` carries the on-state styling: a bare `.iconbtn` has
      // no `.active` rule of its own, so without this the class the toggle
      // flips would paint nothing and the button would read as dead (the AI
      // toggle carries `.ai-toggle` for exactly the same reason).
      this.mindMapBtn = el('button', {
        class: 'iconbtn mindmap-toggle',
        title: 'Mind map',
        'aria-label': 'Mind map',
        'aria-pressed': 'false',
      }) as HTMLButtonElement;
      this.mindMapBtn.append(icon('mindmap'));
      this.mindMapBtn.addEventListener('click', () => {
        this.board?.setMindMap(!mindMapEnabled(this.nb.id));
        this.refreshMindMapBtn();
      });
      this.refreshMindMapBtn();
      rightGroup.append(this.mindMapBtn, this.splitBtn, importBtn, paperBtn);
    }
    else rightGroup.append(this.aiToggleBtn, this.aiSendBtn, this.splitBtn, importBtn, exportBtn, pagesBtn, paperBtn);
    leftIsland.append(back, this.titleEl);
    bar.append(leftIsland, rightGroup);
    this.appBarEl = bar;
    this.appBarRightGroup = rightGroup;

    // Notability-style dock: a fixed top row (tools + undo/redo, never reflows)
    // and a fixed-height options row below it for the active tool's own
    // controls, so switching tools never shifts the top row or the page below.
    this.toolsEl = el('div', { class: 'nb-dock nb-dock--collapsed' });
    this.toolsTopEl = el('div', { class: 'nb-dock__row nb-dock__row--tools' });
    this.toolsOptionsEl = el('div', { class: 'nb-dock__row nb-dock__row--options' });
    this.toolsEl.append(this.toolsTopEl, this.toolsOptionsEl);
    this.bindDockHoldDrag();
    this.toolsEl.classList.toggle('nb-dock--bottom', toolState.dockPosition === 'bottom');
    this.scrollEl = el('div', { class: 'nb-scroll' });
    // `.nb-split` is what now fills the space under the dock: `.nb-scroll` is
    // its (flex: 1) first child and the read-only secondary pane, when one is
    // open, is its second — a *sibling* of the scroller, deliberately, so the
    // pane's own pinch/pan gestures never reach bindZoomGestures' listeners
    // and the AI panel's `.nb.ai-panel-open .nb-scroll` margin rule keeps
    // indenting exactly what it always did.
    this.splitEl = el('div', { class: 'nb-split' });
    this.splitEl.append(this.scrollEl);
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
        isBlockedTouch: (e) => this.isBlockedTouch(e),
      },
      this.camera
    );
    blockGestures(this.scrollEl);
    this.bindZoomGestures();
    this.bindHandToolGestures();
    this.bindScrollbarThumb();
    this.bindOutsidePenPressCancelsSelection();
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
      accept: IMAGE_ACCEPT,
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

    view.append(bar, this.toolsEl, this.splitEl, this.imageInput, this.pdfInput);
    this.aiMode.mountPanel(view); // fixed-position, so it overlays regardless of where it sits in the DOM
    this.root.replaceChildren(view);
    // has to wait until scrollEl is actually attached and laid out —
    // clientWidth/Height (and so the canvas's own pixel size) read 0 before that.
    this.layoutDragPreviewCanvas();

    // `.nb-scroll` runs up behind the islands, so their bottom edge feeds the
    // top clearance. The row is fixed to the viewport edges, so this fires on
    // a window resize as well as on the row growing or shrinking. The first
    // callback is the initial observation — pages don't exist yet — so skip it.
    let islandsH = -1;
    this.appBarObserver = new ResizeObserver(() => {
      const h = this.appBarEl.offsetHeight;
      // a resize changes both the viewport and the island widths, and an
      // island can change width on its own (observed below)
      if (this.syncDockInline()) this.applyDockPosition();
      const first = islandsH < 0;
      islandsH = h;
      if (first) return;
      if (this.isBoard) this.refreshTopClearance();
      else this.settleTopClearance();
    });
    this.appBarObserver.observe(this.appBarEl);
    for (const island of this.appBarEl.querySelectorAll('.nb-appbar__left, .nb-appbar__right')) {
      this.appBarObserver.observe(island);
    }

    // Opening/closing/floating the pane resizes `.nb-scroll` without a window
    // `resize` to announce it, and the shared drag-preview canvas is sized by
    // hand against that box (the custom scrollbar thumb re-lays-out on its
    // own, via the ResizeObserver bindScrollbarThumb already puts on it).
    this.pane = new SecondaryPane(this.nb.id, this.splitEl, {
      onLayout: () => this.layoutDragPreviewCanvas(),
    });
    void this.pane.restore(); // async only for an image split's blob; a page split restores synchronously

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
    this.scrollEl.style.setProperty('--zoom', String(zoom));
    if (this.isBoard) {
      // A board draws the camera into its own canvas transform rather than
      // moving a DOM layer, so there is nothing to transform here — just ask
      // for a frame. The selection overlay and callout are DOM that floats
      // above the canvas, though, so they still need re-placing every tick;
      // everything else below is page chrome a board has none of.
      this.board?.schedule();
      this.overlay.update();
      this.repositionCallout();
      return;
    }
    this.cameraEl.style.transform = `scale(${zoom}) translate(${-x}px, ${-y}px)`;
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

  /**
   * Hold-to-drag for the dock. Touch/pen only: holding a non-interactive part
   * of the dock (background / padding) for `DOCK_HOLD_MS` without moving picks
   * it up; it then follows the pointer vertically and on release snaps to
   * whichever half of the viewport its centre is in. Presses that start on a
   * button, swatch, control or any other reorderable element are ignored, so
   * their own tap / long-press-reorder handling is untouched.
   * `toolState.dockPosition` is the only state; everything else (CSS class,
   * clearances) is derived from it in `applyDockPosition`.
   */
  private bindDockHoldDrag(): void {
    const dock = this.toolsEl;
    let activeId: number | null = null;
    let holdTimer: ReturnType<typeof setTimeout> | null = null;
    let dragging = false;
    let downX = 0;
    let downY = 0;
    let lastY = 0;
    let startY = 0;
    let startTop = 0;
    let slots: HTMLElement[] = [];

    const snapTarget = (): DockPosition => {
      const r = dock.getBoundingClientRect();
      return r.top + r.height / 2 > window.innerHeight / 2 ? 'bottom' : 'top';
    };
    const showSlots = (): void => {
      const r = dock.getBoundingClientRect();
      const inline = this.dockFitsInline() === true; // judged once, at pickup — not re-evaluated mid-drag
      for (const pos of ['top', 'bottom'] as const) {
        const slot = el('div', { class: `nb-dock-slot nb-dock-slot--${pos}` });
        if (pos === 'top' && inline) slot.classList.add('nb-dock-slot--inline');
        slot.style.width = `${r.width}px`;
        slot.style.height = `${r.height}px`;
        document.body.append(slot);
        slots.push(slot);
      }
      markSlot();
    };
    const markSlot = (): void => {
      const target = snapTarget();
      slots.forEach((slot, i) => slot.classList.toggle('nb-dock-slot--active', (i === 0 ? 'top' : 'bottom') === target));
    };
    const blockScroll = (e: Event): void => e.preventDefault();
    const cancelHold = (): void => {
      if (holdTimer) clearTimeout(holdTimer);
      holdTimer = null;
    };
    const enterDrag = (): void => {
      holdTimer = null;
      if (activeId === null) return;
      dragging = true;
      startY = lastY;
      startTop = dock.getBoundingClientRect().top;
      dock.setPointerCapture(activeId);
      dock.classList.add('nb-dock--dragging');
      dock.style.top = `${startTop}px`;
      dock.addEventListener('touchmove', blockScroll, { passive: false });
      showSlots();
    };
    const finish = (): void => {
      cancelHold();
      if (dragging) {
        const next = snapTarget();
        dock.classList.remove('nb-dock--dragging');
        dock.style.top = '';
        dock.removeEventListener('touchmove', blockScroll);
        for (const slot of slots) slot.remove();
        slots = [];
        if (next !== toolState.dockPosition) {
          toolState.dockPosition = next;
          saveToolState();
        }
        this.applyDockPosition();
        this.repositionCallout(); // no-ops unless a callout is open
      }
      dragging = false;
      activeId = null;
    };

    dock.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' || activeId !== null) return;
      if ((e.target as Element).closest(DOCK_INTERACTIVE)) return;
      activeId = e.pointerId;
      downX = e.clientX;
      downY = lastY = e.clientY;
      holdTimer = setTimeout(enterDrag, DOCK_HOLD_MS);
    });
    dock.addEventListener('pointermove', (e) => {
      if (e.pointerId !== activeId) return;
      lastY = e.clientY;
      if (!dragging) {
        if (Math.hypot(e.clientX - downX, e.clientY - downY) > DOCK_HOLD_SLOP) finish();
        return;
      }
      const maxTop = window.innerHeight - dock.offsetHeight;
      dock.style.top = `${clamp(startTop + e.clientY - startY, 0, Math.max(0, maxTop))}px`;
      markSlot();
    });
    const end = (e: PointerEvent): void => {
      if (e.pointerId === activeId) finish();
    };
    dock.addEventListener('pointerup', end);
    dock.addEventListener('pointercancel', end);
  }

  /** Popovers launched from a dock button open away from the edge the dock is docked to. */
  private dockPopoverDirection(): PopoverDirection {
    return toolState.dockPosition === 'bottom' ? 'above' : 'below';
  }

  /** Derives everything that depends on the dock's edge from `toolState.dockPosition`. */
  private applyDockPosition(): void {
    this.toolsEl.classList.toggle('nb-dock--bottom', toolState.dockPosition === 'bottom');
    this.syncDockInline();
    if (this.isBoard) {
      // dockHeightChanged skips boards; they only need the clearances and thumb re-derived
      this.refreshTopClearance();
      this.layoutScrollbarThumb();
      return;
    }
    this.dockHeightChanged();
  }

  /** The least `camera.y` allowed: page 1's own top can be dragged down to at most this many *world* units below the viewport top — i.e. `TOP_CLEARANCE` screen px of resting clearance under the dock, at the current zoom. */
  private minCameraY(): number {
    return -this.topClearance / this.camera.zoom;
  }

  /**
   * Recomputes the resting clearance above page 1 from where the dock's bottom
   * edge currently is, so `TOP_GAP` of grey is left under it whether or not a
   * tool's options row is open.
   *
   * `.page-head` (the "Page 1" label) is part of the page wrap and scales with
   * the camera, so it is subtracted here — the gap the eye reads is the one
   * down to the page card itself, not to the label above it.
   *
   * Cached rather than measured in `minCameraY`, which is on the per-frame
   * path (the scrollbar thumb's reposition calls it every camera tick). The
   * three things that can move the dock's bottom or the label's scaled height
   * — a zoom, a resize/page change, and a tool switch — each call this once.
   */
  /**
   * The dock's height just changed (its options row opened or closed), which
   * moves where page 1 should rest. Re-derives the clearance and, if we're
   * currently sitting in that top band at all, re-pins the camera to it — so
   * opening the options row pushes the page down out from under the dock
   * rather than letting the dock cover it.
   */
  private dockHeightChanged(): void {
    // The whole top-clearance mechanism exists to keep page 1 resting clear of
    // the dock, and `settleTopClearance` re-pins the camera whenever
    // `camera.y < 0`. A board has no page 1, and its `camera.y` is routinely
    // negative (an empty board opens centred on the origin, at -viewH/2), so
    // that re-pin snapped the view by hundreds of units on every tool switch —
    // `renderTools` opens the options row, which lands here. `.nb-dock` is
    // `position: fixed`, so it never changes `.nb-scroll`'s own box either:
    // there is nothing about a dock height change a board needs to react to.
    if (this.isBoard) return;
    this.settleTopClearance();
    // `.nb-dock` animates its options row in and out (`transition: gap 0.16s`),
    // so the height it reports right now is still the old one — settle again
    // once that has finished, or the gap lands a few px short.
    if (this.dockSettleTimer) clearTimeout(this.dockSettleTimer);
    this.dockSettleTimer = setTimeout(() => {
      this.dockSettleTimer = null;
      this.settleTopClearance();
    }, 220);
  }

  /** Re-derives the clearances and re-pins the camera if it is resting in the top band, or against the bottom limit when the dock supplies the bottom clearance. */
  private settleTopClearance(): void {
    const wasAtBottom = this.camera.y >= this.maxCameraY() - 0.5;
    this.refreshTopClearance();
    if (this.camera.y < 0) this.camera.y = this.minCameraY();
    else if (wasAtBottom) this.camera.y = this.maxCameraY();
    const c = this.clampCamera(this.camera.x, this.camera.y);
    this.camera.x = c.x;
    this.camera.y = c.y;
    this.layoutScrollbarThumb();
    this.applyCamera();
  }

  private refreshTopClearance(): void {
    const scrollTop = this.scrollEl.getBoundingClientRect().top;
    const dockRect = this.toolsEl.getBoundingClientRect();
    const head = this.wrapById.values().next().value?.querySelector<HTMLElement>('.page-head');
    const headH = head ? head.offsetHeight : 0;
    // `.nb-scroll` runs up behind the floating islands, so page 1 must also rest below their bottom edge
    const islands = this.appBarEl.getBoundingClientRect().bottom - scrollTop + TOP_GAP;
    if (toolState.dockPosition === 'bottom') {
      // Mirror image: the dock is at the bottom, so it supplies the clearance
      // below the last page and only the islands sit over the top of page 1. A
      // board keeps the viewport-fraction fallback, as it does for the top clearance.
      this.topClearance = Math.max(TOP_GAP, islands);
      this.bottomClearance = this.isBoard
        ? null
        : Math.max(TOP_GAP, this.scrollEl.getBoundingClientRect().bottom - dockRect.top + TOP_GAP);
      return;
    }
    this.bottomClearance = null;
    this.topClearance = Math.max(TOP_GAP, dockRect.bottom - scrollTop + TOP_GAP - headH * this.camera.zoom, islands);
  }

  /** The greatest `camera.y` allowed: the last page's own bottom can't be dragged more than the bottom clearance above the viewport's bottom — the dock's own footprint when it is bottom-docked, else `BOTTOM_CLEARANCE_VH` of screen height. */
  private maxCameraY(): number {
    const viewH = this.scrollEl.clientHeight;
    const contentH = this.cameraEl.offsetHeight;
    const bottomClearance = this.bottomClearance ?? window.innerHeight * BOTTOM_CLEARANCE_VH;
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
    if (this.isBoard) return this.clampBoard(x, y);
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
    // A board pans in all four directions by definition, so the soft-clamp
    // paths must never collapse its x axis the way they do for a page column
    // narrower than the viewport.
    if (this.isBoard) return true;
    const { left, right } = this.contentWorldXBounds();
    return right - left > this.scrollEl.clientWidth / this.camera.zoom;
  }

  /**
   * A board's pan bounds: the item-exact content box (from the store, never
   * from measuring DOM) grown by exactly one viewport on every side, so there
   * is always a full screen of fresh space just past the outermost drawing —
   * which on an infinite canvas is the point — and nothing beyond that, so a
   * pan into the void still meets resistance and springs back rather than
   * drifting forever.
   *
   * Both axes are treated alike: no top clearance to rest page 1 against, no
   * content height pinning the bottom. Because the margin is a viewport rather
   * than a fixed distance, the reachable area grows as you zoom out, which is
   * what makes "zoom out, pan, zoom in somewhere new" work. An empty board is
   * not clamped at all — see below.
   */
  private clampBoard(x: number, y: number): { x: number; y: number } {
    const b = store.boardBounds(this.nb.id);
    // An empty board has no content to hang a limit off, and clamping to a
    // degenerate box at the origin would fence a blank canvas into one screen
    // before a single mark existed. Until the first item lands it is simply
    // unbounded — pan anywhere, in any direction, with nothing to spring back
    // against because there is no "back".
    //
    // The handover is jump-free for free: the first item is drawn *on screen*,
    // so its bounds necessarily intersect the viewport, and "bounds intersect
    // the viewport" is exactly the condition the box below permits. Wherever
    // the camera is when that stroke is released, it is already legal.
    if (!b) return { x, y };
    const z = this.camera.zoom || 1;
    const viewW = this.scrollEl.clientWidth / z;
    const viewH = this.scrollEl.clientHeight / z;
    // camera.x may range from "content's left edge at the right of the screen"
    // to "content's right edge at the left of the screen"
    const minX = b.x - viewW;
    const minY = b.y - viewH;
    return {
      x: clamp(x, minX, Math.max(minX, b.x + b.w)),
      y: clamp(y, minY, Math.max(minY, b.y + b.h)),
    };
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
    if (!this.isBoard) this.refreshTopClearance(); // the label's scaled height, and so the clearance, moves with the zoom
    const clamped = this.clampCamera(wx - sx / next, wy - sy / next);
    this.camera.x = clamped.x;
    this.camera.y = clamped.y;
    this.refreshAutoColors(); // the size dot previews at the on-screen stroke width
    if (!this.isBoard) {
      for (const pc of this.pcByPage.values()) pc.zoomChanged(); // a pending line's handles stay screen-sized
      this.layoutScrollbarThumb(); // zoom changes the thumb's size/range, not just its position
    }
    this.applyCamera();
    if (!this.isBoard) this.settleQuality(); // ...and, once it stops moving, the resolution pages are rasterised at
  }

  // ---------------------------------------------------------------- quality
  /**
   * How many device pixels per page unit every mounted page should rasterise
   * at, expressed as a multiplier on DPR (so 1 = the old fixed behaviour).
   *
   * Two bounds, both needed:
   *  - the camera's own zoom, so ink is drawn at the resolution it is being
   *    *shown* at rather than always at DPR (the reason zoomed-in ink used to
   *    look soft) — and, zoomed out, so a page at 50% isn't rasterised at 4×
   *    the pixels it can possibly display;
   *  - PAGE_PIXEL_BUDGET spread across the whole mount window, which is what
   *    keeps "zoom in on a long notebook" from asking iOS for more canvas
   *    than it will give. Each page holds two canvases, hence the 2×.
   *
   * canvasPixelFactor applies its own per-canvas ceiling inside PageCanvas on
   * top of this, so the effective factor is the lower of the two.
   */
  private pageQuality(): number {
    const desired = clamp(this.camera.zoom, ZOOM_MIN, ZOOM_MAX);
    let area = 0;
    for (const id of this.mounted) {
      const p = store.pages.get(id);
      if (p) area += pageW(p) * pageH(p);
    }
    if (area <= 0) return desired;
    const maxFactor = Math.sqrt(PAGE_PIXEL_BUDGET / (2 * area));
    return clamp(desired, ZOOM_MIN, Math.max(ZOOM_MIN, maxFactor / DPR));
  }

  /**
   * Re-rasterises every mounted page at the settled quality, one per animation
   * frame so a window of several never repaints them all in one go (the same
   * drain the split pane's scroller uses).
   *
   * A page mid-stroke/mid-drag/mid-text-edit refuses (setQuality returns
   * false) rather than clearing its canvas out from under the gesture; when
   * that happens the whole pass is simply rescheduled, so it retries every
   * QUALITY_SETTLE_MS until the user is idle. That is also why nothing here
   * is on the per-frame camera path.
   *
   * Nothing at all runs while a pointer is down (see `pointersDown`): a
   * resize and full repaint of some page, one per frame, is exactly what made
   * the first stroke after a zoom lag. A press landing mid-pass stops it, and
   * the whole pass is redone once every pointer lifts. Pages go nearest the
   * viewport centre first, so the one about to be drawn on is sharp soonest.
   */
  private applyQuality(): void {
    this.renderQuality = this.pageQuality();
    if (this.pointersDown.size) {
      this.qualityHeld = true;
      return;
    }
    const q = this.renderQuality;
    const centre = this.camera.y + this.scrollEl.clientHeight / this.camera.zoom / 2;
    const distance = (pc: PageCanvas): number => {
      const pageEl = this.wrapById.get(pc.page.id)?.querySelector<HTMLElement>('.page');
      return pageEl ? Math.abs(pageEl.offsetTop + pageEl.offsetHeight / 2 - centre) : Infinity;
    };
    this.qualityQueue = [...this.mounted]
      .map((id) => this.pcByPage.get(id))
      .filter((pc): pc is PageCanvas => pc != null && pc.mounted)
      .map((pc) => ({ pc, d: distance(pc) }))
      .sort((a, b) => a.d - b.d)
      .map(({ pc }) => pc);
    if (!this.qualityQueue.length) return;
    let deferred = false;
    const drain = (): void => {
      this.qualityRaf = 0;
      if (this.pointersDown.size) {
        this.qualityQueue = [];
        this.qualityHeld = true;
        return;
      }
      const pc = this.qualityQueue.shift();
      // it may have been unmounted between frames (the user kept scrolling)
      if (pc?.mounted && !pc.setQuality(q)) deferred = true;
      if (this.qualityQueue.length) this.qualityRaf = requestAnimationFrame(drain);
      else if (deferred) this.settleQuality(); // come back for the busy ones
    };
    if (this.qualityRaf) cancelAnimationFrame(this.qualityRaf);
    this.qualityRaf = requestAnimationFrame(drain);
  }

  /** Debounced applyQuality — called from anything that changes the zoom or which pages are mounted. */
  private settleQuality(): void {
    if (this.qualitySettleTimer) clearTimeout(this.qualitySettleTimer);
    this.qualitySettleTimer = null;
    if (this.pointersDown.size) {
      // no timer, so no retry loop, while a pointer is down — resumeQuality picks it up
      this.qualityHeld = true;
      return;
    }
    this.qualitySettleTimer = setTimeout(() => {
      this.qualitySettleTimer = null;
      this.applyQuality();
    }, QUALITY_SETTLE_MS);
  }

  /** Runs a quality pass that was held off while pointers were down, once the last one has lifted. */
  private resumeQuality(): void {
    if (this.pointersDown.size || !this.qualityHeld) return;
    this.qualityHeld = false;
    this.settleQuality();
  }

  /** Drops any queued/scheduled re-render — teardown, so nothing touches a page after onLeave. */
  private stopQuality(): void {
    this.qualityHeld = false;
    if (this.qualitySettleTimer) clearTimeout(this.qualitySettleTimer);
    this.qualitySettleTimer = null;
    if (this.qualityRaf) cancelAnimationFrame(this.qualityRaf);
    this.qualityRaf = 0;
    this.qualityQueue = [];
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
   * Whether `id` (a Touch identifier, or a PointerEvent's `pointerId` for a
   * touch-type pointer — the two number the same physical contact, an
   * assumption blockNativeGesture in page-canvas.ts already relies on) is
   * currently ineligible to start or continue a pan, pinch, selection-box
   * drag, or scrollbar-thumb drag: a contact already known to have co-occurred
   * with the stylus (`palmTouchIds`), or one that landed within
   * PEN_COOLDOWN_MS of the stylus's last liftoff. Does *not* cover "the
   * stylus is down right now" — callers with their own TouchList check that
   * directly (`hasStylus`/`this.stylusDown`), since only they can see it fresh
   * every event; this is the *identity* half of the rule.
   */
  private isPalmTouch(id: number): boolean {
    if (this.palmTouchIds.has(id)) return true;
    return performance.now() - this.stylusLiftAt < PEN_COOLDOWN_MS;
  }

  /**
   * Whether `e` (a PointerEvent reaching the selection box or the scrollbar
   * thumb, neither of which sees a TouchList of its own) should be treated as
   * a palm/pen-priority contact and ignored. The pen itself is never blocked
   * here — only `touch`-typed pointers are: while the stylus is actually
   * down (pen priority), a contact already tagged as a palm, or one landing
   * within the post-lift cooldown. Mirrors bindZoomGestures's own rules; see
   * its doc comment for the full reasoning.
   */
  private isBlockedTouch(e: PointerEvent): boolean {
    return e.pointerType === 'touch' && (this.stylusDown || this.isPalmTouch(e.pointerId));
  }

  /**
   * A pen press anywhere outside the current selection or adjustable-line
   * state cancels it — a lasso/shape/rect selection, a selected shape, or a
   * straightened line still in its adjustable phase — regardless of which
   * tool is active and regardless of which page (or the gray gap between
   * pages) the press lands on.
   *
   * Each PageCanvas already clears its *own* selection for some tools
   * (lasso, an empty shapes-tap) and always settles its *own* pending line
   * on any same-page press outside its handles — but nothing previously
   * told a *different* page's still-selected/still-pending state to let go,
   * so switching to an unrelated tool and drawing elsewhere, or moving to a
   * different page entirely, left the old selection's box, handles, and
   * decorative lasso outline sitting there indefinitely (`overlayPc`
   * pointing at a page whose own `selected`/`lastLassoPath` nothing had ever
   * cleared). A capture-phase listener here — running before any page's own
   * pointerdown handling — is the one place that can see every press
   * regardless of target, including the gray gap where no page's own
   * listener fires at all.
   *
   * A press that lands inside `.sel-box` itself is left alone entirely
   * (that element's own onDown handles it, exactly as before — revealing
   * the callout, starting a move/resize/rotate). A press on the SAME page
   * that currently owns a pending line is also left alone: that page's own
   * startPress already decides correctly whether it hit one of the line's
   * own handles (continue adjusting) or landed elsewhere (commit it) — this
   * only has to settle any *other* page's pending line, which never gets
   * that chance on its own.
   *
   * Only a pen press does this — palm and finger contacts must never clear
   * a selection, so this reuses the exact same pen-priority/palm-contact
   * check (isBlockedTouch, backed by palmTouchIds/stylusDown/the post-lift
   * cooldown) as everything else in the palm-rejection work, rather than a
   * new heuristic.
   *
   * Clearing/committing that state here is only half the fix: the very same
   * press then goes on (via the normal bubble-phase pointerdown) to whatever
   * page it actually landed on, which would otherwise start its own tool's
   * press as always and leave a mark. So whenever anything was actually
   * dismissed, the landing page (if any — the gray gap has none) is flagged
   * via markDismissingPress, and its startPress refuses to run any tool at
   * all for that press. This capture-phase listener is what makes the flag
   * land *before* the page's own pointerdown, so nothing is ever drawn and
   * then withdrawn.
   */
  private bindOutsidePenPressCancelsSelection(): void {
    this.scrollEl.addEventListener(
      'pointerdown',
      (e) => {
        // every new press starts clean, whatever its pointer type — see
        // clearDismissingPress for the flagged presses that never reach a canvas
        for (const pc of this.pcByPage.values()) pc.clearDismissingPress();
        this.board?.clearDismissingPress();
        if (e.pointerType !== 'pen' || this.isBlockedTouch(e)) return;
        const target = e.target as HTMLElement;
        if (target.closest('.sel-box')) return; // inside - handled by SelectionOverlay's own onDown
        let dismissed = this.overlayPc ? this.overlayPc.clearSelection() : false;
        if (this.isBoard) {
          // one surface, so there is no "some other page's line" to settle —
          // the board's own onDown handles its pending line directly. All this
          // has to do is stop the press that cleared a selection from also
          // drawing, which on a page is what markDismissingPress buys.
          // A snapped mind-map bubble is settled here as well: the board's
          // onDown would do it too (this runs first, so that call finds
          // nothing), but a press that is spent on the bubble must be flagged
          // either way so it never also leaves a mark.
          if (this.board?.commitPendingBubble()) dismissed = true;
          // revealed connection nodes are view state, so putting them away is
          // not itself worth spending the press on — the board's own onDown
          // decides whether this press grabs a node or dismisses them
          if (dismissed) this.board?.markDismissingPress();
          return;
        }
        const samePageId = (target.closest('.page') as HTMLElement | null)?.dataset.pageId ?? null;
        for (const [pageId, pc] of this.pcByPage) {
          // another page's adjustable line counts as dismissed state too, so
          // the press that settles it is spent on that and draws nothing
          if (pageId !== samePageId) {
            const line = pc.commitLine();
            const shape = pc.commitShapeEdit();
            if (line || shape) dismissed = true;
          }
        }
        if (dismissed && samePageId) this.pcByPage.get(samePageId)?.markDismissingPress();
      },
      { capture: true }
    );
  }

  /**
   * If a touch-driven pan or pinch began within the last PEN_RACE_WINDOW_MS
   * and the stylus has just shown up, undoes whatever drift it caused
   * instead of merely halting it — the pencil usually lands a beat *after*
   * the palm that's about to rest on the glass, so by the time its touch is
   * seen, the palm may already have nudged the camera. Only one of pan/pinch
   * is ever live at once, so checking both here is safe.
   */
  private restorePreStylusDrift(): void {
    const now = performance.now();
    if (this.pan && now - this.pan.snapT < PEN_RACE_WINDOW_MS) {
      this.camera.x = this.pan.snapX;
      this.camera.y = this.pan.snapY;
      this.applyCamera();
    } else if (this.pinch && now - this.pinch.snapT < PEN_RACE_WINDOW_MS) {
      this.camera.x = this.pinch.snapX;
      this.camera.y = this.pinch.snapY;
      this.camera.zoom = this.pinch.snapZoom;
      this.applyCamera();
    }
  }

  /**
   * One-finger pan, two-finger pinch-zoom, and ctrl/⌘ + wheel zoom, all
   * driven entirely by our own JS now that `.nb-scroll` doesn't scroll
   * natively (see its own CSS comment) — replaces native one-finger
   * scrolling, which used to need no code here at all.
   *
   * The pinch session, once started, stays owned for as long as *any*
   * (non-stylus, non-palm) touch remains — not just while the count reads
   * exactly 2. Real two-finger releases are rarely simultaneous (one finger
   * lifts a beat early), and a third finger can graze the glass mid-gesture;
   * re-deriving "are we pinching" from the instantaneous touch count on
   * every event used to mean that single frame at the wrong count stopped
   * preventDefault() entirely, handing the still-moving remaining touch to
   * native pan-x pan-y — occasionally flinging a completely different page
   * into view. Now, once `pinch` is set, touchmove keeps suppressing native
   * scroll at any count; it only actually applies the zoom/pan math while
   * exactly 2 eligible touches are live, and just holds position (still
   * swallowing the event) otherwise. A single remaining eligible touch after
   * a pinch ends is picked back up as a one-finger pan rather than dropped.
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
   *
   * Palms report as an ordinary touch — nothing about the contact itself
   * marks it as illegitimate, so what does is *context*: any touch present
   * at the same time as a stylus touch is a palm by definition, and stays
   * ineligible for the rest of its time on the glass, even after the pencil
   * lifts (`palmTouchIds`, checked via `isPalmTouch`/`eligible` below) — this
   * specifically closes the hole where endTouch used to unconditionally pick
   * a single remaining touch back up as a pan the instant the pencil lifted,
   * which if that touch was a resting palm, restarted panning from it. A
   * fresh contact landing shortly after the pencil lifts (PEN_COOLDOWN_MS) is
   * treated the same way, for a palm resettling as the hand moves. And a pan
   * or pinch that manages to start from a palm that lands *before* the
   * pencil does gets its drift undone once the pencil shows up, not just
   * stopped (`restorePreStylusDrift`, PEN_RACE_WINDOW_MS) — the pencil is
   * rarely down at the exact instant the palm first touches.
   */
  private bindZoomGestures(): void {
    const s = this.scrollEl;
    const dist = (a: Touch, b: Touch): number => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    const hasStylus = (t: TouchList): boolean =>
      Array.from(t).some((touch) => (touch as WebKitTouch).touchType === 'stylus');
    // Keeps `stylusDown` (consulted by callers with no TouchList of their
    // own — bindScrollbarThumb, SelectionOverlay) exactly in sync with
    // whether the pencil is touching right now, records the moment it lifts
    // (for the cooldown), and tags every other touch currently present
    // alongside it as a palm for the rest of its time on the glass.
    const trackStylus = (t: TouchList): void => {
      const stylus = hasStylus(t);
      if (this.stylusDown && !stylus) this.stylusLiftAt = performance.now();
      this.stylusDown = stylus;
      if (stylus) {
        for (const touch of Array.from(t)) {
          if ((touch as WebKitTouch).touchType !== 'stylus') this.palmTouchIds.add(touch.identifier);
        }
      }
    };
    const eligible = (t: TouchList): Touch[] => Array.from(t).filter((touch) => !this.isPalmTouch(touch.identifier));
    const beginPan = (t: Touch): void => {
      this.pan = {
        touchId: t.identifier,
        lastX: t.clientX,
        lastY: t.clientY,
        lastT: performance.now(),
        vx: 0,
        vy: 0,
        snapX: this.camera.x,
        snapY: this.camera.y,
        snapT: performance.now(),
      };
    };
    s.addEventListener(
      'touchstart',
      (e) => {
        this.stopMomentum();
        trackStylus(e.touches);
        if (this.stylusDown) {
          this.restorePreStylusDrift();
          this.pan = null;
          this.pinch = null;
          return;
        }
        const live = eligible(e.touches);
        if (live.length >= 2) {
          this.pan = null;
          const mx = (live[0].clientX + live[1].clientX) / 2;
          const my = (live[0].clientY + live[1].clientY) / 2;
          this.pinch = {
            d0: dist(live[0], live[1]),
            z0: this.camera.zoom,
            mx,
            my,
            cx: mx,
            cy: my,
            snapX: this.camera.x,
            snapY: this.camera.y,
            snapZoom: this.camera.zoom,
            snapT: performance.now(),
          };
        } else if (live.length === 1 && !this.pinch) {
          beginPan(live[0]);
        }
      },
      { passive: true }
    );
    s.addEventListener(
      'touchmove',
      (e) => {
        trackStylus(e.touches);
        if (this.stylusDown) {
          // the pencil joined (or was already down) mid-gesture: undo
          // whatever drift a palm caused before it landed, then bail out of
          // both pan and pinch entirely — see doc comment above.
          this.restorePreStylusDrift();
          this.pan = null;
          this.pinch = null;
          return;
        }
        if (this.pinch) {
          e.preventDefault(); // own the whole gesture until every touch lifts — see doc comment above
          const live = eligible(e.touches);
          if (live.length < 2) return; // no 2-eligible-touch baseline right now: hold position, keep suppressing native scroll
          const p = this.pinch;
          const rawMx = (live[0].clientX + live[1].clientX) / 2;
          const rawMy = (live[0].clientY + live[1].clientY) / 2;
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
          this.setZoom((p.z0 * dist(live[0], live[1])) / p.d0, { x: mx, y: my });
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
      // a touch that just lifted is no longer "currently down", so it can't
      // matter for palm-tracking any more — forget it (keeps the set from
      // growing unboundedly, and lets a later, unrelated touch reuse the
      // same identifier without inheriting its palm status).
      for (const touch of Array.from(e.changedTouches)) this.palmTouchIds.delete(touch.identifier);
      trackStylus(e.touches);
      if (e.touches.length >= 2) return; // still pinching (or a 3rd finger grazed) — see the pinch-session doc comment above
      const live = eligible(e.touches);
      if (live.length === 1 && !this.stylusDown) {
        // one eligible touch remains after a pinch (or an extra graze) ends
        // — pick it back up as a pan instead of dropping input until the
        // next touchstart. If the one *raw* touch remaining is the pencil,
        // or a palm/cooldown-blocked contact, `live` is empty here instead
        // and this is skipped — that second case is the fix: the pencil
        // lifting used to unconditionally re-arm a pan from whatever touch
        // was left, which if it was a resting palm, restarted panning from
        // it. See the class doc comment above.
        this.pinch = null;
        beginPan(live[0]);
        return;
      }
      if (e.touches.length > 0) return; // the remaining touch is a stylus, or ineligible — leave it alone entirely
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
   * Hand tool: drag anywhere to pan, with the pencil or the mouse.
   *
   * A *finger* never reaches here — it pans through the same one-finger
   * gesture bindZoomGestures recognizes for every tool, and this is scoped to
   * `pen`/`mouse` specifically so a finger drag is panned once, there, rather
   * than twice.
   *
   * The pencil is the case this exists for. bindZoomGestures deliberately
   * refuses a stylus-tagged contact outright (pen priority: a Pencil stroke
   * must never be corrupted by the palm resting alongside it) — right for
   * every tool that draws, and exactly wrong for the one tool whose whole job
   * is to pan with the pencil, which is why the Pencil previously did nothing
   * at all here. Panning it from the Pointer Event stream instead keeps that
   * rule untouched: palms are `pointerType: 'touch'` and so can't enter this
   * path at all, and the touch path still refuses them for itself.
   *
   * Nothing competes for the contact either way. The touch path only listens
   * to Touch Events, which a mouse never fires and which this ignores; and
   * PageCanvas/BoardCanvas both step aside for this tool before claiming a
   * press (see PageCanvas.onDown's own comment), so the press arrives here
   * unclaimed and this pointer capture is the only one on it.
   */
  private bindHandToolGestures(): void {
    const s = this.scrollEl;
    s.addEventListener('pointerdown', (e) => {
      if (toolState.kind !== 'hand' || (e.pointerType !== 'pen' && e.pointerType !== 'mouse')) return;
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
      // straight from the pointer delta with no clampCamera call, so a
      // hand-tool drag could push it arbitrarily far past the
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
    // A board pans in two axes with no fixed extent, so a one-axis thumb would
    // misrepresent it; phase 1 simply has none.
    if (this.isBoard) return;
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
      this.refreshTopClearance(); // a resize or a page change can move the dock's bottom edge
      const track = s.getBoundingClientRect();
      // The track is the scroller's own full height, so the thumb reaches the
      // top of the page. Where it passes behind the dock is purely a paint
      // question, settled by the thumb's z-index sitting below the dock's —
      // see `.nb-scrollbar-thumb` in styles.css.
      const trackTop = track.top + INSET;
      trackH = track.height - INSET * 2;
      const minY = this.minCameraY();
      const maxY = this.maxCameraY();
      panRange = Math.max(0, maxY - minY);
      if (panRange <= 1 || trackH <= 0) {
        thumb.hidden = true;
        return;
      }
      thumb.hidden = false;
      const viewWorldH = s.clientHeight / this.camera.zoom;
      const shownFraction = clamp(viewWorldH / (panRange + viewWorldH), 0.02, 1);
      thumbH = Math.min(trackH, Math.max(MIN_THUMB, shownFraction * trackH));
      thumb.style.top = `${trackTop}px`;
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

    // Every subscription below is held in a named binding rather than an
    // inline closure purely so destroyScrollbarThumb can hand the exact same
    // reference back to removeEventListener.
    const onVisibility = (): void => {
      if (!document.hidden) layout();
    };
    const onPageShow = (): void => layout();

    window.addEventListener('resize', layout);
    // Backstops for the same class of bug: `.nb-scroll`'s own box can change
    // shape (briefly, or for real) without a matching `window.resize` ever
    // firing — iOS doesn't reliably dispatch one when returning from the
    // app switcher. The ResizeObserver catches any actual change to the
    // track's rendered box (including the transient narrowing during
    // backgrounding and the restore afterward); visibilitychange/pageshow
    // are the direct backstop for iOS specifically not firing resize on
    // return to foreground.
    const trackObserver = new ResizeObserver(() => layout());
    trackObserver.observe(s);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pageshow', onPageShow);
    layout();

    this.destroyScrollbarThumb = () => {
      window.removeEventListener('resize', layout);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pageshow', onPageShow);
      trackObserver.disconnect();
      thumb.remove();
      // a stale layout()/reposition() after teardown would touch a detached
      // node for nothing; put the no-op defaults back
      this.layoutScrollbarThumb = () => {};
      this.repositionScrollbarThumb = () => {};
    };

    let drag: { pointerId: number; startY: number; startCamY: number; trackH: number; thumbH: number } | null = null;
    thumb.addEventListener('pointerdown', (e) => {
      // a palm resting on this narrow strip (or the pencil itself down
      // elsewhere) shouldn't grab the thumb any more than it should start a
      // pan — see bindZoomGestures's own doc comment for the palm/pen rules
      // this mirrors.
      if (this.isBlockedTouch(e)) return;
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
   * Generic hold-then-drag reorder for the main view's pages: press
   * `trigger` (a page's header label) and hold it still (within
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
    // `scroller` is `this.scrollEl` (the main notebook view, which hasn't been
    // a real scrolling element since the camera migration — see its own CSS
    // comment), so writing scrollTop on it is a silent no-op and the camera
    // has to be panned instead. Kept general because it used to also serve
    // the page manager's genuinely-scrollable grid; that surface is on
    // enableReorderDrag now (see openPageManager).
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

  // --------------------------------------------------------------- insert
  private openInsertMenu(anchor: HTMLElement): void {
    const menu = el('div', { class: 'menu', role: 'menu' });
    let modal: Modal | null = null;
    const item = (label: string, name: IconName, run: () => void): void => {
      const b = el('button', { class: 'menu__item menu__item--icon', role: 'menuitem' });
      b.append(icon(name, 'sm'), el('span', { text: label }));
      b.addEventListener('click', () => {
        modal?.close();
        run();
      });
      menu.append(b);
    };
    // importing a PDF means adding pages, which a board has none of
    if (!this.isBoard) item('Import PDF pages', 'import', () => this.pdfInput.click());
    item('Insert image', 'image', () => this.imageInput.click());
    modal = openAnchoredModal(anchor, menu);
  }

  // ---------------------------------------------------------- split screen
  /**
   * The split-screen button's own dropdown. `openAnchoredModal` gives it the
   * light-dismiss behaviour every other anchored popover here has (an outside
   * tap closes it, a second tap on the button toggles it) — the pane itself
   * is *not* built on a modal, since it has to survive outside taps, route
   * changes and everything else a modal dismisses on.
   */
  private openSplitMenu(anchor: HTMLElement): void {
    const menu = el('div', { class: 'menu menu--split', role: 'menu' });
    let modal: Modal | null = null;
    const item = (label: string, name: IconName, run: () => void): void => {
      const b = el('button', { class: 'menu__item menu__item--icon', role: 'menuitem' });
      b.append(icon(name, 'sm'), el('span', { text: label }));
      b.addEventListener('click', () => {
        modal?.close();
        run();
      });
      menu.append(b);
    };
    // "page" here means the *other* notebook's pages, which on a board would
    // read as though the board had one of its own
    item(this.isBoard ? 'Split screen notebook' : 'Split screen page', 'book', () => this.pane.startPagePick());
    item('Split screen image', 'image', () => this.pane.startImagePick());
    item('Split screen PDF', 'pdf', () => this.pane.startPdfPick());
    modal = openAnchoredModal(anchor, menu);
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
    this.dockHeightChanged();
  }

  /** Hides the options row; also drops the size popover, whose anchor button lives in it. */
  private closeDockOptions(): void {
    this.sizePopover?.close();
    this.toolsEl.classList.add('nb-dock--collapsed');
    this.dockHeightChanged();
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
      b.dataset.tool = kind; // marks the reorderable buttons — the ruler/protractor below share `.tool` but aren't draggable
      b.append(icon(name));
      // long-press to drag this tool to a new slot in the row; unlike the
      // colour swatches there's nothing to drop it on, so a drop outside the
      // dock just snaps it back
      const drag = this.enableReorderDrag({
        container: top,
        item: b,
        items: () => Array.from(top.querySelectorAll<HTMLElement>('.tool[data-tool]')),
        liftedClass: 'tool--lifted',
        ghost: () => {
          const g = el('div', { class: 'tool-ghost' });
          g.append(icon(name));
          return g;
        },
        commit: (order) => {
          setToolOrder(order.map((e) => e.dataset.tool as ToolKind));
          saveToolState();
          this.renderTools();
        },
      });
      b.addEventListener('click', () => {
        if (drag.tookClick()) return;
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
    // Every tool a board has a surface for. Only the ruler and protractor are
    // left out, filtered separately below — they attach to a mounted
    // PageCanvas, which a board has none of.
    const boardTools: ToolKind[] = [
      'pen',
      'highlighter',
      'eraser',
      'lasso',
      'text',
      'shapes',
      'tape',
      'laser',
      'hand',
    ];
    const TOOL_BUTTONS: Record<ToolKind, { icon: IconName; label: string }> = {
      pen: { icon: 'pen', label: 'Pen' },
      highlighter: { icon: 'highlighter', label: 'Highlighter' },
      eraser: { icon: 'eraser', label: 'Eraser' },
      lasso: { icon: 'lasso', label: 'Lasso select' },
      text: { icon: 'text', label: 'Text' },
      shapes: { icon: 'shapes', label: 'Shapes' },
      tape: { icon: 'tape', label: 'Tape' },
      laser: { icon: 'laser', label: 'Laser pointer' },
      hand: { icon: 'hand', label: 'Hand — drag to pan with pen or mouse, like a finger' },
    };
    // built in the user's own order (drag-to-reorder writes toolState.toolOrder)
    const built = new Map<ToolKind, HTMLElement>();
    for (const kind of toolState.toolOrder) {
      if (this.isBoard && !boardTools.includes(kind)) continue;
      if (kind === 'shapes') continue; // no Shapes button anywhere; pages get shapes from the pen's hold-to-snap
      const spec = TOOL_BUTTONS[kind];
      built.set(kind, toolBtn(kind, spec.icon, spec.label));
    }
    // kept so applyAiToolbarLockdown can leave just these two enabled (and
    // colour the pen violet) while AI mode is on — see its own doc comment.
    // Both are in boardTools, so neither lookup is ever empty.
    this.penToolBtn = built.get('pen') as HTMLButtonElement;
    this.eraserToolBtn = built.get('eraser') as HTMLButtonElement;
    top.append(...built.values(), el('span', { class: 'divider' }));

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
        opts.append(
          el('span', {
            class: 'hint',
            text: `Drag anywhere — with the pen, a finger, or the mouse — to pan the ${this.isBoard ? 'board' : 'page'}.`,
          })
        );
        break;
      case 'text':
        opts.append(
          this.buildSwatches(
            toolState.penSwatches,
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
            toolState.penSwatches,
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
          isPen ? toolState.penSwatches : toolState.hiSwatches,
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
    // Both guides need a mounted PageCanvas to show themselves on (toggleGuide
    // bails without one), so on a board they were rendered but inert — hidden
    // there for the same reason the page manager and the scrollbar are. The
    // trailing divider goes with them: with nothing between it and the one
    // ending the tool block above, two would sit side by side.
    if (!this.isBoard) {
      top.append(
        guideBtn('ruler', 'ruler', 'Ruler'),
        guideBtn('protractor', 'protractor', 'Protractor'),
        el('span', { class: 'divider' })
      );
    }
    top.append(this.undoBtn, this.redoBtn);
    // a rebuild discards and recreates every button above — reapply the AI
    // lockdown (and the pen's violet colouring) to the fresh ones right away.
    this.applyAiToolbarLockdown();
    if (this.syncDockInline()) this.applyDockPosition(); // the tool row's natural width may have changed
  }

  /**
   * Whether the tool row, centred in the viewport at its natural width, clears
   * both islands by 20px each side — judged by the islands' actual edges, so
   * an island shifted by the AI panel counts. Null until the row has a width.
   */
  private dockFitsInline(): boolean | null {
    const w = this.toolsTopEl.scrollWidth;
    const left = this.appBarEl.querySelector<HTMLElement>('.nb-appbar__left');
    const right = this.appBarEl.querySelector<HTMLElement>('.nb-appbar__right');
    if (!left || !right || w === 0) return null;
    const vw = document.documentElement.clientWidth;
    return vw / 2 - w / 2 >= left.getBoundingClientRect().right + 20 && vw / 2 + w / 2 <= right.getBoundingClientRect().left - 20;
  }

  /**
   * Puts the dock's tool row on the islands' row (`nb-dock--inline`) when it is
   * top-docked and the row, centred, clears both islands. Measures the tool
   * row's `scrollWidth` — its natural content width, which the class (it only
   * moves `top`) can't change — so toggling can't feed back into the check.
   * Returns whether the class changed; the caller re-derives the clearances.
   */
  private syncDockInline(): boolean {
    const fits = this.dockFitsInline();
    if (fits === null) return false; // not laid out yet
    const inline = toolState.dockPosition === 'top' && fits;
    if (inline === this.toolsEl.classList.contains('nb-dock--inline')) return false;
    this.toolsEl.classList.toggle('nb-dock--inline', inline);
    return true;
  }

  /** Reads a picked photo / GIF and drops it on the page in view, selected, with the lasso tool active. */
  private async insertImage(file: File): Promise<void> {
    const target: ItemSurface | null = this.isBoard
      ? this.board
      : this.currentPageId
        ? (this.pcByPage.get(this.currentPageId) ?? null)
        : null;
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
      // pdf.js is loaded only when needed. One retry: on a freshly deployed
      // PWA the chunk request can lose a race with the service worker
      // swapping caches, and the module load fails outright.
      const loadImport = () => import('../pdf-import');
      const { importPdfPages } = await loadImport().catch(() => loadImport());
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
    modal = openAnchoredModal(anchor, menu, { direction: this.dockPopoverDirection() });
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
      t.append(this.buildSwatches(toolState.penSwatches, null, (c) => this.selPc?.recolorSelection('pen', c), 'pen'));
    }
    if (hasHi) {
      t.append(
        this.buildSwatches(toolState.hiSwatches, null, (c) => this.selPc?.recolorSelection('highlighter', c), 'highlighter')
      );
    }
  }

  /**
   * A row of colour swatches (presets and user-added colours interleaved),
   * then an "add colour" button that opens the picker. The "auto" swatch
   * paints itself from the page in view. Position 0 is the tool's primary
   * colour — marked with a dotted ring, and the one a note opens on.
   *
   * With `tool` set, swatches are draggable: long-press arms a drag (a
   * `.swatch-ghost` tracks the pointer — the row itself clips overflow, see
   * `.nb-dock__row`'s doc comment, so the real swatch can't float past it)
   * and a trash button appears at the end of the row, just before "+".
   * Dropping on that trash removes the colour; dropping anywhere else in the
   * dock reorders; dropping outside the dock snaps back. The primary can be
   * reordered but not removed. A removed preset goes to that tool's "deleted
   * presets" list, offered back from the "+" picker; a removed custom colour
   * is just gone.
   */
  private buildSwatches(
    colors: string[],
    current: string | null,
    onPick: (c: string) => void,
    tool?: 'pen' | 'highlighter'
  ): HTMLElement {
    const swatches = el('div', { class: 'dock-group' });
    // both built below when `tool` is set; the trash is only in the DOM while a
    // swatch is actually being dragged, and sits immediately before the "+"
    let trash: HTMLElement | null = null;
    let plus: HTMLElement | null = null;

    const add = (c: string, index: number): void => {
      const isAuto = c === AUTO_COLOR;
      const s = el('button', {
        class:
          'swatch' +
          (isAuto ? ' swatch--auto' : '') +
          (tool && index === 0 ? ' swatch--primary' : '') +
          (c === current ? ' active' : ''),
        style: isAuto ? '' : `background:${c}`,
        title: isAuto ? 'Auto — adapts to paper' : c,
        'aria-label': isAuto ? 'Ink auto — adapts to paper' : `Ink ${c}`,
      });
      s.dataset.color = c;
      if (isAuto) {
        const paint = (): void => {
          s.style.background = resolveInkColor(AUTO_COLOR, this.currentPaper());
        };
        paint();
        this.colorRefreshers.push(paint);
      }
      const drag = tool
        ? this.enableReorderDrag({
            container: swatches,
            item: s,
            items: () => Array.from(swatches.querySelectorAll<HTMLElement>('.swatch[data-color]')),
            liftedClass: 'swatch--lifted',
            ghost: () => {
              const g = el('div', { class: 'swatch-ghost' + (isAuto ? ' swatch--auto' : '') });
              g.style.background = isAuto ? s.style.background : c;
              return g;
            },
            commit: (order) => {
              setSwatchOrder(tool, order.map((e) => e.dataset.color ?? ''));
              saveToolState();
              this.renderTools();
            },
            // the dotted ring marks whichever colour would land first, so
            // during a drag it belongs to the swatch heading for slot 0
            onPreviewOrder: (order) => {
              const first = (order ?? Array.from(swatches.querySelectorAll<HTMLElement>('.swatch[data-color]')))[0];
              for (const e of swatches.querySelectorAll<HTMLElement>('.swatch[data-color]')) {
                e.classList.toggle('swatch--primary', e === first);
              }
            },
            dropZone: {
              el: () => trash,
              place: () => {
                if (trash && plus) swatches.insertBefore(trash, plus); // only the "+" shifts over, so the measured slots are unaffected
              },
              // a refused drop (the primary) changes nothing, which the caller
              // reads as "handled" — so the swatch just snaps back
              drop: () => {
                if (colors[0] === c) return;
                removeSwatch(tool, c);
                saveToolState();
                this.renderTools();
              },
            },
          })
        : null;
      s.addEventListener('click', () => {
        if (drag?.tookClick()) return;
        onPick(c);
      });
      swatches.append(s);
    };
    colors.forEach(add);
    if (tool) {
      trash = el('button', {
        class: 'swatch swatch--trash',
        title: 'Drop a colour here to remove it',
        'aria-label': 'Drop a colour here to remove it',
        tabindex: '-1',
      });
      trash.append(icon('delete', 'sm'));
      const addBtn = el('button', { class: 'swatch swatch--add', title: 'Add colour', 'aria-label': 'Add colour' });
      plus = addBtn;
      addBtn.append(icon('plus', 'sm'));
      addBtn.addEventListener('click', async () => {
        const seed = tool === 'pen' ? toolState.penColor : toolState.hiColor;
        const deleted = tool === 'pen' ? toolState.penDeletedPresets : toolState.hiDeletedPresets;
        let restored = false;
        const hex = await pickColor(
          addBtn,
          seed === AUTO_COLOR ? '#2563eb' : seed,
          {
            colors: deleted,
            onRestore: (c) => {
              restorePreset(tool, c);
              saveToolState();
              restored = true;
            },
          },
          this.dockPopoverDirection()
        );
        if (!hex) {
          if (restored) this.renderTools();
          return;
        }
        addCustomColor(tool, hex);
        saveToolState();
        onPick(hex.toLowerCase()); // the new colour becomes the current one
      });
      swatches.append(addBtn);
    }
    return swatches;
  }

  /**
   * Long-press-to-reorder for one item of a row — the colour swatches, the
   * tool buttons, and (in `grid` mode) the page manager's thumbnail cards.
   *
   * Holding an item for HOLD_MS arms a drag: the item dims in place, a ghost
   * appended to `<body>` tracks the pointer (the row clips overflow — see
   * `.nb-dock__row`'s doc comment — so the item itself can't float past it),
   * and the row opens a gap wherever the drop would land. Dropping inside
   * `.nb-dock` commits that order; dropping outside, or never leaving the
   * starting slot, just closes the gap again.
   *
   * The preview deliberately never touches the DOM. Re-inserting the dragged
   * item would implicitly release the pointer capture taken on pointerdown —
   * capture is dropped the moment an element leaves the document, even for
   * the instant `insertBefore` takes — and the rest of the gesture would then
   * go to whatever happened to be under the pointer. So the gap is opened
   * purely by sliding transforms, which also keeps the layout the hit test
   * reads fixed for the whole drag, leaving it nothing to oscillate against.
   *
   * Returns `tookClick()`, which the caller must consult in its own click
   * handler: the browser may still send a trailing `click` for the press that
   * turned into a drag, and that must not read as a tap.
   */
  private enableReorderDrag(opts: {
    /** The row the items sit in; carries `is-reordering` while a drag is live. */
    container: HTMLElement;
    /** The one item these listeners are for. */
    item: HTMLElement;
    /** The part of `item` a press has to start on to arm a drag; `item` itself by default. The page manager's cards carry their own action buttons, which must stay pressable. */
    trigger?: HTMLElement;
    /** Every reorderable item in the row, in DOM order (must include `item`). */
    items: () => HTMLElement[];
    /** Put on `item` for the duration of the drag. */
    liftedClass: string;
    /** Builds the element that tracks the pointer. */
    ghost: () => HTMLElement;
    /** Commits a finished reorder. */
    commit: (order: HTMLElement[]) => void;
    /** Called with the previewed order as it changes, and with null on teardown (meaning: back to the real DOM order). */
    onPreviewOrder?: (order: HTMLElement[] | null) => void;
    /** An extra target that consumes the drop instead of reordering — the swatch row's trash. */
    dropZone?: { el: () => HTMLElement | null; place: () => void; drop: () => void };
    /**
     * Items wrap onto several rows (the page manager's grid) rather than
     * sitting in one row (the dock). The slot under the pointer is then the
     * nearest slot centre in both axes instead of a step along a single
     * uniform pitch, and a displaced item slides to its neighbour's actual
     * position — which is how a card at the end of a row slides down to the
     * start of the next one.
     */
    grid?: boolean;
    /** The element a drop has to finish inside to commit; the dock by default. */
    bounds?: () => HTMLElement;
    /** A natively-scrolling ancestor to auto-scroll while the pointer sits near its top/bottom edge. */
    autoscroll?: () => HTMLElement | null;
    /** Animate the ghost onto the slot it landed in instead of just vanishing. */
    settleMs?: number;
    /**
     * Also `preventDefault()` the underlying `touchmove` while the drag is
     * live. Needed wherever the item's `touch-action` deliberately still
     * permits a pan (the page manager's grid must stay scrollable from a
     * thumbnail) — `touch-action` is latched for the whole gesture at
     * `pointerdown`, so without this the browser claims the first vertical
     * move after the hold armed and cancels the pointer. Safe precisely
     * because arming required the finger to be held still: no pan has begun
     * yet, so cancelling the default still suppresses it.
     */
    blockTouchScroll?: boolean;
  }): { tookClick: () => boolean } {
    const {
      container,
      item,
      trigger = opts.item,
      items,
      liftedClass,
      ghost: makeGhost,
      commit,
      onPreviewOrder,
      dropZone,
      grid = false,
      bounds,
      autoscroll,
      settleMs = 0,
      blockTouchScroll = false,
    } = opts;
    const HOLD_MS = 350;
    const SLOP = 6;
    /** How long a displaced item takes to slide into its new slot. Short enough that the gap keeps up with a quick drag. */
    const SLIDE_MS = 140;

    let holdTimer: ReturnType<typeof setTimeout> | null = null;
    let slideTimer: ReturnType<typeof setTimeout> | null = null;
    let downX = 0;
    let downY = 0;
    let pointerId: number | null = null;
    let ghost: HTMLElement | null = null;
    let suppressClick = false;
    /** Each item's layout centre, measured once when the drag arms (a scaled item still reports its own centre, since a scale is about the origin). */
    let slots: { el: HTMLElement; center: number; cy: number }[] = [];
    let pitch = 0;
    let fromIdx = 0;
    let toIdx = 0;
    let autoRaf = 0;
    let lastX = 0;
    let lastY = 0;
    /** The auto-scroller's scrollTop when the slots above were measured — everything scrolled since has to come off their (viewport-relative) centres. */
    let scrollTop0 = 0;
    const scrollShift = (): number => {
      const sc = autoscroll?.();
      return sc ? sc.scrollTop - scrollTop0 : 0;
    };

    const clearHold = (): void => {
      if (holdTimer != null) clearTimeout(holdTimer);
      holdTimer = null;
    };
    const positionGhost = (x: number, y: number): void => {
      if (ghost) {
        ghost.style.left = `${x}px`;
        ghost.style.top = `${y}px`;
      }
    };
    const overDropZone = (x: number, y: number): boolean => {
      const z = dropZone?.el();
      if (!z?.isConnected) return false;
      const r = z.getBoundingClientRect();
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    };
    /** The items in the order the current preview would commit. */
    const previewed = (): HTMLElement[] => {
      const rest = slots.map((sl) => sl.el).filter((e) => e !== item);
      rest.splice(toIdx, 0, item);
      return rest;
    };
    /** The slot nearest the pointer, in both axes — the wrapped-grid counterpart of the single-pitch step below. */
    const nearestSlot = (x: number, y: number): number => {
      const shift = scrollShift();
      let best = toIdx;
      let bestD = Infinity;
      slots.forEach((sl, i) => {
        const d = Math.hypot(x - sl.center, y - (sl.cy - shift));
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      });
      return best;
    };
    /** Opens the gap at the slot the pointer is over: the dragged item slides to it, everything it displaces slides one slot the other way. */
    const previewDropAt = (x: number, y: number): void => {
      if (slots.length < 2) return;
      let next: number;
      if (grid) {
        next = nearestSlot(x, y);
      } else {
        if (!pitch) return;
        next = Math.max(0, Math.min(slots.length - 1, Math.round((x - slots[0].center) / pitch)));
      }
      if (next === toIdx) return;
      toIdx = next;
      slots.forEach((sl, i) => {
        let dx = 0;
        let dy = 0;
        // Which slot item `i` has to appear in: the dragged one takes `toIdx`,
        // and everything between the two ends shuffles one slot towards the
        // slot that was vacated.
        let land = i;
        if (i === fromIdx) land = toIdx;
        else if (fromIdx < toIdx && i > fromIdx && i <= toIdx) land = i - 1;
        else if (toIdx < fromIdx && i >= toIdx && i < fromIdx) land = i + 1;
        if (land !== i) {
          if (grid) {
            // the neighbour's real position, so a card at a row's end slides
            // down and across to the start of the next one
            dx = slots[land].center - sl.center;
            dy = slots[land].cy - sl.cy;
          } else {
            dx = i === fromIdx ? slots[toIdx].center - slots[fromIdx].center : land < i ? -pitch : pitch;
          }
        }
        sl.el.style.setProperty('--slide', `${dx}px`);
        if (grid) sl.el.style.setProperty('--slide-y', `${dy}px`);
      });
      onPreviewOrder?.(previewed());
    };
    /** While the pointer sits within EDGE of the scroller's top/bottom, keep scrolling it — otherwise a page can't be dropped anywhere that's off screen. */
    const autoTick = (): void => {
      autoRaf = 0;
      const sc = autoscroll?.();
      if (!ghost || !sc) return;
      const EDGE = 64;
      const SPEED = 14;
      const r = sc.getBoundingClientRect();
      const dir = lastY < r.top + EDGE ? -1 : lastY > r.bottom - EDGE ? 1 : 0;
      if (dir !== 0) {
        const before = sc.scrollTop;
        // eased by how far into the edge band the pointer is, so the scroll
        // creeps at the boundary and runs at the very edge
        const depth = dir < 0 ? (r.top + EDGE - lastY) / EDGE : (lastY - (r.bottom - EDGE)) / EDGE;
        sc.scrollTop = before + dir * SPEED * Math.min(1, Math.max(0.2, depth));
        if (sc.scrollTop !== before) previewDropAt(lastX, lastY); // the slots just moved under the pointer
      }
      autoRaf = requestAnimationFrame(autoTick);
    };
    const startDrag = (): void => {
      holdTimer = null; // the timer that called this has already fired — clearHold's clearTimeout would be a harmless no-op, but leaving the id set would make pointermove's "still waiting to arm" check below misfire
      suppressClick = true;
      item.classList.add(liftedClass);
      dropZone?.place();
      if (slideTimer != null) clearTimeout(slideTimer);
      slideTimer = null;
      container.classList.add('is-reordering'); // turns on the slide transition for the duration
      const els = items();
      slots = els.map((e) => {
        const r = e.getBoundingClientRect();
        return { el: e, center: r.left + r.width / 2, cy: r.top + r.height / 2 };
      });
      pitch = slots.length > 1 ? slots[1].center - slots[0].center : 0;
      fromIdx = els.indexOf(item);
      toIdx = fromIdx;
      scrollTop0 = autoscroll?.()?.scrollTop ?? 0;
      lastX = downX;
      lastY = downY;
      ghost = makeGhost();
      document.body.append(ghost);
      positionGhost(downX, downY);
      if (autoscroll && !autoRaf) autoRaf = requestAnimationFrame(autoTick);
    };
    /** Tears the drag down: the gap closes back up and the preview hooks are put back to the real order. */
    const teardownDrag = (): void => {
      item.classList.remove(liftedClass);
      ghost?.remove();
      ghost = null;
      if (autoRaf) {
        cancelAnimationFrame(autoRaf);
        autoRaf = 0;
      }
      const z = dropZone?.el();
      z?.classList.remove('is-over');
      z?.remove();
      for (const sl of slots) {
        sl.el.style.setProperty('--slide', '0px');
        if (grid) sl.el.style.setProperty('--slide-y', '0px');
      }
      onPreviewOrder?.(null);
      // the transition has to outlive the reset above so the gap closes
      // smoothly; a commit rebuilds the row before this lands, which is
      // just as well — there's nothing left to transition by then
      slideTimer = setTimeout(() => {
        container.classList.remove('is-reordering');
        slideTimer = null;
      }, SLIDE_MS);
      // swallow the trailing `click` the browser may still send for this
      // press, then clear the flag so it can never eat a later real tap
      setTimeout(() => {
        suppressClick = false;
      }, 0);
    };
    const endDrag = (x: number, y: number): void => {
      const onZone = overDropZone(x, y);
      const dock = (bounds?.() ?? this.toolsEl).getBoundingClientRect();
      const insideDock = x >= dock.left && x <= dock.right && y >= dock.top && y <= dock.bottom;
      // whatever the preview was showing is exactly what commits
      const order = previewed();
      const reordered = toIdx !== fromIdx;
      const landing = slots[toIdx];
      const shift = scrollShift();
      // a committing drop keeps the ghost so it can settle onto the slot it
      // landed in rather than blinking out from under the finger
      const settler = settleMs && reordered && !onZone ? ghost : null;
      if (settler) ghost = null;
      teardownDrag(); // the measurements above are taken first — this removes the drop zone
      if (onZone) {
        dropZone?.drop();
        return;
      }
      if (!insideDock || !reordered) {
        settler?.remove();
        return; // off the toolbar, or never left its slot: the gap just closes again
      }
      commit(order);
      if (settler && landing) {
        settler.style.transition = `left ${settleMs}ms ease, top ${settleMs}ms ease, transform ${settleMs}ms ease, opacity ${settleMs}ms ease`;
        requestAnimationFrame(() => {
          settler.style.left = `${landing.center}px`;
          settler.style.top = `${landing.cy - shift}px`;
          settler.style.transform = 'none'; // unwinds the lift (scale + tilt) the ghost's own class applies
          settler.style.opacity = '0';
        });
        setTimeout(() => settler.remove(), settleMs + 40);
      }
    };
    const releaseCapture = (): void => {
      clearHold();
      if (pointerId != null) {
        try {
          trigger.releasePointerCapture(pointerId);
        } catch {
          /* already released */
        }
      }
      pointerId = null;
    };

    trigger.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      downX = e.clientX;
      downY = e.clientY;
      pointerId = e.pointerId;
      trigger.setPointerCapture(pointerId);
      clearHold();
      holdTimer = setTimeout(startDrag, HOLD_MS);
    });
    trigger.addEventListener('pointermove', (e) => {
      if (holdTimer != null) {
        if (Math.abs(e.clientX - downX) > SLOP || Math.abs(e.clientY - downY) > SLOP) clearHold();
        return;
      }
      if (ghost) {
        e.preventDefault();
        lastX = e.clientX;
        lastY = e.clientY;
        positionGhost(e.clientX, e.clientY);
        const onZone = overDropZone(e.clientX, e.clientY);
        dropZone?.el()?.classList.toggle('is-over', onZone);
        if (!onZone) previewDropAt(e.clientX, e.clientY); // aiming at the drop zone isn't aiming at a slot
      }
    });
    if (blockTouchScroll) {
      trigger.addEventListener(
        'touchmove',
        (e) => {
          if (ghost) e.preventDefault(); // see blockTouchScroll's doc comment
        },
        { passive: false }
      );
    }
    trigger.addEventListener('pointerup', (e) => {
      releaseCapture();
      if (ghost) endDrag(e.clientX, e.clientY);
    });
    // the browser took the gesture over (a scroll/zoom pan, a system gesture):
    // its coordinates are zeroed, so it can never be read as a drop — close
    // the gap and leave the order alone
    trigger.addEventListener('pointercancel', () => {
      releaseCapture();
      if (ghost) teardownDrag();
    });

    return {
      tookClick: () => {
        if (!suppressClick) return false;
        suppressClick = false;
        return true;
      },
    };
  }

  // ------------------------------------------------------------ selection
  private onSelection(pc: ItemSurface, count: number): void {
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
  private onSelectionFrame(pc: ItemSurface, frame: Frame | null): void {
    if (frame && (toolState.kind === 'lasso' || toolState.kind === 'tape')) {
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
   * (the surface's own units) via `pc.calloutBasis()` (that surface's live
   * screen mapping) so it tracks scroll/zoom/drag for free, each time it's
   * told the frame changed.
   */
  private showSelectionCallout(pc: ItemSurface, frame: Frame): void {
    const basis = pc.calloutBasis();
    if (!basis) {
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
    this.positionCallout(this.calloutEl, frame, basis.rect, basis.pw);
  }

  /**
   * A lasso drag over empty space (see PageCanvas's onEmptyLassoSelection) —
   * there's nothing selected, so Duplicate/Cut/Copy/Delete would all be
   * no-ops; only Paste ever makes sense here. Shown regardless of clipboard
   * state (even an empty pill) so lassoing empty space always gives a
   * consistent place to check/attempt paste, positioned near the lasso
   * itself rather than no UI at all.
   */
  private showEmptyLassoCallout(pc: ItemSurface, frame: Frame): void {
    const basis = pc.calloutBasis();
    if (!basis) {
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
    this.positionCallout(this.calloutEl, frame, basis.rect, basis.pw);
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

    // the dock floats over the page at either edge — keep the callout out of
    // its footprint by narrowing the vertical band it may occupy to the side
    // of the dock the page content is on
    const dock = this.toolsEl.getBoundingClientRect();
    const dockOnTop = (dock.top + dock.bottom) / 2 < vh / 2;
    const freeTop = dockOnTop ? Math.max(MARGIN, dock.bottom + MARGIN) : MARGIN;
    const freeBottom = dockOnTop ? vh - MARGIN : Math.min(vh - MARGIN, dock.top - MARGIN);

    const spaceAbove = box.top - GAP - ch;
    const below = spaceAbove < freeTop;
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
    const clampedTop = Math.max(freeTop, Math.min(top, freeBottom - ch));

    callout.style.left = `${Math.round(left)}px`;
    callout.style.top = `${Math.round(clampedTop)}px`;
    // the arrow points at the selection's horizontal centre even when the
    // callout itself got clamped sideways away from directly above it
    const arrowX = Math.max(12, Math.min((box.left + box.right) / 2 - left, cw - 12));
    callout.style.setProperty('--sel-callout-arrow-x', `${Math.round(arrowX)}px`);
  }

  /** Finishes any text edit and drops any selection on every page — or on the board. */
  private deactivateAll(): void {
    for (const pc of this.pcByPage.values()) pc.deactivate();
    this.board?.deactivate();
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
    const inView: ItemSurface | null = this.isBoard
      ? this.board
      : this.currentPageId
        ? (this.pcByPage.get(this.currentPageId) ?? null)
        : null;
    const target = at ? this.calloutPc : (this.selPc ?? inView);
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
    const items = cloneItems(this.clipboard, target.page.id, this.nb.id, dx, dy);
    // pasting again (without an explicit target) lands the next copy one step further along
    if (!at && dx) this.clipboard = items.map((it) => JSON.parse(JSON.stringify(it)) as PageItem);
    target.pasteItems(items);
    return true;
  }

  private duplicateSelection(): boolean {
    const pc = this.selPc;
    const items = pc?.selectedItems() ?? [];
    if (!pc || !items.length) return false;
    pc.pasteItems(cloneItems(items, pc.page.id, this.nb.id, PASTE_OFFSET, PASTE_OFFSET));
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
      dot.style.opacity = isPen ? '1' : '0.5';
    };
    paintDot(sizeNow());
    // re-paints on zoom changes too (pageScale depends on the current zoom), not just colour
    this.colorRefreshers.push(() => paintDot(sizeNow()));

    btn.addEventListener('click', () => {
      const { panel, refreshTicks } = this.buildSizePanel(isPen, paintDot);
      this.sizePopover = openAnchoredModal(btn, panel, {
        direction: this.dockPopoverDirection(),
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
    if (this.isBoard) {
      // One canvas for the whole board, mounted once into the camera layer's
      // own host. There is no page list to reconcile.
      if (!this.board) {
        // the same hook object shape a page gets, minus the page-only members
        // (see BoardHooks) — every selection/callout/tape path above is shared
        this.board = new BoardCanvas(this.nb, this.camera, {
          onOp: (op) => {
            const isAiInk = this.aiMode.isActive() && (op.kind === 'add-stroke' || (op.kind === 'add-items' && op.aiInk));
            if (!isAiInk) this.pushOp(op);
            this.aiMode.handleOp(op);
          },
          onSelection: (s, n) => this.onSelection(s, n),
          onSelectionFrame: (s, frame) => this.onSelectionFrame(s, frame),
          onEmptyLassoSelection: (s, frame) => this.showEmptyLassoCallout(s, frame),
          isAiActive: () => this.aiMode.isActive(),
          onPendingLine: () => this.syncHistory(),
          showSelection: (s, frame, opts) => {
            this.overlayPc = s;
            // board items are already in world coordinates, so the overlay's
            // origin is the world origin and a frame *is* a world rect
            this.overlay.show(frame, opts, { origin: { x: 0, y: 0 }, pw: 0, ph: 0, paper: store.boardPaper(this.nb.id) });
          },
          updateSelection: (s, frame) => {
            if (this.overlayPc === s) this.overlay.update(frame);
          },
          hideSelection: (s) => {
            if (this.overlayPc === s) {
              this.overlay.hide();
              this.overlayPc = null;
            }
          },
        });
        this.board.mount(this.scrollEl);
      }
      return;
    }
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
    setPaperOverlayVars(pageEl, page.paper); // for the overlays drawn inside the page: ruler/protractor, text caret
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
          // An erase raised while AI mode is on ('remove-items' whole, 'edit'
          // partial) can only have reached this turn's own ink — PageCanvas
          // refuses to hit anything else (see its `erasable`) — so it is AI
          // ink too, and belongs on AiMode's turn stack rather than the main
          // one. Keeping it off the main stack is also what stops Undo, after
          // AI mode has been switched off and the turn discarded, from
          // resurrecting a piece of violet ink as permanent page content.
          const isAiInk =
            this.aiMode.isActive() &&
            (op.kind === 'add-stroke' ||
              (op.kind === 'add-items' && op.aiInk) ||
              op.kind === 'remove-items' ||
              op.kind === 'edit');
          if (!isAiInk) this.pushOp(op);
          this.aiMode.handleOp(op);
        },
        onSelection: (s, n) => this.onSelection(s, n),
        onSelectionFrame: (s, frame) => this.onSelectionFrame(s, frame),
        onEmptyLassoSelection: (s, frame) => this.showEmptyLassoCallout(s, frame),
        isAiActive: () => this.aiMode.isActive(),
        isAiInk: (itemId) => this.aiMode.isAiInk(page.id, itemId),
        onPendingLine: () => this.syncHistory(),
        refreshPage: (pageId) => this.rebuildIfMounted(pageId),
        adoptCrossPageLasso: (pageId, ids, lassoPath) => {
          if (this.mounted.has(pageId)) this.pcByPage.get(pageId)?.adoptCrossPageLasso(ids, lassoPath);
        },
        showSelection: (s, frame, opts) => {
          this.overlayPc = s;
          this.overlay.show(frame, opts, { origin: { x: pageEl.offsetLeft, y: pageEl.offsetTop }, pw: pageW(page), ph: pageH(page), paper: store.pageById(page.id)?.paper ?? page.paper });
        },
        updateSelection: (s, frame) => {
          if (this.overlayPc === s) this.overlay.update(frame);
        },
        hideSelection: (s) => {
          if (this.overlayPc === s) {
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
    setPaperOverlayVars(pageEl, page.paper);
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
    if (this.isBoard) return; // no page mount window on a board
    const viewH = this.scrollEl.clientHeight;
    // world units. The screen-px band is what keeps pop-in away, but it is
    // also capped in world terms so zooming out can't keep widening it — see
    // MOUNT_MARGIN_PX / MOUNT_MARGIN_MAX.
    const margin = Math.min(MOUNT_MARGIN_PX / this.camera.zoom, MOUNT_MARGIN_MAX);
    const viewTop = this.camera.y;
    const viewBottom = this.camera.y + viewH / this.camera.zoom;
    const loadTop = viewTop - margin;
    const loadBottom = viewBottom + margin;
    const centre = (viewTop + viewBottom) / 2;

    const candidates: Array<{ id: string; pc: PageCanvas; pageEl: HTMLElement; dist: number }> = [];
    for (const [id, wrap] of this.wrapById) {
      const pageEl = wrap.querySelector<HTMLElement>('.page');
      const pc = this.pcByPage.get(id);
      if (!pageEl || !pc) continue;
      const pTop = pageEl.offsetTop;
      const pBottom = pTop + pageEl.offsetHeight;
      if (pBottom > loadTop && pTop < loadBottom) {
        candidates.push({ id, pc, pageEl, dist: Math.abs((pTop + pBottom) / 2 - centre) });
      }
      const visibleH = Math.max(0, Math.min(pBottom, viewBottom) - Math.max(pTop, viewTop));
      const ratio = pageEl.offsetHeight > 0 ? visibleH / pageEl.offsetHeight : 0;
      if (ratio > 0) this.pageVisibility.set(id, ratio);
      else this.pageVisibility.delete(id);
    }

    // Nearest the viewport centre first, so when the band holds more pages
    // than MAX_MOUNTED_PAGES the ones dropped are the furthest from view.
    candidates.sort((a, b) => a.dist - b.dist);
    const keep = new Set<string>();
    for (const c of candidates.slice(0, MAX_MOUNTED_PAGES)) keep.add(c.id);

    const before = this.mounted.size;
    for (const c of candidates) {
      if (!keep.has(c.id)) continue;
      // only on the way in: re-rasterising an already-mounted page is
      // applyQuality's job, one per frame, not something to do synchronously
      // for every page on a camera tick
      if (!this.mounted.has(c.id)) c.pc.setQuality(this.renderQuality);
      c.pc.mount(c.pageEl);
      this.mounted.add(c.id);
      if (this.guideKind && c.id === this.guidePageId) c.pc.showGuide(this.guideKind);
    }
    for (const id of [...this.mounted]) {
      if (keep.has(id)) continue;
      const pc = this.pcByPage.get(id);
      pc?.unmount();
      // unmount() refuses mid-stroke / mid-edit; such a page stays mounted
      // (and stays in `mounted`) until the gesture finishes
      if (pc && !pc.mounted) this.mounted.delete(id);
    }
    // the budget in pageQuality is shared across whatever is mounted, so a
    // change in how many that is re-balances it
    if (this.mounted.size !== before) this.settleQuality();

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

  /** Reflects mind-map mode on its app-bar toggle. Boards only; a no-op when there is no such button. */
  private refreshMindMapBtn(): void {
    const btn = this.mindMapBtn;
    if (!btn) return;
    const on = this.board ? this.board.mindMap : mindMapEnabled(this.nb.id);
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', String(on));
  }

  /** Reflects AI mode's global state on the single app-bar toggle + send buttons, and on undo/redo (which switch to AI-scoped history while active). */
  private refreshAiControls(): void {
    const active = this.aiMode.isActive();
    this.aiToggleBtn.classList.toggle('active', active);
    this.aiToggleBtn.setAttribute('aria-pressed', String(active));
    this.aiSendBtn.hidden = !active;
    // AI mode only inks with the pen — the lockdown below disables every
    // other tool button, but leaves toolState.kind (and so pointer handling
    // in page-canvas.ts) on whatever was active before. Force it to the pen,
    // same as any other tool switch, so drawing always inks right away.
    if (active && toolState.kind !== 'pen') {
      this.deactivateAll();
      toolState.kind = 'pen';
      saveToolState();
      this.renderTools();
    }
    this.applyAiToolbarLockdown();
    this.syncHistory();
  }

  /**
   * While AI mode is on, every toolbar/app-bar button is genuinely disabled
   * (not just dimmed) except the pen, Eraser, Undo/Redo, the AI toggle and
   * the Send button — AI mode is meant to be a focused "just draw, erase,
   * undo/redo, and send" surface, not a place to also switch tools, insert
   * images, manage pages, etc. `button:disabled` already renders greyed-out
   * and inert (see styles.css), so this only needs to set the attribute on
   * the right elements. Undo/redo are left alone here and handled by
   * syncHistory instead (it already owns their disabled state the rest of
   * the time), so they keep reflecting AiMode's own per-page canUndo/canRedo
   * rather than being force-disabled like everything else. Reapplied on
   * every dock rebuild too (renderTools), since that discards and recreates
   * all of these as fresh elements.
   */
  private applyAiToolbarLockdown(): void {
    const active = this.aiMode.isActive();
    if (active) this.sizePopover?.close(); // its trigger is about to be disabled too
    this.penToolBtn?.classList.toggle('tool--ai', active);
    this.eraserToolBtn?.classList.toggle('tool--ai', active);
    for (const b of this.toolsTopEl.querySelectorAll('button')) {
      if (b === this.penToolBtn || b === this.eraserToolBtn || b === this.undoBtn || b === this.redoBtn) continue;
      (b as HTMLButtonElement).disabled = active;
    }
    for (const b of this.toolsOptionsEl.querySelectorAll('button')) {
      (b as HTMLButtonElement).disabled = active;
    }
    for (const b of this.appBarRightGroup.querySelectorAll('button')) {
      // the split button is exempt alongside the AI ones: its pane is
      // read-only, so opening or closing it can't disturb the turn AI mode is
      // capturing — and a reference page is most useful while writing to AI.
      if (b === this.aiToggleBtn || b === this.aiSendBtn || b === this.splitBtn) continue;
      (b as HTMLButtonElement).disabled = active;
    }
  }

  /** Paper of the page currently in view, for resolving the "auto" ink token. */
  private currentPaper(): Paper {
    if (this.isBoard) return store.boardPaper(this.nb.id);
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
    // A board is one continuous sheet, so there is no page to name in the title
    // and no this-page/all-pages choice to offer — the control was always
    // ignored there (see the Confirm handler), so it is dropped rather than
    // relabelled.
    const isBoard = this.isBoard;

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
      el('h2', { class: 'dlg__title', text: isBoard ? 'Board paper' : `Page ${page.index + 1} paper` }),
      field('Template', templateRow),
      field('Line spacing', spacingRow),
      field(
        'Paper color',
        segmented(['White', 'Cream', 'Dark'], COLORS.indexOf(draft.color), (i) => {
          draft = { ...draft, color: COLORS[i] };
        })
      )
    );
    if (!isBoard) {
      wrap.append(
        field(
          'Apply to',
          segmented(['This page', 'All pages'], 1, (i) => {
            scope = i === 0 ? 'page' : 'all';
          })
        )
      );
    }

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
      if (this.isBoard) {
        // one sheet, so there is no per-page/all distinction to make
        store.setBoardPaper(this.nb.id, draft);
        this.board?.paperChanged();
      } else {
        store.setPaper(page.id, draft, scope);
        if (scope === 'all') for (const p of store.pagesOf(this.nb.id)) this.refreshPagePaper(p);
        else this.refreshPagePaper(page);
      }
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
    if (this.isBoard) return; // nothing to keep a blank page after
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
   * Full-screen page manager: every page as a thumbnail, in order — hold a
   * thumbnail to drag it to a new position, duplicate, delete, or tap one to
   * jump to it. Thumbnails are rendered once per open and cached in `thumbs`
   * for the rest of the session — reordering/deleting just redraws the list
   * from the cache; only a freshly duplicated page renders new pixels.
   *
   * Reordering is `enableReorderDrag` in its grid mode — the same hold-then-
   * drag the dock's tools and colour swatches use, so there is one drag
   * implementation rather than one per surface. Up/down arrow buttons used
   * to do this job here; they're gone, which is also what gives each card
   * room for a bigger thumbnail.
   */
  private async openPageManager(): Promise<void> {
    const { renderPageCanvas } = await import('../export/raster'); // pulls in the (lazy) export/render code only when this opens
    // rendered wider than the CSS grid's minimum column (200px) since the
    // thumbnail box stretches to fill wider columns on a big screen, and on
    // an iPad a ~250px column is ~500 device px — the canvas would otherwise
    // upscale and look soft. Capped rather than tracking devicePixelRatio
    // outright: these are cached for the session, one per page.
    const THUMB_W = 420;
    const thumbs = new Map<string, HTMLCanvasElement>();

    const wrap = el('div', { class: 'pagemgr' });
    const head = el('div', { class: 'pagemgr__head' });
    const titles = el('div', { class: 'pagemgr__titles' });
    titles.append(
      el('h2', { class: 'pagemgr__title', text: 'Pages' }),
      // the hold-to-drag gesture is the only way to reorder now, and an
      // invisible gesture nobody is told about is one nobody finds
      el('span', { class: 'pagemgr__hint', text: 'Tap to jump to a page · hold and drag to reorder' })
    );
    head.append(titles);
    const closeBtn = el('button', { class: 'iconbtn', title: 'Close', 'aria-label': 'Close' });
    closeBtn.append(icon('close'));
    const selectBtn = el('button', { class: 'ghost', text: 'Select' }) as HTMLButtonElement;
    const headBtns = el('div', { class: 'pagemgr__headbtns' });
    headBtns.append(selectBtn, closeBtn);
    head.append(headBtns);
    const grid = el('div', { class: 'pagemgr__grid' });

    // multi-select: while `selecting`, a tap on a thumbnail toggles it and the
    // hold-to-drag reorder isn't bound at all (render() rebuilds on each mode change)
    let selecting = false;
    const selected = new Set<string>();
    const bar = el('div', { class: 'pagemgr__bar' });
    bar.hidden = true;
    const countEl = el('span', { class: 'pagemgr__count' });
    const selectAllBtn = el('button', { class: 'ghost', text: 'Select all' }) as HTMLButtonElement;
    const moveBtn = el('button', { class: 'ghost', text: 'Move' }) as HTMLButtonElement;
    const deleteBtn = el('button', { class: 'danger', text: 'Delete' }) as HTMLButtonElement;
    bar.append(countEl, selectAllBtn, moveBtn, deleteBtn);
    wrap.append(head, grid, bar);

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

    /** Pages that can be selected: every page but the trailing blank the notebook keeps for itself. */
    const selectableIds = (): string[] => {
      const pages = store.pagesOf(this.nb.id);
      if (pages.length && store.isBlankPage(pages[pages.length - 1].id)) pages.pop();
      return pages.map((p) => p.id);
    };

    const refreshBar = (): void => {
      const n = selected.size;
      countEl.textContent = n === 1 ? '1 selected' : `${n} selected`;
      moveBtn.disabled = n === 0;
      deleteBtn.disabled = n === 0;
      selectAllBtn.disabled = n >= selectableIds().length;
    };

    const setSelecting = (on: boolean): void => {
      selecting = on;
      selected.clear();
      selectBtn.textContent = on ? 'Done' : 'Select';
      bar.hidden = !on;
      refreshBar();
      render();
    };

    const render = (): void => {
      const pages = store.pagesOf(this.nb.id);
      const lastBlank = pages.length > 0 && store.isBlankPage(pages[pages.length - 1].id);
      grid.replaceChildren();
      pages.forEach((page, i) => {
        const selectable = !(lastBlank && i === pages.length - 1);
        const card = el('div', { class: 'pagemgr__card' });
        card.dataset.pageId = page.id;
        if (selecting && selectable) {
          card.classList.add('pagemgr__card--selectable');
          card.classList.toggle('pagemgr__card--selected', selected.has(page.id));
        }

        const thumbBtn = el('button', {
          class: 'pagemgr__thumbbtn',
          title: `Go to page ${i + 1}`,
          'aria-label': `Go to page ${i + 1}`,
        });
        const thumbBox = el('span', { class: 'pagemgr__thumb' });
        thumbBox.style.aspectRatio = `${pageW(page)} / ${pageH(page)}`; // a landscape-imported page thumbnails at its own shape, not the default portrait box
        thumbBtn.append(thumbBox, el('span', { class: 'pagemgr__num', text: `Page ${i + 1}` }));
        const drag = selecting ? null : this.enableReorderDrag({
          container: grid,
          item: card,
          trigger: thumbBtn, // not the whole card: its Duplicate/Delete buttons stay pressable
          items: () => Array.from(grid.querySelectorAll<HTMLElement>('.pagemgr__card')),
          liftedClass: 'pagemgr__card--lifted',
          grid: true,
          bounds: () => grid,
          autoscroll: () => grid,
          settleMs: 160,
          // .pagemgr__thumbbtn keeps touch-action: pan-y so the grid scrolls
          // from a thumbnail; a live drag has to cancel that pan itself
          blockTouchScroll: true,
          ghost: () => {
            const g = el('div', { class: 'pagemgr__ghost' });
            const r = thumbBox.getBoundingClientRect();
            g.style.width = `${r.width}px`;
            g.style.height = `${r.height}px`;
            g.style.margin = `${-r.height / 2}px 0 0 ${-r.width / 2}px`; // centred on the pointer, like .swatch-ghost / .tool-ghost
            const src = thumbs.get(page.id);
            if (src) {
              // a copy, not the live canvas: moving that one out of the card
              // would leave the lifted slot blank, and the grid re-renders
              // from the same cache on drop
              const c = el('canvas') as HTMLCanvasElement;
              c.width = src.width;
              c.height = src.height;
              c.className = 'pagemgr__canvas';
              c.getContext('2d')?.drawImage(src, 0, 0);
              g.append(c);
            }
            return g;
          },
          commit: (order) => {
            const to = order.indexOf(card);
            if (to >= 0 && store.reorderPage(page.id, to)) {
              this.syncPages();
              render();
            }
          },
        });
        thumbBtn.addEventListener('click', () => {
          if (selecting) {
            if (!selectable) return;
            const on = !selected.has(page.id);
            if (on) selected.add(page.id);
            else selected.delete(page.id);
            card.classList.toggle('pagemgr__card--selected', on);
            refreshBar();
            return;
          }
          if (drag?.tookClick()) return; // the press turned into a drag; not a tap
          modal.close();
          this.goToPage(page.id);
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
          actionBtn('duplicate', 'Duplicate page', selecting, () => {
            store.duplicatePage(page.id);
            store.enforceTrailingBlank(this.nb.id);
            this.syncPages();
            render();
          }),
          actionBtn('delete', 'Delete page', selecting, async () => {
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
        if (selecting && selectable) {
          // on the card, not the thumb box: the async thumbnail paint replaces that box's children
          const check = el('span', { class: 'pagemgr__check' });
          check.append(icon('check'));
          card.append(check);
        }
        grid.append(card);
      });
    };

    selectBtn.addEventListener('click', () => setSelecting(!selecting));
    selectAllBtn.addEventListener('click', () => {
      for (const id of selectableIds()) selected.add(id);
      refreshBar();
      for (const c of grid.querySelectorAll<HTMLElement>('.pagemgr__card--selectable')) c.classList.add('pagemgr__card--selected');
    });

    deleteBtn.addEventListener('click', async () => {
      const n = selected.size;
      if (!n) return;
      const ok = await confirmDialog({
        title: n === 1 ? 'Delete 1 page?' : `Delete ${n} pages?`,
        message: 'Their strokes and content will be removed from this notebook.',
        confirmText: n === 1 ? 'Delete page' : 'Delete pages',
        danger: true,
      });
      if (!ok) return;
      // snapshot in page order (ascending index) so undo can re-insert them the same way
      const items: Array<{ page: Page; strokes: Stroke[]; elements: PageElement[] }> = [];
      for (const id of selected) {
        const page = store.pageById(id);
        if (!page) continue;
        items.push({
          page: { ...page },
          strokes: store.strokesOf(id).map((s) => ({ ...s })),
          elements: store.elementsOf(id).map((e) => ({ ...e })),
        });
        thumbs.delete(id);
      }
      items.sort((a, b) => a.page.index - b.page.index);
      selected.clear();
      if (items.length) {
        store.deletePages(items.map((it) => it.page.id));
        this.pushOp({ kind: 'del-pages', items });
        this.syncPages();
      }
      refreshBar();
      render();
    });

    moveBtn.addEventListener('click', () => {
      if (!selected.size) return;
      const pages = store.pagesOf(this.nb.id); // the one scan for this move
      const before = pages.map((p) => p.id);
      const picked = pages.filter((p) => selected.has(p.id)).map((p) => p.id); // keeps their relative order
      const rest = before.filter((id) => !selected.has(id));
      // "End" stops short of the trailing blank page the notebook keeps last
      const endAt = pages.length && store.isBlankPage(before[before.length - 1]) && !selected.has(before[before.length - 1]) ? rest.length - 1 : rest.length;

      const apply = (at: number): void => {
        const after = [...rest.slice(0, at), ...picked, ...rest.slice(at)];
        if (after.every((id, i) => id === before[i])) return; // nothing would move
        if (!store.reorderPages(this.nb.id, after, pages)) return;
        this.pushOp({ kind: 'reorder-pages', before, after });
        this.syncPages();
        selected.clear();
        refreshBar();
        render();
      };

      const box = el('div', { class: 'dlg' });
      box.append(el('h2', { class: 'dlg__title', text: picked.length === 1 ? 'Move 1 page to…' : `Move ${picked.length} pages to…` }));
      const list = el('div', { class: 'pagemgr__pick' });
      const option = (label: string, at: number): void => {
        const b = el('button', { class: 'ghost', text: label }) as HTMLButtonElement;
        b.addEventListener('click', () => {
          picker.close();
          apply(at);
        });
        list.append(b);
      };
      option('Start', 0);
      option('End', endAt);
      rest.forEach((id, at) => {
        if (at === endAt && endAt < rest.length) return; // the trailing blank: "Before" it is "End"
        const n = before.indexOf(id) + 1;
        option(`Before page ${n}`, at);
      });
      box.append(list);
      const picker = openModal(box);
    });

    refreshBar();
    render();
  }

  // -------------------------------------------------------------- history
  private pushOp(op: ViewOp): void {
    this.undoStack.push(op);
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack.length = 0;
    this.syncHistory();
    this.enforceAndMaybeRerender();
    // A fresh edit repaints its own PageCanvas directly and never goes through
    // rebuildIfMounted (only undo/redo and AiMode do), so the split pane has
    // to be told here as well — otherwise a page shown in both places would
    // update in the main view and sit stale in the pane until an undo.
    for (const id of opPageIds(op)) this.pane?.refreshIfShowing(id);
  }

  /** While AI mode is active on the current page, Undo/Redo act on that
   * turn's own ephemeral ink stack instead of the notebook's normal
   * content — see AiMode.undo/redo. */
  private undo(): void {
    // A line still in its adjustable phase is the newest thing the user did,
    // but it isn't in the store or on either stack yet — popping the stack
    // here would undo the element *before* it while rebuildIfMounted's
    // refresh() quietly committed the line on the way past. Drop it instead.
    if (this.cancelPendingLine()) return;
    if (this.currentPageId && this.aiMode.isActive()) {
      this.aiMode.undo(this.currentPageId);
      return;
    }
    const op = this.undoStack.pop();
    if (!op) return;
    this.invert(op);
    this.redoStack.push(op);
    this.syncHistory();
    this.enforceAndMaybeRerender();
  }

  /**
   * Discards an adjustable line on whichever surface still holds one; true if
   * there was one. A board's snapped-but-uncommitted mind-map bubble is the
   * same kind of state — the newest thing the user did, not yet in the store
   * or on either stack — so Undo drops it here too, before the stacks.
   */
  private cancelPendingLine(): boolean {
    if (this.board?.cancelLine()) return true;
    if (this.board?.cancelPendingBubble()) return true;
    for (const pc of this.pcByPage.values()) if (pc.cancelLine()) return true;
    return false;
  }

  private hasPendingLine(): boolean {
    if (this.board?.hasPendingLine) return true;
    if (this.board?.hasPendingBubble) return true;
    for (const pc of this.pcByPage.values()) if (pc.hasPendingLine) return true;
    return false;
  }

  private redo(): void {
    if (this.currentPageId && this.aiMode.isActive()) {
      this.aiMode.redo(this.currentPageId);
      return;
    }
    const op = this.redoStack.pop();
    if (!op) return;
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
      case 'del-pages':
        // ascending original index, so each page lands where it was
        for (const it of op.items) {
          store.insertPage({ ...it.page }, it.page.index);
          for (const s of it.strokes) store.addStroke({ ...s });
          for (const e of it.elements) store.addElement({ ...e });
        }
        this.syncPages();
        break;
      case 'reorder-pages':
        store.reorderPages(this.nb.id, op.before);
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
      case 'del-pages':
        store.deletePages(op.items.map((it) => it.page.id));
        this.syncPages();
        break;
      case 'reorder-pages':
        store.reorderPages(this.nb.id, op.after);
        this.syncPages();
        break;
    }
  }

  /** After undo/redo touched a page: drop any selection there (it may reference gone items) and repaint. */
  private rebuildIfMounted(pageId: string): void {
    if (this.isBoard) {
      // undo/redo and every other store edit land here; the board repaints
      // wholesale rather than per page. `refresh` rather than `invalidate`
      // for the same reason a page uses it: an undone item may be one the
      // selection still names, and a selection box floating over nothing is
      // worse than no selection.
      this.board?.refresh();
      return;
    }
    if (this.mounted.has(pageId)) this.pcByPage.get(pageId)?.refresh();
    // the split pane may be showing this same page read-only — it holds its
    // own PageView, which `pcByPage` knows nothing about
    this.pane?.refreshIfShowing(pageId);
  }

  /** Undo/redo button enabled state — reflects AiMode's turn-scoped stack while it's active on the current page (Undo/Redo are exceptions to the toolbar lockdown, see applyAiToolbarLockdown), the main stacks otherwise. */
  private syncHistory(): void {
    // Undo drops an adjustable line before it consults either stack, so it has
    // something to do even on a page where nothing has been committed yet.
    const pending = this.hasPendingLine();
    if (this.currentPageId && this.aiMode.isActive()) {
      this.undoBtn.disabled = !pending && !this.aiMode.canUndo(this.currentPageId);
      this.redoBtn.disabled = !this.aiMode.canRedo(this.currentPageId);
      return;
    }
    this.undoBtn.disabled = !pending && this.undoStack.length === 0;
    this.redoBtn.disabled = this.redoStack.length === 0;
  }
}

/**
 * Every page an op touched. All but two kinds carry a single `pageId`; a
 * cross-page selection move names both ends, and a page deletion names the
 * page itself. Only used to tell the split pane what to repaint.
 */
function opPageIds(op: ViewOp): string[] {
  if (op.kind === 'move-page') return [op.fromPageId, op.toPageId];
  if (op.kind === 'del-page') return [op.page.id];
  if (op.kind === 'del-pages') return op.items.map((it) => it.page.id);
  if (op.kind === 'reorder-pages') return op.after; // content is unchanged, but the pane repaints what it shows
  return [op.pageId];
}

const ERASER_MODES: Record<EraserMode, { label: string; sub: string }> = {
  whole: { label: 'Whole stroke', sub: 'Removes any stroke you touch' },
  partial: { label: 'Partial', sub: 'Removes only the parts you touch' },
};

/** A page-unit Frame's (rotation-aware) bounding box, in fixed screen px — used by positionCallout. */
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
