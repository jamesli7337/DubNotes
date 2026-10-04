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
/** Over this many sigmas from an end or a corner, smoothing ramps up from nothing to full. */
const SETTLE_TAPER_SIGMAS = 3;
/** A turn sharper than this over one sigma either side is a corner: pinned, and never smoothed across. */
const CORNER_COS = Math.cos((60 * Math.PI) / 180);

/**
 * Smooths a finished pen/highlighter stroke once, at pen-up: a Gaussian over
 * arc length (`sigma` in surface units) applied to x/y, pressure untouched.
 * Returns a new array; strokes under 4 points come back as-is.
 *
 * The first and last points are pinned, and so is every sharp corner (a turn
 * of more than ~60 degrees between the chords one sigma behind and one sigma
 * ahead). The stroke is smoothed piecewise between those pins — the kernel
 * never reaches across one — and the strength ramps from 0 at each pin to full
 * over SETTLE_TAPER_SIGMAS, so ends neither shrink nor drift and handwriting
 * corners keep their point. Each sample is weighted by the arc length it
 * stands for, so a cluster of near-coincident samples (a pause) doesn't drag
 * the curve towards itself.
 */
export function smoothInkStroke(points: number[][], sigma: number): number[][] {
  const n = points.length;
  if (n < 4 || !(sigma > 0)) return points;

  const s = new Array<number>(n).fill(0); // cumulative arc length
  for (let i = 1; i < n; i++) {
    s[i] = s[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  }
  if (s[n - 1] <= 0) return points;

  // the sample one sigma behind / ahead of each point along the arc
  const pinned = new Array<boolean>(n).fill(false);
  pinned[0] = pinned[n - 1] = true;
  let back = 0;
  let fwd = 0;
  for (let i = 1; i < n - 1; i++) {
    while (back < i && s[i] - s[back + 1] >= sigma) back++;
    if (fwd < i) fwd = i;
    while (fwd < n - 1 && s[fwd] - s[i] < sigma) fwd++;
    const ax = points[i][0] - points[back][0];
    const ay = points[i][1] - points[back][1];
    const bx = points[fwd][0] - points[i][0];
    const by = points[fwd][1] - points[i][1];
    const la = Math.hypot(ax, ay);
    const lb = Math.hypot(bx, by);
    if (la > 0 && lb > 0 && (ax * bx + ay * by) / (la * lb) < CORNER_COS) pinned[i] = true;
  }

  // the arc length each sample stands for
  const ds = points.map((_, i) => (s[Math.min(n - 1, i + 1)] - s[Math.max(0, i - 1)]) / 2);

  const out = points.map((p) => p.slice());
  const reach = 3 * sigma;
  const ramp = SETTLE_TAPER_SIGMAS * sigma;
  let start = 0;
  for (let end = 1; end < n; end++) {
    if (!pinned[end]) continue;
    // smooth the open run (start, end), its kernel confined to [start, end]
    let lo = start;
    let hi = start;
    for (let i = start + 1; i < end; i++) {
      const k = Math.min(1, (s[i] - s[start]) / ramp, (s[end] - s[i]) / ramp);
      if (k <= 0) continue;
      while (s[i] - s[lo] > reach) lo++;
      while (hi < end && s[hi + 1] - s[i] <= reach) hi++;
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
    start = end;
  }
  return out;
}
