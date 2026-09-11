import { getStroke } from 'perfect-freehand';
import type { Paper, PaperColor } from '../types';

export interface Drawable {
  tool: 'pen' | 'highlighter';
  color: string;
  size: number;
  points: number[][];
}

const PEN_OPTS = { thinning: 0.62, smoothing: 0.55, streamline: 0.45, simulatePressure: false };
const HI_OPTS = { thinning: 0, smoothing: 0.5, streamline: 0.5, simulatePressure: false };

/** Sentinel stroke colour, stored instead of a hex value; resolved at render time. */
export const AUTO_COLOR = 'auto';

/** Auto ink: dark on light paper, light on dark paper — always readable. */
const AUTO_INK: Record<PaperColor, string> = {
  white: '#1f2530',
  cream: '#1f2530',
  dark: '#f5f4ef',
};

/** Used when a paper colour isn't in `AUTO_INK` (e.g. an unknown value from a hand-edited backup). */
const AUTO_INK_FALLBACK = AUTO_INK.white;

/** Resolves a stored stroke colour (a hex value, or the `AUTO_COLOR` token) against a page's paper. */
export function resolveInkColor(color: string, paper: Paper): string {
  if (color !== AUTO_COLOR) return color;
  return AUTO_INK[paper.color] ?? AUTO_INK_FALLBACK;
}

/** The filled outline polygon perfect-freehand produces for a stroke (used by the canvas and the PDF export). */
export function strokeOutline(points: number[][], size: number, highlighter: boolean): number[][] {
  return getStroke(points, {
    size,
    last: true,
    ...(highlighter ? HI_OPTS : PEN_OPTS),
  });
}

/** Alpha the highlighter paints with; the PDF export uses the same value. */
export const HIGHLIGHTER_ALPHA = 0.3;

function outlinePath(points: number[][], size: number, highlighter: boolean): Path2D {
  const outline = strokeOutline(points, size, highlighter);
  const path = new Path2D();
  if (outline.length < 2) return path;
  path.moveTo(outline[0][0], outline[0][1]);
  for (let i = 1; i < outline.length; i++) path.lineTo(outline[i][0], outline[i][1]);
  path.closePath();
  return path;
}

/**
 * Renders one stroke with perfect-freehand at the context's current transform.
 * `paper` resolves an `AUTO_COLOR` token to a concrete colour; every call site
 * that paints a stroke (live, committed cache, thumbnail) must pass it so auto
 * ink is always resolved the same way. `opacity` (0–1) additionally dims the
 * stroke, used for the eraser's pending-delete preview.
 */
export function drawStroke(ctx: CanvasRenderingContext2D, s: Drawable, paper: Paper, opacity = 1): void {
  if (s.points.length === 0) return;
  const highlighter = s.tool === 'highlighter';
  const path = outlinePath(s.points, s.size, highlighter);
  ctx.save();
  ctx.fillStyle = resolveInkColor(s.color, paper);
  ctx.globalAlpha = (highlighter ? HIGHLIGHTER_ALPHA : 1) * opacity;
  ctx.fill(path);
  ctx.restore();
}
