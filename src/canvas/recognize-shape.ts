import { recognizeLine, type ShapeFit } from './recognize';

/**
 * Pen hold-to-snap for pages: a line first (recognizeLine, unchanged), then a
 * closed shape. Geometry only — no store, no canvas. Every screen-px constant
 * below is divided by `zoom` before use, the same way isStraight's are, so a
 * shape that looks the same size snaps the same way at any zoom.
 */
export function recognizeShape(pts: number[][], nib: number, zoom: number): ShapeFit | null {
  return recognizeLine(pts, nib, zoom) ?? recognizeClosed(pts, zoom);
}

const DEG = Math.PI / 180;

/** Fewest samples a closed stroke may have. */
const MIN_POINTS = 12;
/** Shortest path (screen px) worth considering as a closed shape. */
const MIN_LEN = 80;
/** Smallest bounding-box side (screen px). */
const MIN_SIZE = 24;
/** The end may sit this far from the start, as a fraction of the path, and still count as closed. */
const MAX_GAP = 0.15;
/** Douglas-Peucker tolerance as a fraction of the path length, with a floor in screen px. */
const DP_EPS = 0.03;
const DP_EPS_FLOOR = 4;
/** A vertex turning the path less than this is not a corner. */
const MIN_TURN = 28 * DEG;
/**
 * How far a side may bow off its own chord, as a fraction of the chord, and
 * still be a straight side. A circle's quarter arc bows 0.21 (see MAX_BOW in
 * recognize.ts), so a circle can never pass for a four-cornered shape.
 */
const EDGE_BOW = 0.12;
const EDGE_BOW_FLOOR = 4;
/** A triangle corner this close to 90° is snapped to exactly 90°. */
const RIGHT_SNAP = 12 * DEG;
/** Every corner of a rectangle must be this close to 90°. */
const RECT_RIGHT_TOL = 18 * DEG;
/** A rectangle / ellipse within this of the axes is snapped to them. */
const AXIS_SNAP = 10 * DEG;
/** Narrowest interior angle a triangle may have. */
const MIN_TRI_ANGLE = 20 * DEG;
/** An ellipse whose axes are within this fraction of each other is a circle. */
const CIRCLE_ASPECT = 0.1;
/** RMS deviation of the stroke's normalised radius from 1 that still reads as an ellipse. A square scores ~0.11. */
const ELLIPSE_RESIDUAL = 0.06;
/** Minor / major axis below which it is a squashed there-and-back, not an ellipse. */
const ELLIPSE_MIN_ASPECT = 0.15;
/** Enclosed area as a fraction of the fitted ellipse's — separates a ring from a figure-8 or scribble. */
const ELLIPSE_MIN_FILL = 0.75;
const RESAMPLE_N = 64;

const dist = (a: number[], b: number[]): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

function distToChord(p: number[], a: number[], b: number[]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return dist(p, a);
  return Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / len;
}

/** Douglas-Peucker over ring[i0..i1], adding the indices of the points it keeps. */
function simplify(ring: number[][], i0: number, i1: number, eps: number, keep: Set<number>): void {
  const stack: number[][] = [[i0, i1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let worst = -1;
    let worstD = 0;
    for (let i = a + 1; i < b; i++) {
      const d = distToChord(ring[i], ring[a], ring[b]);
      if (d > worstD) {
        worstD = d;
        worst = i;
      }
    }
    if (worst >= 0 && worstD > eps) {
      keep.add(worst);
      stack.push([a, worst], [worst, b]);
    }
  }
}

/** How much the path turns at `cur`, 0..π. */
function turnAt(prev: number[], cur: number[], next: number[]): number {
  const a1 = Math.atan2(cur[1] - prev[1], cur[0] - prev[0]);
  const a2 = Math.atan2(next[1] - cur[1], next[0] - cur[0]);
  let d = Math.abs(a2 - a1);
  if (d > Math.PI) d = Math.PI * 2 - d;
  return d;
}

/** Interior angle at `cur` between its two neighbours, 0..π. */
function interiorAngle(prev: number[], cur: number[], next: number[]): number {
  const ax = prev[0] - cur[0];
  const ay = prev[1] - cur[1];
  const bx = next[0] - cur[0];
  const by = next[1] - cur[1];
  const m = Math.hypot(ax, ay) * Math.hypot(bx, by);
  if (m < 1e-9) return 0;
  return Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by) / m)));
}

function shoelace2(pts: number[][]): number {
  let sum = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    sum += (pts[j][0] - pts[i][0]) * (pts[j][1] + pts[i][1]);
  }
  return sum;
}

/** `n` points evenly spaced by arc length along a polyline (the closing point included in `ring`). */
function resample(ring: number[][], total: number, n: number): number[][] {
  const out: number[][] = [];
  const step = total / n;
  let seg = 1;
  let segStart = 0;
  let segLen = dist(ring[0], ring[1]);
  for (let k = 0; k < n; k++) {
    const target = k * step;
    while (seg < ring.length - 1 && segStart + segLen < target) {
      segStart += segLen;
      seg++;
      segLen = dist(ring[seg - 1], ring[seg]);
    }
    const t = segLen > 1e-9 ? Math.min(1, Math.max(0, (target - segStart) / segLen)) : 0;
    const a = ring[seg - 1];
    const b = ring[seg];
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}

/**
 * Fits a triangle, rectangle or ellipse to a stroke that loops back to where it
 * began, or returns null (writing, a scribble, a stroke that is merely curved).
 * Corners come from Douglas-Peucker on the closed path; sides must be straight
 * for a polygon, which is also what keeps a circle (four vertices, bowed sides)
 * from being read as a square. No corners at all falls to the ellipse fit.
 */
function recognizeClosed(pts: number[][], zoom: number): ShapeFit | null {
  const n = pts.length;
  if (n < MIN_POINTS) return null;
  const ring = pts.concat([pts[0]]); // ring[n] is the start again, closing the path
  let total = 0;
  for (let i = 1; i < ring.length; i++) total += dist(ring[i - 1], ring[i]);
  if (total < MIN_LEN / zoom) return null;
  if (dist(pts[0], pts[n - 1]) > MAX_GAP * total) return null;

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
  const min = MIN_SIZE / zoom;
  if (x1 - x0 < min || y1 - y0 < min) return null;

  const corners = findCorners(ring, total, zoom);
  if (corners) {
    const poly = corners.length === 3 ? fitTriangle(ring, corners, zoom) : corners.length === 4 ? fitRect(ring, corners) : null;
    if (poly) return poly;
  }
  return fitEllipse(ring, total);
}

/**
 * Indices into `ring` of the stroke's corners, or null unless every side
 * between them is straight. A vertex that barely turns the path is dropped, the
 * flattest first.
 */
function findCorners(ring: number[][], total: number, zoom: number): number[] | null {
  const last = ring.length - 1;
  let far = 0;
  let farD = 0;
  for (let i = 1; i < last; i++) {
    const d = dist(ring[0], ring[i]);
    if (d > farD) {
      farD = d;
      far = i;
    }
  }
  if (far === 0) return null;
  const eps = Math.max(DP_EPS * total, DP_EPS_FLOOR / zoom);
  const keep = new Set<number>([0, far, last]);
  simplify(ring, 0, far, eps, keep);
  simplify(ring, far, last, eps, keep);
  const idx = [...keep].sort((a, b) => a - b);
  idx.pop(); // the closing duplicate of index 0

  for (;;) {
    if (idx.length < 3) return null;
    let flat = -1;
    let flatTurn = MIN_TURN;
    for (let k = 0; k < idx.length; k++) {
      const t = turnAt(ring[idx[(k + idx.length - 1) % idx.length]], ring[idx[k]], ring[idx[(k + 1) % idx.length]]);
      if (t < flatTurn) {
        flatTurn = t;
        flat = k;
      }
    }
    if (flat < 0) break;
    idx.splice(flat, 1);
  }
  if (idx.length !== 3 && idx.length !== 4) return null;

  for (let k = 0; k < idx.length; k++) {
    const a = idx[k];
    const b = k + 1 < idx.length ? idx[k + 1] : last;
    const chord = dist(ring[a], ring[b]);
    const tol = Math.max(EDGE_BOW * chord, EDGE_BOW_FLOOR / zoom);
    for (let i = a + 1; i < b; i++) if (distToChord(ring[i], ring[a], ring[b]) > tol) return null;
  }
  return idx;
}

function fitTriangle(ring: number[][], idx: number[], zoom: number): ShapeFit | null {
  const v = idx.map((i) => [ring[i][0], ring[i][1]]);
  const ang = v.map((p, k) => interiorAngle(v[(k + 2) % 3], p, v[(k + 1) % 3]));
  if (Math.min(...ang) < MIN_TRI_ANGLE) return null;

  // one corner close enough to square becomes exactly square: its first leg stays, the second is turned perpendicular
  let right = -1;
  let rightOff = RIGHT_SNAP;
  ang.forEach((a, k) => {
    const off = Math.abs(a - Math.PI / 2);
    if (off <= rightOff) {
      rightOff = off;
      right = k;
    }
  });
  if (right >= 0) {
    const c = v[right];
    const a = v[(right + 2) % 3];
    const bi = (right + 1) % 3;
    const b = v[bi];
    const ul = dist(a, c);
    const ux = (a[0] - c[0]) / ul;
    const uy = (a[1] - c[1]) / ul;
    const nx = -uy;
    const ny = ux;
    const side = (b[0] - c[0]) * nx + (b[1] - c[1]) * ny >= 0 ? 1 : -1;
    const len = dist(b, c);
    v[bi] = [c[0] + nx * side * len, c[1] + ny * side * len];
  }

  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of v) {
    if (p[0] < x0) x0 = p[0];
    if (p[0] > x1) x1 = p[0];
    if (p[1] < y0) y0 = p[1];
    if (p[1] > y1) y1 = p[1];
  }
  const w = x1 - x0;
  const h = y1 - y0;
  const min = MIN_SIZE / zoom;
  if (w < min || h < min) return null;
  return { shape: 'triangle', x: x0, y: y0, w, h, rotation: 0, pts: v.map((p) => [(p[0] - x0) / w, (p[1] - y0) / h]) };
}

function fitRect(ring: number[][], idx: number[]): ShapeFit | null {
  const v = idx.map((i) => ring[i]);
  let sin4 = 0;
  let cos4 = 0;
  for (let k = 0; k < 4; k++) {
    const a = v[(k + 3) % 4];
    const c = v[k];
    const b = v[(k + 1) % 4];
    if (Math.abs(interiorAngle(a, c, b) - Math.PI / 2) > RECT_RIGHT_TOL) return null;
    const dir = Math.atan2(b[1] - c[1], b[0] - c[0]);
    sin4 += Math.sin(4 * dir);
    cos4 += Math.cos(4 * dir);
  }
  // the sides' common direction, folded to ±45°: averaging 4×angle makes the four sides agree
  let rot = Math.atan2(sin4, cos4) / 4;
  if (Math.abs(rot) < AXIS_SNAP) rot = 0;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  let u0 = Infinity;
  let v0 = Infinity;
  let u1 = -Infinity;
  let v1 = -Infinity;
  for (const p of v) {
    const u = p[0] * cos + p[1] * sin;
    const w = -p[0] * sin + p[1] * cos;
    if (u < u0) u0 = u;
    if (u > u1) u1 = u;
    if (w < v0) v0 = w;
    if (w > v1) v1 = w;
  }
  const w = u1 - u0;
  const h = v1 - v0;
  if (w <= 0 || h <= 0) return null;
  const cu = (u0 + u1) / 2;
  const cv = (v0 + v1) / 2;
  const cx = cu * cos - cv * sin;
  const cy = cu * sin + cv * cos;
  return { shape: 'rect', x: cx - w / 2, y: cy - h / 2, w, h, rotation: rot };
}

function fitEllipse(ring: number[][], total: number): ShapeFit | null {
  const s = resample(ring, total, RESAMPLE_N);
  let mx = 0;
  let my = 0;
  for (const p of s) {
    mx += p[0];
    my += p[1];
  }
  mx /= s.length;
  my /= s.length;
  let cxx = 0;
  let cyy = 0;
  let cxy = 0;
  for (const p of s) {
    const dx = p[0] - mx;
    const dy = p[1] - my;
    cxx += dx * dx;
    cyy += dy * dy;
    cxy += dx * dy;
  }
  cxx /= s.length;
  cyy /= s.length;
  cxy /= s.length;
  // principal axes; an ellipse's variance along an axis is half its squared semi-axis
  let theta = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
  const mean = (cxx + cyy) / 2;
  const diff = Math.hypot((cxx - cyy) / 2, cxy);
  let a = Math.sqrt(2 * (mean + diff));
  let b = Math.sqrt(2 * Math.max(0, mean - diff));
  if (a < 1e-6 || b < ELLIPSE_MIN_ASPECT * a) return null;

  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const rho = s.map((p) => {
    const u = (p[0] - mx) * cos + (p[1] - my) * sin;
    const v = -(p[0] - mx) * sin + (p[1] - my) * cos;
    return Math.hypot(u / a, v / b);
  });
  const avg = rho.reduce((t, r) => t + r, 0) / rho.length;
  let sq = 0;
  for (const r of rho) sq += (r - 1) * (r - 1);
  if (Math.sqrt(sq / rho.length) > ELLIPSE_RESIDUAL) return null;
  a *= avg; // pass through the stroke's mean radius rather than the variance estimate
  b *= avg;
  if (Math.abs(shoelace2(s) / 2) < ELLIPSE_MIN_FILL * Math.PI * a * b) return null;

  if (Math.abs(a - b) / Math.max(a, b) < CIRCLE_ASPECT) {
    const r = (a + b) / 2;
    return { shape: 'ellipse', x: mx - r, y: my - r, w: r * 2, h: r * 2, rotation: 0 };
  }
  // fold the major axis to (-90°, 90°], then snap to the axes if close
  if (theta > Math.PI / 2) theta -= Math.PI;
  if (Math.abs(theta) < AXIS_SNAP) theta = 0;
  else if (Math.abs(Math.abs(theta) - Math.PI / 2) < AXIS_SNAP) {
    theta = 0;
    [a, b] = [b, a];
  }
  return { shape: 'ellipse', x: mx - a, y: my - b, w: a * 2, h: b * 2, rotation: theta };
}
