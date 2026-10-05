import { getStrokeOutlinePoints } from 'perfect-freehand';
import type { StrokePoint } from 'perfect-freehand';
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

/** perfect-freehand's own default for a sample that carries no usable pressure. */
const DEFAULT_PRESSURE = 0.5;
/** ...and the one it gives the very first sample, which has no velocity behind it yet. */
const FIRST_PRESSURE = 0.25;

/** perfect-freehand's hard-coded "near the end of the stroke" window, in surface units. */
const END_WINDOW = 3;

/** perfect-freehand treats a missing or negative pressure as "not supplied". */
function hasPressure(p: number | undefined): boolean {
  return p != null && p >= 0;
}

/**
 * Builds the `StrokePoint` chain that `getStrokeOutlinePoints` consumes —
 * replacing perfect-freehand's own `getStrokePoints`, which has three defects
 * confined to the first few samples of a stroke. All three are in page units,
 * so they scale with the camera: ~2px for 50ms at zoom 1, but ~5px of jump and
 * ~7px of error for ~150ms at zoom 3, where they are plainly visible as the
 * start of a stroke rendering in the wrong direction and then correcting
 * itself.
 *
 * What the library does and why it is wrong here:
 *
 *  1. Given a single point it appends a synthetic `p0 + [1, 1]`, so the first
 *     frame of every press is a short sliver skewed 45 degrees down-right
 *     whatever direction the pen is actually moving. We emit one `StrokePoint`
 *     instead, which is the input `getStrokeOutlinePoints` already has a round
 *     dot for.
 *
 *  2. A minimum-length gate (`runningLength < size`) drops every interior
 *     sample until the accumulated path length reaches the nib size, so the
 *     start stays a straight chord from the press point to the current point.
 *     When the gate finally opens, an interior vertex materialises *behind*
 *     ink that has already been drawn and the start geometry rebuilds around
 *     it. We keep every sample; the outline builder already culls outline
 *     points closer than `(size * smoothing)^2`, so density at the start costs
 *     nothing. This is the only change that affects a stroke's *topology*, and
 *     only over its first `size` units.
 *
 *  3. The streamline filter — an exponential moving average, `lerp(prev, raw,
 *     t)` — starts cold at `p0`, so its first outputs sit short of where the
 *     pen has actually travelled, and the shortfall also delays the gate in
 *     (2). We initialise it the standard way, dividing by the accumulated
 *     weight `1 - (1 - t)^n`: the first admitted sample is taken raw (so ink
 *     appears exactly under the pen on the first frame of a press), and the
 *     correction decays to 1 within a handful of samples, leaving the rest of
 *     the stroke smoothed exactly as before.
 *
 * Everything else is the library's behaviour verbatim: the same `t` from
 * `streamline`, the same pressure defaults, the same `vector` pointing back
 * along the path, the same duplicate-sample skip, the same `last` rule that
 * takes the final sample raw, and the same back-fill of the first point's
 * vector from the second. The library's two-point special case (expanding a
 * 2-sample stroke to 5 interpolated ones) is dropped: it exists to give the
 * gate and the cold filter something to chew on, and without those a 2-sample
 * stroke is simply the segment the user drew.
 *
 * This replaces one stage of the pipeline through public API rather than
 * forking the library: the outline builder — thinning, tapers, caps, corner
 * handling, the dot — is still entirely perfect-freehand's, and it is the part
 * we have no quarrel with.
 */
function strokePointsFor(points: number[][], size: number, streamline: number): StrokePoint[] {
  if (points.length === 0) return [];
  const first: StrokePoint = {
    point: [points[0][0], points[0][1]],
    pressure: hasPressure(points[0][2]) ? points[0][2] : FIRST_PRESSURE,
    vector: [1, 1],
    distance: 0,
    runningLength: 0,
  };
  // one sample: a dot, with no direction invented for it
  if (points.length === 1) {
    first.vector = [0, 0];
    return [first];
  }

  const t = 0.15 + (1 - streamline) * 0.85;
  const out: StrokePoint[] = [first];
  let prev = first;
  let runningLength = 0;
  let decay = 1; // (1 - t)^n for the n points admitted so far
  const max = points.length - 1;
  for (let i = 1; i < points.length; i++) {
    const raw = points[i];
    // `last` is always set by our callers, so the newest sample is never
    // smoothed: the ink's tip stays exactly under the pen.
    let px: number;
    let py: number;
    if (i === max) {
      px = raw[0];
      py = raw[1];
    } else {
      // bias-corrected EMA: `t / (1 - (1 - t)^n)` is 1 for the first admitted
      // sample and relaxes to `t`
      const a = Math.min(1, t / (1 - decay * (1 - t)));
      px = prev.point[0] + (raw[0] - prev.point[0]) * a;
      py = prev.point[1] + (raw[1] - prev.point[1]) * a;
    }
    if (px === prev.point[0] && py === prev.point[1]) continue;
    decay *= 1 - t;
    const distance = Math.hypot(px - prev.point[0], py - prev.point[1]);
    runningLength += distance;
    const vx = prev.point[0] - px;
    const vy = prev.point[1] - py;
    const len = Math.hypot(vx, vy) || 1;
    prev = {
      point: [px, py],
      pressure: hasPressure(raw[2]) ? raw[2] : DEFAULT_PRESSURE,
      vector: [vx / len, vy / len],
      distance,
      runningLength,
    };
    out.push(prev);
  }
  // the first point has no incoming direction of its own; the library borrows
  // the second's, and the start cap is built from it
  out[0].vector = out[1] ? out[1].vector : [0, 0];

  // For our options `runningLength` is read by exactly one thing: the outline
  // builder's "skip points crowded near the end" test, `total - runningLength
  // < END_WINDOW` (the tapers that would also read it are off, and a taper of
  // `undefined` resolves to 0 whatever the total). That test has no floor, so
  // on a stroke shorter than END_WINDOW it skips the *first* point as well and
  // builds the start cap from the far end instead — a backward-bulging blob
  // that collapses onto the line the moment the stroke passes 3 units. It is
  // the fourth start-of-stroke artefact, and the only reason the library's own
  // `getStrokePoints` does not hit it is that its minimum-length gate (2,
  // above) re-counts each rejected sample's distance from the same unmoved
  // previous point, inflating the total enough to clear the window by
  // accident. Having removed that gate we have to be explicit: report a total
  // at least one window beyond the first point, which keeps the first point
  // out of the window and changes no geometry.
  if (out.length > 1 && prev.runningLength < END_WINDOW) prev.runningLength = END_WINDOW;
  return out;
}

/**
 * The filled outline polygon perfect-freehand produces for a stroke (used by
 * the canvas and the PDF export).
 *
 * The densify pass is here rather than only at commit time so that every
 * render of a stroke is built from the same points: `commitDrawStroke` stores
 * densified points, so a stored stroke early-outs of `densifyStrokePoints`
 * unchanged, while the live preview — which paints the raw samples as they
 * arrive — is conditioned identically instead of a frame behind. Without it
 * the two disagree at the start of a stroke drawn below 100% zoom, where
 * densify actually inserts points, and the stroke visibly shifts as it
 * commits.
 */
export function strokeOutline(points: number[][], size: number, highlighter: boolean): number[][] {
  const opts = highlighter ? HI_OPTS : PEN_OPTS;
  const pts = densifyStrokePoints(points, size);
  return getStrokeOutlinePoints(strokePointsFor(pts, size, opts.streamline), {
    size,
    last: true,
    ...opts,
    // smoothing only feeds perfect-freehand's outline-vertex cull ((size*smoothing)^2, world units); the cull must be at most half the densify gap, otherwise every other outline vertex is dropped.
    smoothing: Math.min(opts.smoothing, (0.5 * densifyTarget(size)) / Math.max(size, 0.0001)),
  });
}

/**
 * Densest sample spacing worth keeping, in surface units — reached at a pen
 * size of 4.5 (the default) and held there for anything thicker. Below that it
 * tracks the nib, because the artefact this guards against is relative to the
 * stroke's own width: a 0.5-unit hairline sampled every 1.5 units is nothing
 * but chords.
 */
const DENSIFY_MAX = 1.5;
const DENSIFY_MIN = 0.4;

/** The spacing `densifyStrokePoints` fills a stroke in to, for a given nib. */
function densifyTarget(size: number): number {
  return Math.min(DENSIFY_MAX, Math.max(DENSIFY_MIN, size / 3));
}

/**
 * Fills in a captured stroke so its samples are no further apart than
 * `densifyTarget(size)` **surface units**, interpolating along a centripetal
 * Catmull-Rom spline through the samples.
 *
 * Why this is needed at all: a pointer reports samples at a roughly constant
 * rate in *screen* space, and both surfaces convert those to surface units by
 * dividing by the camera zoom (`PageCanvas.toLocal`, `BoardCanvas.toBoard`).
 * Draw at the 0.5 zoom floor and the same hand movement lands samples twice as
 * far apart in stored units as it would at 100%; draw quickly and they are
 * further apart again. perfect-freehand builds its outline from the samples it
 * is given, so a sparsely sampled curve gets an outline whose chords cut
 * *inside* the true envelope — invisible at the zoom it was drawn at, and
 * plainly visible as thin white notches along the edge once magnified.
 * Measured on a 30-unit handwriting loop viewed at 8 device px per unit: a
 * stroke sampled every 8 units loses 21.5% of its area with notches up to 17.6
 * units long, against 1.0% and 0.6 units after this runs.
 *
 * Interpolation has to be curved, not linear: inserting points along the
 * chords keeps the chords, which is the actual defect (measured: linear
 * resampling left the worst notch at 4.5 units where Catmull-Rom took it to
 * 0.9). The captured samples are all preserved exactly and only intermediate
 * ones are added, so this sharpens the silhouette without moving the line the
 * user actually drew. Pressure is interpolated linearly along each segment,
 * which cannot overshoot the way the spline can.
 *
 * Strokes whose samples are already within the target — every ordinary stroke
 * drawn around 100% zoom — are returned as the *same array*, untouched, so
 * this cannot change how normal-zoom ink looks.
 */
export function densifyStrokePoints(points: number[][], size: number): number[][] {
  if (points.length < 2) return points;
  const target = densifyTarget(size);
  let needs = false;
  for (let i = 1; i < points.length; i++) {
    if (Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]) > target) {
      needs = true;
      break;
    }
  }
  if (!needs) return points;

  // clamped at both ends, so the first and last segments bend with their one
  // real neighbour rather than against a phantom point
  const at = (i: number): number[] => points[Math.max(0, Math.min(points.length - 1, i))];
  const out: number[][] = [points[0]];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    const seg = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    // Steps are counted against the straight chord, but the spline bulges
    // outside it, so equal parameter steps land further apart than `target`
    // along the actual curve — by ~1.16x on handwriting curvature and more on
    // a very long segment. The margin keeps the *realised* spacing inside the
    // target instead of merely near it, which is what the comment above
    // promises; measured worst case 1.39 units against a 1.5 target.
    const steps = seg > target ? Math.ceil(seg / (target * 0.7)) : 1;
    // centripetal (exponent 0.5) rather than uniform parameterisation: it is
    // the variant that cannot cusp or loop when the samples are unevenly
    // spaced, which coalesced pointer batches routinely are
    const d01 = Math.sqrt(Math.hypot(p1[0] - p0[0], p1[1] - p0[1])) || 1e-6;
    const d12 = Math.sqrt(seg) || 1e-6;
    const d23 = Math.sqrt(Math.hypot(p3[0] - p2[0], p3[1] - p2[1])) || 1e-6;
    for (let step = 1; step <= steps; step++) {
      if (step === steps) {
        out.push(p2); // land exactly on the captured sample
        break;
      }
      const t = step / steps;
      const coord = (k: number): number => {
        const m1 = ((p1[k] - p0[k]) / d01 - (p2[k] - p0[k]) / (d01 + d12) + (p2[k] - p1[k]) / d12) * d12;
        const m2 = ((p2[k] - p1[k]) / d12 - (p3[k] - p1[k]) / (d12 + d23) + (p3[k] - p2[k]) / d23) * d12;
        const t2 = t * t;
        const t3 = t2 * t;
        return (2 * t3 - 3 * t2 + 1) * p1[k] + (t3 - 2 * t2 + t) * m1 + (-2 * t3 + 3 * t2) * p2[k] + (t3 - t2) * m2;
      };
      out.push([coord(0), coord(1), p1[2] + (p2[2] - p1[2]) * t]);
    }
  }
  return out;
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
