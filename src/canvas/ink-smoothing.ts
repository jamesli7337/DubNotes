/** The bits of a pointer sample that ink capture reads. A `PointerEvent` is one. */
export interface ClientSample {
  clientX: number;
  clientY: number;
  pressure: number;
}

/** EMA weight given to each new screen-space sample. */
const INK_SMOOTHING = 0.5;

/**
 * Low-pass filter for pen/highlighter capture, run on raw **screen-space**
 * samples before they are converted to page/board units. Hand jitter is a
 * fixed size in screen px whatever the zoom, so filtering it here smooths ink
 * the same at every zoom — where streamline, running after densify in surface
 * units, barely smooths anything for ink drawn zoomed out. Pressure is passed
 * through untouched. Shared by `PageCanvas` and `BoardCanvas`.
 */
export class InkSmoother {
  private x = 0;
  private y = 0;

  /** Starts a new contact: the press itself is taken as-is. */
  reset(e: ClientSample): void {
    this.x = e.clientX;
    this.y = e.clientY;
  }

  /** Feeds one raw sample and returns the filtered one. */
  next(e: ClientSample): ClientSample {
    this.x += (e.clientX - this.x) * INK_SMOOTHING;
    this.y += (e.clientY - this.y) * INK_SMOOTHING;
    return { clientX: this.x, clientY: this.y, pressure: e.pressure };
  }
}

/** Commit-time smoothing radius, in screen px; divided by the zoom to give surface units. */
export const INK_SETTLE_SIGMA_PX = 2.5;
/** Over this many sigmas from either end, smoothing ramps up from nothing to full. */
const SETTLE_TAPER_SIGMAS = 3;

/**
 * Smooths a finished pen/highlighter stroke once, at pen-up: a Gaussian over
 * arc length (`sigma` in surface units) applied to x/y, pressure untouched.
 * Returns a new array; strokes under 4 points come back as-is.
 *
 * The first and last points are pinned, and the strength ramps from 0 at each
 * end to full over SETTLE_TAPER_SIGMAS, so ends neither shrink nor drift. Each
 * sample is weighted by the arc length it stands for, so a cluster of
 * near-coincident samples (a pause) doesn't drag the curve towards itself.
 */
export function smoothInkStroke(points: number[][], sigma: number): number[][] {
  const n = points.length;
  if (n < 4 || !(sigma > 0)) return points;

  const s = new Array<number>(n).fill(0); // cumulative arc length
  for (let i = 1; i < n; i++) {
    s[i] = s[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  }
  const total = s[n - 1];
  if (total <= 0) return points;

  // the arc length each sample stands for
  const ds = points.map((_, i) => (s[Math.min(n - 1, i + 1)] - s[Math.max(0, i - 1)]) / 2);

  const out = points.map((p) => p.slice());
  const reach = 3 * sigma;
  const ramp = SETTLE_TAPER_SIGMAS * sigma;
  let lo = 0;
  let hi = 0;
  for (let i = 1; i < n - 1; i++) {
    const k = Math.min(1, s[i] / ramp, (total - s[i]) / ramp);
    if (k <= 0) continue;
    while (s[i] - s[lo] > reach) lo++;
    while (hi < n - 1 && s[hi + 1] - s[i] <= reach) hi++;
    let sx = 0;
    let sy = 0;
    let sw = 0;
    for (let j = lo; j <= hi; j++) {
      const d = s[j] - s[i];
      const w = Math.exp((-d * d) / (2 * sigma * sigma)) * ds[j];
      sx += points[j][0] * w;
      sy += points[j][1] * w;
      sw += w;
    }
    if (sw <= 0) continue;
    out[i][0] = points[i][0] + (sx / sw - points[i][0]) * k;
    out[i][1] = points[i][1] + (sy / sw - points[i][1]) * k;
  }
  return out;
}

/** Below this raw pressure a trailing sample is the pen lifting away, not ink. */
const LIFT_PRESSURE = 0.2;
/** The most arc length, in sigmas, the lift trim may take off a stroke's end. */
const LIFT_TRIM_SIGMAS = 2;

/**
 * The pressure each captured ink point was reported with, *before*
 * `toBoard` / `toLocal` map a missing (<= 0) pressure to 0.5. Kept beside the
 * points rather than in them so nothing stored changes shape.
 */
const rawPressure = new WeakMap<number[], number>();

/** Records the unmapped pointer pressure behind a captured ink point. */
export function tagRawPressure(pt: number[], pressure: number): void {
  rawPressure.set(pt, pressure);
}

/**
 * Drops the pen-lift flick from a finished stroke: trailing points whose raw
 * pressure is under LIFT_PRESSURE (a raw 0 counts), taking at most
 * LIFT_TRIM_SIGMAS * `sigma` of arc off the end and always leaving at least 2
 * points. A stroke none of whose points reported a real pressure (a device
 * that sends 0 throughout) is left alone — its pressure says nothing about the
 * lift. Returns a new array, or `points` itself when nothing is trimmed.
 */
export function trimLiftTail(points: number[][], sigma: number): number[][] {
  const raw = (p: number[]): number => rawPressure.get(p) ?? p[2];
  if (!points.some((p) => (rawPressure.get(p) ?? 0) > 0)) return points;
  const maxArc = LIFT_TRIM_SIGMAS * sigma;
  let end = points.length; // points[end..] are trimmed
  let arc = 0;
  while (end > 2 && raw(points[end - 1]) < LIFT_PRESSURE) {
    const a = points[end - 2];
    const b = points[end - 1];
    arc += Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (arc > maxArc) break;
    end--;
  }
  return end === points.length ? points : points.slice(0, end);
}
