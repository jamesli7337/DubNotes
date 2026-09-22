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
