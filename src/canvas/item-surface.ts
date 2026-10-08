import { HOLD_DRIFT_PX, LASER_COLOR, LASER_FADE_MS, SHAPE_CUE_MS, SHAPE_HOLD_MS } from '../tools';
import type { PageItem, PageElement, ShapeElement, TapeElement, TextElement } from '../types';
import { isStroke, nearPolyline, uid } from '../util';
import { aabb, itemsFrame, nearConnector, pointInElement, type Frame } from './geom';
import type { Op } from './page-canvas';
import type { OverlayOptions } from './selection';
import { uiColors } from './ui-colors';

/**
 * What a page and a board have in common as a place items live on.
 *
 * `PageCanvas` and `BoardCanvas` render and route pointers very differently —
 * one is a fixed-size bitmap inside a CSS-transformed layer, the other a
 * viewport-sized canvas that draws the camera itself — but everything *above*
 * them (the dock's selection actions, the floating callout, the tape popover,
 * the shared SelectionOverlay, clipboard paste) only ever needs the surface
 * below. `NotebookView` holds this type rather than `PageCanvas`, so the same
 * UI drives either without knowing which it has.
 *
 * The geometry that crosses this boundary — a `Frame`, a hit-test point, a
 * pasted item's coordinates — is always in the surface's *own* units: page
 * units for a page, global board units for a board. `calloutBasis()` is what
 * lets a caller turn those into screen space without knowing the difference.
 */
export interface ItemSurface {
  /**
   * The chunk/page new items are filed under by default. For a page this is
   * the page itself; for a board it is the origin chunk, and the board
   * re-files each item by its own bounds on the way in (see its `pasteItems`),
   * because a board's chunk is derived from geometry, not from the surface.
   */
  readonly page: { id: string };
  readonly mounted: boolean;
  readonly hasSelection: boolean;

  selectedItems(): PageItem[];
  clearSelection(): boolean;
  deleteSelection(): void;
  recolorSelection(tool: 'pen' | 'highlighter', color: string): void;
  pasteItems(items: PageItem[]): void;
  insertImage(src: string, naturalW: number, naturalH: number): void;
  /** Finish any edit and drop the selection — called when the active tool changes. */
  deactivate(): void;

  /** SelectionOverlay's drag hooks, routed here by NotebookView for whichever surface owns the shown selection. */
  beginTransform(): void;
  updateTransform(frame: Frame): void;
  endTransform(frame: Frame | null): void;
  tapSelection(x: number, y: number): void;

  // tape strips
  isPeeled(id: string): boolean;
  deleteTape(id: string): void;

  /**
   * How to map a `Frame` in this surface's units onto the screen, for UI that
   * floats in `document.body` (the selection callout). `rect`/`pw` feed `frameScreenBox` unchanged: screen = rect.left +
   * local * (rect.width / pw).
   *
   * A page returns its own live screen rect and its page width, so the scale
   * is the camera zoom. A board has no per-item element to measure, so it
   * returns the canvas rect *shifted by the camera* — which makes the same
   * formula resolve world units against the same origin. Null when the
   * surface isn't mounted and there is nothing to measure.
   */
  calloutBasis(): { rect: DOMRect; pw: number } | null;
}

/** The hooks a surface needs from NotebookView — the subset a board and a page both raise. */
export interface SurfaceHooks {
  onOp: (op: Op) => void;
  /** the set of selected items on this surface changed; `count` 0 means cleared */
  onSelection: (s: ItemSurface, count: number) => void;
  /** the visible selection's frame changed shape/position, or was cleared (`null`) — fires every drag tick, so keep it cheap */
  onSelectionFrame: (s: ItemSurface, frame: Frame | null) => void;
  /** a lasso *drag* ended over empty space — the drawn lasso's own box, for a Paste-only callout */
  onEmptyLassoSelection: (s: ItemSurface, frame: Frame) => void;
  isAiActive: () => boolean;
  /** A line entered or left its adjustable phase. Undo can drop such a line even with nothing on the history stack, so the button's enabled state has to track this as well as the stack. */
  onPendingLine: () => void;
  showSelection: (s: ItemSurface, frame: Frame, opts: OverlayOptions) => void;
  updateSelection: (s: ItemSurface, frame: Frame) => void;
  hideSelection: (s: ItemSurface) => void;
}

/** How close a tap has to land to a stroke's centreline to select it. */
export const TAP_RADIUS = 6;
/** Smallest box a Shapes drag will place, in screen px (divided by zoom at the call site). */
export const SHAPE_MIN = 12;
/** Fraction of the surface an inserted image is fitted to. */
export const IMAGE_FIT = 0.6;

/**
 * Topmost item under a point, in reverse z-order: strokes by proximity to
 * their centreline (fattened by the nib and a tap slop), elements by their
 * own rotated box. `items` is whatever the surface considers hit-testable —
 * a page's whole item list, or a board's index query around the point.
 */
export function topItemAt(items: PageItem[], x: number, y: number): PageItem | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    const hit = isStroke(it)
      ? nearPolyline(x, y, it.points, it.size / 2 + TAP_RADIUS)
      : // a connector is a line, not a box: its `x`/`y`/`w`/`h` are only the
        // bounding box the spatial index needs, so hit-testing it like an
        // element would claim the whole empty area beside a diagonal one
        it.kind === 'connector'
        ? nearConnector(it, x, y, it.size / 2 + TAP_RADIUS)
        : pointInElement(it, x, y);
    if (hit) return it;
  }
  return null;
}

/** Topmost element of one kind under a point — the text/shape/tape variants of topItemAt. */
export function topElementAt(els: PageElement[], kind: 'text', x: number, y: number): TextElement | null;
export function topElementAt(els: PageElement[], kind: 'shape', x: number, y: number): ShapeElement | null;
export function topElementAt(els: PageElement[], kind: 'tape', x: number, y: number): TapeElement | null;
export function topElementAt(els: PageElement[], kind: PageElement['kind'], x: number, y: number): PageElement | null {
  for (let i = els.length - 1; i >= 0; i--) {
    const e = els[i];
    if (e.kind === kind && pointInElement(e, x, y)) return e;
  }
  return null;
}

/**
 * The frame and handle set to show around a selection — shared so a board's
 * selection behaves identically to a page's.
 *
 * A lasso selection gets a frame around the drawn outline itself (the aabb of
 * the path) rather than the tighter `itemsFrame`, only its corner handles, no
 * rotate grip, and aspect-locked corner drags so a group can't be stretched
 * non-uniformly. Callers must use this same frame when starting a transform,
 * or the overlay's drag math and the surface's would disagree about what
 * "from" means and distort items on the first tick.
 */
export function selectionView(
  items: PageItem[],
  lassoPath: number[][] | null,
  editing: boolean
): { frame: Frame; opts: OverlayOptions } | null {
  const frame = lassoPath ? { ...aabb(lassoPath), rot: 0 } : itemsFrame(items);
  if (!frame) return null;
  const single = !lassoPath && items.length === 1 && !isStroke(items[0]) ? items[0] : null;
  const isText = single?.kind === 'text';
  return {
    frame,
    opts: {
      // never for a lasso selection, and never for a bubble — its outline,
      // membership tests and move set all read its plain box, so rotation is
      // forbidden rather than supported (see transformItems, which pins it)
      rotate: single != null && single.kind !== 'bubble',
      aspect: lassoPath != null || isText || single?.kind === 'image', // photos and lasso groups keep their proportions
      edges: lassoPath ? 'none' : isText ? 'horizontal' : 'all',
      passThrough: editing,
    },
  };
}

/** Builds a copy of `it` for another surface/position; used by paste and duplicate. */
export function cloneItem(it: PageItem, pageId: string, notebookId: string, dx: number, dy: number): PageItem {
  const base = { id: uid(), pageId, notebookId, createdAt: Date.now() };
  if (isStroke(it)) {
    return { ...it, ...base, points: it.points.map((p) => [p[0] + dx, p[1] + dy, p[2]]) };
  }
  const el: PageElement = { ...it, ...base, x: it.x + dx, y: it.y + dy };
  return el;
}

/**
 * Clones a whole set together, so that references *within* the set point at the
 * copies rather than back at the originals — which is what `cloneItem` on its
 * own cannot know about.
 *
 * Mind-map links are the reason this exists. A connector names two bubbles and
 * a bubble names the items it owns; copied verbatim, a duplicated bubble would
 * own the originals (so dragging the copy would drag them) and a duplicated
 * connector would still be tied to the originals. So:
 *  - a connector is kept only when *both* of its bubbles were cloned too, and
 *    is re-anchored to those copies; one copied without its bubbles is dropped,
 *    since a link to half a pair has no meaning;
 *  - a bubble's membership is remapped to the copies, dropping anything that
 *    wasn't part of the set;
 *  - a connector's cached endpoints are translated like any other geometry, so
 *    the copy draws in the right place without waiting for a restitch.
 *
 * Nothing here can fire in a paged notebook — neither kind exists there — so
 * this is `cloneItem` per item for every other caller.
 */
export function cloneItems(
  items: PageItem[],
  pageId: string,
  notebookId: string,
  dx: number,
  dy: number
): PageItem[] {
  const idMap = new Map<string, string>();
  const clones = items.map((it) => {
    const c = cloneItem(it, pageId, notebookId, dx, dy);
    idMap.set(it.id, c.id);
    return c;
  });
  const out: PageItem[] = [];
  for (const c of clones) {
    if (isStroke(c)) {
      out.push(c);
      continue;
    }
    if (c.kind === 'connector') {
      const a = idMap.get(c.a.bubbleId);
      const b = idMap.get(c.b.bubbleId);
      if (!a || !b) continue;
      out.push({
        ...c,
        a: { ...c.a, bubbleId: a },
        b: { ...c.b, bubbleId: b },
        ax: c.ax + dx,
        ay: c.ay + dy,
        bx: c.bx + dx,
        by: c.by + dy,
      });
      continue;
    }
    if (c.kind === 'bubble') {
      out.push({
        ...c,
        members: c.members.map((m) => idMap.get(m)).filter((m): m is string => m !== undefined),
      });
      continue;
    }
    out.push(c);
  }
  return out;
}

/** The box or ellipse spanning two corners, as a polygon the lasso hit-tests can use as-is. */
export function marqueePolygon(shape: 'box' | 'circle', a: number[], b: number[]): number[][] {
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
export function survivingSegments(points: number[][], gone: Set<number>): number[][][] {
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
export function sameText(a: PageElement, b: TextElement): boolean {
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

/**
 * Draws the lasso outline on `v`, in the surface's own units. A freehand path
 * (`!closed`) is raw pointer samples — connecting them with straight `lineTo`s
 * reads as a jagged, faceted line, so it's smoothed with the standard
 * quadratic-curve-through-midpoints technique. Box/circle marquees are already
 * clean geometry built in `marqueePolygon`, so they're drawn as plain straight
 * segments — smoothing would just round the box's sharp corners.
 *
 * Dash size and line width are screen-px constants counter-scaled by `zoom`,
 * so the outline stays a uniform on-screen dotted line at any magnification.
 */
export function strokeLassoPath(v: CanvasRenderingContext2D, path: number[][], closed: boolean, zoom: number): void {
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
  const z = zoom > 0 ? zoom : 1;
  v.setLineDash([6 / z, 4 / z]);
  v.lineWidth = 1.5 / z;
  v.strokeStyle = uiColors().lasso;
  v.stroke();
  v.restore();
}


// ------------------------------------------------------------------- laser
/** One pointer-down-to-up trail; each point is [x, y, timestamp]. */
export type LaserTrail = number[][][];

/**
 * Draws the laser trail — each segment fading with its age over
 * LASER_FADE_MS, a soft glow under a bright core, and a dot at the head —
 * and returns the trail with fully-faded points pruned out. The caller stores
 * that back and schedules another frame while it is non-empty, which is what
 * keeps the fade animating.
 *
 * Shared verbatim between a page and a board: the geometry is in the
 * surface's own units either way, and the widths are deliberately *not*
 * counter-scaled by zoom (a laser trail is drawn content, not screen-sized
 * chrome), so there is nothing surface-specific left in it.
 */
export function paintLaserTrail(v: CanvasRenderingContext2D, trail: LaserTrail): LaserTrail {
  const now = performance.now();
  const alive = trail
    .map((pts) => pts.filter((p) => now - p[2] < LASER_FADE_MS))
    .filter((pts) => pts.length > 0);
  if (!alive.length) return alive;
  v.save();
  v.lineCap = 'round';
  v.lineJoin = 'round';
  for (const pts of alive) {
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
  return alive;
}

// --------------------------------------------------------------- line snap
/** A stroke that has snapped into its adjustable straight-line phase. */
export interface LineEdit {
  a: number[];
  b: number[];
  color: string;
  size: number;
}

/** Opacity of the ghosted line cue shown partway through a hold, before it snaps. */
export const SHAPE_CUE_OPACITY = 0.35;
/** How many trailing live points the hold-still check averages over, instead of comparing only against the single previous sample. */
export const STILL_TRAIL = 5;
/** Radius of a pending line's endpoint handles (screen px, counter-scaled for zoom). */
export const LINE_HANDLE_R = 5;
/**
 * How close a press must land to an endpoint to grab it instead of committing
 * the line (screen px, counter-scaled for zoom). Still a little wider than the
 * dot that's drawn, so the handle doesn't demand pixel accuracy — but only a
 * little: every px of slop here is page you can't tap to dismiss the line, and
 * too much slop means a press meant to commit grabs an endpoint instead.
 */
export const LINE_HANDLE_HIT = 7;

/**
 * Whether the pen has actually moved, judged against a short trailing average
 * of the live points rather than the single previous sample — so one noisy
 * sample during an otherwise-still hold cannot by itself restart the timer.
 */
export function trailMoved(live: number[][], pt: number[]): boolean {
  const trail = live.slice(-STILL_TRAIL);
  if (!trail.length) return true;
  const ax = trail.reduce((sum, p) => sum + p[0], 0) / trail.length;
  const ay = trail.reduce((sum, p) => sum + p[1], 0) / trail.length;
  return Math.hypot(pt[0] - ax, pt[1] - ay) > 1.5;
}

/**
 * Whether the pen tip has drifted far enough from the point the hold last
 * started at (`anchor`) to restart it. Measured in screen px (page/board
 * distance × zoom), so Pencil rest jitter stays inside the radius at any zoom.
 */
export function holdDrifted(anchor: number[] | null, tip: number[], zoom: number): boolean {
  if (!anchor) return true;
  return Math.hypot(tip[0] - anchor[0], tip[1] - anchor[1]) * zoom > HOLD_DRIFT_PX;
}

/** The pending line's two endpoint handles, drawn at a constant on-screen size. */
export function paintLineHandles(v: CanvasRenderingContext2D, le: LineEdit, zoom: number): void {
  const z = zoom > 0 ? zoom : 1;
  v.save();
  v.lineWidth = 2 / z;
  v.strokeStyle = uiColors().handleStroke;
  v.fillStyle = uiColors().handleFill;
  for (const p of [le.a, le.b]) {
    v.beginPath();
    v.arc(p[0], p[1], LINE_HANDLE_R / z, 0, Math.PI * 2);
    v.fill();
    v.stroke();
  }
  v.restore();
}

/** Which endpoint handle a press lands on, if any — the nearer wins. */
export function lineEndAt(le: LineEdit, pt: number[], zoom: number): 'a' | 'b' | null {
  const z = zoom > 0 ? zoom : 1;
  const da = Math.hypot(pt[0] - le.a[0], pt[1] - le.a[1]);
  const db = Math.hypot(pt[0] - le.b[0], pt[1] - le.b[1]);
  if (Math.min(da, db) > LINE_HANDLE_HIT / z) return null;
  return da <= db ? 'a' : 'b';
}

/**
 * The two timers behind hold-to-straighten: a ghosted cue at SHAPE_CUE_MS, the
 * snap itself at SHAPE_HOLD_MS. Pure timer bookkeeping with no surface
 * knowledge — what happens when they fire is the caller's business — so a page
 * and a board share the durations and the re-arm semantics rather than each
 * keeping its own pair.
 */
export class LineSnapHold {
  private cueTimer: ReturnType<typeof setTimeout> | null = null;
  private holdTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * (Re)starts both timers, dropping any already running — called on every real
   * movement. `cueMs`/`holdMs` override the straighten durations for a hold
   * that isn't a mid-stroke one: those are long on purpose, so an ordinary
   * pause while writing never reads as intent, but a deliberate press-and-hold
   * on something (a mind-map bubble) has no such ambiguity to guard against and
   * would feel broken at the same timings.
   */
  arm(onCue: () => void, onHold: () => void, cueMs = SHAPE_CUE_MS, holdMs = SHAPE_HOLD_MS): void {
    this.disarm();
    this.cueTimer = setTimeout(() => {
      this.cueTimer = null;
      onCue();
    }, cueMs);
    this.holdTimer = setTimeout(() => {
      this.holdTimer = null;
      onHold();
    }, holdMs);
  }

  disarm(): void {
    if (this.cueTimer != null) {
      clearTimeout(this.cueTimer);
      this.cueTimer = null;
    }
    if (this.holdTimer != null) {
      clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }
  }
}
