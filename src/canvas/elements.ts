import { getPdfPage, isPdfPageFailed } from '../pdf-render';
import type { ImageElement, PageBackground, PageElement, Paper, ShapeElement, TapeElement, TextElement } from '../types';
import { resolveInkColor } from './freehand';

/** Default strip colour for a new tape element. */
export const TAPE_COLOR = '#fbbf24';

/** Same face the UI uses, so the in-place text editor and the canvas agree. */
export const TEXT_FONT_FAMILY =
  '"Plus Jakarta Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
export const TEXT_LINE_HEIGHT = 1.3;

export function textFont(fontSize: number): string {
  return `400 ${fontSize}px ${TEXT_FONT_FAMILY}`;
}

let measureCtx: CanvasRenderingContext2D | null = null;
function measurer(): CanvasRenderingContext2D {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  return measureCtx!;
}

export interface TextLayout {
  lines: string[];
  lineHeight: number;
  height: number;
}

/**
 * Greedy word wrap at `maxWidth` page units; words wider than the box break by
 * character. Mirrors what the browser does inside the edit textarea closely
 * enough that committed text lands where it was typed.
 */
export function layoutText(text: string, fontSize: number, maxWidth: number): TextLayout {
  const ctx = measurer();
  ctx.font = textFont(fontSize);
  const fits = (s: string): boolean => ctx.measureText(s).width <= maxWidth;
  const lines: string[] = [];

  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(' ')) {
      const test = line ? `${line} ${word}` : word;
      if (fits(test)) {
        line = test;
        continue;
      }
      if (line) {
        lines.push(line);
        line = '';
      }
      if (fits(word)) {
        line = word;
        continue;
      }
      let chunk = '';
      for (const ch of word) {
        if (chunk && !fits(chunk + ch)) {
          lines.push(chunk);
          chunk = ch;
        } else {
          chunk += ch;
        }
      }
      line = chunk;
    }
    lines.push(line);
  }

  const lineHeight = fontSize * TEXT_LINE_HEIGHT;
  return { lines, lineHeight, height: Math.max(lines.length, 1) * lineHeight };
}

/** Height a text element needs to show all of its (wrapped) text. */
export function textHeight(el: TextElement): number {
  return layoutText(el.text, el.fontSize, el.w).height;
}

// ------------------------------------------------------------------ images
const images = new Map<string, HTMLImageElement>();

/** Resolves once the image for `src` is decoded (used by exports, which can't paint a placeholder). */
export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const ready = getImage(src, () => {
      const img = images.get(src);
      if (img && img.naturalWidth > 0) resolve(img);
      else reject(new Error('Image could not be decoded.'));
    });
    if (ready) resolve(ready);
    else images.get(src)?.addEventListener('error', () => reject(new Error('Image could not be decoded.')), { once: true });
  });
}

/** Decoded image for a data URL, or null while it is still loading (`onReady` fires once it is). */
export function getImage(src: string, onReady?: () => void): HTMLImageElement | null {
  let img = images.get(src);
  if (!img) {
    img = new Image();
    img.src = src;
    images.set(src, img);
  }
  if (img.complete && img.naturalWidth > 0) return img;
  if (onReady) img.addEventListener('load', onReady, { once: true });
  return null;
}

// ------------------------------------------------------------------ drawing
/** The bitmap for a background if it is ready (image decoded / PDF page rendered), else null. */
export function backgroundBitmap(
  bg: PageBackground,
  onReady?: () => void
): { source: CanvasImageSource; width: number; height: number } | null {
  if (bg.assetId !== undefined) {
    const c = getPdfPage(bg.assetId, bg.page, onReady);
    return c ? { source: c, width: c.width, height: c.height } : null;
  }
  const img = getImage(bg.src, onReady);
  return img ? { source: img, width: img.naturalWidth, height: img.naturalHeight } : null;
}

/**
 * Paints a page background (an imported PDF page) over the paper fill and
 * under everything else. A PDF page (`bg.assetId`) fills `w × h` completely,
 * full-bleed — scaled to cover and centre-cropped to the page's own
 * proportions, rather than fitted inside with the page's paper showing
 * around it, since a PDF page's own aspect ratio rarely matches PAGE_W:PAGE_H
 * exactly (imperceptible for near-Letter-proportioned pages; a page far from
 * that proportion, e.g. a wide landscape scan, loses some of its margin off
 * the top/bottom or sides to the crop — an inherent trade-off of filling the
 * page rather than showing the whole source image). A legacy `bg.src` image
 * background (pre-PDF-import format; nothing in the app creates these
 * anymore) keeps the older fit-inside-and-centre behaviour, since it was
 * never a whole scanned page and correctly showing all of it matters more
 * there. While a PDF page is still rendering, a light placeholder marks its
 * area; if it failed to render (see pdf-render.ts's `looksBlank`/
 * `isPdfPageFailed` — an unsupported image codec resolves "successfully"
 * with nothing painted, so this can't rely on an exception alone), a more
 * visible placeholder says so, rather than leaving what would otherwise look
 * like a page that silently imported empty.
 */
export function drawBackground(
  ctx: CanvasRenderingContext2D,
  bg: PageBackground,
  w: number,
  h: number,
  onReady?: () => void
): void {
  const bmp = backgroundBitmap(bg, onReady);
  if (!bmp) {
    if (bg.assetId && isPdfPageFailed(bg.assetId, bg.page)) {
      ctx.fillStyle = '#e3e1da';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#79766c';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = textFont(22);
      ctx.fillText("This page couldn't be rendered", w / 2, h / 2);
    } else if (bg.assetId) {
      ctx.fillStyle = 'rgba(128, 128, 128, 0.08)';
      ctx.fillRect(0, 0, w, h);
    }
    return;
  }
  if (bg.assetId !== undefined) {
    // cover + centre-crop: fills w × h exactly, no paper margin around it
    const s = Math.max(w / bmp.width, h / bmp.height);
    const sw = w / s;
    const sh = h / s;
    const sx = (bmp.width - sw) / 2;
    const sy = (bmp.height - sh) / 2;
    ctx.drawImage(bmp.source, sx, sy, sw, sh, 0, 0, w, h);
    return;
  }
  const s = Math.min(w / bmp.width, h / bmp.height);
  const dw = bmp.width * s;
  const dh = bmp.height * s;
  ctx.drawImage(bmp.source, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

/**
 * Paints one element at the context's current transform. `paper` resolves the
 * "auto" ink token exactly as it is for strokes. `opacity` dims (used for the
 * eraser-style pending preview); `onImageReady` is called when an image that
 * wasn't decoded yet finishes loading, so the caller can repaint. A tape in
 * `peeled` is drawn see-through (outline only) instead of covering.
 */
export function drawElement(
  ctx: CanvasRenderingContext2D,
  el: PageElement,
  paper: Paper,
  opacity = 1,
  onImageReady?: () => void,
  peeled?: Set<string>
): void {
  ctx.save();
  ctx.globalAlpha = opacity;
  if (el.rotation) {
    const cx = el.x + el.w / 2;
    const cy = el.y + el.h / 2;
    ctx.translate(cx, cy);
    ctx.rotate(el.rotation);
    ctx.translate(-cx, -cy);
  }
  switch (el.kind) {
    case 'text':
      drawText(ctx, el, paper);
      break;
    case 'image':
      drawImage(ctx, el, onImageReady);
      break;
    case 'shape':
      drawShape(ctx, el, paper);
      break;
    case 'tape':
      drawTape(ctx, el, peeled?.has(el.id) ?? false);
      break;
  }
  ctx.restore();
}

function drawTape(ctx: CanvasRenderingContext2D, el: TapeElement, peeled: boolean): void {
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.25)';
  if (peeled) {
    // see-through: just the outline so it can be found and re-covered
    ctx.setLineDash([6, 4]);
    ctx.fillStyle = el.color;
    ctx.globalAlpha *= 0.15;
    ctx.fillRect(el.x, el.y, el.w, el.h);
    ctx.globalAlpha /= 0.15;
    ctx.strokeRect(el.x, el.y, el.w, el.h);
    return;
  }
  ctx.fillStyle = el.color;
  ctx.fillRect(el.x, el.y, el.w, el.h);
  ctx.strokeRect(el.x + 0.75, el.y + 0.75, el.w - 1.5, el.h - 1.5);
  // a faint sheen so it reads as a strip of tape rather than a flat box
  ctx.fillStyle = 'rgba(255, 255, 255, 0.28)';
  ctx.fillRect(el.x, el.y, el.w, Math.max(2, el.h * 0.3));
}

/** Padding (page units) the `bg` tint card extends beyond the text's own box. */
const TEXT_BG_PAD_X = 8;
const TEXT_BG_PAD_Y = 6;

function drawText(ctx: CanvasRenderingContext2D, el: TextElement, paper: Paper): void {
  const { lines, lineHeight } = layoutText(el.text, el.fontSize, el.w);
  if (el.bg) {
    // a fixed tint, not resolved through resolveInkColor — this is meant to
    // stand out from the page consistently, not blend with the paper.
    ctx.fillStyle = el.bg;
    const r = 6;
    const x = el.x - TEXT_BG_PAD_X;
    const y = el.y - TEXT_BG_PAD_Y;
    const w = el.w + TEXT_BG_PAD_X * 2;
    const h = el.h + TEXT_BG_PAD_Y * 2;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    ctx.fill();
  }
  ctx.font = textFont(el.fontSize);
  ctx.fillStyle = resolveInkColor(el.color, paper);
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  const lead = (lineHeight - el.fontSize) / 2; // half-leading, like CSS line-height
  lines.forEach((line, i) => {
    if (line) ctx.fillText(line, el.x, el.y + i * lineHeight + lead);
  });
}

function drawImage(ctx: CanvasRenderingContext2D, el: ImageElement, onReady?: () => void): void {
  const img = getImage(el.src, onReady);
  if (img) {
    ctx.drawImage(img, el.x, el.y, el.w, el.h);
  } else {
    ctx.fillStyle = 'rgba(128, 128, 128, 0.15)';
    ctx.fillRect(el.x, el.y, el.w, el.h);
  }
}

function drawShape(ctx: CanvasRenderingContext2D, el: ShapeElement, paper: Paper): void {
  ctx.strokeStyle = resolveInkColor(el.color, paper);
  ctx.lineWidth = el.size;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const cy = el.y + el.h / 2;
  ctx.beginPath();
  switch (el.shape) {
    case 'rect':
      ctx.rect(el.x, el.y, el.w, el.h);
      break;
    case 'ellipse':
      ctx.ellipse(el.x + el.w / 2, cy, el.w / 2, el.h / 2, 0, 0, Math.PI * 2);
      break;
    case 'triangle': {
      const pts = el.pts ?? [[0.5, 0], [1, 1], [0, 1]];
      pts.forEach(([fx, fy], i) => {
        if (i === 0) ctx.moveTo(el.x + fx * el.w, el.y + fy * el.h);
        else ctx.lineTo(el.x + fx * el.w, el.y + fy * el.h);
      });
      ctx.closePath();
      break;
    }
    case 'line':
      ctx.moveTo(el.x, cy);
      ctx.lineTo(el.x + el.w, cy);
      break;
    case 'arrow': {
      // shaft along the box's horizontal centreline, head at the right end
      const head = Math.max(el.size * 4, 12);
      const tipX = el.x + el.w;
      ctx.moveTo(el.x, cy);
      ctx.lineTo(tipX, cy);
      ctx.moveTo(tipX - head * Math.cos(Math.PI / 6), cy - head * Math.sin(Math.PI / 6));
      ctx.lineTo(tipX, cy);
      ctx.lineTo(tipX - head * Math.cos(Math.PI / 6), cy + head * Math.sin(Math.PI / 6));
      break;
    }
  }
  ctx.stroke();
}
