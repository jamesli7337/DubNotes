import type { Paper, PaperColor, PaperSpacing } from '../types';

interface PaperInk {
  /** page background fill */
  bg: string;
  /** ruling / dot colour, chosen for contrast against `bg` */
  rule: string;
}

const PAPER_INK: Record<PaperColor, PaperInk> = {
  white: { bg: '#ffffff', rule: '#c7d2dd' },
  cream: { bg: '#f8f2e2', rule: '#ddcda4' },
  dark: { bg: '#1e2330', rule: '#3f4759' },
};

const SPACING_PX: Record<PaperSpacing, number> = {
  narrow: 26,
  medium: 38,
  wide: 54,
};

/** Background fill for a page's paper — lets an unmounted page show the right colour. */
export function paperBg(paper: Paper): string {
  return PAPER_INK[paper.color].bg;
}

/** Paints the page background plus optional ruling for `paper`. Rendered into the
 *  committed-strokes cache, never stored as strokes. Ruling colour adapts to the
 *  paper colour so lines stay visible on dark paper. */
export function drawTemplate(
  ctx: CanvasRenderingContext2D,
  paper: Paper,
  w: number,
  h: number
): void {
  const ink = PAPER_INK[paper.color];
  const gap = SPACING_PX[paper.spacing];

  ctx.save();
  ctx.fillStyle = ink.bg;
  ctx.fillRect(0, 0, w, h);
  const t = deviceScale(ctx);
  // One device pixel, expressed in the user units the caller is drawing in.
  // A flat `1` meant one *user* unit, which is only one device pixel when the
  // context happens to be unscaled — under a camera at zoom 4 on a 2× screen
  // it painted an 8px bar.
  ctx.lineWidth = 1 / t.s;

  if (paper.template === 'ruled') {
    ctx.strokeStyle = ink.rule;
    for (let y = gap * 1.5; y < h - 4; y += gap) line(ctx, t, 0, y, w, y);
  } else if (paper.template === 'grid') {
    ctx.strokeStyle = ink.rule;
    for (let x = gap; x < w; x += gap) line(ctx, t, x, 0, x, h);
    for (let y = gap; y < h; y += gap) line(ctx, t, 0, y, w, y);
  } else if (paper.template === 'dot') {
    ctx.fillStyle = ink.rule;
    for (let x = gap; x < w; x += gap) {
      for (let y = gap; y < h; y += gap) {
        ctx.beginPath();
        ctx.arc(x, y, 1.3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  ctx.restore();
}

/**
 * The context's current transform, reduced to what pixel snapping needs: `s`
 * device pixels per user unit, and the translation in device pixels.
 *
 * Read once per `drawTemplate` call rather than per line — a grid on a large
 * page is hundreds of `line()` calls, and `getTransform()` allocates a
 * DOMMatrix each time.
 *
 * Every caller scales uniformly (DPR, a page's pixel factor, the board
 * camera's `zoom * DPR`, an export scale), so one `s` is enough; `sx`/`sy` are
 * averaged rather than tracked separately so a hypothetical non-uniform
 * transform degrades to a sensible hairline instead of throwing.
 */
function deviceScale(ctx: CanvasRenderingContext2D): { s: number; tx: number; ty: number } {
  const m = ctx.getTransform();
  const sx = Math.abs(m.a);
  const sy = Math.abs(m.d);
  const s = (sx + sy) / 2 || 1;
  return { s, tx: m.e, ty: m.f };
}

/** A user-space coordinate moved onto the nearest device half-pixel, so a one-device-pixel line lands on exactly one row/column of pixels instead of straddling two at half intensity. */
function snap(v: number, s: number, translate: number): number {
  return (Math.round(v * s + translate) + 0.5 - translate) / s;
}

/**
 * One crisp hairline. The snapping is done in *device* space: the old
 * `Math.round(v) + 0.5` rounded to whole user units and offset by half a user
 * unit, which is the right trick only when one user unit is one device pixel.
 * Under the notebook camera (and in the board spike) a user unit is several
 * device pixels, so it quantised ruling to whole page units — shifting the
 * grid's phase — and offset every line by half a page unit.
 */
function line(
  ctx: CanvasRenderingContext2D,
  t: { s: number; tx: number; ty: number },
  x1: number,
  y1: number,
  x2: number,
  y2: number
): void {
  ctx.beginPath();
  ctx.moveTo(snap(x1, t.s, t.tx), snap(y1, t.s, t.ty));
  ctx.lineTo(snap(x2, t.s, t.tx), snap(y2, t.s, t.ty));
  ctx.stroke();
}
