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
  ctx.lineWidth = 1;

  if (paper.template === 'ruled') {
    ctx.strokeStyle = ink.rule;
    for (let y = gap * 1.5; y < h - 4; y += gap) line(ctx, 0, y, w, y);
  } else if (paper.template === 'grid') {
    ctx.strokeStyle = ink.rule;
    for (let x = gap; x < w; x += gap) line(ctx, x, 0, x, h);
    for (let y = gap; y < h; y += gap) line(ctx, 0, y, w, y);
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

function line(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number): void {
  ctx.beginPath();
  ctx.moveTo(Math.round(x1) + 0.5, Math.round(y1) + 0.5);
  ctx.lineTo(Math.round(x2) + 0.5, Math.round(y2) + 0.5);
  ctx.stroke();
}
