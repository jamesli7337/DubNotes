import { AI_COLOR } from '../ai-mode';
import { DPR, pageH, pageW } from '../const';
import { store } from '../store';
import {
  ERASER_RADIUS,
  LASER_COLOR,
  LASER_FADE_MS,
  resolveDrawTool,
  SHAPE_CUE_MS,
  SHAPE_HOLD_MS,
  TEXT_DEFAULT_SIZE,
  TEXT_DEFAULT_WIDTH,
  toolState,
} from '../tools';
import type {
  ImageElement,
  Notebook,
  Page,
  PageElement,
  PageItem,
  ShapeElement,
  Stroke,
  TapeElement,
  TextElement,
} from '../types';
import { clamp, isStroke, nearPolyline, uid } from '../util';
import {
  drawBackground,
  drawElement,
  layoutText,
  TAPE_COLOR,
  TEXT_FONT_FAMILY,
  TEXT_LINE_HEIGHT,
  textHeight,
} from './elements';
import { drawStroke, resolveInkColor } from './freehand';
import { Guide, projectOnEdge, type EdgeLine, type GuideKind } from './guide';
import { lineEnds, lineFit, recognizeLine, type ShapeFit } from './recognize';
import {
  aabb,
  elementInPolygon,
  itemsFrame,
  mapPoint,
  nearShapeOutline,
  pointInElement,
  pointInPolygon,
  strokeInPolygon,
  transformItems,
  translateItems,
  type Frame,
} from './geom';
import { SelectionOverlay } from './selection';
import { drawTemplate } from './templates';

/** Undo-able edits a page can produce. Page add/delete is handled by NotebookView. */
export type Op =
  | { kind: 'add-stroke'; pageId: string; stroke: Stroke }
  | { kind: 'erase'; pageId: string; strokes: Stroke[] }
  | { kind: 'add-items'; pageId: string; items: PageItem[]; aiInk?: boolean }
  | { kind: 'remove-items'; pageId: string; items: PageItem[] }
  | { kind: 'replace-items'; pageId: string; before: PageItem[]; after: PageItem[] }
  /** some items went away and others (with different ids) took their place — e.g. a partial erase splitting strokes */
  | { kind: 'edit'; pageId: string; removed: PageItem[]; added: PageItem[] };

export interface PageHooks {
  onOp: (op: Op) => void;
  /** the set of selected items on this page changed; `count` 0 means cleared */
  onSelection: (pc: PageCanvas, count: number) => void;
  /**
   * The visible selection's frame changed shape/position — on select, drag,
   * resize, rotate, and deselect (`null`). Frame is in this page's own units;
   * pair with `pageRect()` to place external UI (the lasso selection callout)
   * against it in screen space. Fires far more often than onSelection (every
   * drag frame), so keep this cheap.
   */
  onSelectionFrame: (pc: PageCanvas, frame: Frame | null) => void;
  /**
   * A lasso *drag* (not a tap) just ended over empty space — nothing was
   * caught, so onSelection/onSelectionFrame both fire with 0/null as usual,
   * but this fires right alongside them with the drawn lasso's own bounding
   * box, so the notebook can still show a (Paste-only) callout near where
   * the user gestured, instead of no UI at all. Never fires for a plain
   * tap-to-deselect — only an actual drawn lasso shape.
   */
  onEmptyLassoSelection: (pc: PageCanvas, frame: Frame) => void;
  /**
   * A tap/hold on an *existing* tape strip while the tape tool itself is
   * active — every other tool still treats the same tap as peel/cover (see
   * toggleTape), unaffected by this. `frame` is that tape's own box, for
   * positioning a popover (resize + delete) near it — a second such call for
   * the same tape id is how the notebook's popover toggles closed again.
   */
  onTapeTap: (pc: PageCanvas, tapeId: string, frame: Frame) => void;
  /** true while AI mode is on for this page — a fresh pen/highlighter stroke inks in AI_COLOR instead of the tool's own colour. */
  isAiActive: () => boolean;
}

type CoalescingEvent = PointerEvent & { getCoalescedEvents?: () => PointerEvent[] };

/** Opacity for strokes the eraser is currently hovering, before they're actually removed. */
const PENDING_OPACITY = 0.25;
/** Opacity of the ghosted line cue shown partway through a line-snap hold, before it snaps. */
const SHAPE_CUE_OPACITY = 0.35;
/** Radius of a pending line's endpoint handles (screen px, counter-scaled for zoom), and how close a press must be to grab one. */
const LINE_HANDLE_R = 7;
const LINE_HANDLE_HIT = 14;
/** Pointer travel (page units) that turns a tap into a drag. */
const TAP_SLOP = 4;
/** Extra hit radius, in page units, when tapping a stroke to select it. */
const TAP_RADIUS = 6;
/** Max gap between two taps (ms) and how far apart they may land (page units) to still count as one double-tap — see isDoubleTap. */
const DOUBLE_TAP_MS = 350;
const DOUBLE_TAP_SLOP = 24;
/** Smallest tape strip a drag can create. */
export const TAPE_MIN = 12;
/** Smallest box the Shapes tool places (page units); an arrow only needs this much length. */
const SHAPE_MIN = 12;
/** An inserted image is fitted into this fraction of the page width. */
const IMAGE_FIT = 0.6;

/** A `Touch` carries this on WebKit (stylus vs finger); not in the standard Touch Events types. */
type WebKitTouch = Touch & { touchType?: 'direct' | 'stylus' };

interface TextEditor {
  /** the element being edited — for a new box this is not in the store yet */
  el: TextElement;
  isNew: boolean;
  area: HTMLTextAreaElement;
}

/** A line the pen snapped to, still adjustable by its endpoints and not in the store yet. */
interface LineEdit {
  a: number[];
  b: number[];
  color: string;
  size: number;
}

/**
 * One page = two canvases plus a DOM overlay:
 *  - `cache` holds the template + every committed item (repainted rarely)
 *  - `view` is what the user sees; each animation frame it blits `cache`
 *    and paints only what is in flight on top: the live stroke, the lasso
 *    path, or the items being dragged.
 *  - the selection overlay (handles) and the text editor sit above `view`.
 */
export class PageCanvas {
  readonly page: Page;
  /** this page's own size, in page units — see pageW/pageH's doc comment (const.ts). Read once at construction since a page's size never changes after creation. */
  private readonly pw: number;
  private readonly ph: number;
  private nb: Notebook;
  private readonly hooks: PageHooks;

  private host: HTMLElement | null = null;
  /** clipping layer inside the page for the canvas, text editor and guides; the selection box sits above it, unclipped */
  private clip: HTMLElement | null = null;
  private view: HTMLCanvasElement | null = null;
  private cache: HTMLCanvasElement | null = null;
  private vctx: CanvasRenderingContext2D | null = null;
  private cctx: CanvasRenderingContext2D | null = null;
  private overlay: SelectionOverlay | null = null;

  private raf = 0;
  private mode:
    | 'draw'
    | 'erase'
    | 'lasso'
    | 'text-press'
    | 'tape'
    | 'tape-tap'
    | 'laser'
    | 'shapes'
    | 'shape-press'
    | 'line-adjust'
    | null = null;
  /**
   * laser-pointer trail: each entry is one pointer-down-to-up stroke, itself a
   * list of [x, y, time] points; view-only, fades out and is never stored.
   * Kept as separate strokes (rather than one flat list) so consecutive
   * presses never draw a connecting segment between them.
   */
  private laser: number[][][] = [];
  /** tapes currently peeled back — view state, never stored */
  private readonly peeled = new Set<string>();
  /** tape under a press that may turn into a peel/cover tap */
  private tapeHit: string | null = null;
  /** a tape's geometry snapshot while its popover's resize sliders are being dragged — see beginTapeResize/commitTapeResize */
  private tapeResizeOrig: TapeElement | null = null;
  /** shape under a Shapes-tool press: a tap selects it, a drag places a new shape over it */
  private shapeHit: string | null = null;
  /** a finger resting on a tape: becomes a peel/cover tap if it lifts without moving */
  private touchTap: { id: string; pointerId: number; x: number; y: number } | null = null;
  private pointerId = -1;
  private live: number[][] = [];
  private liveTool: { kind: 'pen' | 'highlighter'; color: string; size: number } = {
    kind: 'pen',
    color: '#000',
    size: 3,
  };
  private erased = new Set<string>();
  /** partial eraser: stroke id → indices of the points rubbed out so far (view-only until pointerup) */
  private partial = new Map<string, Set<number>>();
  /** the selection polygon: the path drawn (freehand) or the box / ellipse spanning press → pointer */
  private lasso: number[][] = [];
  /** where the lasso pointer is now — for box / circle the polygon's points aren't the pointer */
  private lassoPt: number[] = [0, 0];
  /** the finalized lasso path from the most recent lasso selection, kept only for the decorative outline — set on a non-empty lasso-shape selection, cleared by every other kind of selection change. Purely visual: never read for hit-testing. */
  private lastLassoPath: number[][] | null = null;
  /** state for isDoubleTap: when/where the previous tap-on-the-selection landed. */
  private lastTapAt = 0;
  private lastTapPt: number[] = [0, 0];
  private pressPt: number[] = [0, 0];
  private isMounted = false;

  /** line-snap (pen tool only): the stroke snaps to a line once the pen has held still */
  private shapeMode = false;
  private cueTimer: ReturnType<typeof setTimeout> | null = null;
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  /** ghosted preview shown partway through the hold, alongside the still-visible ink — not yet snapped */
  private pendingFit: ShapeFit | null = null;
  /**
   * the snapped line, adjustable by its endpoint handles until a press elsewhere
   * (or a new stroke, a tool switch, undo) commits it; not in the store until then
   */
  private lineEdit: LineEdit | null = null;
  /** which endpoint the current press is dragging: 'b' for the pen that just snapped, else the handle grabbed */
  private adjustEnd: 'a' | 'b' | null = null;
  /** ruler / protractor on this page, and the edge the current stroke is snapped to */
  private guide: Guide | null = null;
  private snapEdge: EdgeLine | null = null;

  /** ids of the selected items (strokes and elements) */
  private selected = new Set<string>();
  /** snapshot of the selection when a drag started, and its live transformed copy */
  private xfOrig: PageItem[] | null = null;
  private xfFrame: Frame | null = null;
  private xfCur: Frame | null = null;
  private xfLive: PageItem[] | null = null;
  /** snapshot of lastLassoPath when the drag started (frozen, like xfOrig) — each tick's live outline is remapped from this, never from the previous tick's result, so remaps don't compound */
  private xfLassoOrig: number[][] | null = null;
  private editor: TextEditor | null = null;
  private lastDim: Set<string> | undefined;

  constructor(page: Page, nb: Notebook, hooks: PageHooks) {
    this.page = page;
    this.pw = pageW(page);
    this.ph = pageH(page);
    this.nb = nb;
    this.hooks = hooks;
  }

  get mounted(): boolean {
    return this.isMounted;
  }

  /** True while a stroke, lasso, drag or text edit is in progress. */
  get busy(): boolean {
    return this.mode != null || this.xfOrig != null || this.editor != null;
  }

  get hasSelection(): boolean {
    return this.selected.size > 0;
  }

  /** This mounted page's own screen rect — for external UI (the lasso selection callout) anchored against a Frame from onSelectionFrame. */
  pageRect(): DOMRect | null {
    return this.host?.getBoundingClientRect() ?? null;
  }

  mount(host: HTMLElement): void {
    if (this.isMounted) return;
    this.host = host;

    const view = document.createElement('canvas');
    view.width = this.pw * DPR;
    view.height = this.ph * DPR;
    const cache = document.createElement('canvas');
    cache.width = this.pw * DPR;
    cache.height = this.ph * DPR;

    this.view = view;
    this.cache = cache;
    this.vctx = view.getContext('2d');
    this.cctx = cache.getContext('2d');
    const clip = document.createElement('div');
    clip.className = 'page-clip';
    clip.appendChild(view);
    host.appendChild(clip);
    this.clip = clip;
    this.overlay = new SelectionOverlay(
      host,
      {
        onDragStart: () => this.beginTransform(),
        onDrag: (f) => this.updateTransform(f),
        onDragEnd: (f) => this.endTransform(f),
        onTap: (x, y) => this.tapSelection(x, y),
        onDelete: () => this.deleteSelection(),
      },
      this.pw,
      this.ph
    );

    view.addEventListener('pointerdown', this.onDown);
    view.addEventListener('pointermove', this.onMove);
    view.addEventListener('pointerup', this.onUp);
    view.addEventListener('pointercancel', this.onUp);
    // non-passive Touch Event listeners, purely to veto the native pan/scroll
    // gesture recognizer while a pen stroke is live — see blockNativeGesture's
    // doc comment. Pointer Events remain the only source of ink data (position,
    // pressure, getCoalescedEvents); these never touch `live`/store state.
    view.addEventListener('touchstart', this.blockNativeGesture, { passive: false });
    view.addEventListener('touchmove', this.blockNativeGesture, { passive: false });
    host.addEventListener('touchstart', this.blockNativeGesture, { passive: false });
    host.addEventListener('touchmove', this.blockNativeGesture, { passive: false });

    this.isMounted = true;
    this.rebuild();
  }

  unmount(): void {
    if (!this.isMounted || this.busy) return; // never yank mid-stroke / mid-edit
    this.commitLine();
    this.clearSelection();
    const v = this.view;
    if (v) {
      v.removeEventListener('pointerdown', this.onDown);
      v.removeEventListener('pointermove', this.onMove);
      v.removeEventListener('pointerup', this.onUp);
      v.removeEventListener('pointercancel', this.onUp);
      v.removeEventListener('touchstart', this.blockNativeGesture);
      v.removeEventListener('touchmove', this.blockNativeGesture);
      v.remove();
    }
    this.host?.removeEventListener('touchstart', this.blockNativeGesture);
    this.host?.removeEventListener('touchmove', this.blockNativeGesture);
    this.overlay?.destroy();
    this.overlay = null;
    this.guide?.destroy();
    this.guide = null;
    this.clip?.remove();
    this.clip = null;
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    this.view = this.cache = null;
    this.vctx = this.cctx = null;
    this.host = null;
    this.isMounted = false;
  }

  // ------------------------------------------------------------- painting
  /** Items that must not appear in the cache: those being dragged, edited or partially erased (the view paints them). */
  private hiddenIds(): Set<string> | null {
    if (!this.xfOrig && !this.editor && !this.partial.size) return null;
    const ids = new Set<string>();
    if (this.xfOrig) for (const it of this.xfOrig) ids.add(it.id);
    if (this.editor) ids.add(this.editor.el.id);
    for (const id of this.partial.keys()) ids.add(id);
    return ids;
  }

  /**
   * Repaints the cache from scratch (template + all committed items in z-order).
   * `pending` ids (mid-eraser-drag, not yet removed from the store) are drawn
   * dimmed rather than skipped, so the user sees what will disappear before it's
   * deleted. Items mid-drag or mid-edit are left out; the view paints them.
   */
  rebuild(pending?: Set<string>): void {
    const c = this.cctx;
    const cache = this.cache;
    if (!c || !cache) return;
    this.lastDim = pending;
    const hidden = this.hiddenIds();
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, cache.width, cache.height);
    c.setTransform(DPR, 0, 0, DPR, 0, 0);
    drawTemplate(c, this.page.paper, this.pw, this.ph);
    if (this.page.background) {
      drawBackground(c, this.page.background, this.pw, this.ph, () => this.rebuild(this.lastDim));
    }
    for (const it of store.itemsOf(this.page.id)) {
      if (hidden?.has(it.id)) continue;
      this.paintItem(c, it, pending?.has(it.id) ? PENDING_OPACITY : 1);
    }
    this.blit();
    // blit() above only repaints the committed-items cache, not the overlay
    // pass that draws the active lasso selection's decorative outline (see
    // frame()) — without this, that outline vanished the instant any rebuild
    // ran (e.g. right when a drag/resize/rotate ends), even though the
    // selection itself was still active. Scheduling a frame keeps it drawn
    // through every rebuild, not just while a gesture is still in flight.
    if (this.lastLassoPath) this.schedule();
  }

  private paintItem(ctx: CanvasRenderingContext2D, it: PageItem, opacity = 1): void {
    if (isStroke(it)) drawStroke(ctx, it, this.page.paper, opacity);
    else drawElement(ctx, it, this.page.paper, opacity, () => this.rebuild(this.lastDim), this.peeled);
  }

  private blit(): void {
    const v = this.vctx;
    if (!v || !this.view || !this.cache) return;
    v.setTransform(1, 0, 0, 1, 0, 0);
    v.clearRect(0, 0, this.view.width, this.view.height);
    v.drawImage(this.cache, 0, 0);
  }

  private frame = (): void => {
    this.raf = 0;
    this.blit();
    const v = this.vctx;
    if (!v) return;
    v.setTransform(DPR, 0, 0, DPR, 0, 0);

    // the ink in flight — unless it has already snapped to a line (drawn below, in its place)
    if (this.mode === 'draw' && this.live.length && !this.lineEdit) {
      drawStroke(
        v,
        { tool: this.liveTool.kind, color: this.liveTool.color, size: this.liveTool.size, points: this.live },
        this.page.paper
      );
      if (this.pendingFit) {
        // ghost cue partway through the hold: shown over the still-visible ink, not yet snapped
        drawElement(v, this.shapeFromFit(this.pendingFit), this.page.paper, SHAPE_CUE_OPACITY);
      }
    }
    if (this.lineEdit) this.paintLineEdit(v);
    if (this.xfLive) {
      const editing = this.editor?.el.id;
      for (const it of this.xfLive) if (it.id !== editing) this.paintItem(v, it); // the textarea shows that one
    }
    if (this.mode === 'tape' && this.live.length > 1) {
      drawElement(v, this.tapeFromDrag(), this.page.paper, 0.7); // preview of the strip being laid
    }
    if (this.mode === 'shapes' && this.live.length > 1) {
      const s = this.shapeFromDrag();
      if (s) drawElement(v, s, this.page.paper, 0.7); // preview of the shape being sized
    }
    if (this.laser.length) this.paintLaser(v);
    if (this.partial.size) {
      // partially erased strokes: the rubbed-out parts dimmed, the survivors solid
      for (const [id, gone] of this.partial) {
        const s = store.strokesOf(this.page.id).find((k) => k.id === id);
        if (!s) continue;
        drawStroke(v, s, this.page.paper, PENDING_OPACITY);
        for (const seg of survivingSegments(s.points, gone)) drawStroke(v, { ...s, points: seg }, this.page.paper);
      }
    }
    if (this.mode === 'lasso' && this.lasso.length > 1) {
      // no fill (no translucent wash over the enclosed region). A freehand
      // lasso is not closePath()ed either: the visible outline is only the
      // dashed line along the path actually drawn, with no straight segment
      // connecting end to start. A box / circle is a closed figure, so it is.
      this.strokeLassoPath(v, this.lasso, toolState.lassoShape !== 'free');
    } else if (this.lastLassoPath && this.lastLassoPath.length > 1) {
      // decorative echo of the finalized selection's lasso shape (page-space
      // points, so pan/zoom are already handled the same way as the live
      // path above — both are drawn through this same zoom-transformed
      // canvas). Static: it does not track the selection box being dragged
      // or resized afterwards, and goes stale once that happens.
      this.strokeLassoPath(v, this.lastLassoPath, true);
    }
  };

  /**
   * Draws the lasso outline. A freehand path (`!closed`) is raw pointer
   * samples — connecting them with straight `lineTo`s reads as a jagged,
   * faceted line, so it's smoothed with the standard quadratic-curve-through-
   * midpoints technique (each segment curves toward the midpoint of the next
   * one) for a clean, consistent line instead. Box/circle marquees are
   * already clean geometry (4 rectangle corners, or a 48-point circle) built
   * in marqueePolygon, not sampled input, so they're drawn as plain straight
   * segments — smoothing them would just round the box's sharp corners.
   */
  private strokeLassoPath(v: CanvasRenderingContext2D, path: number[][], closed: boolean): void {
    v.save();
    v.beginPath();
    v.moveTo(path[0][0], path[0][1]);
    if (closed) {
      for (let i = 1; i < path.length; i++) v.lineTo(path[i][0], path[i][1]);
      v.closePath();
    } else {
      for (let i = 1; i < path.length - 1; i++) {
        const mx = (path[i][0] + path[i + 1][0]) / 2;
        const my = (path[i][1] + path[i + 1][1]) / 2;
        v.quadraticCurveTo(path[i][0], path[i][1], mx, my);
      }
      if (path.length > 1) v.lineTo(path[path.length - 1][0], path[path.length - 1][1]);
    }
    v.lineCap = 'round';
    v.lineJoin = 'round';
    v.setLineDash([6, 4]);
    v.lineWidth = 1.5;
    v.strokeStyle = 'rgba(37, 99, 235, 0.9)';
    v.stroke();
    v.restore();
  }

  private schedule(): void {
    if (!this.raf) this.raf = requestAnimationFrame(this.frame);
  }

  /**
   * Draws the laser trail: each segment fades with its age over LASER_FADE_MS,
   * with a soft glow under a bright core. Keeps animating until it is gone.
   */
  private paintLaser(v: CanvasRenderingContext2D): void {
    const now = performance.now();
    this.laser = this.laser
      .map((pts) => pts.filter((p) => now - p[2] < LASER_FADE_MS))
      .filter((pts) => pts.length > 0);
    if (this.laser.length) {
      v.save();
      v.lineCap = 'round';
      v.lineJoin = 'round';
      for (const pts of this.laser) {
        for (let i = 1; i < pts.length; i++) {
          const alpha = 1 - (now - pts[i][2]) / LASER_FADE_MS;
          v.globalAlpha = alpha * 0.35;
          v.strokeStyle = LASER_COLOR;
          v.lineWidth = 14;
          v.beginPath();
          v.moveTo(pts[i - 1][0], pts[i - 1][1]);
          v.lineTo(pts[i][0], pts[i][1]);
          v.stroke();
          v.globalAlpha = alpha;
          v.lineWidth = 4;
          v.stroke();
        }
        const head = pts[pts.length - 1];
        v.globalAlpha = 1 - (now - head[2]) / LASER_FADE_MS;
        v.fillStyle = LASER_COLOR;
        v.beginPath();
        v.arc(head[0], head[1], 5, 0, Math.PI * 2);
        v.fill();
      }
      v.restore();
    }
    if (this.laser.length) this.schedule(); // keep fading
  }

  private toLocal(e: PointerEvent): number[] {
    const r = this.view!.getBoundingClientRect();
    const x = (e.clientX - r.left) * (this.pw / r.width);
    const y = (e.clientY - r.top) * (this.ph / r.height);
    let p = e.pressure;
    if (!p || p <= 0) p = 0.5; // some styluses report 0 on contact
    return [clamp(x, 0, this.pw), clamp(y, 0, this.ph), p];
  }

  // ------------------------------------------------------------- pointer
  /**
   * Vetoes iOS's native pan/scroll gesture recognizer, which can otherwise win
   * a race against our own pointer stream and steal an in-progress pen stroke
   * (surfacing as a stray pointercancel partway through — the "pencil drops to
   * touch" bug). `touch-action` alone doesn't reliably govern this for a
   * WebKit-classified stylus contact (see WebKit bug 217430); the documented,
   * production fix (used by e.g. Excalidraw) is a non-passive Touch Event
   * listener that calls preventDefault() synchronously, which iOS is
   * guaranteed to honor before any gesture recognizer acts — unlike `touch-
   * action`, whose effective value a recognizer may already have sampled
   * before our JS runs. This exists purely to block that competition; actual
   * ink data (position, pressure, coalesced points) still comes from the
   * Pointer Event handlers below, untouched.
   *
   * Blocks unconditionally while a stroke is live (`mode === 'draw'`) so a
   * palm or anything else landing mid-stroke can't trigger a native gesture
   * either. Also blocks a stylus's own touchstart even before `mode` updates
   * (WebKit tags a `Touch` with `touchType: 'stylus'`) so the very first
   * contact of a new stroke is covered too, not just the ones after — a
   * finger's touchstart (`touchType: 'direct'`) is never matched by this, so
   * finger-scrolling between strokes is untouched.
   */
  private blockNativeGesture = (e: TouchEvent): void => {
    // Hand tool: the whole point of blocking the native gesture the rest of
    // the time is to make a stylus draw instead of pan — here we want the
    // opposite, so let WebKit's own recognizer (and touch-action) take it.
    if (toolState.kind === 'hand') return;
    const stylus = Array.from(e.changedTouches).some((t) => (t as WebKitTouch).touchType === 'stylus');
    if (this.mode === 'draw' || stylus) e.preventDefault();
  };

  private onDown = (e: PointerEvent): void => {
    // Hand tool: every pointer type just pans, nothing here reacts to it —
    // no preventDefault, no capture, no tool dispatch. That leaves the event
    // to bubble/behave natively: touch/pen panning happens for free via
    // `touch-action: pan-x pan-y` on .nb-scroll (which the browser already
    // applies to pen input, not just touch — the same CSS a finger drag
    // relies on below); the mouse case (touch-action doesn't cover mice)
    // is handled separately, by NotebookView's own drag-to-pan listener on
    // .nb-scroll, which only activates for this tool.
    if (toolState.kind === 'hand') return;
    if (e.pointerType === 'touch') {
      // finger drags scroll; a finger *tap* on a tape strip still peels /
      // covers it. blockNativeGesture (above) is what actually keeps a
      // mid-stroke touch (a palm, or a stylus contact WebKit hands us as
      // 'touch') from triggering a native pan; this preventDefault is just
      // cheap, harmless, redundant insurance on top of that.
      if (this.mode === 'draw') e.preventDefault();
      const pt = this.toLocal(e);
      const tape = this.topTapeAt(pt[0], pt[1]);
      this.touchTap = tape ? { id: tape.id, pointerId: e.pointerId, x: pt[0], y: pt[1] } : null;
      return;
    }

    e.preventDefault();
    if (this.mode || this.xfOrig) return;

    const pt = this.toLocal(e);
    const kind = toolState.kind;

    // a snapped line waiting to be adjusted: a press on one of its endpoint
    // handles drags that end; a press anywhere else commits it and carries on
    if (this.lineEdit) {
      const end = this.lineEndAt(pt);
      if (end) {
        this.mode = 'line-adjust';
        this.adjustEnd = end;
        this.capture(e);
        this.schedule();
        return;
      }
      this.commitLine();
    }

    // a press on a tape strip is a peel / cover tap unless it turns into a drag
    const tape = kind === 'lasso' ? null : this.topTapeAt(pt[0], pt[1]);
    if (tape) {
      if (this.editor) this.commitEdit();
      this.mode = 'tape-tap';
      this.tapeHit = tape.id;
      this.pressPt = pt;
      this.capture(e);
      return;
    }

    if (kind === 'tape') {
      this.commitEdit();
      this.mode = 'tape';
      this.live = [pt];
      this.pressPt = pt;
      this.capture(e);
      this.schedule();
      return;
    }

    if (kind === 'shapes') {
      this.commitEdit();
      const hit = this.topShapeAt(pt[0], pt[1]);
      if (hit) {
        // over an existing shape: a tap selects it to readjust (its handles
        // take over from there); a drag places a new shape on top — decided on move/up
        this.mode = 'shape-press';
        this.shapeHit = hit.id;
        this.pressPt = pt;
        this.capture(e);
        return;
      }
      this.clearSelection(); // the last placed shape's handles go; a press inside them never reaches here
      this.beginShapeDrag(pt);
      this.capture(e);
      this.schedule();
      return;
    }

    if (kind === 'laser') {
      this.mode = 'laser';
      this.laser.push([[pt[0], pt[1], performance.now()]]); // a fresh, disconnected stroke
      this.capture(e);
      this.schedule();
      return;
    }

    if (kind === 'text') {
      if (this.editor) {
        // tapping outside the box just finishes the edit
        this.commitEdit();
        return;
      }
      const hit = this.topTextAt(pt[0], pt[1]);
      if (hit) {
        // tap → edit it; drag → move it (decided on move/up)
        this.setSelection([hit.id]);
        this.mode = 'text-press';
        this.pressPt = pt;
      } else {
        this.startEdit(this.newText(pt[0], pt[1]), true);
        return;
      }
    } else if (kind === 'lasso') {
      this.commitEdit();
      this.clearSelection();
      this.mode = 'lasso';
      this.lasso = [pt];
      this.lassoPt = pt;
      this.pressPt = pt;
    } else if (kind === 'eraser') {
      this.mode = 'erase';
      this.erased = new Set();
      this.partial = new Map();
    } else {
      const t = resolveDrawTool()!;
      this.liveTool = { kind: t.kind, color: this.aiInkColor(t.color), size: t.size };
      this.mode = 'draw';
      // a pen-down beside the ruler / protractor edge rides along that edge
      this.snapEdge = this.guide?.edgeNear(pt[0], pt[1]) ?? null;
      this.live = [this.snapped(pt)];
      this.shapeMode = kind === 'pen'; // line-snap is only ever available on the pen, not the highlighter
      this.pendingFit = null;
      if (this.shapeMode) this.armHold();
    }

    this.capture(e);
    if (this.mode === 'erase') this.eraseAt(pt);
    this.schedule();
  };

  /**
   * Blocks native pan/scroll for this contact via the `.page--capturing` class
   * (see styles.css) rather than a JS-toggled inline style — a native gesture
   * recognizer can decide eligibility using whatever touch-action was in
   * effect right at contact, before a same-task style write is guaranteed to
   * be incorporated, so a reactive inline style can lose that race. The class
   * rule itself is static in the stylesheet; only its presence is toggled.
   */
  private capture(e: PointerEvent): void {
    this.host!.classList.add('page--capturing');
    try {
      this.view!.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    this.pointerId = e.pointerId;
  }

  /** The other half of `capture()`: releases the class hold on native pan/scroll. */
  private clearCapturing(): void {
    this.host!.classList.remove('page--capturing');
  }

  private onMove = (e: PointerEvent): void => {
    if (e.pointerId !== this.pointerId || !this.mode) return;
    e.preventDefault();
    const src = e as CoalescingEvent;
    // fall back to the dispatching event itself whenever there's nothing
    // coalesced to use — whether the method is absent, or (spec-legal, if
    // rare) present but returns an empty array — so a move is never dropped
    const coalesced = src.getCoalescedEvents ? src.getCoalescedEvents() : [];
    const events = coalesced.length ? coalesced : [e];
    for (const ev of events) {
      const pt = this.toLocal(ev);
      switch (this.mode) {
        case 'draw': {
          if (this.lineEdit) {
            // already snapped: the pen is now dragging the line's far end
            this.lineEdit.b = [pt[0], pt[1]];
            break;
          }
          const last = this.live[this.live.length - 1];
          const moved = Math.hypot(pt[0] - last[0], pt[1] - last[1]) > 1.5;
          this.live.push(this.snapped(pt));
          if (this.shapeMode && moved) {
            if (this.pendingFit) {
              // translucent cue: keep tracking the pen so the ghost's length and
              // direction adjust live as you refine the stroke, rather than
              // freezing or vanishing the moment you move
              this.pendingFit = recognizeLine(this.live, this.liveTool.size);
            }
            this.armHold();
          }
          break;
        }
        case 'line-adjust':
          if (this.lineEdit && this.adjustEnd) this.lineEdit[this.adjustEnd] = [pt[0], pt[1]];
          break;
        case 'shapes':
          this.live.push(pt);
          break;
        case 'shape-press':
          // moved: it's a new shape starting from the press point, not a tap on the old one
          if (Math.hypot(pt[0] - this.pressPt[0], pt[1] - this.pressPt[1]) < TAP_SLOP) break;
          this.shapeHit = null;
          this.clearSelection();
          this.beginShapeDrag(this.pressPt);
          this.live.push(pt);
          break;
        case 'erase':
          this.eraseAt(pt);
          break;
        case 'lasso':
          this.lassoPt = pt;
          if (toolState.lassoShape === 'free') this.lasso.push(pt);
          else this.lasso = marqueePolygon(toolState.lassoShape, this.pressPt, pt);
          break;
        case 'tape':
          this.live.push(pt);
          break;
        case 'laser':
          this.laser[this.laser.length - 1].push([pt[0], pt[1], performance.now()]);
          break;
        case 'tape-tap': {
          // moved off the strip: it wasn't a tap after all — carry on with the real tool
          if (Math.hypot(pt[0] - this.pressPt[0], pt[1] - this.pressPt[1]) < TAP_SLOP) break;
          this.tapeHit = null;
          const kind = toolState.kind;
          if (kind === 'eraser') {
            this.mode = 'erase';
            this.erased = new Set();
            this.partial = new Map();
            this.eraseAt(this.pressPt);
            this.eraseAt(pt);
          } else if (kind === 'tape') {
            this.mode = 'tape';
            this.live = [this.pressPt, pt];
          } else if (kind === 'shapes') {
            this.clearSelection();
            this.beginShapeDrag(this.pressPt);
            this.live.push(pt);
          } else if (kind === 'text') {
            this.mode = null; // the text tool has nothing to drag here
          } else if (kind === 'laser') {
            this.mode = 'laser';
            // a fresh, disconnected stroke — not appended to any prior one
            this.laser.push([[this.pressPt[0], this.pressPt[1], performance.now()], [pt[0], pt[1], performance.now()]]);
          } else {
            const t = resolveDrawTool()!;
            this.liveTool = { kind: t.kind, color: this.aiInkColor(t.color), size: t.size };
            this.mode = 'draw';
            this.snapEdge = this.guide?.edgeNear(this.pressPt[0], this.pressPt[1]) ?? null;
            this.live = [this.snapped(this.pressPt), this.snapped(pt)];
            this.shapeMode = kind === 'pen';
            if (this.shapeMode) this.armHold();
          }
          break;
        }
        case 'text-press': {
          const dx = pt[0] - this.pressPt[0];
          const dy = pt[1] - this.pressPt[1];
          if (!this.xfOrig && Math.hypot(dx, dy) < TAP_SLOP) break;
          if (!this.xfOrig) this.beginTransform();
          if (this.xfOrig && this.xfFrame) {
            this.updateTransform({ ...this.xfFrame, x: this.xfFrame.x + dx, y: this.xfFrame.y + dy });
          }
          break;
        }
      }
    }
    this.schedule();
  };

  private onUp = (e: PointerEvent): void => {
    if (e.pointerType === 'touch') {
      const tap = this.touchTap;
      this.touchTap = null;
      if (tap && tap.pointerId === e.pointerId && e.type === 'pointerup') {
        const pt = this.toLocal(e);
        if (Math.hypot(pt[0] - tap.x, pt[1] - tap.y) < TAP_SLOP * 2) this.handleTapeTap(tap.id);
      }
      return;
    }
    if (e.pointerId !== this.pointerId || !this.mode) return;
    e.preventDefault();
    const cancelled = e.type === 'pointercancel';

    try {
      this.view!.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    this.clearCapturing();

    if (this.mode === 'line-adjust') {
      this.reset();
      if (!cancelled) this.commitLine(); // a handle drag ends with the line committed
      this.schedule();
      return;
    }

    if (this.mode === 'draw' && this.live.length) {
      this.disarmHold();
      if (this.lineEdit) {
        if (!cancelled) {
          // the stroke snapped: lifting leaves the line adjustable, handles and all
          this.reset();
          this.schedule();
          return;
        }
        this.lineEdit = null; // the pointer was lost mid-snap — keep the ink it started as
      }
      this.commitDrawStroke();
      return;
    }

    if (this.mode === 'erase' && (this.erased.size || this.partial.size)) {
      if (cancelled) {
        // nothing was ever persisted — pending strokes just stop being dimmed
        this.reset();
        this.rebuild();
        return;
      }
      if (this.partial.size) {
        this.commitPartialErase();
        return;
      }
      const removed = store.removeItems(this.page.id, this.erased); // strokes and shapes alike
      this.reset();
      this.rebuild();
      if (removed.length) this.hooks.onOp({ kind: 'remove-items', pageId: this.page.id, items: removed });
      return;
    }

    if (this.mode === 'lasso') {
      const path = this.lasso;
      const pt = this.lassoPt;
      this.reset();
      if (cancelled) {
        this.blit();
        return;
      }
      const travelled = Math.hypot(pt[0] - this.pressPt[0], pt[1] - this.pressPt[1]);
      if (path.length < 3 || travelled < TAP_SLOP) {
        // a tap: if a lasso selection is still active and this tap landed
        // inside its outline, a second tap close behind it (see isDoubleTap)
        // reveals the Duplicate/Cut/Copy/Delete callout without disturbing
        // the selection. Otherwise, the usual tap-select-topmost-or-clear
        // applies — which also covers "tap outside the lassoed region clears
        // the selection", since a miss (hit == null) selects nothing.
        if (this.lastLassoPath && pointInPolygon(pt[0], pt[1], this.lastLassoPath)) {
          if (this.isDoubleTap(pt[0], pt[1])) {
            const frame = itemsFrame(this.selectedItems());
            if (frame) this.hooks.onSelectionFrame(this, frame);
          }
        } else {
          const hit = this.topItemAt(pt[0], pt[1]);
          this.setSelection(hit ? [hit.id] : []);
        }
      } else {
        const ids: string[] = [];
        for (const it of store.itemsOf(this.page.id)) {
          const inside = isStroke(it) ? strokeInPolygon(it.points, path) : elementInPolygon(it, path);
          if (inside) ids.push(it.id);
        }
        this.setSelection(ids, ids.length ? path : null);
        // showSelection() (via setSelection) skips the overlay box for a
        // lasso selection but doesn't itself repaint the canvas — blit()
        // below only redraws the cache, not the overlay pass that paints
        // lastLassoPath, so schedule an animation frame for that (lands
        // before the next paint; no flash of the bare selection first)
        if (ids.length) this.schedule();
        if (!ids.length) this.hooks.onEmptyLassoSelection(this, { ...aabb(path), rot: 0 });
      }
      this.blit();
      return;
    }

    if (this.mode === 'tape-tap') {
      const id = this.tapeHit;
      this.reset();
      if (id && !cancelled) this.handleTapeTap(id);
      this.blit();
      return;
    }

    if (this.mode === 'shape-press') {
      const id = this.shapeHit;
      this.reset();
      if (id && !cancelled) this.setSelection([id]); // a tap: select it for readjusting
      this.blit();
      return;
    }

    if (this.mode === 'laser') {
      this.reset(); // the trail keeps fading on its own; nothing to store
      this.schedule();
      return;
    }

    if (this.mode === 'tape') {
      const tape = this.live.length > 1 ? this.tapeFromDrag() : null;
      this.reset();
      if (tape && !cancelled && tape.w >= TAPE_MIN && tape.h >= TAPE_MIN) {
        store.addItems([tape]);
        this.rebuild();
        this.hooks.onOp({ kind: 'add-items', pageId: this.page.id, items: [tape], aiInk: tape.color === AI_COLOR });
      } else {
        this.blit();
      }
      return;
    }

    if (this.mode === 'shapes') {
      const shape = this.live.length > 1 ? this.shapeFromDrag() : null;
      this.reset();
      if (shape && !cancelled) {
        // placed: it's an ordinary element from here on, selected so its handles are up
        store.addItems([shape]);
        this.rebuild();
        this.hooks.onOp({ kind: 'add-items', pageId: this.page.id, items: [shape], aiInk: shape.color === AI_COLOR });
        this.setSelection([shape.id]);
      } else {
        this.blit();
      }
      return;
    }

    if (this.mode === 'text-press') {
      const wasDragging = this.xfOrig != null;
      const frame = this.xfCur;
      const id = [...this.selected][0];
      this.reset();
      if (wasDragging) {
        this.endTransform(cancelled ? null : frame);
        return;
      }
      const el = store.elementsOf(this.page.id).find((x) => x.id === id);
      if (el && el.kind === 'text' && !cancelled) this.startEdit(el, false);
      return;
    }

    this.reset();
    this.blit();
  };

  private reset(): void {
    this.mode = null;
    this.live = [];
    this.lasso = [];
    this.erased = new Set();
    this.partial = new Map();
    this.pointerId = -1;
    this.tapeHit = null;
    this.shapeHit = null;
    this.snapEdge = null;
    this.pendingFit = null;
    this.adjustEnd = null; // lineEdit itself outlives the press: it stays until something commits it
    this.shapeMode = false;
    this.disarmHold();
  }

  /** While AI mode is on, a fresh stroke inks in the AI accent colour instead of the tool's own — it's ephemeral turn ink, not the user's permanent pen colour. */
  private aiInkColor(base: string): string {
    return this.hooks.isAiActive() ? AI_COLOR : base;
  }

  /** Builds a Stroke from `this.live` and commits it — the ordinary end of a draw gesture. */
  private commitDrawStroke(): void {
    if (this.live.length === 1) {
      const [x, y, p] = this.live[0];
      this.live.push([x + 0.1, y + 0.1, p]); // a tap becomes a dot
    }
    const stroke: Stroke = {
      id: uid(),
      pageId: this.page.id,
      notebookId: this.nb.id,
      tool: this.liveTool.kind,
      color: this.liveTool.color,
      size: this.liveTool.size,
      points: this.live,
      createdAt: Date.now(),
    };
    store.addStroke(stroke);
    if (this.cctx) {
      this.cctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      drawStroke(this.cctx, stroke, this.page.paper);
    }
    this.reset();
    this.blit();
    this.hooks.onOp({ kind: 'add-stroke', pageId: this.page.id, stroke });
  }

  // ----------------------------------------------------- shapes & guides
  /** The point, moved onto the guide edge the stroke is riding (pressure kept). */
  private snapped(pt: number[]): number[] {
    if (!this.snapEdge) return pt;
    const [x, y] = projectOnEdge(this.snapEdge, pt[0], pt[1]);
    return [x, y, pt[2]];
  }

  /**
   * (Re)starts the line-snap hold timers, from a dead stop. Two
   * stages, both gated on the stroke drawn *so far* already being nearly
   * straight (recognizeLine returns non-null) so an ordinary pause mid-writing
   * never shows anything:
   *   - at SHAPE_CUE_MS: a ghosted preview of the candidate line appears over
   *     the still-visible ink, as a "this is about to snap" cue. Movement
   *     doesn't cancel it — it keeps re-fitting the line to the growing stroke.
   *   - at SHAPE_HOLD_MS: the ink is replaced by the line itself, adjustable:
   *     the pen (still down) now drags the far end, and lifting leaves it on
   *     the page with both endpoint handles until something commits it.
   * Any movement before the snap re-arms both timers from scratch (see the
   * 'draw' case in onMove), so only a genuinely still pause reaches either stage.
   */
  private armHold(): void {
    this.disarmHold();
    this.cueTimer = setTimeout(() => {
      this.cueTimer = null;
      if (this.mode !== 'draw' || !this.shapeMode || this.lineEdit) return;
      const fit = recognizeLine(this.live, this.liveTool.size);
      if (fit) {
        this.pendingFit = fit;
        this.schedule();
      }
    }, SHAPE_CUE_MS);
    this.holdTimer = setTimeout(() => {
      this.holdTimer = null;
      if (this.mode !== 'draw' || !this.shapeMode || this.lineEdit) return;
      const fit = recognizeLine(this.live, this.liveTool.size);
      if (fit) {
        const [a, b] = lineEnds(fit);
        this.lineEdit = { a, b, color: this.liveTool.color, size: this.liveTool.size };
        this.adjustEnd = 'b';
        this.pendingFit = null;
        this.schedule();
      }
    }, SHAPE_HOLD_MS);
  }

  private disarmHold(): void {
    if (this.cueTimer != null) {
      clearTimeout(this.cueTimer);
      this.cueTimer = null;
    }
    if (this.holdTimer != null) {
      clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }
  }

  private shapeFromFit(fit: ShapeFit, color = this.liveTool.color, size = this.liveTool.size): ShapeElement {
    return {
      id: uid(),
      kind: 'shape',
      pageId: this.page.id,
      notebookId: this.nb.id,
      shape: fit.shape,
      x: fit.x,
      y: fit.y,
      w: fit.w,
      h: fit.h,
      rotation: fit.rotation,
      color,
      size,
      createdAt: Date.now(),
      ...(fit.pts ? { pts: fit.pts } : {}),
    };
  }

  /** The pending line as an element (fresh id each call — only commitLine keeps one). */
  private lineElement(le: LineEdit): ShapeElement {
    return this.shapeFromFit(lineFit('line', le.a, le.b, le.size), le.color, le.size);
  }

  /**
   * The view zoom the page is drawn at (the scroller's `--zoom`, inherited by
   * the canvas). Anything meant to stay a fixed size on screen — the line's
   * endpoint handles, like the selection overlay's DOM handles — divides by it.
   */
  private zoom(): number {
    const z = this.view ? parseFloat(getComputedStyle(this.view).getPropertyValue('--zoom')) : 1;
    return z > 0 ? z : 1;
  }

  /** The pending line and its two endpoint handles. */
  private paintLineEdit(v: CanvasRenderingContext2D): void {
    const le = this.lineEdit;
    if (!le) return;
    drawElement(v, this.lineElement(le), this.page.paper);
    const z = this.zoom();
    v.save();
    v.lineWidth = 2 / z;
    v.strokeStyle = '#2563eb';
    v.fillStyle = '#fff';
    for (const p of [le.a, le.b]) {
      v.beginPath();
      v.arc(p[0], p[1], LINE_HANDLE_R / z, 0, Math.PI * 2);
      v.fill();
      v.stroke();
    }
    v.restore();
  }

  /** Which endpoint handle of the pending line a press lands on, if any (the nearer wins). */
  private lineEndAt(pt: number[]): 'a' | 'b' | null {
    const le = this.lineEdit;
    if (!le) return null;
    const da = Math.hypot(pt[0] - le.a[0], pt[1] - le.a[1]);
    const db = Math.hypot(pt[0] - le.b[0], pt[1] - le.b[1]);
    if (Math.min(da, db) > LINE_HANDLE_HIT / this.zoom()) return null;
    return da <= db ? 'a' : 'b';
  }

  /** The view zoom changed: the pending line's handles are sized for the screen, so repaint them. */
  zoomChanged(): void {
    if (this.lineEdit) this.schedule();
  }

  /** Adds the pending line to the page as one undo step; a no-op when there is none. */
  commitLine(): void {
    const le = this.lineEdit;
    if (!le) return;
    this.lineEdit = null;
    this.adjustEnd = null;
    const shape = this.lineElement(le);
    store.addItems([shape]);
    this.rebuild();
    // le.color was set from aiInkColor() when the stroke that became this
    // line started — same violet-means-ephemeral-turn-ink signal add-stroke
    // ops carry, so AiMode can discard a snapped line the same way it
    // discards freehand ink once its turn is sent (see AiMode.handleOp).
    this.hooks.onOp({ kind: 'add-items', pageId: this.page.id, items: [shape], aiInk: le.color === AI_COLOR });
  }

  // --------------------------------------------------------- shapes tool
  /** Starts sizing a shape from `pt`; it takes the pen's colour and width (forced to AI_COLOR while AI mode is active, same as a pen stroke). */
  private beginShapeDrag(pt: number[]): void {
    this.liveTool = { kind: 'pen', color: this.aiInkColor(toolState.penColor), size: toolState.penSize };
    this.mode = 'shapes';
    this.live = [pt];
    this.pressPt = pt;
  }

  /**
   * The shape a Shapes-tool drag from live[0] to its last point would place, or
   * null while the drag is still too small. An arrow runs from the press to the
   * pointer; the others fill the dragged box.
   */
  private shapeFromDrag(): ShapeElement | null {
    const a = this.live[0];
    const b = this.live[this.live.length - 1];
    const kind = toolState.shapeKind;
    const { color, size } = this.liveTool;
    if (kind === 'arrow') {
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) < SHAPE_MIN) return null;
      return this.shapeFromFit(lineFit('arrow', a, b, size), color, size);
    }
    const w = Math.abs(b[0] - a[0]);
    const h = Math.abs(b[1] - a[1]);
    if (w < SHAPE_MIN || h < SHAPE_MIN) return null;
    const fit: ShapeFit = { shape: kind, x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w, h, rotation: 0 };
    if (kind === 'triangle') fit.pts = [[0.5, 0], [1, 1], [0, 1]]; // apex up, base along the bottom
    return this.shapeFromFit(fit, color, size);
  }

  /** Which guide (ruler / protractor) is shown on this page, if any. */
  get guideKind(): GuideKind | null {
    return this.guide?.kind ?? null;
  }

  showGuide(kind: GuideKind): void {
    if (!this.clip) return;
    if (this.guide?.kind === kind) return;
    this.guide?.destroy();
    this.guide = new Guide(this.clip, kind, this.pw, this.ph);
  }

  hideGuide(): void {
    this.guide?.destroy();
    this.guide = null;
  }

  private eraseAt(pt: number[]): void {
    if (toolState.eraserMode === 'partial') {
      this.partialEraseAt(pt);
      return;
    }
    let hit = false;
    const eraserTol = ERASER_RADIUS / this.zoom();
    for (const s of store.strokesOf(this.page.id)) {
      if (this.erased.has(s.id)) continue;
      const tol = s.size / 2 + eraserTol;
      if (nearPolyline(pt[0], pt[1], s.points, tol)) {
        this.erased.add(s.id);
        hit = true;
      }
    }
    if (this.eraseShapesAt(pt)) hit = true;
    if (hit) this.rebuild(this.erased);
  }

  /**
   * Marks any shape whose outline the eraser touches for removal (whole — a
   * shape has no parts to rub out, in either mode). Its interior doesn't
   * count, so erasing ink inside a box leaves the box. True when one was newly hit.
   */
  private eraseShapesAt(pt: number[]): boolean {
    let hit = false;
    const eraserTol = ERASER_RADIUS / this.zoom();
    for (const e of store.elementsOf(this.page.id)) {
      if (e.kind !== 'shape' || this.erased.has(e.id)) continue;
      if (nearShapeOutline(e, pt[0], pt[1], e.size / 2 + eraserTol)) {
        this.erased.add(e.id);
        hit = true;
      }
    }
    return hit;
  }

  /**
   * Marks the points of every stroke within the eraser's reach as rubbed out.
   * The cache is rebuilt only when a stroke *enters* the pending set (it is
   * then left out of the cache and painted by the view with the pending parts
   * dimmed); further rubbing on the same stroke only repaints the view.
   */
  private partialEraseAt(pt: number[]): void {
    let newStroke = false;
    let changed = false;
    const eraserTol = ERASER_RADIUS / this.zoom();
    for (const s of store.strokesOf(this.page.id)) {
      const tol = s.size / 2 + eraserTol;
      const t2 = tol * tol;
      let gone = this.partial.get(s.id);
      const p = s.points;
      for (let i = 0; i < p.length; i++) {
        const near = (pt[0] - p[i][0]) ** 2 + (pt[1] - p[i][1]) ** 2 <= t2;
        // a sparse stroke can pass through the eraser between two samples: treat
        // the segment as hit too, taking both of its ends
        const segHit =
          !near && i + 1 < p.length && nearPolyline(pt[0], pt[1], [p[i], p[i + 1]], tol);
        if (!near && !segHit) continue;
        if (!gone) {
          gone = new Set();
          this.partial.set(s.id, gone);
          newStroke = true;
        }
        if (!gone.has(i)) {
          gone.add(i);
          changed = true;
        }
        if (segHit && !gone.has(i + 1)) {
          gone.add(i + 1);
          changed = true;
        }
      }
    }
    const shapeHit = this.eraseShapesAt(pt);
    if (newStroke || shapeHit) this.rebuild(this.erased.size ? this.erased : undefined);
    else if (changed) this.schedule();
  }

  /** Replaces every partially erased stroke by its surviving segments, as one undo step. */
  private commitPartialErase(): void {
    const pageId = this.page.id;
    const removed: PageItem[] = [];
    const added: Stroke[] = [];
    for (const [id, gone] of this.partial) {
      const s = store.strokesOf(pageId).find((k) => k.id === id);
      if (!s) continue;
      removed.push(s);
      for (const seg of survivingSegments(s.points, gone)) added.push({ ...s, id: uid(), points: seg });
    }
    // shapes touched during a partial erase go whole, in the same undo step
    for (const e of store.elementsOf(pageId)) if (this.erased.has(e.id)) removed.push(e);
    this.reset();
    if (removed.length) {
      store.removeItems(pageId, new Set(removed.map((it) => it.id)));
      store.addItems(added);
    }
    this.rebuild();
    if (removed.length) this.hooks.onOp({ kind: 'edit', pageId, removed, added });
  }

  // ---------------------------------------------------------- hit testing
  private topItemAt(x: number, y: number): PageItem | null {
    const items = store.itemsOf(this.page.id);
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      const hit = isStroke(it)
        ? nearPolyline(x, y, it.points, it.size / 2 + TAP_RADIUS)
        : pointInElement(it, x, y);
      if (hit) return it;
    }
    return null;
  }

  private topTextAt(x: number, y: number): TextElement | null {
    const els = store.elementsOf(this.page.id);
    for (let i = els.length - 1; i >= 0; i--) {
      const e = els[i];
      if (e.kind === 'text' && pointInElement(e, x, y)) return e;
    }
    return null;
  }

  private topShapeAt(x: number, y: number): ShapeElement | null {
    const els = store.elementsOf(this.page.id);
    for (let i = els.length - 1; i >= 0; i--) {
      const e = els[i];
      if (e.kind === 'shape' && pointInElement(e, x, y)) return e;
    }
    return null;
  }

  private topTapeAt(x: number, y: number): TapeElement | null {
    const els = store.elementsOf(this.page.id);
    for (let i = els.length - 1; i >= 0; i--) {
      const e = els[i];
      if (e.kind === 'tape' && pointInElement(e, x, y)) return e;
    }
    return null;
  }

  // ------------------------------------------------------- tape & images
  /** Peels a covering strip back, or covers a peeled one. View-only: nothing is stored. */
  private toggleTape(id: string): void {
    if (this.peeled.has(id)) this.peeled.delete(id);
    else this.peeled.add(id);
    this.rebuild();
  }

  /** True while the strip is peeled back (for tests and the dock). */
  isPeeled(id: string): boolean {
    return this.peeled.has(id);
  }

  /**
   * A tap/hold resolved on an existing tape strip: every tool but the tape
   * tool itself still peels/covers it exactly as before (unaffected by the
   * popover below); the tape tool instead offers resize + delete, since a
   * tap there can no longer mean "start a new strip" (that only fires when
   * the press lands on empty page — see topTapeAt's caller in onDown).
   */
  private handleTapeTap(id: string): void {
    if (toolState.kind !== 'tape') {
      this.toggleTape(id);
      return;
    }
    const frame = this.tapeFrame(id);
    if (frame) this.hooks.onTapeTap(this, id, frame);
  }

  private getTape(id: string): TapeElement | undefined {
    return store.elementsOf(this.page.id).find((e): e is TapeElement => e.kind === 'tape' && e.id === id);
  }

  private tapeFrame(id: string): Frame | null {
    const t = this.getTape(id);
    return t ? { x: t.x, y: t.y, w: t.w, h: t.h, rot: t.rotation } : null;
  }

  /** Snapshots a tape's current geometry before a popover resize gesture, for one undo step once it finishes (see commitTapeResize). */
  beginTapeResize(id: string): TapeElement | null {
    const t = this.getTape(id);
    this.tapeResizeOrig = t ? { ...t } : null;
    return this.tapeResizeOrig;
  }

  /** Live preview while a resize slider is being dragged — repaints immediately, no undo step yet. */
  previewTapeResize(id: string, w: number, h: number): void {
    const t = this.getTape(id);
    if (!t) return;
    store.replaceItems(this.page.id, [{ ...t, w: Math.max(TAPE_MIN, w), h: Math.max(TAPE_MIN, h) }]);
    this.rebuild();
  }

  /** Commits a finished resize gesture as one undo step, against the snapshot from beginTapeResize. */
  commitTapeResize(id: string): void {
    const before = this.tapeResizeOrig;
    this.tapeResizeOrig = null;
    if (!before) return;
    const after = this.getTape(id);
    if (!after || (after.w === before.w && after.h === before.h)) return;
    this.hooks.onOp({ kind: 'replace-items', pageId: this.page.id, before: [before], after: [after] });
  }

  /** A tape strip's current width/height (page units), for the popover's resize sliders — null if it no longer exists. */
  tapeGeometry(id: string): { w: number; h: number } | null {
    const t = this.getTape(id);
    return t ? { w: t.w, h: t.h } : null;
  }

  /** Deletes one tape strip directly by id (the popover's Delete), independent of the lasso selection. */
  deleteTape(id: string): void {
    const removed = store.removeItems(this.page.id, new Set([id]));
    if (!removed.length) return;
    this.peeled.delete(id);
    this.rebuild();
    this.hooks.onOp({ kind: 'remove-items', pageId: this.page.id, items: removed });
  }

  private tapeFromDrag(): TapeElement {
    const a = this.live[0];
    const b = this.live[this.live.length - 1];
    const x = Math.min(a[0], b[0]);
    const y = Math.min(a[1], b[1]);
    return {
      id: uid(),
      kind: 'tape',
      pageId: this.page.id,
      notebookId: this.nb.id,
      x,
      y,
      w: Math.abs(b[0] - a[0]),
      h: Math.abs(b[1] - a[1]),
      rotation: 0,
      color: this.aiInkColor(TAPE_COLOR),
      createdAt: Date.now(),
    };
  }

  /** Places a loaded image centred on the page, fitted to a fraction of its width, as one undo step; selects it. */
  insertImage(src: string, naturalW: number, naturalH: number): void {
    const maxW = this.pw * IMAGE_FIT;
    const maxH = this.ph * IMAGE_FIT;
    const s = Math.min(maxW / naturalW, maxH / naturalH, 1);
    const w = Math.max(24, naturalW * s);
    const h = Math.max(24, naturalH * s);
    const el: ImageElement = {
      id: uid(),
      kind: 'image',
      pageId: this.page.id,
      notebookId: this.nb.id,
      x: (this.pw - w) / 2,
      y: (this.ph - h) / 2,
      w,
      h,
      rotation: 0,
      src,
      createdAt: Date.now(),
    };
    this.pasteItems([el]);
  }

  // ------------------------------------------------------------ selection
  /**
   * The selected items, in z-order. A text box mid-edit is represented by the
   * editor's working copy (current text and geometry), which for a brand-new
   * box is not in the store at all yet.
   */
  selectedItems(): PageItem[] {
    if (!this.selected.size) return [];
    const ed = this.editor;
    const items = store
      .itemsOf(this.page.id)
      .filter((it) => this.selected.has(it.id))
      .map((it) => (ed && it.id === ed.el.id ? ed.el : it));
    if (ed?.isNew && this.selected.has(ed.el.id)) items.push(ed.el);
    return items;
  }

  /**
   * Sets the selection. `lassoPath` is the finalized polygon when this
   * selection came from a lasso drag (non-empty result) — omitted/null for
   * every other selection path (tap-select, shape-select, text-select),
   * which clears any previous lasso outline/behaviour.
   */
  private setSelection(ids: string[], lassoPath: number[][] | null = null): void {
    this.selected = new Set(ids);
    this.lastLassoPath = lassoPath;
    this.showSelection();
    this.hooks.onSelection(this, this.selected.size);
  }

  clearSelection(): void {
    this.commitEdit();
    if (!this.selected.size) {
      this.lastLassoPath = null;
      this.overlay?.hide();
      this.hooks.onSelectionFrame(this, null);
      return;
    }
    this.setSelection([]);
  }

  /** Called by the notebook when the active tool changes: finish any edit or pending line and drop the selection. */
  deactivate(): void {
    this.commitLine();
    this.clearSelection();
  }

  /**
   * True on the second of two taps landing close together in time and
   * space — used to gate the Duplicate/Cut/Copy/Delete callout so it only
   * ever appears on a deliberate double-tap of an already-selected group,
   * never from the initial select or from a drag/resize/rotate. Consumes
   * the pair (resets the clock) so a third rapid tap needs its own new pair
   * rather than chaining off the one that just fired.
   */
  private isDoubleTap(x: number, y: number): boolean {
    const now = performance.now();
    const isDouble =
      now - this.lastTapAt <= DOUBLE_TAP_MS && Math.hypot(x - this.lastTapPt[0], y - this.lastTapPt[1]) <= DOUBLE_TAP_SLOP;
    this.lastTapAt = isDouble ? 0 : now;
    this.lastTapPt = [x, y];
    return isDouble;
  }

  /**
   * Draws (or hides) the handles around the current selection. A lasso
   * selection (this.lastLassoPath set) gets a frame around the lasso outline
   * itself (aabb of the drawn path) rather than the tighter itemsFrame, only
   * its four corner handles active, no rotate grip, and uniform (aspect-
   * locked) scaling on a corner drag so the group can't be stretched
   * non-uniformly. The frame is never reported to the notebook from here —
   * the Duplicate/Cut/Copy/Delete callout only ever opens from an explicit
   * double-tap (see isDoubleTap, tapSelection and the pointerup tap branch),
   * never automatically from selecting, dragging, resizing or rotating.
   */
  private showSelection(): void {
    const ov = this.overlay;
    if (!ov) return;
    const items = this.selectedItems();
    const lasso = this.lastLassoPath;
    const frame = lasso ? { ...aabb(lasso), rot: 0 } : itemsFrame(items);
    if (!frame) {
      ov.hide();
      this.hooks.onSelectionFrame(this, null);
      return;
    }
    const single = !lasso && items.length === 1 && !isStroke(items[0]) ? items[0] : null;
    const isText = single?.kind === 'text';
    ov.show(frame, {
      rotate: single != null, // never for a lasso selection — see above
      aspect: lasso != null || isText || single?.kind === 'image', // photos (and lasso groups) keep their proportions on a corner drag
      edges: lasso ? 'none' : isText ? 'horizontal' : 'all',
      passThrough: this.editor != null,
    });
    this.hooks.onSelectionFrame(this, null);
  }

  /**
   * A tap (no drag) on the selection box itself. For a lasso selection, the
   * box is only a rectangle around the actual (possibly non-rectangular)
   * lasso path, so a plain tap anywhere in that rectangle would otherwise
   * never reach the canvas's own tap handling — the box claims the pointer
   * event first. So it's routed here instead: inside the drawn lasso path,
   * a double-tap (see isDoubleTap) reveals the Duplicate/Cut/Copy/Delete
   * callout without touching the selection; outside the path (but still
   * inside the box's rectangle), treat it exactly like a tap that landed
   * fully outside the box already does — select whatever's under it, or
   * clear. A single (non-lasso) selected item gets the same double-tap
   * treatment.
   *
   * For every other selection, unchanged: with the text tool, a tap re-opens
   * a selected text box for editing.
   */
  private tapSelection(x: number, y: number): void {
    if (this.lastLassoPath) {
      if (!pointInPolygon(x, y, this.lastLassoPath)) {
        const hit = this.topItemAt(x, y);
        this.setSelection(hit ? [hit.id] : []);
        return;
      }
    } else if (!this.selected.size) {
      return;
    }
    if (toolState.kind === 'lasso' && this.isDoubleTap(x, y)) {
      const frame = this.lastLassoPath ? { ...aabb(this.lastLassoPath), rot: 0 } : itemsFrame(this.selectedItems());
      if (frame) this.hooks.onSelectionFrame(this, frame);
      return;
    }
    if (this.lastLassoPath || toolState.kind !== 'text' || this.editor) return;
    const items = this.selectedItems();
    const el = items.length === 1 && !isStroke(items[0]) ? items[0] : null;
    if (el?.kind === 'text' && pointInElement(el, x, y)) this.startEdit(el, false);
  }

  deleteSelection(): void {
    if (this.editor) {
      // deleting the box being edited: discard whatever was typed
      const ed = this.editor;
      this.editor = null;
      ed.area.remove();
      if (ed.isNew) {
        this.setSelection([]);
        this.rebuild();
        return;
      }
    }
    const ids = new Set(this.selected);
    this.selected = new Set();
    this.lastLassoPath = null;
    const removed = store.removeItems(this.page.id, ids);
    this.overlay?.hide();
    this.rebuild();
    this.hooks.onSelection(this, 0);
    this.hooks.onSelectionFrame(this, null);
    if (removed.length) this.hooks.onOp({ kind: 'remove-items', pageId: this.page.id, items: removed });
  }

  /** Recolours the selected strokes of one tool (pen swatches → pen strokes, etc.). */
  recolorSelection(tool: 'pen' | 'highlighter', color: string): void {
    const before = this.selectedItems().filter((it): it is Stroke => isStroke(it) && it.tool === tool);
    if (!before.length) return;
    const after = before.map((s) => ({ ...s, color }));
    store.replaceItems(this.page.id, after);
    this.rebuild();
    this.hooks.onOp({ kind: 'replace-items', pageId: this.page.id, before, after });
  }

  /**
   * Adds already-cloned items (new ids, this page) as one undo step and
   * selects them — the shared landing point for clipboard paste, Duplicate,
   * and image-insert alike. While AI mode is active, everything landing
   * here is forced into the same violet/ephemeral treatment as a fresh pen
   * stroke: colour, for whichever items have one (an image has none — still
   * tracked as this turn's ink, just with nothing to recolour), and flagged
   * aiInk so it's captured and cleared with the rest of the turn.
   */
  pasteItems(items: PageItem[]): void {
    if (!items.length) return;
    this.commitEdit();
    const aiInk = this.hooks.isAiActive();
    const toAdd = aiInk ? items.map((it) => ('color' in it ? { ...it, color: AI_COLOR } : it)) : items;
    store.addItems(toAdd);
    this.rebuild();
    this.hooks.onOp({ kind: 'add-items', pageId: this.page.id, items: toAdd, aiInk });
    this.setSelection(toAdd.map((it) => it.id));
  }

  /** The store changed under us (undo/redo): settle any pending line (like a text edit), drop any selection and repaint. */
  refresh(): void {
    this.commitLine();
    this.clearSelection();
    this.rebuild();
  }

  // ------------------------------------------------------------ transform
  private beginTransform(): void {
    const items = this.selectedItems();
    // must match showSelection()'s frame exactly — the overlay's own drag
    // math (and the `frame` values it reports to updateTransform) are
    // relative to whatever frame was last shown, so if this independently
    // recomputed the tighter itemsFrame for a lasso selection instead, the
    // two would disagree about what "from" means and distort items on the
    // very first drag tick.
    const frame = this.lastLassoPath ? { ...aabb(this.lastLassoPath), rot: 0 } : itemsFrame(items);
    if (!items.length || !frame) return;
    this.xfOrig = items;
    this.xfFrame = frame;
    this.xfCur = frame;
    this.xfLive = items;
    this.xfLassoOrig = this.lastLassoPath;
    this.hooks.onSelectionFrame(this, null); // moving/resizing/rotating must never trigger or keep open the callout
    this.rebuild(); // hides the originals; the view paints the live copies
  }

  private updateTransform(frame: Frame): void {
    if (!this.xfOrig || !this.xfFrame) return;
    const same = frame.w === this.xfFrame.w && frame.h === this.xfFrame.h && frame.rot === this.xfFrame.rot;
    this.xfLive = same
      ? translateItems(this.xfOrig, frame.x - this.xfFrame.x, frame.y - this.xfFrame.y)
      : transformItems(this.xfOrig, this.xfFrame, frame);
    // remapped fresh from the frozen pre-drag snapshot each tick (never from
    // the previous tick's result) so repeated remaps don't compound — same
    // reasoning as xfLive being recomputed from xfOrig every time, not from
    // itself
    if (this.xfLassoOrig) {
      const from = this.xfFrame;
      this.lastLassoPath = this.xfLassoOrig.map((p) => mapPoint(p[0], p[1], from, frame));
    }
    this.xfCur = frame;
    this.syncEditor(this.xfLive[0]);
    this.overlay?.update(frame);
    this.schedule();
  }

  private endTransform(frame: Frame | null): void {
    const orig = this.xfOrig;
    const from = this.xfFrame;
    const lassoOrig = this.xfLassoOrig;
    this.xfOrig = this.xfFrame = this.xfCur = this.xfLive = null;
    this.xfLassoOrig = null;
    if (!orig || !from) return;

    if (frame) {
      const same = frame.w === from.w && frame.h === from.h && frame.rot === from.rot;
      const after = same
        ? translateItems(orig, frame.x - from.x, frame.y - from.y)
        : transformItems(orig, from, frame).map((it) =>
            !isStroke(it) && it.kind === 'text' ? { ...it, h: textHeight(it) } : it
          );
      const ed = this.editor;
      if (ed && orig.length === 1 && orig[0].id === ed.el.id) {
        // mid-edit: keep the geometry on the working copy; commitEdit records
        // the whole edit (typing + moves) as a single undo step
        ed.el = after[0] as TextElement;
      } else {
        store.replaceItems(this.page.id, after);
        this.hooks.onOp({ kind: 'replace-items', pageId: this.page.id, before: orig, after });
      }
      // permanently commit the outline's new shape (not just the live view
      // during the drag) so it doesn't snap back to its pre-drag position on
      // the next showSelection() below, and a second drag starts consistent
      // with where the box and items actually ended up
      if (lassoOrig) this.lastLassoPath = lassoOrig.map((p) => mapPoint(p[0], p[1], from, frame));
    } else if (lassoOrig) {
      // cancelled drag: items were never changed, so restore the outline to
      // its pre-drag shape too, undoing whatever updateTransform() left it at
      this.lastLassoPath = lassoOrig;
    }
    this.rebuild();
    this.showSelection();
    this.syncEditor();
  }

  // ------------------------------------------------------------ text edit
  private newText(x: number, y: number): TextElement {
    const fontSize = TEXT_DEFAULT_SIZE;
    const w = Math.min(TEXT_DEFAULT_WIDTH, this.pw - x);
    return {
      id: uid(),
      kind: 'text',
      pageId: this.page.id,
      notebookId: this.nb.id,
      x,
      y: clamp(y - fontSize * TEXT_LINE_HEIGHT * 0.5, 0, this.ph - fontSize),
      w: Math.max(w, 60),
      h: fontSize * TEXT_LINE_HEIGHT,
      rotation: 0,
      text: '',
      color: this.aiInkColor(toolState.textColor),
      fontSize,
      createdAt: Date.now(),
    };
  }

  private startEdit(el: TextElement, isNew: boolean): void {
    if (!this.clip) return;
    this.commitEdit();
    const area = document.createElement('textarea');
    area.className = 'text-editor';
    area.rows = 1;
    area.spellcheck = false;
    area.setAttribute('aria-label', 'Text box');
    area.value = el.text;
    this.editor = { el: { ...el }, isNew, area };
    this.clip.append(area);
    this.syncEditor();

    area.addEventListener('input', () => {
      const ed = this.editor;
      if (!ed) return;
      ed.el = { ...ed.el, text: area.value, h: layoutText(area.value, ed.el.fontSize, ed.el.w).height };
      this.syncEditor();
      const f = itemsFrame([ed.el]);
      if (f) this.overlay?.update(f);
    });
    area.addEventListener('keydown', (e) => {
      e.stopPropagation(); // typing must not trigger app shortcuts
      if (e.key === 'Escape') {
        e.preventDefault();
        this.commitEdit();
      }
    });
    area.addEventListener('pointerdown', (e) => e.stopPropagation());

    this.selected = new Set([el.id]);
    this.lastLassoPath = null;
    this.rebuild(); // hides the committed copy while the textarea shows it
    this.showSelection();
    this.hooks.onSelection(this, 1);
    requestAnimationFrame(() => {
      area.focus();
      area.setSelectionRange(area.value.length, area.value.length);
    });
  }

  /** Positions the textarea over its element (the live one mid-drag, else the editor's). */
  private syncEditor(live?: PageItem): void {
    const ed = this.editor;
    if (!ed) return;
    const el = live && live.id === ed.el.id && !isStroke(live) && live.kind === 'text' ? live : ed.el;
    const s = ed.area.style;
    s.left = `${el.x}px`;
    s.top = `${el.y}px`;
    s.width = `${el.w}px`;
    s.height = `${Math.max(el.h, el.fontSize * TEXT_LINE_HEIGHT)}px`;
    s.font = `400 ${el.fontSize}px ${TEXT_FONT_FAMILY}`;
    s.lineHeight = String(TEXT_LINE_HEIGHT);
    s.color = resolveInkColor(el.color, this.page.paper);
    s.transform = el.rotation ? `rotate(${el.rotation}rad)` : '';
  }

  /** Finishes the current text edit: adds / updates / removes the element as one undo step. */
  commitEdit(): void {
    const ed = this.editor;
    if (!ed) return;
    this.editor = null;
    ed.area.remove();
    const text = ed.area.value;
    const pageId = this.page.id;

    if (!text.trim()) {
      if (!ed.isNew) {
        const removed = store.removeItems(pageId, new Set([ed.el.id]));
        if (removed.length) this.hooks.onOp({ kind: 'remove-items', pageId, items: removed });
      }
      this.selected = new Set();
      this.lastLassoPath = null;
      this.overlay?.hide();
      this.rebuild();
      this.hooks.onSelection(this, 0);
      return;
    }

    const next: TextElement = { ...ed.el, text, h: layoutText(text, ed.el.fontSize, ed.el.w).height };
    if (ed.isNew) {
      store.addItems([next]);
      this.hooks.onOp({ kind: 'add-items', pageId, items: [next], aiInk: next.color === AI_COLOR });
    } else {
      const cur = store.elementsOf(pageId).find((e) => e.id === next.id);
      if (cur && !sameText(cur, next)) {
        store.replaceItems(pageId, [next]);
        this.hooks.onOp({ kind: 'replace-items', pageId, before: [cur], after: [next] });
      }
    }
    this.rebuild();
    this.showSelection(); // stays selected (draggable) until the user taps elsewhere
  }

  /** Called when the page's paper changes: text ink may resolve differently now. */
  paperChanged(): void {
    this.rebuild();
    this.syncEditor();
  }

  /** Builds a copy of `el` for another page/position; used by paste and duplicate. */
  static cloneItem(it: PageItem, pageId: string, notebookId: string, dx: number, dy: number): PageItem {
    const base = { id: uid(), pageId, notebookId, createdAt: Date.now() };
    if (isStroke(it)) {
      return { ...it, ...base, points: it.points.map((p) => [p[0] + dx, p[1] + dy, p[2]]) };
    }
    const el: PageElement = { ...it, ...base, x: it.x + dx, y: it.y + dy };
    return el;
  }
}

/** The box or ellipse spanning two corners, as a polygon the lasso hit-tests can use as-is. */
function marqueePolygon(shape: 'box' | 'circle', a: number[], b: number[]): number[][] {
  const x0 = Math.min(a[0], b[0]);
  const y0 = Math.min(a[1], b[1]);
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  if (shape === 'box') {
    return [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ];
  }
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const rx = (x1 - x0) / 2;
  const ry = (y1 - y0) / 2;
  const n = 48;
  const pts: number[][] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    pts.push([cx + rx * Math.cos(t), cy + ry * Math.sin(t)]);
  }
  return pts;
}

/** Maximal runs of points not in `gone`; runs shorter than two points can't be drawn and are dropped. */
function survivingSegments(points: number[][], gone: Set<number>): number[][][] {
  const segs: number[][][] = [];
  let run: number[][] = [];
  for (let i = 0; i <= points.length; i++) {
    if (i < points.length && !gone.has(i)) {
      run.push(points[i]);
      continue;
    }
    if (run.length >= 2) segs.push(run);
    run = [];
  }
  return segs;
}

/** True when nothing an edit session can change (text or geometry) differs. */
function sameText(a: PageElement, b: TextElement): boolean {
  return (
    a.kind === 'text' &&
    a.text === b.text &&
    a.x === b.x &&
    a.y === b.y &&
    a.w === b.w &&
    a.h === b.h &&
    a.rotation === b.rotation &&
    a.fontSize === b.fontSize &&
    a.color === b.color
  );
}
