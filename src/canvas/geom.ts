import type { BubbleElement, BubbleNode, ConnectorElement, PageElement, PageItem, ShapeElement } from '../types';
import { isStroke, nearPolyline } from '../util';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A selection frame: a box that may be rotated (radians) about its centre. */
export interface Frame extends Rect {
  rot: number;
}

/**
 * The single source of truth for pan/zoom: `x`/`y` is the world-space point
 * currently at the top-left of the viewport (`.nb-scroll`'s own content box),
 * `zoom` scales distances from there. Applied to `.nb-camera` as one CSS
 * transform (`scale(zoom) translate(-x, -y)`, transform-origin 0 0) instead
 * of native scroll mixed with a per-page CSS scale — see NotebookView's own
 * camera-model doc comment. "World space" is just each `.page`'s own
 * offsetLeft/offsetTop within `.nb-camera` (plain, transform-agnostic layout,
 * not a separately-tracked coordinate system) plus that page's own local
 * (page-unit) coordinates.
 */
export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

/** World-space point → screen-space point, relative to `.nb-scroll`'s own top-left (its content box, since `.nb-camera` starts flush against it). */
export function worldToScreen(camera: Camera, wx: number, wy: number): [number, number] {
  return [(wx - camera.x) * camera.zoom, (wy - camera.y) * camera.zoom];
}

/** The inverse of worldToScreen. */
export function screenToWorld(camera: Camera, sx: number, sy: number): [number, number] {
  return [sx / camera.zoom + camera.x, sy / camera.zoom + camera.y];
}

export function rotateAround(x: number, y: number, cx: number, cy: number, ang: number): [number, number] {
  if (!ang) return [x, y];
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const dx = x - cx;
  const dy = y - cy;
  return [cx + dx * c - dy * s, cy + dx * s + dy * c];
}

/** Ray-casting point-in-polygon; `poly` is a closed ring of [x, y] (last edge is implicit). */
export function pointInPolygon(x: number, y: number, poly: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0];
    const yi = poly[i][1];
    const xj = poly[j][0];
    const yj = poly[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** The element's four corners in page space, rotation applied. */
export function elementCorners(el: PageElement): number[][] {
  const cx = el.x + el.w / 2;
  const cy = el.y + el.h / 2;
  return [
    [el.x, el.y],
    [el.x + el.w, el.y],
    [el.x + el.w, el.y + el.h],
    [el.x, el.y + el.h],
  ].map(([x, y]) => rotateAround(x, y, cx, cy, el.rotation));
}

export function elementCenter(el: PageElement): [number, number] {
  return [el.x + el.w / 2, el.y + el.h / 2];
}

/** True if the page-space point lies inside the (rotated) element box. */
export function pointInElement(el: PageElement, x: number, y: number): boolean {
  const [cx, cy] = elementCenter(el);
  const [lx, ly] = rotateAround(x, y, cx, cy, -el.rotation);
  return lx >= el.x && lx <= el.x + el.w && ly >= el.y && ly <= el.y + el.h;
}

/**
 * Corner radius of a `roundrect` bubble, derived from its box rather than
 * stored — so a resize can never leave a radius that no longer suits the box.
 * Exported because the renderer has to draw the same curve this polygon
 * describes (see drawBubble in elements.ts).
 */
export function bubbleRadius(el: BubbleElement): number {
  return Math.min(el.w, el.h) * 0.22;
}

/**
 * A bubble's outline as a closed ring of points — the single source of truth
 * for "is this inside the bubble" and "did the eraser touch its edge". The
 * bubble's box is the outline (see BubbleElement), so this is derived, never
 * stored. Both rings come out convex, which is what lets the strict
 * containment tests below sample points rather than clip segments.
 *
 * A bubble's `rotation` is always 0, so unlike `nearShapeOutline` there is no
 * unrotating to do here.
 */
export function bubblePolygon(el: BubbleElement): number[][] {
  const pts: number[][] = [];
  if (el.outline === 'ellipse') {
    const cx = el.x + el.w / 2;
    const cy = el.y + el.h / 2;
    const n = 48;
    for (let i = 0; i < n; i++) {
      const t = (i / n) * Math.PI * 2;
      pts.push([cx + (el.w / 2) * Math.cos(t), cy + (el.h / 2) * Math.sin(t)]);
    }
    return pts;
  }
  const r = bubbleRadius(el);
  const per = 8; // segments per rounded corner
  // each corner's arc centre and the angle its quarter-turn starts at, walked
  // clockwise from the top-right so the ring comes out as one simple polygon
  const corners: number[][] = [
    [el.x + el.w - r, el.y + r, -Math.PI / 2],
    [el.x + el.w - r, el.y + el.h - r, 0],
    [el.x + r, el.y + el.h - r, Math.PI / 2],
    [el.x + r, el.y + r, Math.PI],
  ];
  for (const [cx, cy, a0] of corners) {
    for (let i = 0; i <= per; i++) {
      const a = a0 + (i / per) * (Math.PI / 2);
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
  }
  return pts;
}

/**
 * Where a bubble's connection node sits, in board units: the midpoint of that
 * side of its box. One formula serves both outlines — an inscribed ellipse
 * touches its box exactly at the side midpoints, so the node lands on the drawn
 * curve either way.
 */
export function bubbleNodePoint(el: BubbleElement, node: BubbleNode): [number, number] {
  const cx = el.x + el.w / 2;
  const cy = el.y + el.h / 2;
  switch (node) {
    case 'n':
      return [cx, el.y];
    case 's':
      return [cx, el.y + el.h];
    case 'w':
      return [el.x, cy];
    case 'e':
      return [el.x + el.w, cy];
  }
}

/** All four nodes of a bubble, for drawing the revealed handles and for hit-testing them. */
export function bubbleNodes(el: BubbleElement): { node: BubbleNode; pt: [number, number] }[] {
  return (['n', 'e', 's', 'w'] as BubbleNode[]).map((node) => ({ node, pt: bubbleNodePoint(el, node) }));
}

/** The node of `el` whose point is closest to (x, y) — where a connector dropped on a bubble attaches. */
export function nearestBubbleNode(el: BubbleElement, x: number, y: number): BubbleNode {
  let best: BubbleNode = 'n';
  let bestD = Infinity;
  for (const { node, pt } of bubbleNodes(el)) {
    const d = (pt[0] - x) ** 2 + (pt[1] - y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = node;
    }
  }
  return best;
}

/**
 * The bounding box a connector carries for the spatial index: the two endpoints'
 * aabb, never thinner than the line itself, so a perfectly horizontal or
 * vertical connector still has a box the index and the viewport cull can see.
 */
export function connectorBox(ax: number, ay: number, bx: number, by: number, size: number): Rect {
  const pad = Math.max(size / 2, 1);
  return aabb(
    [
      [ax, ay],
      [bx, by],
    ],
    pad
  );
}

/**
 * True when (x, y) is within `tol` of an element's box *perimeter* — the
 * counterpart of `nearShapeOutline` for the kinds that have no drawn outline of
 * their own (a text box, a tape strip). Rotation is included, since it works
 * off `elementCorners`.
 *
 * Perimeter rather than interior on purpose: it keeps the eraser's rule the
 * same for every boxed element — rubbing *inside* a box takes what is inside
 * it, not the box (see PageCanvas.eraseShapesAt, which says the same of a
 * shape's interior).
 */
export function nearElementOutline(el: PageElement, x: number, y: number, tol: number): boolean {
  const ring = elementCorners(el);
  ring.push(ring[0]);
  return nearPolyline(x, y, ring, tol);
}

/** True when (x, y) is within `tol` of a connector's drawn line. */
export function nearConnector(el: ConnectorElement, x: number, y: number, tol: number): boolean {
  return nearPolyline(
    x,
    y,
    [
      [el.ax, el.ay],
      [el.bx, el.by],
    ],
    tol
  );
}

/**
 * Strict containment, as opposed to the any-overlap test `strokeInPolygon`
 * does: every one of the stroke's own points has to be inside. That difference
 * is the whole reason this exists — a lasso should catch what it brushes past,
 * but a bubble that claimed every stroke it merely grazed would steal half of
 * the word next to it.
 *
 * Sampling the points (rather than clipping each segment) is sound because the
 * only polygons passed here are bubble rings, which are convex: a segment
 * between two interior points of a convex ring cannot leave it.
 */
export function strokeFullyInPolygon(points: number[][], poly: number[][]): boolean {
  if (!points.length) return false;
  for (const p of points) if (!pointInPolygon(p[0], p[1], poly)) return false;
  return true;
}

/** The same strict test for an element: all four of its (rotated) corners inside. */
export function elementFullyInPolygon(el: PageElement, poly: number[][]): boolean {
  for (const c of elementCorners(el)) if (!pointInPolygon(c[0], c[1], poly)) return false;
  return true;
}

/** `strokeFullyInPolygon` / `elementFullyInPolygon` for whichever kind of item this is. */
export function itemFullyInPolygon(it: PageItem, poly: number[][]): boolean {
  return isStroke(it) ? strokeFullyInPolygon(it.points, poly) : elementFullyInPolygon(it, poly);
}

/**
 * True when (x, y) is within `tol` of the shape's drawn outline — the box edges
 * of a rect, the ring of an ellipse, the sides of a triangle, the centre-line
 * of a line / arrow — as opposed to anywhere inside its box (see pointInElement).
 * The point is taken into the shape's unrotated frame, so rotation is free.
 */
export function nearShapeOutline(el: ShapeElement, x: number, y: number, tol: number): boolean {
  const [cx, cy] = elementCenter(el);
  const [lx, ly] = rotateAround(x, y, cx, cy, -el.rotation);
  // cheap reject: outside the box grown by the tolerance
  if (lx < el.x - tol || lx > el.x + el.w + tol || ly < el.y - tol || ly > el.y + el.h + tol) return false;
  let outline: number[][];
  switch (el.shape) {
    case 'line':
    case 'arrow':
      outline = [
        [el.x, cy],
        [el.x + el.w, cy],
      ];
      break;
    case 'triangle': {
      const pts = el.pts ?? [[0.5, 0], [1, 1], [0, 1]];
      outline = pts.map(([fx, fy]) => [el.x + fx * el.w, el.y + fy * el.h]);
      outline.push(outline[0]);
      break;
    }
    case 'ellipse': {
      const n = 48;
      outline = [];
      for (let i = 0; i <= n; i++) {
        const a = (i / n) * Math.PI * 2;
        outline.push([cx + (el.w / 2) * Math.cos(a), cy + (el.h / 2) * Math.sin(a)]);
      }
      break;
    }
    default:
      outline = [
        [el.x, el.y],
        [el.x + el.w, el.y],
        [el.x + el.w, el.y + el.h],
        [el.x, el.y + el.h],
        [el.x, el.y],
      ];
  }
  return nearPolyline(lx, ly, outline, tol);
}

export function aabb(pts: number[][], pad = 0): Rect {
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
  if (!pts.length) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2 };
}

/** Axis-aligned bounds of one item (strokes padded by half their nib width). */
export function itemBounds(item: PageItem): Rect {
  if (isStroke(item)) return aabb(item.points, item.size / 2);
  return aabb(elementCorners(item));
}

export function unionRects(rects: Rect[]): Rect | null {
  if (!rects.length) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * The frame a selection is edited through. A single element keeps its own
 * (possibly rotated) box so its handles line up with its edges; anything else
 * gets the axis-aligned union of the items' bounds.
 */
export function itemsFrame(items: PageItem[]): Frame | null {
  if (items.length === 1 && !isStroke(items[0])) {
    const e = items[0];
    return { x: e.x, y: e.y, w: e.w, h: e.h, rot: e.rotation };
  }
  const r = unionRects(items.map(itemBounds));
  return r ? { ...r, rot: 0 } : null;
}

/** Orientation of c relative to segment ab: sign of the cross product, 0 if collinear. */
function orient(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return Math.sign((bx - ax) * (cy - ay) - (by - ay) * (cx - ax));
}

/** Assuming a, b, c are collinear, is c within segment ab's bounding box? */
function onSegment(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): boolean {
  return (
    cx >= Math.min(ax, bx) && cx <= Math.max(ax, bx) && cy >= Math.min(ay, by) && cy <= Math.max(ay, by)
  );
}

/** True if segment a1a2 and segment b1b2 cross or touch. */
function segmentsIntersect(a1: number[], a2: number[], b1: number[], b2: number[]): boolean {
  const o1 = orient(a1[0], a1[1], a2[0], a2[1], b1[0], b1[1]);
  const o2 = orient(a1[0], a1[1], a2[0], a2[1], b2[0], b2[1]);
  const o3 = orient(b1[0], b1[1], b2[0], b2[1], a1[0], a1[1]);
  const o4 = orient(b1[0], b1[1], b2[0], b2[1], a2[0], a2[1]);
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(a1[0], a1[1], a2[0], a2[1], b1[0], b1[1])) return true;
  if (o2 === 0 && onSegment(a1[0], a1[1], a2[0], a2[1], b2[0], b2[1])) return true;
  if (o3 === 0 && onSegment(b1[0], b1[1], b2[0], b2[1], a1[0], a1[1])) return true;
  if (o4 === 0 && onSegment(b1[0], b1[1], b2[0], b2[1], a2[0], a2[1])) return true;
  return false;
}

/**
 * True when the two (implicitly closed, like pointInPolygon) simple polygons
 * genuinely share area — one contains a vertex of the other, or their edges
 * cross — rather than just sampling a few representative points.
 */
function polygonsOverlap(a: number[][], b: number[][]): boolean {
  for (const p of a) if (pointInPolygon(p[0], p[1], b)) return true;
  for (const p of b) if (pointInPolygon(p[0], p[1], a)) return true;
  for (let i = 0; i < a.length; i++) {
    const a1 = a[i];
    const a2 = a[(i + 1) % a.length];
    for (let j = 0; j < b.length; j++) {
      if (segmentsIntersect(a1, a2, b[j], b[(j + 1) % b.length])) return true;
    }
  }
  return false;
}

/**
 * Does a stroke count as inside the lasso? Any single point inside the
 * polygon selects the whole stroke; failing that, any segment between
 * consecutive points that crosses the polygon's boundary also selects it
 * (reusing segmentsIntersect, same as polygonsOverlap) — that catches a
 * sparse stroke that jumps clean across the lasso between two widely-spaced
 * samples, which point-sampling alone would miss. No majority requirement:
 * the smallest bit of the stroke touching the lasso is enough, matching how
 * elementInPolygon/polygonsOverlap already treat any overlap as a hit.
 */
export function strokeInPolygon(points: number[][], poly: number[][]): boolean {
  if (!points.length) return false;
  if (points.some((p) => pointInPolygon(p[0], p[1], poly))) return true;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    for (let j = 0; j < poly.length; j++) {
      if (segmentsIntersect(a, b, poly[j], poly[(j + 1) % poly.length])) return true;
    }
  }
  return false;
}

/** Does an element count as inside the lasso? True when its actual (rotated) box overlaps the lasso's drawn polygon — not just when a sampled corner or centre happens to land inside it. */
export function elementInPolygon(el: PageElement, poly: number[][]): boolean {
  return polygonsOverlap(elementCorners(el), poly);
}

/**
 * Maps a page-space point from where it sits inside `from` to where it lands
 * inside `to` — rotate, then per-axis scale, then translate. The same
 * transform `transformItems` applies to every item's points/corners, exposed
 * standalone for anything that needs to remap raw points without wrapping
 * them in PageItems first (e.g. PageCanvas's live lasso-outline echo).
 */
export function mapPoint(x: number, y: number, from: Frame, to: Frame): [number, number] {
  const sx = from.w > 0 ? to.w / from.w : 1;
  const sy = from.h > 0 ? to.h / from.h : 1;
  const fcx = from.x + from.w / 2;
  const fcy = from.y + from.h / 2;
  const tcx = to.x + to.w / 2;
  const tcy = to.y + to.h / 2;
  const cos = Math.cos(to.rot);
  const sin = Math.sin(to.rot);
  const [lx0, ly0] = rotateAround(x, y, fcx, fcy, -from.rot);
  const lx = (lx0 - fcx) * sx;
  const ly = (ly0 - fcy) * sy;
  return [tcx + lx * cos - ly * sin, tcy + lx * sin + ly * cos];
}

/**
 * Re-maps items from one frame to another: everything inside `from` is moved,
 * scaled (per axis, in frame-local space) and rotated so it sits identically
 * inside `to`. Stroke nibs and text sizes scale with the box; a shape's
 * outline width is fixed at creation and never changes here, on any handle —
 * only its box (position/size/rotation) does.
 */
export function transformItems(items: PageItem[], from: Frame, to: Frame): PageItem[] {
  const sx = from.w > 0 ? to.w / from.w : 1;
  const sy = from.h > 0 ? to.h / from.h : 1;
  const drot = to.rot - from.rot;
  const uniform = Math.sqrt(Math.abs(sx * sy));

  return items.map((item): PageItem => {
    if (isStroke(item)) {
      return {
        ...item,
        size: item.size * uniform,
        points: item.points.map((p) => {
          const [x, y] = mapPoint(p[0], p[1], from, to);
          return [x, y, p[2]];
        }),
      };
    }
    const [cx, cy] = elementCenter(item);
    const [ncx, ncy] = mapPoint(cx, cy, from, to);
    const w = item.w * sx;
    const h = item.h * sy;
    const box = { x: ncx - w / 2, y: ncy - h / 2, w, h, rotation: item.rotation + drot };
    switch (item.kind) {
      case 'text':
        // width-only drags re-wrap without changing the type size; uniform
        // (corner) drags scale it with the box
        return { ...item, ...box, fontSize: item.fontSize * sy };
      case 'shape':
        return { ...item, ...box };
      case 'connector': {
        // endpoints ride along so a whole-group drag looks right on the very
        // first tick; restitchConnectors then re-derives them from the bubbles,
        // which is what they actually mean (see ConnectorElement)
        const [nax, nay] = mapPoint(item.ax, item.ay, from, to);
        const [nbx, nby] = mapPoint(item.bx, item.by, from, to);
        return { ...item, ...box, rotation: 0, ax: nax, ay: nay, bx: nbx, by: nby };
      }
      case 'bubble':
        // A bubble's outline, membership tests and move set all read its plain
        // box, so rotation is pinned at 0 here rather than supported — this is
        // the one chokepoint every resize/drag passes through, so there is
        // nowhere else a rotated bubble could come from. (selectionView also
        // hides the rotate grip, so it normally never even gets asked.)
        return { ...item, ...box, rotation: 0 };
      case 'image':
      case 'tape':
        return { ...item, ...box };
    }
  });
}

/** Moves items by a page-space delta without touching scale or rotation. */
export function translateItems(items: PageItem[], dx: number, dy: number): PageItem[] {
  return items.map((item): PageItem => {
    if (isStroke(item)) return { ...item, points: item.points.map((p) => [p[0] + dx, p[1] + dy, p[2]]) };
    // a connector's cached endpoints are part of its geometry, so they move too
    if (item.kind === 'connector') {
      return {
        ...item,
        x: item.x + dx,
        y: item.y + dy,
        ax: item.ax + dx,
        ay: item.ay + dy,
        bx: item.bx + dx,
        by: item.by + dy,
      };
    }
    return { ...item, x: item.x + dx, y: item.y + dy };
  });
}
