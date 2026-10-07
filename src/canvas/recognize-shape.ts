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

// ------------------------------------------------------------ tuning constants
// Floors: what keeps small handwriting from snapping. Screen px, divided by zoom.
/** Fewest samples a closed stroke may have. */
const MIN_POINTS = 12;
/** Shortest path (screen px) worth considering as a closed shape. */
const MIN_LEN = 80;
/** Smallest bounding-box side (screen px). */
const MIN_SIZE = 24;

// Acceptance: every candidate is fitted and scored; the best one wins if it is good enough.
/** The end may sit this far from the start, as a fraction of the path, and still count as closed. */
const MAX_GAP = 0.25;
/** Highest mean point-to-outline distance, as a fraction of sqrt(bbox area), the winning candidate may have. Raise to snap more. */
const ACCEPT_ERROR = 0.08;
/** The stroke must enclose at least this fraction of the candidate's area — rejects there-and-back squiggles and figure-8s. */
const ENCLOSED_MIN = 0.6;
/** Points the stroke is resampled to (by arc length) for fitting and scoring. */
const RESAMPLE_N = 64;

// Rectangle
/** Coarse step of the orientation search over ±45° (a rectangle repeats every 90°). */
const RECT_ANGLE_STEP = 5 * DEG;
/** Fine step of the search around the best coarse angle. */
const RECT_REFINE_STEP = 1 * DEG;
/** A rectangle / ellipse rotated less than this is snapped to the axes. */
const AXIS_SNAP = 15 * DEG;

// Ellipse
/** Minor / major axis below which it is a squashed there-and-back, not an ellipse. */
const ELLIPSE_MIN_ASPECT = 0.15;
/** An ellipse whose axes are within this fraction of each other is a circle. */
const CIRCLE_ASPECT = 0.1;

// Triangle
/** Narrowest interior angle a triangle may have. */
const MIN_TRI_ANGLE = 15 * DEG;
/** A triangle corner this close to 90° is snapped to exactly 90°. */
const RIGHT_SNAP = 18 * DEG;
/** Douglas-Peucker is loosened until at most this many corner candidates remain, then the best three are chosen. */
const TRI_MAX_CANDIDATES = 8;
/** Starting Douglas-Peucker tolerance as a fraction of the path length, and the factor it grows by each pass. */
const TRI_START_EPS = 0.01;
const TRI_EPS_GROWTH = 1.5;

// Handles
/** Smallest side (page units) a corner drag will shrink a box to. */
const HANDLE_MIN_SIDE = 8;

const dist = (a: number[], b: number[]): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

function distToChord(p: number[], a: number[], b: number[]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return dist(p, a);
  return Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / len;
}

/** Distance from `p` to the segment a–b. */
function distToSegment(p: number[], a: number[], b: number[]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-9) return dist(p, a);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
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

/** Twice the enclosed area of the implicitly-closed polygon (shoelace), signed. */
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

// ------------------------------------------------------------------ scoring
/** A function giving a point's distance to the outline of `fit`. */
function outlineDistance(fit: ShapeFit): (p: number[]) => number {
  if (fit.shape === 'triangle') {
    const v = shapeHandles(fit);
    return (p) => Math.min(distToSegment(p, v[0], v[1]), distToSegment(p, v[1], v[2]), distToSegment(p, v[2], v[0]));
  }
  const cx = fit.x + fit.w / 2;
  const cy = fit.y + fit.h / 2;
  const hw = fit.w / 2;
  const hh = fit.h / 2;
  const cos = Math.cos(fit.rotation);
  const sin = Math.sin(fit.rotation);
  if (fit.shape === 'rect') {
    return (p) => {
      const dx = p[0] - cx;
      const dy = p[1] - cy;
      const du = hw - Math.abs(dx * cos + dy * sin); // how far inside each side, negative when outside
      const dv = hh - Math.abs(-dx * sin + dy * cos);
      return du >= 0 && dv >= 0 ? Math.min(du, dv) : Math.hypot(Math.max(-du, 0), Math.max(-dv, 0));
    };
  }
  return (p) => {
    const dx = p[0] - cx;
    const dy = p[1] - cy;
    const u = dx * cos + dy * sin;
    const v = -dx * sin + dy * cos;
    const r = Math.hypot(u, v);
    if (r < 1e-9) return Math.min(hw, hh);
    const rho = Math.hypot(u / hw, v / hh);
    return r * Math.abs(1 - 1 / rho); // along the ray from the centre
  };
}

/** Mean distance of the sample points from the fit's outline. */
function meanError(fit: ShapeFit, s: number[][]): number {
  if (fit.w < 1e-6 || fit.h < 1e-6) return Infinity;
  const d = outlineDistance(fit);
  let t = 0;
  for (const p of s) t += d(p);
  return t / s.length;
}

/** The area a fit encloses. */
function fitArea(fit: ShapeFit): number {
  if (fit.shape === 'rect') return fit.w * fit.h;
  if (fit.shape === 'ellipse') return (Math.PI * fit.w * fit.h) / 4;
  return Math.abs(shoelace2(shapeHandles(fit))) / 2;
}

/**
 * Fits a rectangle, ellipse and triangle to a stroke that loops back to near
 * where it began, scores each by how far the stroke strays from that outline,
 * and returns the best if it is good enough — or null (writing, a scribble, a
 * there-and-back). Rounded corners and wobbly sides only raise a candidate's
 * score a little, so they no longer disqualify it.
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

  const s = resample(ring, total, RESAMPLE_N);
  const size = Math.sqrt((x1 - x0) * (y1 - y0));
  const enclosed = Math.abs(shoelace2(s)) / 2;

  let best: ShapeFit | null = null;
  let bestErr = Infinity;
  for (const fit of [fitRect(s), fitEllipse(s), fitTriangle(ring, total, s, zoom)]) {
    if (!fit || enclosed < ENCLOSED_MIN * fitArea(fit)) continue;
    const err = meanError(fit, s) / size;
    if (err < bestErr) {
      bestErr = err;
      best = fit;
    }
  }
  return best && bestErr <= ACCEPT_ERROR ? best : null;
}

// --------------------------------------------------------------- candidates
/** The tightest box around `s` at orientation `rot`. */
function boxAt(s: number[][], rot: number): ShapeFit {
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  let u0 = Infinity;
  let v0 = Infinity;
  let u1 = -Infinity;
  let v1 = -Infinity;
  for (const p of s) {
    const u = p[0] * cos + p[1] * sin;
    const v = -p[0] * sin + p[1] * cos;
    if (u < u0) u0 = u;
    if (u > u1) u1 = u;
    if (v < v0) v0 = v;
    if (v > v1) v1 = v;
  }
  const w = u1 - u0;
  const h = v1 - v0;
  const cu = (u0 + u1) / 2;
  const cv = (v0 + v1) / 2;
  const cx = cu * cos - cv * sin;
  const cy = cu * sin + cv * cos;
  return { shape: 'rect', x: cx - w / 2, y: cy - h / 2, w, h, rotation: rot };
}

/** The oriented bounding rectangle that sits closest to the stroke, found by searching orientations. */
function fitRect(s: number[][]): ShapeFit | null {
  let bestRot = 0;
  let bestErr = Infinity;
  const tryRot = (rot: number): void => {
    const err = meanError(boxAt(s, rot), s);
    if (err < bestErr) {
      bestErr = err;
      bestRot = rot;
    }
  };
  for (let r = -Math.PI / 4; r < Math.PI / 4; r += RECT_ANGLE_STEP) tryRot(r);
  const coarse = bestRot;
  for (let r = coarse - RECT_ANGLE_STEP; r <= coarse + RECT_ANGLE_STEP; r += RECT_REFINE_STEP) tryRot(r);
  if (!Number.isFinite(bestErr)) return null;
  return boxAt(s, Math.abs(bestRot) < AXIS_SNAP ? 0 : bestRot);
}

/** The ellipse with the stroke's own principal axes, scaled through its mean radius. */
function fitEllipse(s: number[][]): ShapeFit | null {
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
  let avg = 0;
  for (const p of s) {
    const u = (p[0] - mx) * cos + (p[1] - my) * sin;
    const v = -(p[0] - mx) * sin + (p[1] - my) * cos;
    avg += Math.hypot(u / a, v / b);
  }
  avg /= s.length;
  a *= avg; // pass through the stroke's mean radius rather than the variance estimate
  b *= avg;

  if (Math.abs(a - b) / Math.max(a, b) < CIRCLE_ASPECT) {
    const r = (a + b) / 2;
    return { shape: 'ellipse', x: mx - r, y: my - r, w: r * 2, h: r * 2, rotation: 0 };
  }
  if (Math.abs(theta) < AXIS_SNAP) theta = 0;
  else if (Math.abs(Math.abs(theta) - Math.PI / 2) < AXIS_SNAP) {
    theta = 0;
    [a, b] = [b, a];
  }
  return { shape: 'ellipse', x: mx - a, y: my - b, w: a * 2, h: b * 2, rotation: theta };
}

/** A triangle fit from its three vertices: the box around them and each vertex as a fraction of it. */
function triangleFit(v: number[][]): ShapeFit {
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
  const w = Math.max(x1 - x0, 1);
  const h = Math.max(y1 - y0, 1);
  return { shape: 'triangle', x: x0, y: y0, w, h, rotation: 0, pts: v.map((p) => [(p[0] - x0) / w, (p[1] - y0) / h]) };
}

/**
 * Indices into `ring` of the stroke's corner candidates: Douglas-Peucker on the
 * closed path, its tolerance loosened until no more than TRI_MAX_CANDIDATES
 * remain, so a wobbly or rounded corner leaves a few candidates, not dozens.
 */
function cornerCandidates(ring: number[][], total: number): number[] {
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
  if (far === 0) return [];
  let eps = TRI_START_EPS * total;
  for (let pass = 0; pass < 16; pass++) {
    const keep = new Set<number>([0, far, last]);
    simplify(ring, 0, far, eps, keep);
    simplify(ring, far, last, eps, keep);
    const idx = [...keep].sort((a, b) => a - b);
    idx.pop(); // the closing duplicate of index 0
    if (idx.length <= TRI_MAX_CANDIDATES) return idx;
    eps *= TRI_EPS_GROWTH;
  }
  return [];
}

/** `v` with the corner nearest square, if within RIGHT_SNAP of 90°, made exactly square (its first leg stays, the second is turned perpendicular), then axis-aligned if within AXIS_SNAP. */
function snapRight(v: number[][]): number[][] {
  const ang = v.map((p, k) => interiorAngle(v[(k + 2) % 3], p, v[(k + 1) % 3]));
  let right = -1;
  let rightOff = RIGHT_SNAP;
  ang.forEach((a, k) => {
    const off = Math.abs(a - Math.PI / 2);
    if (off <= rightOff) {
      rightOff = off;
      right = k;
    }
  });
  if (right < 0) return v;
  const c = v[right];
  const a = v[(right + 2) % 3];
  const bi = (right + 1) % 3;
  const b = v[bi];
  const ul = dist(a, c);
  if (ul < 1e-9) return v;
  const nx = -(a[1] - c[1]) / ul;
  const ny = (a[0] - c[0]) / ul;
  const side = (b[0] - c[0]) * nx + (b[1] - c[1]) * ny >= 0 ? 1 : -1;
  const len = dist(b, c);
  const out = v.map((p) => [p[0], p[1]]);
  out[bi] = [c[0] + nx * side * len, c[1] + ny * side * len];

  // like a rectangle, a right triangle whose legs are close to the axes is laid exactly on them:
  // the tilt of one leg modulo 90° (the legs may point left / right / up / down) is turned out about the right-angle corner
  const quarter = Math.PI / 2;
  const tilt = ((((Math.atan2(a[1] - c[1], a[0] - c[0]) + quarter / 2) % quarter) + quarter) % quarter) - quarter / 2;
  if (Math.abs(tilt) <= AXIS_SNAP) {
    const cos = Math.cos(-tilt);
    const sin = Math.sin(-tilt);
    return out.map((p) => [c[0] + (p[0] - c[0]) * cos - (p[1] - c[1]) * sin, c[1] + (p[0] - c[0]) * sin + (p[1] - c[1]) * cos]);
  }
  return out;
}

/** The best three of the stroke's corner candidates, by how closely their triangle follows the stroke; a corner near square is then squared. */
function fitTriangle(ring: number[][], total: number, s: number[][], zoom: number): ShapeFit | null {
  const cand = cornerCandidates(ring, total);
  if (cand.length < 3) return null;
  const min = MIN_SIZE / zoom;
  let best: number[][] | null = null;
  let bestErr = Infinity;
  for (let i = 0; i < cand.length - 2; i++) {
    for (let j = i + 1; j < cand.length - 1; j++) {
      for (let k = j + 1; k < cand.length; k++) {
        const v = [ring[cand[i]], ring[cand[j]], ring[cand[k]]];
        const smallest = Math.min(...v.map((p, q) => interiorAngle(v[(q + 2) % 3], p, v[(q + 1) % 3])));
        if (smallest < MIN_TRI_ANGLE) continue;
        const fit = triangleFit(v);
        if (fit.w < min || fit.h < min) continue;
        const err = meanError(fit, s);
        if (err < bestErr) {
          bestErr = err;
          best = v;
        }
      }
    }
  }
  return best ? triangleFit(snapRight(best)) : null;
}

// ------------------------------------------------------- pending-shape handles
/**
 * The draggable points of a snapped closed shape, in page units: a triangle's
 * three vertices, otherwise the four corners of its (rotated) box in the order
 * top-left, top-right, bottom-right, bottom-left.
 */
export function shapeHandles(fit: ShapeFit): number[][] {
  if (fit.shape === 'triangle') {
    return (fit.pts ?? [[0.5, 0], [1, 1], [0, 1]]).map(([fx, fy]) => [fit.x + fx * fit.w, fit.y + fy * fit.h]);
  }
  const cx = fit.x + fit.w / 2;
  const cy = fit.y + fit.h / 2;
  const cos = Math.cos(fit.rotation);
  const sin = Math.sin(fit.rotation);
  return [
    [-fit.w / 2, -fit.h / 2],
    [fit.w / 2, -fit.h / 2],
    [fit.w / 2, fit.h / 2],
    [-fit.w / 2, fit.h / 2],
  ].map(([lx, ly]) => [cx + lx * cos - ly * sin, cy + lx * sin + ly * cos]);
}

/**
 * The fit after dragging handle `index` to `pt`. A triangle vertex moves and the
 * box and `pts` are recomputed from the three vertices. For a box, `anchor` is
 * the opposite corner as it was when the drag began: it stays put and the box
 * is resized in its own rotated frame, so a rotated rectangle keeps its angle.
 */
export function dragShapeHandle(fit: ShapeFit, index: number, anchor: number[], pt: number[]): ShapeFit {
  if (fit.shape === 'triangle') {
    const v = shapeHandles(fit);
    v[index] = [pt[0], pt[1]];
    return { ...fit, ...triangleFit(v) };
  }
  const cos = Math.cos(fit.rotation);
  const sin = Math.sin(fit.rotation);
  const ex = pt[0] - anchor[0];
  const ey = pt[1] - anchor[1];
  let dx = ex * cos + ey * sin; // the drag, in the box's own frame
  let dy = -ex * sin + ey * cos;
  dx = (dx < 0 ? -1 : 1) * Math.max(Math.abs(dx), HANDLE_MIN_SIDE);
  dy = (dy < 0 ? -1 : 1) * Math.max(Math.abs(dy), HANDLE_MIN_SIDE);
  const px = anchor[0] + dx * cos - dy * sin;
  const py = anchor[1] + dx * sin + dy * cos;
  const w = Math.abs(dx);
  const h = Math.abs(dy);
  return { ...fit, x: (anchor[0] + px) / 2 - w / 2, y: (anchor[1] + py) / 2 - h / 2, w, h };
}
