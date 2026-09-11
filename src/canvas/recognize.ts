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

function isStraight(pts: number[][]): boolean {
  if (pts.length < 2) return false;
  const chord = dist(pts[0], pts[pts.length - 1]);
  return chord >= 20 && chordDeviation(pts) <= Math.max(0.05 * chord, 5);
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
 */
export function recognizeLine(pts: number[][], nib: number): ShapeFit | null {
  if (pts.length < 6) return null;
  const total = pathLength(pts);
  if (total < 30) return null;
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
  if (!isStraight(shaft)) return null;
  if (pathLength(tail) > Math.max(0.08 * pathLength(shaft), nib)) return null;
  return lineFit('line', start, tip, nib);
}
