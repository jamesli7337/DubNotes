import type { PageElement, PageItem, ShapeElement } from '../types';
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

/** Does a stroke count as inside the lasso? At least half of its points must be. */
export function strokeInPolygon(points: number[][], poly: number[][]): boolean {
  if (!points.length) return false;
  let inside = 0;
  for (const p of points) if (pointInPolygon(p[0], p[1], poly)) inside++;
  return inside * 2 >= points.length;
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

/** Does an element count as inside the lasso? True when its actual (rotated) box overlaps the lasso's drawn polygon — not just when a sampled corner or centre happens to land inside it. */
export function elementInPolygon(el: PageElement, poly: number[][]): boolean {
  return polygonsOverlap(elementCorners(el), poly);
}

/**
 * Re-maps items from one frame to another: everything inside `from` is moved,
 * scaled (per axis, in frame-local space) and rotated so it sits identically
 * inside `to`. Stroke nibs, shape outlines and text sizes scale with the box.
 */
export function transformItems(items: PageItem[], from: Frame, to: Frame): PageItem[] {
  const sx = from.w > 0 ? to.w / from.w : 1;
  const sy = from.h > 0 ? to.h / from.h : 1;
  const fcx = from.x + from.w / 2;
  const fcy = from.y + from.h / 2;
  const tcx = to.x + to.w / 2;
  const tcy = to.y + to.h / 2;
  const drot = to.rot - from.rot;
  const cos = Math.cos(to.rot);
  const sin = Math.sin(to.rot);

  const map = (x: number, y: number): [number, number] => {
    const [lx0, ly0] = rotateAround(x, y, fcx, fcy, -from.rot);
    const lx = (lx0 - fcx) * sx;
    const ly = (ly0 - fcy) * sy;
    return [tcx + lx * cos - ly * sin, tcy + lx * sin + ly * cos];
  };
  const uniform = Math.sqrt(Math.abs(sx * sy));

  return items.map((item): PageItem => {
    if (isStroke(item)) {
      return {
        ...item,
        size: item.size * uniform,
        points: item.points.map((p) => {
          const [x, y] = map(p[0], p[1]);
          return [x, y, p[2]];
        }),
      };
    }
    const [cx, cy] = elementCenter(item);
    const [ncx, ncy] = map(cx, cy);
    const w = item.w * sx;
    const h = item.h * sy;
    const box = { x: ncx - w / 2, y: ncy - h / 2, w, h, rotation: item.rotation + drot };
    switch (item.kind) {
      case 'text':
        // width-only drags re-wrap without changing the type size; uniform
        // (corner) drags scale it with the box
        return { ...item, ...box, fontSize: item.fontSize * sy };
      case 'shape':
        return { ...item, ...box, size: item.size * uniform };
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
    return { ...item, x: item.x + dx, y: item.y + dy };
  });
}
