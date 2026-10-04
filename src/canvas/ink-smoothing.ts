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
  /** The most recent unfiltered sample, so a stroke can end exactly at the pen. */
  lastRaw: ClientSample = { clientX: 0, clientY: 0, pressure: 0 };

  /** Starts a new contact: the press itself is taken as-is. */
  reset(e: ClientSample): void {
    this.x = e.clientX;
    this.y = e.clientY;
    this.lastRaw = { clientX: e.clientX, clientY: e.clientY, pressure: e.pressure };
  }

  /** Feeds one raw sample and returns the filtered one. */
  next(e: ClientSample): ClientSample {
    this.lastRaw = { clientX: e.clientX, clientY: e.clientY, pressure: e.pressure };
    this.x += (e.clientX - this.x) * INK_SMOOTHING;
    this.y += (e.clientY - this.y) * INK_SMOOTHING;
    return { clientX: this.x, clientY: this.y, pressure: e.pressure };
  }
}

/** Appends the final raw point to a smoothed stroke if it differs from its last point, so the ink ends at the pen. */
export function endAtPen(points: number[][], raw: number[]): void {
  const last = points[points.length - 1];
  if (last && (last[0] !== raw[0] || last[1] !== raw[1])) points.push(raw);
}
