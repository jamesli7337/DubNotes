import type { PageItem, PageElement, ShapeElement, TapeElement, TextElement } from '../types';
import { isStroke, nearPolyline, uid } from '../util';
import { aabb, itemsFrame, pointInElement, type Frame } from './geom';
import type { Op } from './page-canvas';
import type { OverlayOptions } from './selection';

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

  // tape strips, driven by the notebook-level resize/delete popover
  isPeeled(id: string): boolean;
  beginTapeResize(id: string): TapeElement | null;
  previewTapeResize(id: string, w: number, h: number): void;
  commitTapeResize(id: string): void;
  tapeGeometry(id: string): { w: number; h: number } | null;
  deleteTape(id: string): void;

  /**
   * How to map a `Frame` in this surface's units onto the screen, for UI that
   * floats in `document.body` (the selection callout, the tape popover's
   * anchor). `rect`/`pw` feed `frameScreenBox` unchanged: screen = rect.left +
   * local * (rect.width / pw).
   *
   * A page returns its own live screen rect and its page width, so the scale
   * is the camera zoom. A board has no per-item element to measure, so it
   * returns the canvas rect *shifted by the camera* — which makes the same
   * formula resolve world units against the same origin. Null when the
   * surface isn't mounted and there is nothing to measure.
   */
  calloutBasis(): { rect: DOMRect; pw: number } | null;

  /**
   * The largest a tape strip may be dragged to in the resize popover, in this
   * surface's own units. A page caps at its own size; a board has no extent,
   * so it caps at what is currently on screen — which keeps the slider's range
   * meaningful (you can always fill the view) without pretending to a limit
   * that does not exist.
   */
  tapeSizeLimit(): { w: number; h: number };
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
  /** a tap on an existing tape strip while the tape tool is active — opens its resize/delete popover */
  onTapeTap: (s: ItemSurface, tapeId: string, frame: Frame) => void;
  isAiActive: () => boolean;
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
    const hit = isStroke(it) ? nearPolyline(x, y, it.points, it.size / 2 + TAP_RADIUS) : pointInElement(it, x, y);
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
      rotate: single != null, // never for a lasso selection
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
  v.strokeStyle = 'rgba(37, 99, 235, 0.9)';
  v.stroke();
  v.restore();
}
