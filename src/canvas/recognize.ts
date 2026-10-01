import type { ShapeKind } from '../types';

/** Geometry of a shape fitted to a hand-drawn stroke (page units). */
export interface ShapeFit {
  shape: ShapeKind;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  /** polygon vertices as fractions of the box (triangle) */
  pts?: number[][];
}

/** Box height given to a line so it stays tappable; the line itself is drawn on the centre-line. */
export const LINE_BOX_H = 14;

const dist = (a: number[], b: number[]): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

function pathLength(pts: number[][]): number {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += dist(pts[i - 1], pts[i]);
  return l;
}

/** Largest distance of any point from the chord between the first and last points. */
function chordDeviation(pts: number[][]): number {
  const a = pts[0];
  const b = pts[pts.length - 1];
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return Infinity;
  let max = 0;
  for (const p of pts) {
    const d = Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / len;
    if (d > max) max = d;
  }
  return max;
}

/** Minimum total stroke length (screen px, counter-scaled for zoom) recognizeLine will even consider. */
const MIN_TOTAL_LEN = 30;
/** Minimum chord length (screen px, counter-scaled for zoom) for a shaft to count as a straight candidate. */
const MIN_CHORD = 20;
/** Deviation floor (screen px, counter-scaled for zoom) under the bow tolerance, for short lines. */
const MIN_DEVIATION_FLOOR = 5;
/**
 * How far a stroke may bow off its own chord and still count as straight, as a
 * fraction of that chord. Read as an arc: a circular arc's sagitta/chord ratio
 * is ~0.05 at 23° of sweep, ~0.09 at 41°, 0.21 at a quarter circle and 0.5 at a
 * semicircle — so this admits a distinctly hand-drawn, slightly bowed line while
 * staying far below anything a user would read as a curve. Turn it down if arcs
 * start snapping, up if deliberate lines keep failing to.
 */
const MAX_BOW = 0.09;

/**
 * `zoom` converts the screen-px constants above into the page-space units
 * `pts` are measured in, so the same *visually* straight/long line snaps the
 * same way regardless of what zoom level it was drawn at — a short-looking
 * line drawn while zoomed in shouldn't be held to the same page-unit chord
 * length as one drawn zoomed out. MAX_BOW and the 8% tail ratio are already
 * scale-invariant and don't need this.
 */
function isStraight(pts: number[][], zoom: number): boolean {
  if (pts.length < 2) return false;
  const chord = dist(pts[0], pts[pts.length - 1]);
  return chord >= MIN_CHORD / zoom && chordDeviation(pts) <= Math.max(MAX_BOW * chord, MIN_DEVIATION_FLOOR / zoom);
}

/** The line (or arrow) element box between two endpoints, `nib` being the stroke width. */
export function lineFit(shape: 'line' | 'arrow', a: number[], b: number[], nib: number): ShapeFit {
  const len = dist(a, b);
  const h = Math.max(nib * 2, LINE_BOX_H);
  const cx = (a[0] + b[0]) / 2;
  const cy = (a[1] + b[1]) / 2;
  return { shape, x: cx - len / 2, y: cy - h / 2, w: len, h, rotation: Math.atan2(b[1] - a[1], b[0] - a[0]) };
}

/** Both endpoints of a line/arrow box, in page units — the inverse of lineFit. */
export function lineEnds(fit: ShapeFit): [number[], number[]] {
  const cx = fit.x + fit.w / 2;
  const cy = fit.y + fit.h / 2;
  const dx = (Math.cos(fit.rotation) * fit.w) / 2;
  const dy = (Math.sin(fit.rotation) * fit.w) / 2;
  return [
    [cx - dx, cy - dy],
    [cx + dx, cy + dy],
  ];
}

/** Geometry of a mind-map bubble fitted to a hand-drawn loop (board units). */
export interface LoopFit {
  outline: 'ellipse' | 'roundrect';
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Minimum total stroke length (screen px, counter-scaled for zoom) a loop must have. */
const MIN_LOOP_LEN = 90;
/** Minimum extent (screen px, counter-scaled) on the shorter axis — smaller than this is a scribble, not a loop around something. */
const MIN_LOOP_SIZE = 24;
/** How far the end may sit from the start and still count as closed: this many screen px (counter-scaled), or this fraction of the path, whichever is more forgiving. */
const LOOP_CLOSE_PX = 36;
const LOOP_CLOSE_RATIO = 0.16;
/**
 * How much of its own bounding box the loop must actually enclose, as
 * |signed area| / box area. A circle inscribed in its box encloses π/4 ≈ 0.79
 * and a rectangle 1.0, while ordinary writing, a zigzag or a there-and-back
 * squiggle encloses almost nothing — so this is what separates "drew a ring
 * around something" from "was still writing". Turn it down if deliberate loops
 * fail to snap, up if writing starts snapping.
 */
const MIN_LOOP_FILL = 0.5;
/**
 * Above this fill ratio the loop reads as a box rather than an ellipse — an
 * ellipse can't exceed π/4 ≈ 0.785 however neatly it's drawn, so the midpoint
 * between that and 1.0 is a natural split.
 */
const ROUNDRECT_FILL = 0.88;

/** Twice the enclosed area of the implicitly-closed polygon (shoelace), signed. */
function shoelace2(pts: number[][]): number {
  let sum = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    sum += (pts[j][0] - pts[i][0]) * (pts[j][1] + pts[i][1]);
  }
  return sum;
}

/**
 * Fits a mind-map bubble to a stroke that loops back on itself — or returns
 * null when it doesn't look like one (a line, a corner, ordinary writing, a
 * there-and-back squiggle). The test is: long enough, big enough, ends near
 * where it started, and genuinely *encloses* most of its own bounding box;
 * then how completely it fills that box decides ellipse vs rounded rectangle.
 *
 * `nib` is the stroke width (the fitted box is padded by it, so content sitting
 * right against the drawn loop ends up inside the clean outline rather than
 * straddling it) and `zoom` converts the screen-px constants above into the
 * board units `pts` are measured in — the same reasoning as `isStraight`'s,
 * so a loop that looks the same size snaps the same way at any zoom.
 */
export function recognizeLoop(pts: number[][], nib: number, zoom: number): LoopFit | null {
  if (pts.length < 12) return null;
  const total = pathLength(pts);
  if (total < MIN_LOOP_LEN / zoom) return null;

  const gap = dist(pts[0], pts[pts.length - 1]);
  if (gap > Math.max(LOOP_CLOSE_PX / zoom, LOOP_CLOSE_RATIO * total)) return null;

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
  const bw = x1 - x0;
  const bh = y1 - y0;
  const min = MIN_LOOP_SIZE / zoom;
  if (bw < min || bh < min) return null;

  const fill = Math.abs(shoelace2(pts) / 2) / (bw * bh);
  if (fill < MIN_LOOP_FILL) return null;

  const pad = nib / 2 + 2 / zoom;
  return {
    outline: fill >= ROUNDRECT_FILL ? 'roundrect' : 'ellipse',
    x: x0 - pad,
    y: y0 - pad,
    w: bw + pad * 2,
    h: bh + pad * 2,
  };
}

/**
 * Fits a straight line to a stroke — the farthest point from the start is the
 * tip, and the run up to it must be nearly straight — or returns null when the
 * stroke doesn't look like one (a curve, a corner, a loop, ordinary writing).
 * Anything drawn past the tip (a wobble at the end) is ignored as long as it
 * is short. `nib` is the stroke width, used for tolerances and the box height.
 * `zoom` is the view zoom the stroke was drawn at — see isStraight's comment.
 */
export function recognizeLine(pts: number[][], nib: number, zoom: number): ShapeFit | null {
  if (pts.length < 6) return null;
  const total = pathLength(pts);
  if (total < MIN_TOTAL_LEN / zoom) return null;
  const start = pts[0];
  let tipIndex = 0;
  let tipDist = 0;
  for (let i = 0; i < pts.length; i++) {
    const d = dist(start, pts[i]);
    if (d > tipDist) {
      tipDist = d;
      tipIndex = i;
    }
  }
  const tip = pts[tipIndex];
  const shaft = pts.slice(0, tipIndex + 1);
  const tail = pts.slice(tipIndex);
  if (!isStraight(shaft, zoom)) return null;
  if (pathLength(tail) > Math.max(0.08 * pathLength(shaft), nib)) return null;
  return lineFit('line', start, tip, nib);
}
