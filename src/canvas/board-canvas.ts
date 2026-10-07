import { AI_COLOR } from '../ai-mode';
import { DPR } from '../const';
import { store } from '../store';
import {
  ERASER_RADIUS,
  resolveDrawTool,
  TAP_SLOP,
  TEXT_DEFAULT_SIZE,
  TEXT_DEFAULT_WIDTH,
  toolState,
} from '../tools';
import type {
  BubbleElement,
  BubbleNode,
  ConnectorElement,
  ImageElement,
  Notebook,
  Paper,
  PageElement,
  PageItem,
  ShapeElement,
  Stroke,
  TapeElement,
  TextElement,
} from '../types';
import { isStroke, nearPolyline, uid } from '../util';
import {
  aabb,
  bubbleNodePoint,
  bubbleNodes,
  bubblePolygon,
  connectorBox,
  nearConnector,
  nearElementOutline,
  nearestBubbleNode,
  nearShapeOutline,
  elementInPolygon,
  itemBounds,
  itemFullyInPolygon,
  itemsFrame,
  mapPoint,
  pointInElement,
  pointInPolygon,
  strokeInPolygon,
  transformItems,
  translateItems,
  type Camera,
  type Frame,
  type Rect,
} from './geom';
import { densifyStrokePoints, drawStroke, resolveInkColor } from './freehand';
import { InkSmoother, type ClientSample } from './ink-smoothing';
import {
  drawElement,
  layoutText,
  TAPE_COLOR,
  TEXT_FONT_FAMILY,
  TEXT_LINE_HEIGHT,
  textHeight,
} from './elements';
import { lineEnds, lineFit, recognizeLine, recognizeLoop, type LoopFit, type ShapeFit } from './recognize';
import {
  cloneItem,
  IMAGE_FIT,
  LineSnapHold,
  lineEndAt,
  paintLaserTrail,
  paintLineHandles,
  holdDrifted,
  SHAPE_CUE_OPACITY,
  trailMoved,
  type LaserTrail,
  type LineEdit,
  marqueePolygon,
  sameText,
  selectionView,
  SHAPE_MIN,
  strokeLassoPath,
  survivingSegments,
  TAP_RADIUS,
  topElementAt,
  topItemAt,
  type ItemSurface,
  type SurfaceHooks,
} from './item-surface';
import { drawTemplate, SPACING_PX } from './templates';
import { TAPE_MIN } from './page-canvas';

/**
 * A board's whole visible surface: one canvas the size of the viewport,
 * redrawn from `store.boardItemsIn` culled to the visible world rect. There
 * are no pages and no tiles — a throwaway spike measured 9.9ms for a worst case
 * of 1861 visible items at zoom 0.2 on an iPad, so a single culled repaint fits
 * the frame budget and tiling can wait.
 *
 * Two canvases, for the same reason PageCanvas has two:
 *  - `settled` holds the paper plus every committed item, rendered for a world
 *    rect a margin larger than the viewport. A pan that stays inside that
 *    margin is a straight `drawImage` at an offset — no item is touched.
 *  - `view` is what the user sees: each frame it blits `settled` and paints
 *    only what is in flight (the live stroke).
 *
 * Crossing the margin, or any zoom change, re-renders `settled` for the new
 * rect. A committed stroke is drawn straight into `settled` rather than
 * invalidating it, so finishing a stroke never costs a full repaint.
 *
 * Coordinates are global board units throughout — nothing here remaps into a
 * chunk's space, because chunks are only a persistence detail (see
 * `Page.col`/`row`).
 */

/** How much larger than the viewport the settled copy is rendered, per side. */
const MARGIN = 0.25;
/** Opacity for strokes the eraser is hovering, before they are actually removed — matches PageCanvas. */
const PENDING_OPACITY = 0.25;

/**
 * A board raises exactly the shared surface hooks and nothing more — the
 * page-only ones (another page to repaint, a cross-page lasso to adopt, the
 * notebook-level drag-preview canvas) have no meaning here: there is one
 * surface, and it is already viewport-sized, so a dragged item can never be
 * clipped by leaving it.
 */
export type BoardHooks = SurfaceHooks;

/** Max gap between two taps (ms) and how far apart they may land to still count as one double-tap. */
const DOUBLE_TAP_MS = 350;
const DOUBLE_TAP_SLOP = 24;

/**
 * Mind-map mode is one on/off switch *per board*, kept in `localStorage`
 * alongside the split pane's own per-notebook state (`noteapp.split.<id>`,
 * secondary-pane.ts) rather than in the notebook record — it is view state,
 * not content: turning it off leaves every bubble exactly where it was, and
 * it has no business in a backup.
 *
 * Read through these two helpers rather than the key, because the app bar's
 * toggle is built before the BoardCanvas that owns the live flag exists.
 */
const MIND_MAP_PREFIX = 'noteapp.mindmap.';

export function mindMapEnabled(notebookId: string): boolean {
  try {
    return localStorage.getItem(MIND_MAP_PREFIX + notebookId) === '1';
  } catch {
    return false; // private mode / blocked storage: the mode is simply off
  }
}

export function setMindMapEnabled(notebookId: string, on: boolean): void {
  try {
    if (on) localStorage.setItem(MIND_MAP_PREFIX + notebookId, '1');
    else localStorage.removeItem(MIND_MAP_PREFIX + notebookId);
  } catch {
    /* ignore — a forgotten mode is not worth failing an edit over */
  }
}

/** Extra radius (screen px, counter-scaled for zoom) *outside* a bubble's outline that still counts as a press on it. */
const BUBBLE_GRAB_TOL = 14;

/**
 * Hold-to-grab, tuned for a Pencil resting on glass rather than for a hold
 * mid-stroke:
 *
 *  - The durations are much shorter than the straighten hold's. That one has to
 *    not misread an ordinary pause while writing; a press that lands on a
 *    bubble and stays there has no such ambiguity, so this sits near the
 *    platform's own long-press feel instead.
 *  - The slop is wider than a tap's, and — crucially — measured in **screen**
 *    px against the press's own client coordinates rather than in board units
 *    against a board-space press point. A resting hand wanders a few px
 *    (diagonally, which is what made a 4-unit board-space threshold cancel on
 *    ~3px of genuine jitter), and a board-space threshold also counts *camera*
 *    movement as pen travel — so a one-finger pan or the palm-rejection camera
 *    rewind under a resting pen would cancel a grab that the pen never moved
 *    for. It sits between the few px a resting hand covers and the ~15px of
 *    extent even the smallest letter has, so it is what catches writing that
 *    is too slow and too local to trip BUBBLE_HOLD_PATH quickly.
 */
const BUBBLE_CUE_MS = 220;
const BUBBLE_HOLD_MS = 700;
const BUBBLE_HOLD_SLOP = 12;
/**
 * Cumulative travel (screen px) that cancels the hold, counting only movement
 * that `trailMoved` judges real.
 *
 * Displacement alone is not enough to tell writing from resting: small, slow
 * handwriting wanders back and forth and can stay within BUBBLE_HOLD_SLOP of
 * where it started for the whole hold window, so the grab would fire in the
 * middle of a letter. Path length sees that immediately — a letter is tens of
 * px of travel whatever its extent.
 *
 * Counting only `trailMoved` steps helps — a hand whose tremor oscillates
 * about a point stays within 1.5 units of the trailing mean and contributes
 * nothing — but a hand that *drifts* or circles slowly while resting does
 * accumulate real path, so this is set well above what such a hand manages
 * inside one hold (a 4px-radius wander is under 60px over BUBBLE_HOLD_MS)
 * rather than as tight as writing alone would allow. Writing is caught twice
 * over anyway: handwriting runs an order of magnitude faster than that (~0.4
 * px/ms even when slow, so ~200ms to get here), and anything with more than
 * BUBBLE_HOLD_SLOP of extent trips the displacement check first.
 */
const BUBBLE_HOLD_PATH = 72;

/** Revealed connection nodes: drawn radius and press target (screen px, counter-scaled for zoom). */
const NODE_R = 5;
const NODE_HIT = 16;

interface BoardTextEditor {
  /** the element being edited — for a new box this is not in the store yet */
  el: TextElement;
  isNew: boolean;
  area: HTMLTextAreaElement;
}

export class BoardCanvas implements ItemSurface {
  private readonly nb: Notebook;
  private readonly camera: Camera;
  private readonly hooks: BoardHooks;

  private host: HTMLElement | null = null;
  private view: HTMLCanvasElement | null = null;
  private vctx: CanvasRenderingContext2D | null = null;
  private settled: HTMLCanvasElement | null = null;
  private sctx: CanvasRenderingContext2D | null = null;

  /** World rect the settled copy currently holds, and the zoom it was rendered at. Null means it holds nothing usable. */
  private settledRect: Rect | null = null;
  private settledZoom = 0;

  private raf = 0;
  private cssW = 0;
  private cssH = 0;

  /**
   * The textarea for an in-place text edit lives in its own layer rather than
   * on the canvas. A page can put it straight into `.page-clip` in page units
   * and let `.nb-camera`'s CSS transform scale it; a board draws its camera
   * into the canvas instead, so there is no transformed DOM layer to inherit.
   * `editorCam` is that missing layer: the same `scale(z) translate(-x, -y)`
   * the page view applies to `.nb-camera`, re-applied whenever the camera
   * moves — which lets the textarea itself be positioned in plain board units,
   * identically to the page path.
   */
  private editorLayer: HTMLElement | null = null;
  private editorCam: HTMLElement | null = null;

  /** Live gesture state. */
  private mode:
    | 'draw'
    | 'erase'
    | 'lasso'
    | 'shapes'
    | 'shape-press'
    | 'tape'
    | 'tape-tap'
    | 'text-press'
    | 'laser'
    | 'line-adjust'
    /** mind map: a press on a bubble that may yet become a hold-to-move, a mark, or nothing */
    | 'bubble-press'
    /** mind map: the hold fired — the bubble and everything it owns move with the pen */
    | 'bubble-move'
    /** mind map: dragging a connector out of a revealed node */
    | 'connect'
    | 'dismiss'
    | null = null;
  private pointerId = -1;
  private live: number[][] = [];
  private liveTool: { kind: 'pen' | 'highlighter'; color: string; size: number } = { kind: 'pen', color: '#000', size: 3 };
  /** ids the current eraser drag will delete on release (whole-stroke mode) */
  private erased = new Set<string>();
  /** partial eraser: stroke id -> indices rubbed out so far, applied on release */
  private partial = new Map<string, Set<number>>();

  /** lasso: the polygon being drawn, and the latest point (for the tap-vs-drag test) */
  private lasso: number[][] = [];
  private lassoPt: number[] = [0, 0];
  /** the finalized polygon of the current lasso selection, drawn as a dashed echo — null for every other way of selecting */
  private lastLassoPath: number[][] | null = null;
  private pressPt: number[] = [0, 0];
  private tapeHit: string | null = null;
  private shapeHit: string | null = null;
  private lastTapAt = 0;
  private lastTapPt: number[] = [0, 0];

  /**
   * Laser-pointer trail: each entry is one pointer-down-to-up stroke. Never
   * stored, and drawn by this canvas's own existing frame loop rather than a
   * second one — `paintLaserTrail` reschedules while anything is still fading,
   * exactly as it does for a page.
   */
  private laser: LaserTrail = [];

  /** line snap: the ghosted cue partway through a hold, then the adjustable line itself */
  private shapeMode = false;
  private pendingFit: ShapeFit | null = null;
  private lineEdit: LineEdit | null = null;
  private adjustEnd: 'a' | 'b' | null = null;
  private readonly hold = new LineSnapHold();
  /** the pen tip when the snap hold was last (re)armed; the hold only restarts once the tip drifts HOLD_DRIFT_PX from here */
  private holdAnchor: number[] | null = null;
  /** this press is spent settling a pending line / selection elsewhere, so it must not also draw */
  private dismissingPress = false;

  /**
   * Mind-map mode (this board only — see mindMapEnabled). While on, the pen's
   * hold-to-snap fits a *loop* instead of a line (`loopMode` below replaces
   * `shapeMode` for the press), a stationary press on a bubble grabs it, and
   * the eraser takes bubbles by their outline.
   */
  private mindMapOn: boolean;
  /** this press is eligible for loop-snap — the mind-map counterpart of `shapeMode`, and never set at the same time */
  private loopMode = false;
  /** the ghosted cue partway through a loop hold, then the snapped-but-uncommitted bubble */
  private pendingLoop: LoopFit | null = null;
  /**
   * A bubble that has snapped but is not in the store yet — the exact shape
   * `lineEdit` has, for the same reason: it is the newest thing the user did,
   * so Undo has to be able to drop it before it consults any stack, and any
   * press that lands afterwards settles it. `members` is recomputed at commit
   * time against the live store, so this holds nothing but the outline.
   */
  private pendingBubble: BubbleElement | null = null;
  /** mind map: which bubble the current 'bubble-press' / 'bubble-move' is about */
  private bubbleHit: string | null = null;
  /** mind map: the hold's first stage fired — the bubble is drawn emphasised, about to be grabbable */
  private bubbleCue = false;
  /**
   * Client (screen) coordinates of the press, and of the latest move — the
   * reference a bubble hold measures travel against, and the anchor its drag
   * is relative to. Screen space on purpose: see BUBBLE_HOLD_SLOP.
   */
  private pressClient: number[] = [0, 0];
  private lastClient: number[] = [0, 0];
  /** Screen-space EMA on this contact's samples; only pen/highlighter ink reads its output. */
  private inkSmoother = new InkSmoother();
  /**
   * Where the grab actually began, in client coordinates — set when the hold
   * fires, not when the press landed. The drag is measured from here so the
   * jitter the hold deliberately tolerated doesn't jump the bubble on the
   * first move, and so a camera pan during the hold doesn't offset it either.
   */
  private grabClient: number[] | null = null;
  /**
   * Every board point this press has visited while it might still become a
   * grab. Two jobs: `trailMoved` reads it to tell real movement from a resting
   * hand's wobble, and if the hold is cancelled it seeds the stroke that takes
   * over — so a mark that began as a possible grab keeps the ink it already
   * laid down instead of restarting from a straight line to wherever the pen
   * had got to.
   */
  private pressTrail: number[][] = [];
  /** Cumulative screen-px travel of this press, real movement only — see BUBBLE_HOLD_PATH. */
  private pressPath = 0;
  /**
   * Mind map: the bubble whose connection nodes are currently revealed. Like
   * `lineEdit` this outlives the press that created it — the nodes stay up so
   * a connector can be dragged out of one, and the next press elsewhere puts
   * them away. Unlike `lineEdit` it is *view* state, not uncommitted content:
   * nothing is lost by dropping it, so Undo is deliberately left alone (it
   * would otherwise be spent hiding handles instead of undoing the move the
   * user just made).
   */
  private nodeEdit: { bubbleId: string } | null = null;
  /** mind map: the connector being dragged out of a revealed node, before it has a target */
  private connect: { fromId: string; fromNode: BubbleNode; to: number[]; targetId: string | null } | null = null;

  /** view-only: which tape strips are peeled back. Never stored, same as a page. */
  private readonly peeled = new Set<string>();
  private tapeResizeOrig: TapeElement | null = null;

  /** selection + transform state, mirroring PageCanvas's own */
  private selected = new Set<string>();
  private xfOrig: PageItem[] | null = null;
  private xfFrame: Frame | null = null;
  private xfCur: Frame | null = null;
  private xfLive: PageItem[] | null = null;
  private xfLassoOrig: number[][] | null = null;
  /**
   * Items that ride along with a *pure move* of the selection without being
   * part of it: a selected bubble's transitive members and the connectors
   * hanging off them.
   *
   * Kept apart from `xfOrig` rather than folded into it, because they must only
   * follow a translation. A resize is the selection's own business — scaling a
   * bubble's box deliberately leaves its contents alone, which is what makes
   * re-resolving membership after a resize meaningful (see `reresolveResized`)
   * — so on any gesture that changes size or rotation these stay exactly where
   * they are, and are left out of the op entirely.
   */
  private xfExtra: PageItem[] | null = null;
  private editor: BoardTextEditor | null = null;

  constructor(nb: Notebook, camera: Camera, hooks: BoardHooks) {
    this.nb = nb;
    this.camera = camera;
    this.hooks = hooks;
    this.mindMapOn = mindMapEnabled(nb.id);
  }

  get busy(): boolean {
    return this.mode != null || this.xfOrig != null || this.editor != null || this.pendingBubble != null;
  }

  /** Whether a line is in its adjustable phase — see the onPendingLine hook. */
  get hasPendingLine(): boolean {
    return this.lineEdit !== null;
  }

  /** Whether mind-map mode is on for this board. */
  get mindMap(): boolean {
    return this.mindMapOn;
  }

  /**
   * Turns mind-map mode on or off and remembers it for this board. Any
   * snapped-but-uncommitted bubble is settled first — leaving one pending
   * across the switch would strand a shape the mode can no longer finish.
   */
  setMindMap(on: boolean): void {
    if (on === this.mindMapOn) return;
    this.commitPendingBubble();
    this.mindMapOn = on;
    setMindMapEnabled(this.nb.id, on);
    this.disarmHold();
    this.pendingLoop = null;
    this.bubbleCue = false;
    this.schedule();
  }

  /** Whether a bubble has snapped but is not committed — Undo can drop it, so the button's state tracks this (see the onPendingLine hook, which both share). */
  get hasPendingBubble(): boolean {
    return this.pendingBubble !== null;
  }

  get mounted(): boolean {
    return this.view != null;
  }

  get hasSelection(): boolean {
    return this.selected.size > 0;
  }

  /** New items are filed under the origin chunk by default; `pasteItems` re-files each by its own bounds. */
  get page(): { id: string } {
    return { id: `${this.nb.id}:0,0` };
  }

  private zoom(): number {
    return this.camera.zoom > 0 ? this.camera.zoom : 1;
  }

  private paper(): Paper {
    return store.boardPaper(this.nb.id);
  }

  // --------------------------------------------------------------- lifecycle
  mount(host: HTMLElement): void {
    if (this.view) return;
    this.host = host;
    const view = document.createElement('canvas');
    view.className = 'board-canvas';
    this.view = view;
    this.vctx = view.getContext('2d');
    this.settled = document.createElement('canvas');
    this.sctx = this.settled.getContext('2d');
    host.appendChild(view);

    // above the canvas, below the dock; only the textarea inside it takes events
    const layer = document.createElement('div');
    layer.className = 'board-editor-layer';
    const cam = document.createElement('div');
    cam.className = 'board-editor-camera';
    layer.appendChild(cam);
    host.appendChild(layer);
    this.editorLayer = layer;
    this.editorCam = cam;

    view.addEventListener('pointerdown', this.onDown);
    view.addEventListener('pointermove', this.onMove);
    view.addEventListener('pointerup', this.onUp);
    view.addEventListener('pointercancel', this.onUp);
    this.resize();
  }

  unmount(): void {
    const v = this.view;
    if (v) {
      v.removeEventListener('pointerdown', this.onDown);
      v.removeEventListener('pointermove', this.onMove);
      v.removeEventListener('pointerup', this.onUp);
      v.removeEventListener('pointercancel', this.onUp);
      v.remove();
    }
    this.commitLine();
    this.commitEdit();
    this.disarmHold();
    this.editorLayer?.remove();
    this.editorLayer = this.editorCam = null;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.view = this.settled = null;
    this.vctx = this.sctx = null;
    this.settledRect = null;
    this.host = null;
  }

  /** Re-measures the viewport and re-renders; call on resize and whenever the surrounding chrome changes the stage's box. */
  resize(): void {
    const host = this.host;
    const view = this.view;
    if (!host || !view || !this.settled) return;
    const r = host.getBoundingClientRect();
    this.cssW = r.width;
    this.cssH = r.height;
    view.width = Math.max(1, Math.round(this.cssW * DPR));
    view.height = Math.max(1, Math.round(this.cssH * DPR));
    view.style.width = `${this.cssW}px`;
    view.style.height = `${this.cssH}px`;
    this.settledRect = null; // the margin box changed shape
    this.schedule();
  }

  /** The paper template changed — the settled copy has it baked in. */
  paperChanged(): void {
    this.invalidate();
  }

  /** Drop the settled copy and repaint from the store (undo/redo, an external edit). */
  invalidate(): void {
    this.settledRect = null;
    this.schedule();
  }

  schedule(): void {
    if (!this.raf && this.view) this.raf = requestAnimationFrame(this.frame);
  }

  // ----------------------------------------------------------------- geometry
  /** The world rect currently on screen. */
  private visibleRect(): Rect {
    const z = this.camera.zoom || 1;
    return { x: this.camera.x, y: this.camera.y, w: this.cssW / z, h: this.cssH / z };
  }

  /** Screen (client) point -> board coordinates. */
  private toBoard(e: ClientSample): number[] {
    const r = this.view!.getBoundingClientRect();
    const z = this.camera.zoom || 1;
    let p = e.pressure;
    if (!p || p <= 0) p = 0.5; // some styluses report 0 on contact
    return [(e.clientX - r.left) / z + this.camera.x, (e.clientY - r.top) / z + this.camera.y, p];
  }

  // ------------------------------------------------------------------ painting
  /** Re-renders the settled copy for a margin box around `v`. */
  private renderSettled(v: Rect): void {
    const c = this.settled;
    const ctx = this.sctx;
    if (!c || !ctx) return;
    const z = this.camera.zoom || 1;
    const rect: Rect = {
      x: v.x - v.w * MARGIN,
      y: v.y - v.h * MARGIN,
      w: v.w * (1 + MARGIN * 2),
      h: v.h * (1 + MARGIN * 2),
    };
    const s = z * DPR;
    const w = Math.max(1, Math.round(rect.w * s));
    const h = Math.max(1, Math.round(rect.h * s));
    if (c.width !== w) c.width = w;
    if (c.height !== h) c.height = h;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    // board units -> device px, so everything below draws in plain board units
    ctx.setTransform(s, 0, 0, s, -rect.x * s, -rect.y * s);

    const paper = this.paper();
    // drawTemplate lays its ruling out from wherever the transform puts (0, 0),
    // so the translation must land on a whole multiple of the paper's own gap
    // or the lattice shifts phase as the margin box moves with pan and zoom.
    const PHASE = SPACING_PX[paper.spacing];
    const gx = Math.floor(rect.x / PHASE) * PHASE;
    const gy = Math.floor(rect.y / PHASE) * PHASE;
    ctx.save();
    ctx.translate(gx, gy);
    drawTemplate(ctx, paper, rect.x + rect.w - gx + PHASE, rect.y + rect.h - gy + PHASE);
    ctx.restore();

    const pending = this.pendingIds();
    const hidden = this.hiddenIds();
    for (const it of store.boardItemsIn(this.nb.id, rect)) {
      if (hidden?.has(it.id)) continue; // mid-drag / mid-edit: the view paints it
      if (this.partial.has(it.id)) continue; // the view paints what survives
      // a connector left behind by a bubble that went away some other route
      // than the cascades below paints nothing rather than a line into space
      if (!isStroke(it) && it.kind === 'connector' && !this.connectorResolves(it)) continue;
      this.paintItem(ctx, it, pending.has(it.id) ? PENDING_OPACITY : 1);
    }

    this.settledRect = rect;
    this.settledZoom = z;
  }

  private paintItem(ctx: CanvasRenderingContext2D, it: PageItem, opacity = 1): void {
    const paper = this.paper();
    if (isStroke(it)) drawStroke(ctx, it, paper, opacity);
    else drawElement(ctx, it, paper, opacity, () => this.invalidate(), this.peeled);
  }

  /** Items the settled copy must leave out because the view is painting a live version of them. */
  private hiddenIds(): Set<string> | null {
    if (!this.xfOrig && !this.editor && !this.partial.size) return null;
    const ids = new Set<string>();
    if (this.xfOrig) for (const it of this.xfOrig) ids.add(it.id);
    if (this.xfExtra) for (const it of this.xfExtra) ids.add(it.id);
    if (this.editor) ids.add(this.editor.el.id);
    for (const id of this.partial.keys()) ids.add(id);
    return ids;
  }

  /** ids the eraser is currently hovering (drawn dimmed, not yet removed). */
  private pendingIds(): Set<string> {
    return this.mode === 'erase' ? this.erased : new Set();
  }

  private frame = (): void => {
    this.raf = 0;
    // the textarea is DOM, not canvas, so it needs the camera written to it
    // separately — every frame, which is exactly when the canvas gets it too
    this.syncEditorCamera();
    const view = this.view;
    const v = this.vctx;
    const settled = this.settled;
    if (!view || !v || !settled) return;

    const vis = this.visibleRect();
    const z = this.camera.zoom || 1;
    const r = this.settledRect;
    const stale =
      !r ||
      this.settledZoom !== z ||
      vis.x < r.x ||
      vis.y < r.y ||
      vis.x + vis.w > r.x + r.w ||
      vis.y + vis.h > r.y + r.h;
    if (stale) this.renderSettled(vis);

    const rect = this.settledRect;
    v.setTransform(1, 0, 0, 1, 0, 0);
    v.clearRect(0, 0, view.width, view.height);
    if (rect) {
      // 1:1 blit — the settled copy is already at this exact device scale, so
      // a pan inside the margin costs one drawImage and no item work at all
      const s = z * DPR;
      v.drawImage(settled, Math.round((vis.x - rect.x) * s), Math.round((vis.y - rect.y) * s), view.width, view.height, 0, 0, view.width, view.height);
    }

    // in flight, painted on top in board units
    const s = z * DPR;
    v.setTransform(s, 0, 0, s, -vis.x * s, -vis.y * s);
    const paper = this.paper();
    // the ink in flight — unless it has already snapped to a line or a bubble, drawn below in its place
    if (this.mode === 'draw' && this.live.length && !this.lineEdit && !this.pendingBubble) {
      drawStroke(v, { tool: this.liveTool.kind, color: this.liveTool.color, size: this.liveTool.size, points: this.live }, paper);
      if (this.pendingFit) {
        // ghost cue partway through the hold: over the still-visible ink, not yet snapped
        drawElement(v, this.shapeFromFit(this.pendingFit, this.liveTool.color, this.liveTool.size), paper, SHAPE_CUE_OPACITY);
      }
      if (this.pendingLoop) {
        drawElement(v, this.bubbleFromLoop(this.pendingLoop), paper, SHAPE_CUE_OPACITY); // same cue, for a loop
      }
    }
    if (this.pendingBubble) drawElement(v, this.pendingBubble, paper);
    // revealed connection nodes, and the connector being dragged out of one —
    // both view-only, so neither costs the settled copy a thing
    if (this.nodeEdit) {
      const nb = this.xfLive?.find((it) => it.id === this.nodeEdit?.bubbleId);
      const b = nb && !isStroke(nb) && nb.kind === 'bubble' ? nb : this.nodeBubble();
      if (b) this.paintNodes(v, b);
    }
    if (this.connect) this.paintConnectDrag(v, this.connect);
    if (this.bubbleCue) {
      // the first stage of a hold *on* a bubble: ghost its outline over itself
      // so it reads as "keep holding and this is what you'll move"
      const b = this.heldBubble();
      if (b) drawElement(v, { ...b, size: b.size * 2 }, paper, SHAPE_CUE_OPACITY);
    }
    if (this.lineEdit) {
      drawElement(v, this.lineElement(this.lineEdit), paper);
      paintLineHandles(v, this.lineEdit, this.zoom());
    }
    for (const [id, gone] of this.partial) {
      const st = this.strokeById(id);
      if (!st) continue;
      drawStroke(v, st, paper, PENDING_OPACITY); // what is being rubbed out, dimmed
      for (const seg of survivingSegments(st.points, gone)) drawStroke(v, { ...st, points: seg }, paper);
    }
    // the items being dragged / resized / rotated, plus the outline riding along
    if (this.xfLive) {
      const editing = this.editor?.el.id;
      for (const it of this.xfLive) if (it.id !== editing) this.paintItem(v, it); // the textarea shows that one
    }
    if (this.mode === 'tape' && this.live.length > 1) {
      drawElement(v, this.tapeFromDrag(), paper, 0.7); // preview of the strip being laid
    }
    if (this.mode === 'shapes' && this.live.length > 1) {
      const sh = this.shapeFromDrag();
      if (sh) drawElement(v, sh, paper, 0.7); // preview of the shape being sized
    }
    if (this.laser.length) {
      this.laser = paintLaserTrail(v, this.laser);
      if (this.laser.length) this.schedule(); // keep fading
    }
    if (this.mode === 'lasso' && this.lasso.length > 1) {
      strokeLassoPath(v, this.lasso, toolState.lassoShape !== 'free', this.zoom());
    } else if (this.lastLassoPath && this.lastLassoPath.length > 1) {
      // decorative echo of the finalized selection's shape — unlike a page,
      // this stays on the one canvas even mid-drag, because that canvas is the
      // whole viewport and nothing can be clipped by leaving a page's bitmap
      strokeLassoPath(v, this.lastLassoPath, true, this.zoom());
    }
  };

  private strokeById(id: string): Stroke | undefined {
    const it = store.boardItem(this.nb.id, id);
    return it && isStroke(it) ? it : undefined;
  }

  // ------------------------------------------------------------------ pointer
  /**
   * Pen and mouse drive every tool; touch is left alone so it reaches the
   * notebook's own pan/pinch gestures on `.nb-scroll`. That also makes palm
   * rejection free: a palm is a touch, and a touch never marks a board. A
   * finger can still move a selection, because the SelectionOverlay's handles
   * are real DOM elements with their own palm rules — it just cannot start one
   * from the canvas.
   */
  private onDown = (e: PointerEvent): void => {
    if (e.pointerType === 'touch' || this.mode) return;
    const kind = toolState.kind;
    if (kind === 'hand') return; // the notebook's own hand-drag pan handles this
    e.preventDefault();
    this.capture(e);
    this.inkSmoother.reset(e);
    const pt = this.toBoard(e);
    this.pressPt = pt;
    this.pressClient = [e.clientX, e.clientY];
    this.lastClient = [e.clientX, e.clientY];
    this.grabClient = null;
    this.pressTrail = [pt];
    this.pressPath = 0;

    // a snapped line waiting to be adjusted: a press on one of its endpoint
    // handles drags that end; a press anywhere else commits it, and is a
    // dismissing press from here on
    if (this.lineEdit) {
      const end = lineEndAt(this.lineEdit, pt, this.zoom());
      if (end) {
        this.mode = 'line-adjust';
        this.adjustEnd = end;
        this.schedule();
        return;
      }
      this.commitLine();
      this.dismissingPress = true;
    }

    // A snapped bubble waiting to be settled has no handles to grab, so any
    // press at all commits it — and is spent doing so, exactly like the press
    // that settles a pending line.
    if (this.commitPendingBubble()) this.dismissingPress = true;

    // Revealed connection nodes behave exactly like a pending line's handles: a
    // press on one drags a connector out of it, a press anywhere else puts them
    // away and is spent doing so.
    if (this.nodeEdit) {
      const node = this.nodeAt(pt);
      if (node) {
        this.mode = 'connect';
        this.connect = { fromId: this.nodeEdit.bubbleId, fromNode: node, to: [pt[0], pt[1]], targetId: null };
        this.schedule();
        return;
      }
      this.dropNodes();
      this.dismissingPress = true;
    }

    // Everything below produces output, so a dismissing press stops here. It
    // still holds the pointer, so the contact cannot fall through to a pan for
    // the rest of its life; onUp resets the mode and repaints.
    //
    // Four exceptions, none of which are output. Taking hold of a bubble
    // *produces* nothing, so a dismissing press has nothing to suppress there
    // — without this the press right after a loop snaps — far and away the
    // likeliest moment to want to move the new bubble — could never grab it,
    // and neither could the press that happened to clear a selection or put a
    // set of nodes away. The lasso tool's own tap-to-select is the same kind
    // of non-output: selecting a different element dismisses the old
    // selection by replacing it rather than leaving a mark. The shapes tool
    // landing on an EXISTING shape picks it up to readjust, same reasoning.
    // The text tool landing on an EXISTING text box opens it for editing,
    // same again. A tap on empty space with the shapes or text tool is not
    // exempt — that's exactly where a dismissing tap would otherwise place a
    // new shape or open a new box, which is the output this gate exists to
    // prevent. Stopping all of these here left a tap on any unselected
    // element select nothing, or an existing shape/text box fail to pick
    // up/open, whenever something else already was selected — which is most
    // of the time in real use.
    if (this.dismissingPress) {
      const entersExisting =
        kind === 'lasso' ||
        (kind === 'shapes' && this.topShapeAt(pt[0], pt[1]) !== null) ||
        (kind === 'text' && this.topTextAt(pt[0], pt[1]) !== null);
      if (!entersExisting) {
        this.commitEdit(); // an open text editor is state this press dismisses too
        if (this.tryBubblePress(pt)) return;
        this.mode = 'dismiss';
        return;
      }
    }

    if (kind === 'laser') {
      this.mode = 'laser';
      this.laser.push([[pt[0], pt[1], performance.now()]]); // a fresh, disconnected stroke
      this.schedule();
      return;
    }

    // a press on a tape strip is a peel / cover tap unless it turns into a drag
    const tape = kind === 'lasso' ? null : this.topTapeAt(pt[0], pt[1]);
    if (tape) {
      this.commitEdit();
      this.mode = 'tape-tap';
      this.tapeHit = tape.id;
      return;
    }

    if (kind === 'tape') {
      this.commitEdit();
      this.mode = 'tape';
      this.live = [pt];
      this.schedule();
      return;
    }

    if (kind === 'shapes') {
      this.commitEdit();
      const hit = this.topShapeAt(pt[0], pt[1]);
      if (hit) {
        // over an existing shape: a tap selects it to readjust, a drag places a
        // new one on top — decided on move/up
        this.mode = 'shape-press';
        this.shapeHit = hit.id;
        return;
      }
      this.clearSelection();
      this.beginShapeDrag(pt);
      this.schedule();
      return;
    }

    if (kind === 'text') {
      if (this.editor) {
        this.commitEdit(); // tapping outside the box just finishes the edit
        return;
      }
      const hit = this.topTextAt(pt[0], pt[1]);
      if (hit) {
        this.setSelection([hit.id]);
        this.mode = 'text-press';
      } else {
        this.startEdit(this.newText(pt[0], pt[1]), true);
      }
      return;
    }

    if (kind === 'lasso') {
      this.commitEdit();
      this.clearSelection();
      this.mode = 'lasso';
      this.lasso = [pt];
      this.lassoPt = pt;
      this.schedule();
      return;
    }

    if (kind === 'eraser') {
      this.mode = 'erase';
      this.erased.clear();
      this.partial.clear();
      this.eraseAt(pt);
      this.schedule();
      return;
    }

    // Mind map: a press that lands on a bubble may be a hold-to-move rather
    // than a mark. Which it is gets decided on move/up, exactly as for
    // 'shape-press' and 'tape-tap' — moving before the hold fires falls
    // straight through to the real tool, so writing inside a bubble is
    // unaffected. Only the drawing tools go through here: the eraser has to
    // reach a bubble's outline to delete it, and lasso/text/tape/shapes/laser
    // all have their own meaning for a press and were handled above.
    if (this.tryBubblePress(pt)) return;

    const t = resolveDrawTool();
    if (!t) {
      this.mode = null;
      return;
    }
    this.commitEdit();
    this.mode = 'draw';
    this.liveTool = { kind: t.kind, color: this.aiInkColor(t.color), size: t.size };
    this.live = [pt];
    // line-snap is only ever on the pen, not the highlighter — and in mind-map
    // mode the pen's hold fits a loop instead, so the two never contend
    this.loopMode = this.mindMapOn && kind === 'pen';
    this.shapeMode = kind === 'pen' && !this.mindMapOn;
    this.pendingFit = null;
    this.pendingLoop = null;
    this.armSnapHold();
    this.schedule();
  };

  private capture(e: PointerEvent): void {
    this.pointerId = e.pointerId;
    try {
      this.view?.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  }

  private onMove = (e: PointerEvent): void => {
    if (e.pointerId !== this.pointerId || !this.mode) return;
    e.preventDefault();
    const evs = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    const list = evs.length ? evs : [e];
    const slop = TAP_SLOP / this.zoom();
    for (const ev of list) {
      const pt = this.toBoard(ev);
      const smoothed = this.inkSmoother.next(ev);
      const prevClient = this.lastClient;
      this.lastClient = [ev.clientX, ev.clientY];
      switch (this.mode) {
        case 'draw': {
          // already snapped to a bubble: the outline is fixed, so the rest of
          // this contact does nothing (a line, by contrast, drags its far end)
          if (this.pendingBubble) break;
          if (this.lineEdit) {
            this.lineEdit.b = [pt[0], pt[1]]; // already snapped: the pen drags the far end
            break;
          }
          const ink = this.toBoard(smoothed);
          this.live.push(ink);
          if ((this.shapeMode || this.loopMode) && holdDrifted(this.holdAnchor, ink, this.zoom())) {
            if (this.pendingFit) {
              // keep tracking the pen so the ghost's length and direction adjust
              // live as the stroke is refined, rather than freezing or vanishing
              this.pendingFit = recognizeLine(this.live, this.liveTool.size, this.zoom());
            }
            if (this.pendingLoop) this.pendingLoop = recognizeLoop(this.live, this.liveTool.size, this.zoom());
            this.armSnapHold();
          }
          break;
        }
        case 'bubble-press': {
          // Is this still a plausible hold, or is the pen writing? Two checks,
          // both in screen px so that neither a camera pan nor the zoom level
          // changes the feel:
          //   - how far it has *travelled* in total, counting only movement
          //     `trailMoved` calls real (BUBBLE_HOLD_PATH) — this is what
          //     catches slow writing, which can keep its displacement small
          //     for the whole hold window;
          //   - how far it has got *from* the press (BUBBLE_HOLD_SLOP) — this
          //     catches a quick decisive drag before enough samples have
          //     arrived to accumulate much path.
          const real = trailMoved(this.pressTrail, pt);
          this.pressTrail.push(pt);
          if (real) this.pressPath += Math.hypot(ev.clientX - prevClient[0], ev.clientY - prevClient[1]);
          const far = Math.hypot(ev.clientX - this.pressClient[0], ev.clientY - this.pressClient[1]) >= BUBBLE_HOLD_SLOP;
          if (this.pressPath < BUBBLE_HOLD_PATH && !far) break;
          // never a grab after all — hand the contact to the real tool, which
          // picks up the whole trail so nothing drawn so far is lost
          this.bubbleHit = null;
          this.bubbleCue = false;
          this.disarmHold();
          this.switchToToolDrag(pt);
          break;
        }
        case 'bubble-move': {
          if (!this.xfOrig || !this.xfFrame || !this.grabClient) break;
          // from where the grab began, in screen px over the live zoom: the
          // bubble tracks the pen itself, not the board point the press landed
          // on — which a pan under the hold would have moved out from under it
          const z = this.zoom();
          this.updateTransform({
            ...this.xfFrame,
            x: this.xfFrame.x + (ev.clientX - this.grabClient[0]) / z,
            y: this.xfFrame.y + (ev.clientY - this.grabClient[1]) / z,
          });
          break;
        }
        case 'connect': {
          if (!this.connect) break;
          this.connect.to = [pt[0], pt[1]];
          const target = this.bubbleContaining(pt, this.connect.fromId);
          this.connect.targetId = target ? target.id : null;
          break;
        }
        case 'line-adjust':
          if (this.lineEdit && this.adjustEnd) this.lineEdit[this.adjustEnd] = [pt[0], pt[1]];
          break;
        case 'laser':
          this.laser[this.laser.length - 1].push([pt[0], pt[1], performance.now()]);
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
        case 'shapes':
          this.live.push(pt);
          break;
        case 'shape-press':
          // moved: a new shape from the press point, not a tap on the old one
          if (Math.hypot(pt[0] - this.pressPt[0], pt[1] - this.pressPt[1]) < slop) break;
          this.shapeHit = null;
          this.clearSelection();
          this.beginShapeDrag(this.pressPt);
          this.live.push(pt);
          break;
        case 'tape-tap': {
          // moved off the strip: it wasn't a tap after all — carry on with the real tool
          if (Math.hypot(pt[0] - this.pressPt[0], pt[1] - this.pressPt[1]) < slop) break;
          this.tapeHit = null;
          this.switchToToolDrag(pt);
          break;
        }
        case 'text-press': {
          const dx = pt[0] - this.pressPt[0];
          const dy = pt[1] - this.pressPt[1];
          if (!this.xfOrig && Math.hypot(dx, dy) < slop) break;
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
    if (e.pointerId !== this.pointerId || !this.mode) return;
    const cancelled = e.type === 'pointercancel';
    const mode = this.mode;
    try {
      this.view?.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }

    switch (mode) {
      case 'line-adjust':
        this.reset();
        if (!cancelled) this.commitLine(); // a handle drag ends with the line committed
        break;
      case 'bubble-press':
        // a plain tap on a bubble: the hold never fired, so nothing happened
        this.reset();
        break;
      case 'bubble-move': {
        const frame = this.xfCur;
        this.reset();
        this.endTransform(cancelled ? null : frame);
        this.schedule(); // the nodes stay revealed over wherever it landed
        return;
      }
      case 'connect': {
        const drag = this.connect;
        this.connect = null;
        this.reset();
        // a drop on another bubble links them; a drop on empty space (or on the
        // bubble it came from) just cancels, leaving the nodes up to try again
        if (drag && !cancelled && drag.targetId) this.createConnector(drag.fromId, drag.fromNode, drag.targetId, drag.to);
        break;
      }
      case 'draw':
        this.disarmHold();
        if (this.pendingBubble) {
          if (!cancelled) {
            // the loop snapped: lifting leaves the bubble waiting to be settled,
            // and the ink it was drawn as is discarded in its favour
            this.live = [];
            this.reset();
            break;
          }
          this.dropPendingBubble(); // the pointer was lost mid-snap — keep the ink it started as
        }
        if (this.lineEdit) {
          if (!cancelled) {
            // the stroke snapped: lifting leaves the line adjustable, handles and all
            this.live = [];
            this.reset();
            break;
          }
          this.dropLineEdit(); // the pointer was lost mid-snap — keep the ink it started as
        }
        this.reset();
        if (!cancelled) this.commitStroke();
        else this.live = [];
        break;
      case 'laser':
        this.reset(); // the trail keeps fading on its own; nothing to store
        break;
      case 'erase':
        if (cancelled) {
          this.erased.clear();
          this.partial.clear();
          this.reset();
          this.invalidate();
        } else {
          this.reset();
          this.commitErase();
        }
        break;
      case 'lasso':
        this.finishLasso(cancelled);
        break;
      case 'tape-tap': {
        const id = this.tapeHit;
        this.reset();
        if (id && !cancelled) this.handleTapeTap(id);
        break;
      }
      case 'shape-press': {
        const id = this.shapeHit;
        this.reset();
        if (id && !cancelled) this.setSelection([id]); // a tap: select it for readjusting
        break;
      }
      case 'tape': {
        const tape = this.live.length > 1 ? this.tapeFromDrag() : null;
        this.live = [];
        this.reset();
        if (tape && !cancelled && tape.w >= TAPE_MIN && tape.h >= TAPE_MIN) this.addNewItems([tape]);
        break;
      }
      case 'shapes': {
        const shape = this.live.length > 1 ? this.shapeFromDrag() : null;
        this.live = [];
        this.reset();
        if (shape && !cancelled) {
          this.addNewItems([shape]);
          this.setSelection([shape.id]);
        }
        break;
      }
      case 'text-press': {
        const wasDragging = this.xfOrig != null;
        const frame = this.xfCur;
        const id = [...this.selected][0];
        this.reset();
        if (wasDragging) {
          this.endTransform(cancelled ? null : frame);
          return;
        }
        const el = id ? store.boardItem(this.nb.id, id) : undefined;
        if (el && !isStroke(el) && el.kind === 'text' && !cancelled) this.startEdit(el, false);
        break;
      }
      default:
        this.reset();
    }
    this.schedule();
  };

  private reset(): void {
    this.mode = null;
    this.pointerId = -1;
    this.lasso = [];
    this.tapeHit = null;
    this.shapeHit = null;
    this.pendingFit = null;
    this.pendingLoop = null;
    this.shapeMode = false;
    this.loopMode = false;
    this.bubbleHit = null;
    this.bubbleCue = false;
    this.grabClient = null;
    this.pressTrail = [];
    this.pressPath = 0;
    this.connect = null;
    // nodeEdit, like lineEdit, deliberately outlives the press that revealed it
    this.adjustEnd = null; // lineEdit itself outlives the press: it stays until something commits it
    this.dismissingPress = false;
    this.disarmHold();
  }

  /**
   * Hands the rest of this contact to whatever tool is actually selected,
   * starting from the original press point — what a press that turned out not
   * to be a tap on something (a tape strip, a mind-map bubble) falls back to.
   */
  private switchToToolDrag(pt: number[]): void {
    const kind = toolState.kind;
    if (kind === 'eraser') {
      this.mode = 'erase';
      this.erased.clear();
      this.partial.clear();
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
      this.laser.push([
        [this.pressPt[0], this.pressPt[1], performance.now()],
        [pt[0], pt[1], performance.now()],
      ]);
    } else {
      const t = resolveDrawTool();
      if (!t) {
        this.mode = null;
        return;
      }
      this.mode = 'draw';
      this.liveTool = { kind: t.kind, color: this.aiInkColor(t.color), size: t.size };
      // the points this press already visited, when it was recorded (a
      // cancelled bubble hold) — otherwise just the two ends, as before
      this.live = this.pressTrail.length > 1 ? [...this.pressTrail] : [this.pressPt, pt];
      this.loopMode = this.mindMapOn && kind === 'pen';
      this.shapeMode = kind === 'pen' && !this.mindMapOn;
      this.armSnapHold();
    }
  }

  // --------------------------------------------------------------- line snap
  /**
   * Starts (or restarts) the hold-still timers. Identical durations and
   * thresholds to a page — both go through LineSnapHold and recognizeLine, so
   * there is nothing here for the two to drift apart on.
   */
  private armHold(): void {
    this.hold.arm(
      () => {
        if (this.mode !== 'draw' || !this.shapeMode || this.lineEdit) return;
        const fit = recognizeLine(this.live, this.liveTool.size, this.zoom());
        if (fit) {
          this.pendingFit = fit;
          this.schedule();
        }
      },
      () => {
        if (this.mode !== 'draw' || !this.shapeMode || this.lineEdit) return;
        const fit = recognizeLine(this.live, this.liveTool.size, this.zoom());
        if (fit) {
          const [a, b] = lineEnds(fit);
          this.lineEdit = { a, b, color: this.liveTool.color, size: this.liveTool.size };
          this.adjustEnd = 'b';
          this.pendingFit = null;
          this.hooks.onPendingLine();
          this.schedule();
        }
      }
    );
  }

  private disarmHold(): void {
    this.hold.disarm();
  }

  /**
   * Arms whichever hold-to-snap this press is eligible for — the loop fit in
   * mind-map mode, the line fit otherwise. Both go through the same
   * `LineSnapHold` (so they share the cue/commit durations exactly) and the two
   * flags are mutually exclusive, so there is never a race between them.
   */
  private armSnapHold(): void {
    const tip = this.live[this.live.length - 1];
    this.holdAnchor = tip ? [tip[0], tip[1]] : null;
    if (this.loopMode) this.armLoopHold();
    else if (this.shapeMode) this.armHold();
  }

  /** The loop counterpart of `armHold`: same timings, `recognizeLoop` in place of `recognizeLine`. */
  private armLoopHold(): void {
    this.hold.arm(
      () => {
        if (this.mode !== 'draw' || !this.loopMode || this.pendingBubble) return;
        const fit = recognizeLoop(this.live, this.liveTool.size, this.zoom());
        if (fit) {
          this.pendingLoop = fit;
          this.schedule();
        }
      },
      () => {
        if (this.mode !== 'draw' || !this.loopMode || this.pendingBubble) return;
        const fit = recognizeLoop(this.live, this.liveTool.size, this.zoom());
        if (!fit) return;
        this.pendingBubble = this.bubbleFromLoop(fit);
        this.pendingLoop = null;
        this.hooks.onPendingLine(); // "a pending thing changed" — Undo can drop this too
        this.schedule();
      }
    );
  }

  /**
   * The two-stage hold on an existing bubble: the first stage only cues (the
   * outline thickens under the pen), the second hands the bubble and
   * everything it owns to the ordinary transform path as a live move.
   */
  private armBubbleHold(): void {
    this.hold.arm(
      () => {
        if (this.mode !== 'bubble-press') return;
        this.bubbleCue = true;
        this.schedule();
      },
      () => {
        if (this.mode !== 'bubble-press') return;
        const b = this.heldBubble();
        if (!b) {
          this.reset();
          return;
        }
        this.bubbleCue = false;
        this.mode = 'bubble-move';
        // anchored where the hold actually completed, not where the press
        // landed — the two differ by whatever jitter the slop tolerated
        this.grabClient = [...this.lastClient];
        // the nodes come up with the grab and stay up after the lift
        this.nodeEdit = { bubbleId: b.id };
        this.beginTransform(this.bubbleMoveSet(b));
        this.schedule();
      },
      BUBBLE_CUE_MS,
      BUBBLE_HOLD_MS
    );
  }

  /**
   * Starts a bubble hold if this press is on one, in mind-map mode, with a
   * drawing tool. Which it turns out to be is decided on move/up, exactly as
   * for 'shape-press' and 'tape-tap': travel beyond the slop before the hold
   * completes falls straight through to the real tool, so writing on or inside
   * a bubble is unaffected.
   *
   * Only the drawing tools come here — the eraser has to reach a bubble's
   * outline to delete it, and lasso/text/tape/shapes/laser each have their own
   * meaning for a press.
   */
  private tryBubblePress(pt: number[]): boolean {
    if (!this.mindMapOn) return false;
    const kind = toolState.kind;
    if (kind !== 'pen' && kind !== 'highlighter') return false;
    const grab = this.bubbleGrabAt(pt);
    if (!grab) return false;
    this.commitEdit();
    this.mode = 'bubble-press';
    this.bubbleHit = grab.id;
    this.bubbleCue = false;
    this.armBubbleHold();
    return true;
  }

  /** The bubble the current press is on, re-read from the store (it may have gone). */
  private heldBubble(): BubbleElement | null {
    const id = this.bubbleHit;
    if (!id) return null;
    const it = store.boardItem(this.nb.id, id);
    return it && !isStroke(it) && it.kind === 'bubble' ? it : null;
  }

  /** The bubble a fitted loop becomes — not in the store, and with no members resolved yet (see commitPendingBubble). */
  private bubbleFromLoop(fit: LoopFit): BubbleElement {
    return {
      id: uid(),
      kind: 'bubble',
      pageId: this.chunkFor(fit),
      notebookId: this.nb.id,
      outline: fit.outline,
      x: fit.x,
      y: fit.y,
      w: fit.w,
      h: fit.h,
      rotation: 0, // always: see BubbleElement
      color: this.liveTool.color,
      size: this.liveTool.size,
      members: [],
      createdAt: Date.now(),
    };
  }

  /** Throws a snapped bubble away instead of committing it — Undo's counterpart to commitPendingBubble, and the whole undo, since it was never in the store. */
  cancelPendingBubble(): boolean {
    if (!this.pendingBubble) return false;
    this.dropPendingBubble();
    this.invalidate();
    return true;
  }

  /** The single way out of the pending phase, so the notebook hears about every one of them. */
  private dropPendingBubble(): void {
    this.pendingBubble = null;
    this.hooks.onPendingLine();
  }

  /**
   * Settles a snapped bubble into the board as one undo step, membership and
   * all; returns whether there was one.
   *
   * Membership is resolved *here*, against the live store, rather than when the
   * loop snapped — the pen may have travelled, and in any case what the board
   * holds is only knowable now. Ownership is exclusive and innermost-wins (see
   * `resolveOwnership`), so committing can also have to rewrite the bubbles
   * this one has taken items from, and that has to land in the same undo step:
   * hence the 'edit' op, whose `removed`/`added` express "these items went
   * away and these took their place" and whose inverse restores both sides at
   * once. With nothing to take, it is a plain 'add-items'.
   */
  commitPendingBubble(): boolean {
    const bubble = this.pendingBubble;
    if (!bubble) return false;
    this.dropPendingBubble();

    const { members, before, after } = this.resolveOwnership(bubble);
    // under its own members in z-order, so the outline never paints over the
    // handwriting it was drawn around (the store orders by createdAt)
    let createdAt = bubble.createdAt;
    for (const m of members) if (m.createdAt <= createdAt) createdAt = m.createdAt - 1;
    const committed: BubbleElement = { ...bubble, createdAt, members: members.map((m) => m.id) };

    store.addItems([committed]);
    if (after.length) {
      store.replaceItems(after[0].pageId, after);
      this.hooks.onOp({ kind: 'edit', pageId: committed.pageId, removed: before, added: [committed, ...after] });
    } else {
      this.hooks.onOp({ kind: 'add-items', pageId: committed.pageId, items: [committed] });
    }
    this.invalidate();
    return true;
  }

  /** The pending line as an element (fresh id each call — only commitLine keeps one). */
  private lineElement(le: LineEdit): ShapeElement {
    return this.shapeFromFit(lineFit('line', le.a, le.b, le.size), le.color, le.size);
  }

  /** The single way out of the adjustable phase, so the notebook hears about every one of them. */
  private dropLineEdit(): void {
    this.lineEdit = null;
    this.adjustEnd = null;
    this.hooks.onPendingLine();
  }

  /** Throws the pending line away instead of committing it — Undo's counterpart to commitLine. It was never added to the store, so dropping it here is the whole undo. */
  cancelLine(): boolean {
    if (!this.lineEdit) return false;
    this.dropLineEdit();
    this.invalidate();
    return true;
  }

  /** Adds the pending line to the board as one undo step; returns whether there was one. */
  commitLine(): boolean {
    const le = this.lineEdit;
    if (!le) return false;
    this.dropLineEdit();
    const shape = this.lineElement(le);
    store.addItems([shape]);
    this.invalidate();
    // le.color was set from aiInkColor() when the stroke that became this line
    // started — the same violet-means-ephemeral-turn-ink signal add-stroke ops
    // carry, so AiMode can discard a snapped line the way it discards freehand
    this.hooks.onOp({ kind: 'add-items', pageId: shape.pageId, items: [shape], aiInk: le.color === AI_COLOR });
    return true;
  }

  /** Tells the board that the press about to land already dismissed something elsewhere, so it must not also draw. Mirrors PageCanvas's own flag. */
  markDismissingPress(): void {
    this.dismissingPress = true;
  }

  /** Drops the flag if still set — a flagged press that never reached the canvas has no onUp of its own to clear it, and a leftover would swallow the next press. */
  clearDismissingPress(): void {
    this.dismissingPress = false;
  }

  /** While AI mode is on a fresh mark inks in the AI accent colour, matching the page path. */
  private aiInkColor(base: string): string {
    return this.hooks.isAiActive() ? AI_COLOR : base;
  }

  /** Adds freshly created items as one undo step, filed under the chunk their own bounds fall in. */
  private addNewItems(items: PageItem[]): void {
    if (!items.length) return;
    const pageId = items[0].pageId;
    store.addItems(items);
    this.invalidate();
    this.hooks.onOp({ kind: 'add-items', pageId, items, aiInk: this.hooks.isAiActive() });
  }

  /** Resolves a finished lasso gesture: a tap selects (or clears), a real drag selects everything the polygon encloses. */
  private finishLasso(cancelled: boolean): void {
    const path = this.lasso;
    const pt = this.lassoPt;
    this.reset();
    if (cancelled) return;
    const travelled = Math.hypot(pt[0] - this.pressPt[0], pt[1] - this.pressPt[1]);
    if (path.length < 3 || travelled < TAP_SLOP / this.zoom()) {
      if (this.lastLassoPath && pointInPolygon(pt[0], pt[1], this.lastLassoPath)) {
        if (this.isDoubleTap(pt[0], pt[1])) {
          const frame = itemsFrame(this.selectedItems());
          if (frame) this.hooks.onSelectionFrame(this, frame);
        }
      } else {
        const hit = topItemAt(this.itemsNear(pt[0], pt[1], TAP_RADIUS), pt[0], pt[1]);
        this.setSelection(hit ? [hit.id] : []);
      }
      return;
    }
    const box = aabb(path);
    const ids: string[] = [];
    for (const it of store.boardItemsIn(this.nb.id, box)) {
      const inside = isStroke(it) ? strokeInPolygon(it.points, path) : elementInPolygon(it, path);
      if (inside) ids.push(it.id);
    }
    this.setSelection(ids, ids.length ? path : null);
    if (!ids.length) this.hooks.onEmptyLassoSelection(this, { ...box, rot: 0 });
  }

  /**
   * True on the second of two taps landing close together in time and space —
   * gates the Duplicate/Cut/Copy/Delete callout so it only ever appears on a
   * deliberate double-tap, never from the initial select or from a drag.
   */
  private isDoubleTap(x: number, y: number): boolean {
    const now = performance.now();
    const isDouble =
      now - this.lastTapAt <= DOUBLE_TAP_MS &&
      Math.hypot(x - this.lastTapPt[0], y - this.lastTapPt[1]) <= DOUBLE_TAP_SLOP;
    this.lastTapAt = isDouble ? 0 : now;
    this.lastTapPt = [x, y];
    return isDouble;
  }

  // --------------------------------------------------------------------- ink
  private commitStroke(): void {
    const raw = this.live;
    this.live = [];
    if (!raw.length) return;
    if (raw.length === 1) {
      const [x, y, p] = raw[0];
      raw.push([x + 0.1, y + 0.1, p]); // a tap becomes a dot
    }
    // filled in to a zoom-independent density before anything measures or
    // stores it — a board is drawn on at zooms from 0.5 to 3 and read back at
    // any of them, so this is where it matters most. See densifyStrokePoints.
    const pts = densifyStrokePoints(raw, this.liveTool.size);
    const b = boundsOfPoints(pts);
    const stroke: Stroke = {
      id: uid(),
      // the chunk is chosen once here, from the bounding box origin, and never
      // affects how the stroke draws or hit-tests
      pageId: store.boardChunkAt(this.nb.id, b.x, b.y),
      notebookId: this.nb.id,
      tool: this.liveTool.kind,
      color: this.liveTool.color,
      size: this.liveTool.size,
      points: pts,
      createdAt: Date.now(),
    };
    // Mind map: ink written strictly inside a bubble joins it, so the bubble
    // keeps owning everything it visibly contains. The stroke and the changed
    // membership have to be one undo step, which is what the 'edit' op already
    // expresses — its inverse removes what was added and restores what was
    // removed, and the bubble appears on both sides under the same id.
    const join = this.mindMapOn ? this.innermostBubbleContaining(stroke) : null;
    store.addStroke(stroke);
    // paint it straight into the settled copy rather than invalidating: a
    // finished stroke should never cost a full repaint
    const ctx = this.sctx;
    const rect = this.settledRect;
    if (ctx && rect) {
      const s = this.settledZoom * DPR;
      ctx.setTransform(s, 0, 0, s, -rect.x * s, -rect.y * s);
      drawStroke(ctx, stroke, this.paper());
    }
    if (join) {
      // the membership change is invisible, so the fast repaint above still stands
      const after: BubbleElement = {
        ...join,
        members: [...join.members.filter((id) => store.boardItem(this.nb.id, id) != null), stroke.id],
      };
      store.replaceItems(after.pageId, [after]);
      this.hooks.onOp({ kind: 'edit', pageId: stroke.pageId, removed: [join], added: [stroke, after] });
      return;
    }
    this.hooks.onOp({ kind: 'add-stroke', pageId: stroke.pageId, stroke });
  }

  // ------------------------------------------------------------------- eraser
  private eraseAt(pt: number[]): void {
    const z = this.camera.zoom || 1;
    const r = ERASER_RADIUS / z; // a constant size on screen, like the page eraser
    const hit: Rect = { x: pt[0] - r, y: pt[1] - r, w: r * 2, h: r * 2 };
    const whole = toolState.eraserMode !== 'partial';
    for (const it of store.boardItemsIn(this.nb.id, hit)) {
      if (!isStroke(it)) {
        // An element is taken whole — it has no parts to rub out, in either
        // eraser mode — and always by its *outline* rather than its interior,
        // so rubbing ink out inside a box leaves the box standing. That is the
        // rule a page's own eraser states for shapes (eraseShapesAt); text and
        // tape have no drawn outline of their own, so their box perimeter
        // stands in for one (nearElementOutline).
        if (this.erased.has(it.id)) continue;
        switch (it.kind) {
          case 'bubble':
            // mind-map kinds only answer to the eraser while the mode is on
            if (!this.mindMapOn) break;
            if (nearPolyline(pt[0], pt[1], bubblePolygon(it), it.size / 2 + r)) {
              this.erased.add(it.id);
              // a bubble's connectors go with it, in the same batch — so they
              // dim together under the eraser and come back together on undo
              for (const c of this.attachedConnectors([it])) this.erased.add(c.id);
            }
            break;
          case 'connector':
            if (!this.mindMapOn) break;
            if (nearConnector(it, pt[0], pt[1], it.size / 2 + r)) this.erased.add(it.id);
            break;
          case 'shape':
            if (nearShapeOutline(it, pt[0], pt[1], it.size / 2 + r)) this.erased.add(it.id);
            break;
          case 'text':
          case 'tape':
            if (nearElementOutline(it, pt[0], pt[1], r)) this.erased.add(it.id);
            break;
          case 'image':
            break; // an inserted photo is not erasable, on a page or a board
        }
        continue;
      }
      if (whole) {
        if (nearPolyline(pt[0], pt[1], it.points, r + it.size / 2)) this.erased.add(it.id);
        continue;
      }
      let gone = this.partial.get(it.id);
      for (let i = 0; i < it.points.length; i++) {
        const p = it.points[i];
        if (Math.hypot(p[0] - pt[0], p[1] - pt[1]) > r + it.size / 2) continue;
        if (!gone) {
          gone = new Set();
          this.partial.set(it.id, gone);
        }
        gone.add(i);
      }
    }
    if (this.erased.size) this.invalidate(); // dimming is baked into the settled copy
  }

  private commitErase(): void {
    if (this.erased.size) {
      const ids = new Set(this.erased);
      this.erased.clear();
      const removed = collectByPage(this.nb.id, ids);
      // Did this gesture take anything that isn't a stroke — a mind-map bubble,
      // or a connector (its own, or one cascaded off a bubble)? If so the whole
      // batch leaves as *one* generic 'remove-items' op, rather than the
      // stroke-only 'erase' op per chunk below.
      //
      // Per chunk is the subtlety: a bubble and the connectors hanging off it
      // routinely land in different chunks, so grouping by chunk would emit one
      // op each and a single undo would bring back only some of them. One op
      // for the lot is what makes the cascade undo as the one thing it was.
      // `store.removeItems` resolves every id to its own chunk on a board, and
      // the inverse (`addItems`) routes per item, so neither side needs the
      // grouping.
      if ([...removed.values()].some((items) => items.some((it) => !isStroke(it)))) {
        const gone = store.removeItems(this.page.id, ids);
        if (gone.length) this.hooks.onOp({ kind: 'remove-items', pageId: gone[0].pageId, items: gone });
      } else {
        for (const [pageId, items] of removed) {
          const gone = store.removeItems(pageId, new Set(items.map((i) => i.id)));
          const strokes = gone.filter(isStroke);
          if (strokes.length) this.hooks.onOp({ kind: 'erase', pageId, strokes });
        }
      }
      this.invalidate();
      return;
    }
    if (!this.partial.size) return;

    // A partial erase removes the originals and puts back whatever survives as
    // fresh strokes — the same shape as the page eraser's own 'edit' op, so
    // undo/redo needs nothing board-specific.
    const byPage = new Map<string, { removed: PageItem[]; added: PageItem[] }>();
    for (const [id, gone] of this.partial) {
      const st = this.strokeById(id);
      if (!st) continue;
      const bucket = byPage.get(st.pageId) ?? { removed: [], added: [] };
      bucket.removed.push(st);
      for (const seg of survivingSegments(st.points, gone)) {
        if (seg.length < 2) continue;
        const b = boundsOfPoints(seg);
        bucket.added.push({
          ...st,
          id: uid(),
          pageId: store.boardChunkAt(this.nb.id, b.x, b.y),
          points: seg,
        });
      }
      byPage.set(st.pageId, bucket);
    }
    this.partial.clear();
    for (const [pageId, { removed, added }] of byPage) {
      store.removeItems(pageId, new Set(removed.map((r) => r.id)));
      store.addItems(added);
      this.hooks.onOp({ kind: 'edit', pageId, removed, added });
    }
    this.invalidate();
  }

  // ------------------------------------------------------------ hit testing
  /**
   * Items whose bounds fall within `pad` of a point. Everything on a board is
   * found through the spatial index rather than by scanning a page's list, so
   * a hit test costs what is *near* the finger, not what is on the board.
   * `itemBounds` already includes a stroke's nib width, so padding by
   * TAP_RADIUS covers exactly the tolerance `topItemAt` then applies.
   */
  private itemsNear(x: number, y: number, pad: number): PageItem[] {
    return store.boardItemsIn(this.nb.id, { x: x - pad, y: y - pad, w: pad * 2, h: pad * 2 });
  }

  private elementsNear(x: number, y: number): PageElement[] {
    return this.itemsNear(x, y, TAP_RADIUS).filter((it): it is PageElement => !isStroke(it));
  }

  private topTextAt(x: number, y: number): TextElement | null {
    return topElementAt(this.elementsNear(x, y), 'text', x, y);
  }

  private topShapeAt(x: number, y: number): ShapeElement | null {
    return topElementAt(this.elementsNear(x, y), 'shape', x, y);
  }

  private topTapeAt(x: number, y: number): TapeElement | null {
    return topElementAt(this.elementsNear(x, y), 'tape', x, y);
  }

  // --------------------------------------------------------------- mind map
  /**
   * The bubble a press at `pt` grabs, or null. Innermost first (the smallest
   * bubble whose outline encloses the point), then either:
   *  - the press is *on* that outline, which is unambiguous, or
   *  - it is inside it with nothing else under the pen, so there is nothing
   *    else the press could sensibly be about.
   *
   * A press inside a bubble that lands on its contents is therefore never a
   * grab — writing over your own handwriting has to keep working — and nor is
   * one that moves before the hold fires (see the 'bubble-press' mode).
   */
  private bubbleGrabAt(pt: number[]): BubbleElement | null {
    const pad = BUBBLE_GRAB_TOL / this.zoom();
    let inner: BubbleElement | null = null;
    for (const it of this.itemsNear(pt[0], pt[1], pad)) {
      if (isStroke(it) || it.kind !== 'bubble') continue;
      const poly = bubblePolygon(it);
      // inside it, or within a generous band just outside the outline
      if (!pointInPolygon(pt[0], pt[1], poly) && !nearPolyline(pt[0], pt[1], poly, it.size / 2 + pad)) continue;
      if (!inner || it.w * it.h < inner.w * inner.h) inner = it;
    }
    return inner;
  }

  /** The innermost bubble whose outline encloses a point, ignoring `exclude`. */
  private bubbleContaining(pt: number[], exclude?: string): BubbleElement | null {
    let inner: BubbleElement | null = null;
    for (const it of this.itemsNear(pt[0], pt[1], 0)) {
      if (isStroke(it) || it.kind !== 'bubble' || it.id === exclude) continue;
      if (!pointInPolygon(pt[0], pt[1], bubblePolygon(it))) continue;
      if (!inner || it.w * it.h < inner.w * inner.h) inner = it;
    }
    return inner;
  }

  /** The bubble whose nodes are currently revealed, re-read from the store (it may have gone). */
  private nodeBubble(): BubbleElement | null {
    const id = this.nodeEdit?.bubbleId;
    if (!id) return null;
    const it = store.boardItem(this.nb.id, id);
    return it && !isStroke(it) && it.kind === 'bubble' ? it : null;
  }

  /** Which revealed node a press landed on, if any. */
  private nodeAt(pt: number[]): BubbleNode | null {
    const b = this.nodeBubble();
    if (!b) return null;
    const hit = NODE_HIT / this.zoom();
    for (const { node, pt: np } of bubbleNodes(b)) {
      if (Math.hypot(pt[0] - np[0], pt[1] - np[1]) <= hit) return node;
    }
    return null;
  }

  /** Whether a set of nodes is revealed — mirrors `hasPendingLine`'s role for the dismiss paths. */
  get hasPendingNodes(): boolean {
    return this.nodeEdit !== null;
  }

  /**
   * Puts the revealed nodes away. Nothing is committed or lost: unlike a
   * pending line or bubble, revealed nodes are view state (see `nodeEdit`), so
   * this never has to be weighed against the undo stack.
   */
  dropNodes(): boolean {
    if (!this.nodeEdit) return false;
    this.nodeEdit = null;
    this.connect = null;
    this.schedule();
    return true;
  }

  /**
   * The four revealed nodes, drawn at a constant size on screen (the same
   * counter-scaling a pending line's handles use). View-only — nothing here
   * ever reaches the settled copy or the store.
   */
  private paintNodes(ctx: CanvasRenderingContext2D, b: BubbleElement): void {
    const z = this.zoom();
    const r = NODE_R / z;
    ctx.save();
    ctx.lineWidth = 1.5 / z;
    for (const { node, pt } of bubbleNodes(b)) {
      const isSource = this.connect?.fromId === b.id && this.connect.fromNode === node;
      ctx.beginPath();
      ctx.arc(pt[0], pt[1], isSource ? r * 1.4 : r, 0, Math.PI * 2);
      ctx.fillStyle = isSource ? '#2563eb' : '#ffffff';
      ctx.fill();
      ctx.strokeStyle = '#2563eb';
      ctx.stroke();
    }
    ctx.restore();
  }

  /** The rubber band while a connector is being dragged out, and a ring round the bubble it would land on. */
  private paintConnectDrag(
    ctx: CanvasRenderingContext2D,
    drag: { fromId: string; fromNode: BubbleNode; to: number[]; targetId: string | null }
  ): void {
    const from = store.boardItem(this.nb.id, drag.fromId);
    if (!from || isStroke(from) || from.kind !== 'bubble') return;
    const z = this.zoom();
    const [ax, ay] = bubbleNodePoint(from, drag.fromNode);
    ctx.save();
    ctx.strokeStyle = '#2563eb';
    ctx.lineWidth = Math.max(from.size, 1.5 / z);
    ctx.setLineDash([6 / z, 4 / z]);
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(drag.to[0], drag.to[1]);
    ctx.stroke();
    ctx.setLineDash([]);
    const target = drag.targetId ? store.boardItem(this.nb.id, drag.targetId) : null;
    if (target && !isStroke(target) && target.kind === 'bubble') {
      // highlight what it would attach to, so a drop is never a guess
      ctx.lineWidth = 2.5 / z;
      const poly = bubblePolygon(target);
      ctx.beginPath();
      poly.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.stroke();
    }
    ctx.restore();
  }

  // -------------------------------------------------------------- connectors
  /** Whether both of a connector's bubbles still exist. */
  private connectorResolves(c: ConnectorElement): boolean {
    for (const id of [c.a.bubbleId, c.b.bubbleId]) {
      const it = store.boardItem(this.nb.id, id);
      if (!it || isStroke(it) || it.kind !== 'bubble') return false;
    }
    return true;
  }

  /**
   * Every connector attached to any of `items`' bubbles that isn't already in
   * the list. A connector always has an endpoint *on* each of its bubbles, so
   * its bounding box necessarily overlaps them both — which means the spatial
   * index finds them without a reverse lookup to maintain.
   */
  private attachedConnectors(items: PageItem[]): ConnectorElement[] {
    const have = new Set(items.map((it) => it.id));
    const out: ConnectorElement[] = [];
    for (const it of items) {
      if (isStroke(it) || it.kind !== 'bubble') continue;
      for (const near of store.boardItemsIn(this.nb.id, itemBounds(it))) {
        if (isStroke(near) || near.kind !== 'connector' || have.has(near.id)) continue;
        if (near.a.bubbleId !== it.id && near.b.bubbleId !== it.id) continue;
        have.add(near.id);
        out.push(near);
      }
    }
    return out;
  }

  /**
   * Re-derives every connector in `items` from its two anchors, so endpoints
   * and bounding box follow whichever end moved. Bubbles are read from `items`
   * first (their live, mid-drag versions) and from the store otherwise (the end
   * that is standing still) — which is the whole reason a connector can't
   * simply be translated along with a drag: one of its ends usually isn't
   * moving at all.
   *
   * Returns a fresh array; a connector whose bubbles have gone is passed
   * through untouched, for whatever is about to remove it to deal with.
   */
  private restitchConnectors(items: PageItem[]): PageItem[] {
    const moved = new Map<string, BubbleElement>();
    for (const it of items) if (!isStroke(it) && it.kind === 'bubble') moved.set(it.id, it);
    const bubble = (id: string): BubbleElement | null => {
      const live = moved.get(id);
      if (live) return live;
      const it = store.boardItem(this.nb.id, id);
      return it && !isStroke(it) && it.kind === 'bubble' ? it : null;
    };
    return items.map((it) => {
      if (isStroke(it) || it.kind !== 'connector') return it;
      const a = bubble(it.a.bubbleId);
      const b = bubble(it.b.bubbleId);
      if (!a || !b) return it;
      const [ax, ay] = bubbleNodePoint(a, it.a.node);
      const [bx, by] = bubbleNodePoint(b, it.b.node);
      return { ...it, ax, ay, bx, by, ...connectorBox(ax, ay, bx, by, it.size) };
    });
  }

  /**
   * Links two bubbles. The far end attaches at whichever of the target's nodes
   * the drag was dropped nearest, so the line lands where it was aimed.
   *
   * Painted straight into the settled copy rather than invalidating it: the
   * only thing that changed is one new line, so there is no reason for a
   * connector to cost a full repaint (the same fast path a finished stroke
   * takes).
   */
  private createConnector(fromId: string, fromNode: BubbleNode, toId: string, dropAt: number[]): void {
    const from = store.boardItem(this.nb.id, fromId);
    const to = store.boardItem(this.nb.id, toId);
    if (!from || isStroke(from) || from.kind !== 'bubble') return;
    if (!to || isStroke(to) || to.kind !== 'bubble') return;
    // already linked? One connector per pair of bubbles, whichever nodes it
    // happens to join and whichever end it was drawn from — a second line
    // between the same two bubbles says nothing the first one doesn't.
    for (const c of this.attachedConnectors([from])) {
      if (c.a.bubbleId === toId || c.b.bubbleId === toId) return;
    }
    const toNode = nearestBubbleNode(to, dropAt[0], dropAt[1]);
    const [ax, ay] = bubbleNodePoint(from, fromNode);
    const [bx, by] = bubbleNodePoint(to, toNode);
    const box = connectorBox(ax, ay, bx, by, from.size);
    const el: ConnectorElement = {
      id: uid(),
      kind: 'connector',
      pageId: this.chunkFor(box),
      notebookId: this.nb.id,
      a: { bubbleId: fromId, node: fromNode },
      b: { bubbleId: toId, node: toNode },
      color: from.color, // reads as part of the map rather than of the current tool
      size: from.size,
      ax,
      ay,
      bx,
      by,
      ...box,
      rotation: 0,
      createdAt: Date.now(),
    };
    store.addItems([el]);
    const ctx = this.sctx;
    const rect = this.settledRect;
    if (ctx && rect) {
      const s = this.settledZoom * DPR;
      ctx.setTransform(s, 0, 0, s, -rect.x * s, -rect.y * s);
      drawElement(ctx, el, this.paper());
    }
    this.schedule();
    this.hooks.onOp({ kind: 'add-items', pageId: el.pageId, items: [el] });
  }

  /**
   * The tightest bubble that strictly contains `item` — the one that owns it
   * under the innermost-wins rule. `exclude` keeps a bubble from being
   * considered its own container.
   */
  private innermostBubbleContaining(item: PageItem, exclude?: string): BubbleElement | null {
    let best: BubbleElement | null = null;
    for (const it of store.boardItemsIn(this.nb.id, itemBounds(item))) {
      if (it.id === item.id || it.id === exclude) continue;
      if (isStroke(it) || it.kind !== 'bubble') continue;
      if (!itemFullyInPolygon(item, bubblePolygon(it))) continue;
      if (!best || it.w * it.h < best.w * best.h) best = it;
    }
    return best;
  }

  /**
   * Who a freshly committed bubble owns, and which existing bubbles have to be
   * rewritten for it.
   *
   * Membership is **exclusive** and **innermost wins**: an item strictly inside
   * this bubble joins it unless some tighter bubble also contains it — in which
   * case that one keeps it, and if that bubble is itself inside this one, the
   * item still travels with this one, transitively through it. A looser bubble
   * that held the item loses it, which is the rewrite this returns.
   */
  private resolveOwnership(bubble: BubbleElement): {
    members: PageItem[];
    before: BubbleElement[];
    after: BubbleElement[];
  } {
    const poly = bubblePolygon(bubble);
    const area = bubble.w * bubble.h;
    const members: PageItem[] = [];
    const edits = new Map<string, BubbleElement>();

    for (const it of store.boardItemsIn(this.nb.id, itemBounds(bubble))) {
      if (it.id === bubble.id || !itemFullyInPolygon(it, poly)) continue;
      const owner = this.innermostBubbleContaining(it, bubble.id);
      if (owner && owner.w * owner.h <= area) continue; // a tighter bubble keeps it
      members.push(it);
      if (owner?.members.includes(it.id)) {
        const cur = edits.get(owner.id) ?? owner;
        edits.set(owner.id, { ...cur, members: cur.members.filter((id) => id !== it.id) });
      }
    }

    // a bubble drawn *around* an existing one joins that one's own container,
    // so a parent's move keeps carrying everything nested below it
    const parent = this.innermostBubbleContaining(bubble, bubble.id);
    if (parent) {
      const cur = edits.get(parent.id) ?? parent;
      if (!cur.members.includes(bubble.id)) {
        edits.set(parent.id, { ...cur, members: [...cur.members, bubble.id] });
      }
    }

    const before: BubbleElement[] = [];
    const after: BubbleElement[] = [];
    for (const [id, next] of edits) {
      const cur = store.boardItem(this.nb.id, id);
      if (!cur || isStroke(cur) || cur.kind !== 'bubble') continue;
      before.push(cur);
      // this bubble is being written for a real reason, so take the chance to
      // drop any member ids that no longer resolve (see BubbleElement.members).
      // `bubble` itself is not in the store until commitPendingBubble adds it.
      after.push({
        ...next,
        members: next.members.filter((m) => m === bubble.id || store.boardItem(this.nb.id, m) != null),
      });
    }
    return { members, before, after };
  }

  /**
   * What has to travel with a selection that contains bubbles, beyond the
   * selection itself: each bubble's transitive members and every connector
   * attached to any bubble that is about to move — the same set a hold-move is
   * given (`bubbleMoveSet`), minus whatever is already selected.
   *
   * Deduplicated by id, so a selection that already holds some of a bubble's
   * contents (or two nested bubbles whose sets overlap) carries each item once,
   * and the selection's own copy always wins.
   */
  private tagAlongs(selected: PageItem[]): PageItem[] | null {
    const have = new Set(selected.map((it) => it.id));
    const out: PageItem[] = [];
    for (const it of selected) {
      if (isStroke(it) || it.kind !== 'bubble') continue;
      for (const m of this.bubbleMoveSet(it)) {
        if (have.has(m.id)) continue;
        have.add(m.id);
        out.push(m);
      }
    }
    return out.length ? out : null;
  }

  /**
   * Re-resolves membership for any bubble this transform *resized*, against
   * the new box and by the same strict containment rule creation uses
   * (`resolveOwnership`) — a shrink leaves content outside the outline, a grow
   * takes in whatever it now encloses.
   *
   * Only a genuine size change counts. A pure move carries the members along
   * with it (see `bubbleMoveSet`), so what it owns cannot have changed, and
   * re-resolving there would quietly re-own whatever the bubble was dropped on.
   *
   * Because ownership is exclusive, a growing bubble can also take items off a
   * looser one; those other bubbles come back as `extraBefore`/`extraAfter` so
   * the caller can put both sides in the one op. `changed` is just what needs
   * writing to the store. Called *after* the transform has landed, so every
   * query here reads final geometry.
   */
  private reresolveResized(
    orig: PageItem[],
    after: PageItem[]
  ): { after: PageItem[]; changed: PageItem[]; extraBefore: PageItem[]; extraAfter: PageItem[] } {
    const sizeBefore = new Map<string, { w: number; h: number }>();
    for (const it of orig) if (!isStroke(it)) sizeBefore.set(it.id, { w: it.w, h: it.h });

    const inSet = new Set(after.map((it) => it.id));
    const changed: PageItem[] = [];
    const extraBefore: PageItem[] = [];
    const extraAfter: PageItem[] = [];
    const edited = new Set<string>();

    const next = after.map((it): PageItem => {
      if (isStroke(it) || it.kind !== 'bubble') return it;
      const was = sizeBefore.get(it.id);
      if (!was || (Math.abs(was.w - it.w) < 0.01 && Math.abs(was.h - it.h) < 0.01)) return it;
      const res = this.resolveOwnership(it);
      for (let i = 0; i < res.after.length; i++) {
        const b = res.after[i];
        // a bubble this transform is already rewriting keeps the version above
        if (inSet.has(b.id) || edited.has(b.id)) continue;
        edited.add(b.id);
        extraBefore.push(res.before[i]);
        extraAfter.push(b);
        changed.push(b);
      }
      const withMembers: PageItem = { ...it, members: res.members.map((m) => m.id) };
      changed.push(withMembers);
      return withMembers;
    });
    return { after: next, changed, extraBefore, extraAfter };
  }

  /**
   * A bubble plus everything that has to move with it: its live members,
   * resolved transitively through nested bubbles, with a visited set so a
   * cycle in corrupt data can't spin. Dead member ids are simply skipped —
   * `members` is advisory (see BubbleElement).
   *
   * Sorted in z-order, because this list is what the view paints during the
   * move in place of the settled copy.
   */
  private bubbleMoveSet(bubble: BubbleElement): PageItem[] {
    const out: PageItem[] = [];
    const seen = new Set<string>();
    const walk = (b: BubbleElement): void => {
      if (seen.has(b.id)) return;
      seen.add(b.id);
      out.push(b);
      for (const id of b.members) {
        if (seen.has(id)) continue;
        const it = store.boardItem(this.nb.id, id);
        if (!it) continue;
        if (!isStroke(it) && it.kind === 'bubble') {
          walk(it);
          continue;
        }
        seen.add(id);
        out.push(it);
      }
    };
    walk(bubble);
    // every connector hanging off any bubble that is about to move: they have
    // to travel in the same transform (and so the same op) to be restitched
    out.push(...this.attachedConnectors(out));
    return out.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
  }

  // ----------------------------------------------------------- new elements
  /** The chunk an item whose bounds start at `b` is filed under. */
  private chunkFor(b: Rect): string {
    return store.boardChunkAt(this.nb.id, b.x, b.y);
  }

  private beginShapeDrag(pt: number[]): void {
    const t = resolveDrawTool();
    this.liveTool = {
      kind: 'pen',
      color: this.aiInkColor(t ? t.color : toolState.penColor),
      size: t ? t.size : toolState.penSize,
    };
    this.mode = 'shapes';
    this.live = [pt];
  }

  private shapeFromFit(fit: ShapeFit, color: string, size: number): ShapeElement {
    return {
      id: uid(),
      kind: 'shape',
      pageId: this.chunkFor({ x: fit.x, y: fit.y, w: fit.w, h: fit.h }),
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

  /** The shape a Shapes drag would place, or null while it is still too small. */
  private shapeFromDrag(): ShapeElement | null {
    const a = this.live[0];
    const b = this.live[this.live.length - 1];
    const kind = toolState.shapeKind;
    const { color, size } = this.liveTool;
    const shapeMin = SHAPE_MIN / this.zoom();
    if (kind === 'arrow') {
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) < shapeMin) return null;
      return this.shapeFromFit(lineFit('arrow', a, b, size), color, size);
    }
    const w = Math.abs(b[0] - a[0]);
    const h = Math.abs(b[1] - a[1]);
    if (w < shapeMin || h < shapeMin) return null;
    const fit: ShapeFit = { shape: kind, x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w, h, rotation: 0 };
    if (kind === 'triangle') fit.pts = [[0.5, 0], [1, 1], [0, 1]]; // apex up, base along the bottom
    return this.shapeFromFit(fit, color, size);
  }

  private tapeFromDrag(): TapeElement {
    const a = this.live[0];
    const b = this.live[this.live.length - 1];
    const x = Math.min(a[0], b[0]);
    const y = Math.min(a[1], b[1]);
    const w = Math.abs(b[0] - a[0]);
    const h = Math.abs(b[1] - a[1]);
    return {
      id: uid(),
      kind: 'tape',
      pageId: this.chunkFor({ x, y, w, h }),
      notebookId: this.nb.id,
      x,
      y,
      w,
      h,
      rotation: 0,
      color: this.aiInkColor(TAPE_COLOR),
      createdAt: Date.now(),
    };
  }

  /**
   * Places a loaded image centred on the *view* rather than on a page — a board
   * has no page to centre in, and dropping it at the origin would put it
   * somewhere the user cannot see. Fitted to a fraction of the visible width,
   * so it arrives at a sensible size whatever the zoom.
   */
  insertImage(src: string, naturalW: number, naturalH: number): void {
    const v = this.visibleRect();
    const scale = Math.min((v.w * IMAGE_FIT) / naturalW, (v.h * IMAGE_FIT) / naturalH, 1);
    const w = Math.max(24, naturalW * scale);
    const h = Math.max(24, naturalH * scale);
    const x = v.x + (v.w - w) / 2;
    const y = v.y + (v.h - h) / 2;
    const el: ImageElement = {
      id: uid(),
      kind: 'image',
      pageId: this.chunkFor({ x, y, w, h }),
      notebookId: this.nb.id,
      x,
      y,
      w,
      h,
      rotation: 0,
      src,
      createdAt: Date.now(),
    };
    this.pasteItems([el]);
  }

  // ------------------------------------------------------------- tape strips
  private getTape(id: string): TapeElement | undefined {
    const it = store.boardItem(this.nb.id, id);
    return it && !isStroke(it) && it.kind === 'tape' ? it : undefined;
  }

  /** Peels a covering strip back, or covers a peeled one. View-only: nothing is stored. */
  private toggleTape(id: string): void {
    if (this.peeled.has(id)) this.peeled.delete(id);
    else this.peeled.add(id);
    this.invalidate();
  }

  private handleTapeTap(id: string): void {
    if (toolState.kind !== 'tape') {
      this.toggleTape(id);
      return;
    }
    const t = this.getTape(id);
    if (t) this.hooks.onTapeTap(this, id, { x: t.x, y: t.y, w: t.w, h: t.h, rot: t.rotation });
  }

  isPeeled(id: string): boolean {
    return this.peeled.has(id);
  }

  beginTapeResize(id: string): TapeElement | null {
    const t = this.getTape(id);
    this.tapeResizeOrig = t ? { ...t } : null;
    return this.tapeResizeOrig;
  }

  previewTapeResize(id: string, w: number, h: number): void {
    const t = this.getTape(id);
    if (!t) return;
    store.replaceItems(t.pageId, [{ ...t, w: Math.max(TAPE_MIN, w), h: Math.max(TAPE_MIN, h) }]);
    this.invalidate();
  }

  commitTapeResize(id: string): void {
    const before = this.tapeResizeOrig;
    this.tapeResizeOrig = null;
    if (!before) return;
    const after = this.getTape(id);
    if (!after || (after.w === before.w && after.h === before.h)) return;
    this.hooks.onOp({ kind: 'replace-items', pageId: before.pageId, before: [before], after: [after] });
  }

  tapeGeometry(id: string): { w: number; h: number } | null {
    const t = this.getTape(id);
    return t ? { w: t.w, h: t.h } : null;
  }

  deleteTape(id: string): void {
    const t = this.getTape(id);
    if (!t) return;
    const removed = store.removeItems(t.pageId, new Set([id]));
    if (!removed.length) return;
    this.peeled.delete(id);
    this.invalidate();
    this.hooks.onOp({ kind: 'remove-items', pageId: t.pageId, items: removed });
  }

  /** A board has no page to bound a strip by, so the slider spans what is on screen. */
  tapeSizeLimit(): { w: number; h: number } {
    const v = this.visibleRect();
    return { w: Math.max(TAPE_MIN * 4, v.w), h: Math.max(TAPE_MIN * 4, v.h) };
  }

  // -------------------------------------------------------------- selection
  /**
   * The selected items, in z-order. A text box mid-edit is represented by the
   * editor's working copy, which for a brand-new box is not in the store yet.
   */
  selectedItems(): PageItem[] {
    if (!this.selected.size) return [];
    const ed = this.editor;
    const items: PageItem[] = [];
    for (const id of this.selected) {
      if (ed && id === ed.el.id) continue;
      const it = store.boardItem(this.nb.id, id);
      if (it) items.push(it);
    }
    items.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
    if (ed && this.selected.has(ed.el.id)) items.push(ed.el);
    return items;
  }

  private setSelection(ids: string[], lassoPath: number[][] | null = null): void {
    this.selected = new Set(ids);
    this.lastLassoPath = lassoPath;
    this.showSelection();
    this.hooks.onSelection(this, this.selected.size);
    this.schedule();
  }

  private showSelection(): void {
    const view = selectionView(this.selectedItems(), this.lastLassoPath, this.editor != null);
    if (!view) {
      this.hooks.hideSelection(this);
      this.hooks.onSelectionFrame(this, null);
      return;
    }
    this.hooks.showSelection(this, view.frame, view.opts);
    this.hooks.onSelectionFrame(this, null);
  }

  clearSelection(): boolean {
    const had = this.editor !== null || this.selected.size > 0 || this.lastLassoPath !== null;
    this.commitEdit();
    this.commitPendingBubble(); // pending state this also settles, like a pending line
    this.dropNodes();
    if (this.selected.size) {
      this.setSelection([]);
    } else {
      this.lastLassoPath = null;
      this.hooks.hideSelection(this);
      this.hooks.onSelectionFrame(this, null);
    }
    if (had) this.schedule();
    return had;
  }

  /** Called by the notebook when the active tool changes. */
  deactivate(): void {
    this.commitLine();
    this.commitPendingBubble();
    this.dropNodes();
    this.clearSelection();
  }

  /** Called by the shared SelectionOverlay's onTap hook. */
  tapSelection(x: number, y: number): void {
    if (this.lastLassoPath) {
      if (pointInPolygon(x, y, this.lastLassoPath)) {
        this.hooks.onSelectionFrame(this, { ...aabb(this.lastLassoPath), rot: 0 });
      } else {
        const hit = topItemAt(this.itemsNear(x, y, TAP_RADIUS), x, y);
        this.setSelection(hit ? [hit.id] : []);
      }
      return;
    }
    if (!this.selected.size) return;
    if (toolState.kind === 'text' && !this.editor) {
      const items = this.selectedItems();
      const el = items.length === 1 && !isStroke(items[0]) ? items[0] : null;
      if (el?.kind === 'text' && pointInElement(el, x, y)) {
        this.startEdit(el, false);
        return;
      }
    }
    const frame = itemsFrame(this.selectedItems());
    if (frame) this.hooks.onSelectionFrame(this, frame);
  }

  deleteSelection(): void {
    if (this.editor) {
      const ed = this.editor;
      this.editor = null;
      ed.area.remove();
      if (ed.isNew) {
        this.setSelection([]);
        this.invalidate();
        return;
      }
    }
    const base = this.selectedItems();
    if (!base.length) return;
    // a bubble's connectors have no meaning without it, so they come off in the
    // same call — and so in the same op, which is what lets one undo put the
    // whole lot back together
    const items = [...base, ...this.attachedConnectors(base)];
    const pageId = items[0].pageId;
    this.selected = new Set();
    this.lastLassoPath = null;
    // removeItems resolves each id to its own chunk on a board, so a selection
    // spanning several still comes off in one call — and so stays one undo step
    const removed = store.removeItems(pageId, new Set(items.map((it) => it.id)));
    this.hooks.hideSelection(this);
    this.invalidate();
    this.hooks.onSelection(this, 0);
    this.hooks.onSelectionFrame(this, null);
    if (removed.length) this.hooks.onOp({ kind: 'remove-items', pageId, items: removed });
  }

  recolorSelection(tool: 'pen' | 'highlighter', color: string): void {
    const before = this.selectedItems().filter((it): it is Stroke => isStroke(it) && it.tool === tool);
    if (!before.length) return;
    const after = before.map((st) => ({ ...st, color }));
    store.replaceItems(before[0].pageId, after);
    this.invalidate();
    this.hooks.onOp({ kind: 'replace-items', pageId: before[0].pageId, before, after });
  }

  /**
   * Adds already-cloned items as one undo step and selects them — the shared
   * landing point for paste, Duplicate and image-insert. Each item is re-filed
   * under the chunk its own bounds fall in: the caller cloned them against this
   * surface's nominal page, but on a board the chunk follows the geometry.
   */
  pasteItems(items: PageItem[]): void {
    if (!items.length) return;
    this.commitEdit();
    const aiInk = this.hooks.isAiActive();
    const toAdd = items.map((it) => {
      const filed = { ...it, pageId: this.chunkFor(itemBounds(it)) } as PageItem;
      return aiInk && 'color' in filed ? ({ ...filed, color: AI_COLOR } as PageItem) : filed;
    });
    store.addItems(toAdd);
    this.invalidate();
    this.hooks.onOp({ kind: 'add-items', pageId: toAdd[0].pageId, items: toAdd, aiInk });
    this.setSelection(toAdd.map((it) => it.id));
  }

  /** The store changed under us (undo/redo): settle any pending line or bubble, drop any selection and repaint. */
  refresh(): void {
    this.commitLine();
    this.commitPendingBubble();
    this.dropNodes();
    this.clearSelection();
    this.invalidate();
  }

  // -------------------------------------------------------------- transform
  /**
   * `given` is for a drag that is not about the selection at all — a mind-map
   * bubble held under the pen, moving with everything it owns. Everything
   * downstream (`updateTransform`, `endTransform`, the one `replace-items` op
   * they produce, the spatial-index re-filing inside `store.replaceItems`) is
   * then shared with a selection drag, which is the point: a bubble move is an
   * ordinary multi-item move with a different way of choosing the items.
   */
  beginTransform(given?: PageItem[]): void {
    const items = given ?? this.selectedItems();
    const lasso = given ? null : this.lastLassoPath;
    // must match showSelection()'s frame exactly, or the overlay's drag math
    // and ours disagree about what "from" means on the very first tick
    const frame = lasso ? { ...aabb(lasso), rot: 0 } : itemsFrame(items);
    if (!items.length || !frame) return;
    this.xfOrig = items;
    this.xfFrame = frame;
    this.xfCur = frame;
    this.xfLive = items;
    this.xfLassoOrig = lasso;
    // A hold-move is handed its whole set up front (`given` already holds the
    // bubble, its members and their connectors). A selection drag is handed
    // only what the user selected, so a selected bubble's contents are
    // collected here instead — otherwise dragging a lasso'd bubble would slide
    // the outline off the handwriting it owns.
    this.xfExtra = given ? null : this.tagAlongs(items);
    this.hooks.onSelectionFrame(this, null); // a drag must never keep the callout open
    this.invalidate(); // hides the originals; the view paints the live copies
  }

  updateTransform(frame: Frame): void {
    if (!this.xfOrig || !this.xfFrame) return;
    const same = frame.w === this.xfFrame.w && frame.h === this.xfFrame.h && frame.rot === this.xfFrame.rot;
    const dx = frame.x - this.xfFrame.x;
    const dy = frame.y - this.xfFrame.y;
    const base = same
      ? translateItems(this.xfOrig, dx, dy)
      : transformItems(this.xfOrig, this.xfFrame, frame);
    // the tag-alongs translate with a move and sit still for a resize; either
    // way they are painted by the view, since the settled copy leaves them out
    const extra = this.xfExtra ? (same ? translateItems(this.xfExtra, dx, dy) : this.xfExtra) : [];
    // one restitch over the lot, so a connector between a moving bubble and a
    // standing one resolves against both in their current positions
    this.xfLive = this.restitchConnectors([...base, ...extra]);
    // remapped fresh from the frozen pre-drag snapshot each tick, never from
    // the previous tick's result, so repeated remaps do not compound
    if (this.xfLassoOrig) {
      const from = this.xfFrame;
      this.lastLassoPath = this.xfLassoOrig.map((pt) => mapPoint(pt[0], pt[1], from, frame));
    }
    this.xfCur = frame;
    this.syncEditor(this.xfLive[0]);
    this.hooks.updateSelection(this, frame);
    this.schedule();
  }

  /**
   * Commits a finished drag/resize/rotate. There is no cross-page branch here —
   * a board is one surface, so a move can never leave it. The item's `pageId`
   * deliberately does not follow it across a chunk boundary either (see
   * Store.replaceItems), which is what keeps this a plain `replace-items` op
   * and so leaves undo/redo with nothing board-specific to know.
   */
  endTransform(frame: Frame | null): void {
    const orig = this.xfOrig;
    const from = this.xfFrame;
    const lassoOrig = this.xfLassoOrig;
    const extra = this.xfExtra ?? [];
    this.xfOrig = this.xfFrame = this.xfCur = this.xfLive = null;
    this.xfLassoOrig = null;
    this.xfExtra = null;
    if (!orig || !from) return;

    if (frame) {
      const same = frame.w === from.w && frame.h === from.h && frame.rot === from.rot;
      // a pure move takes the tag-alongs with it, into the same op — so one
      // undo puts the bubble, its contents and its links all back
      const moved = same && extra.length ? [...orig, ...extra] : orig;
      const after = this.restitchConnectors(
        same
          ? translateItems(moved, frame.x - from.x, frame.y - from.y)
          : transformItems(orig, from, frame).map((it) =>
              !isStroke(it) && it.kind === 'text' ? { ...it, h: textHeight(it) } : it
            )
      );
      const ed = this.editor;
      const midEdit = ed && orig.length === 1 && orig[0].id === ed.el.id;
      if (midEdit) {
        // keep the geometry on the working copy; commitEdit records the whole
        // edit (typing + moves) as a single undo step
        ed.el = after[0] as TextElement;
      } else {
        store.replaceItems(orig[0].pageId, after);
        // a resized bubble encloses something different than it did, so what it
        // owns is re-resolved against the new box — inside the same op, so one
        // undo takes the geometry and the membership back together
        const rr = this.reresolveResized(moved, after);
        if (rr.changed.length) store.replaceItems(orig[0].pageId, rr.changed);
        this.hooks.onOp({
          kind: 'replace-items',
          pageId: orig[0].pageId,
          before: [...moved, ...rr.extraBefore],
          after: [...rr.after, ...rr.extraAfter],
        });
      }
      // commit the outline's new shape permanently, so it does not snap back on
      // the next showSelection() and a second drag starts where this one ended
      if (lassoOrig) this.lastLassoPath = lassoOrig.map((pt) => mapPoint(pt[0], pt[1], from, frame));
    } else if (lassoOrig) {
      this.lastLassoPath = lassoOrig; // cancelled: items never changed, restore the outline too
    }
    this.invalidate();
    this.showSelection();
    this.syncEditor();
  }

  // -------------------------------------------------------------- text edit
  private newText(x: number, y: number): TextElement {
    const fontSize = TEXT_DEFAULT_SIZE;
    const w = TEXT_DEFAULT_WIDTH;
    const ty = y - fontSize * TEXT_LINE_HEIGHT * 0.5;
    return {
      id: uid(),
      kind: 'text',
      pageId: this.chunkFor({ x, y: ty, w, h: fontSize * TEXT_LINE_HEIGHT }),
      notebookId: this.nb.id,
      x,
      // no page edge to clamp against — a board box starts exactly where tapped
      y: ty,
      w,
      h: fontSize * TEXT_LINE_HEIGHT,
      rotation: 0,
      text: '',
      color: this.aiInkColor(toolState.textColor),
      fontSize,
      createdAt: Date.now(),
    };
  }

  private startEdit(el: TextElement, isNew: boolean): void {
    const cam = this.editorCam;
    if (!cam) return;
    this.commitEdit();
    const area = document.createElement('textarea');
    area.className = 'text-editor';
    area.rows = 1;
    area.spellcheck = false;
    area.setAttribute('aria-label', 'Text box');
    area.value = el.text;
    this.editor = { el: { ...el }, isNew, area };
    cam.append(area);
    this.syncEditor();

    area.addEventListener('input', () => {
      const ed = this.editor;
      if (!ed) return;
      ed.el = { ...ed.el, text: area.value, h: layoutText(area.value, ed.el.fontSize, ed.el.w).height };
      this.syncEditor();
      const f = itemsFrame([ed.el]);
      if (f) this.hooks.updateSelection(this, f);
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
    this.invalidate(); // hides the committed copy while the textarea shows it
    this.showSelection();
    this.hooks.onSelection(this, 1);
    requestAnimationFrame(() => {
      area.focus();
      area.setSelectionRange(area.value.length, area.value.length);
    });
  }

  /** Positions the textarea over its element, in board units — `editorCam` carries the camera. */
  private syncEditor(live?: PageItem): void {
    const ed = this.editor;
    if (!ed) return;
    const el = live && live.id === ed.el.id && !isStroke(live) && live.kind === 'text' ? live : ed.el;
    const st = ed.area.style;
    st.left = `${el.x}px`;
    st.top = `${el.y}px`;
    st.width = `${el.w}px`;
    st.height = `${Math.max(el.h, el.fontSize * TEXT_LINE_HEIGHT)}px`;
    st.font = `400 ${el.fontSize}px ${TEXT_FONT_FAMILY}`;
    st.lineHeight = String(TEXT_LINE_HEIGHT);
    st.color = resolveInkColor(el.color, this.paper());
    st.transform = el.rotation ? `rotate(${el.rotation}rad)` : '';
  }

  /** Writes the camera onto the text-editor layer, so the textarea tracks pan/zoom exactly as the canvas does. */
  private syncEditorCamera(): void {
    const cam = this.editorCam;
    if (!cam) return;
    const { x, y, zoom } = this.camera;
    cam.style.transform = `scale(${zoom}) translate(${-x}px, ${-y}px)`;
  }

  /** Finishes the current text edit: adds / updates / removes the element as one undo step. */
  commitEdit(): void {
    const ed = this.editor;
    if (!ed) return;
    this.editor = null;
    ed.area.remove();
    const text = ed.area.value;

    if (!text.trim()) {
      if (!ed.isNew) {
        const removed = store.removeItems(ed.el.pageId, new Set([ed.el.id]));
        if (removed.length) this.hooks.onOp({ kind: 'remove-items', pageId: ed.el.pageId, items: removed });
      }
      this.selected = new Set();
      this.lastLassoPath = null;
      this.hooks.hideSelection(this);
      this.invalidate();
      this.hooks.onSelection(this, 0);
      return;
    }

    const next: TextElement = { ...ed.el, text, h: layoutText(text, ed.el.fontSize, ed.el.w).height };
    if (ed.isNew) {
      store.addItems([next]);
      this.hooks.onOp({ kind: 'add-items', pageId: next.pageId, items: [next], aiInk: next.color === AI_COLOR });
    } else {
      const cur = store.boardItem(this.nb.id, next.id);
      if (cur && !isStroke(cur) && !sameText(cur, next)) {
        store.replaceItems(next.pageId, [next]);
        this.hooks.onOp({ kind: 'replace-items', pageId: next.pageId, before: [cur], after: [next] });
      }
    }
    this.invalidate();
    this.showSelection(); // stays selected (draggable) until the user taps elsewhere
  }

  // ------------------------------------------------------------- screen map
  /**
   * See ItemSurface.calloutBasis. A board has no per-item element to measure,
   * so this hands back the canvas rect shifted by the camera: with `pw` set to
   * the viewport's own width in board units, `frameScreenBox`'s
   * `rect.left + local * (rect.width / pw)` resolves world units against the
   * same origin the canvas draws them at.
   */
  calloutBasis(): { rect: DOMRect; pw: number } | null {
    const view = this.view;
    if (!view) return null;
    const r = view.getBoundingClientRect();
    const z = this.zoom();
    const shifted = new DOMRect(r.left - this.camera.x * z, r.top - this.camera.y * z, r.width, r.height);
    return { rect: shifted, pw: r.width / z };
  }
}

/** Groups the items of `ids` by the chunk they are stored in, so each removal is one store call. Resolved by id against the board registry rather than by scanning the board. */
function collectByPage(notebookId: string, ids: Set<string>): Map<string, PageItem[]> {
  const out = new Map<string, PageItem[]>();
  for (const id of ids) {
    const it = store.boardItem(notebookId, id);
    if (!it) continue;
    const arr = out.get(it.pageId);
    if (arr) arr.push(it);
    else out.set(it.pageId, [it]);
  }
  return out;
}


function boundsOfPoints(pts: number[][]): Rect {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of pts) {
    if (p[0] < x0) x0 = p[0];
    if (p[0] > x1) x1 = p[0];
    if (p[1] < y0) y0 = p[1];
    if (p[1] > y1) y1 = p[1];
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Re-exported so NotebookView can size a board's initial camera without importing geom itself. */
export { itemBounds };
