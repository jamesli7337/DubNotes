import { degrees, LineCapStyle, PDFDocument, PDFFont, PDFPage, rgb, StandardFonts, type RGB } from 'pdf-lib';
import { backgroundBitmap, loadImage, TEXT_LINE_HEIGHT } from '../canvas/elements';
import { HIGHLIGHTER_ALPHA, resolveInkColor, strokeOutline } from '../canvas/freehand';
import { rotateAround } from '../canvas/geom';
import { PAGE_W, pageH, pageW } from '../const';
import { store } from '../store';
import type { Notebook, Page, PageElement, Paper, PaperColor, PaperSpacing, ShapeElement, TextElement } from '../types';
import { downloadBlob, isStroke, safeFileName } from '../util';
import { preloadPageImages } from './raster';

/** Page units → PDF points, fixed app-wide (calibrated against the default
 *  portrait page: 820 page units → 612 pt, Letter width) — every page shares
 *  this one scale regardless of its own size, so a page's own w/h (see
 *  pageW/pageH) only changes which PDF page box it lands in, not how big a
 *  page-unit is. */
const SCALE = 612 / PAGE_W;

// same values as canvas/templates.ts (kept private there); the export must match the screen
const PAPER: Record<PaperColor, { bg: string; rule: string }> = {
  white: { bg: '#ffffff', rule: '#c7d2dd' },
  cream: { bg: '#f8f2e2', rule: '#ddcda4' },
  dark: { bg: '#1e2330', rule: '#3f4759' },
};
const SPACING: Record<PaperSpacing, number> = { narrow: 26, medium: 38, wide: 54 };

function color(css: string): RGB {
  const m = /^#([0-9a-f]{3,8})$/i.exec(css.trim());
  if (!m) return rgb(0, 0, 0);
  let h = m[1];
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

/** Page units → PDF points. */
const px = (x: number): number => x * SCALE;
/** Page units (top-down) → PDF points (PDF origin is bottom-left) — the flip
 *  needs *this* page's own height, so it's built per-page in addPage and
 *  threaded through as a parameter rather than a fixed module function. */
type PyFn = (y: number) => number;

/** SVG path (page units) for a closed polygon; drawn with pdf-lib's y-down SVG semantics from the page's top-left. */
function polygonPath(pts: number[][]): string {
  if (!pts.length) return '';
  return `M${pts[0][0].toFixed(2)} ${pts[0][1].toFixed(2)} ` + pts.slice(1).map((p) => `L${p[0].toFixed(2)} ${p[1].toFixed(2)}`).join(' ') + ' Z';
}

/** Cubic-bezier ellipse (4 arcs) in page units, rotated about the box centre. */
function ellipsePath(el: ShapeElement): string {
  const cx = el.x + el.w / 2;
  const cy = el.y + el.h / 2;
  const rx = el.w / 2;
  const ry = el.h / 2;
  const k = 0.5522847498;
  const r = (x: number, y: number): string => {
    const [rx2, ry2] = rotateAround(x, y, cx, cy, el.rotation);
    return `${rx2.toFixed(2)} ${ry2.toFixed(2)}`;
  };
  return (
    `M${r(cx + rx, cy)} ` +
    `C${r(cx + rx, cy + ry * k)} ${r(cx + rx * k, cy + ry)} ${r(cx, cy + ry)} ` +
    `C${r(cx - rx * k, cy + ry)} ${r(cx - rx, cy + ry * k)} ${r(cx - rx, cy)} ` +
    `C${r(cx - rx, cy - ry * k)} ${r(cx - rx * k, cy - ry)} ${r(cx, cy - ry)} ` +
    `C${r(cx + rx * k, cy - ry)} ${r(cx + rx, cy - ry * k)} ${r(cx + rx, cy)} Z`
  );
}

function drawPaper(pdf: PDFPage, paper: Paper, pw: number, ph: number, py: PyFn): void {
  const ink = PAPER[paper.color];
  pdf.drawRectangle({ x: 0, y: 0, width: px(pw), height: px(ph), color: color(ink.bg) });
  const gap = SPACING[paper.spacing];
  const rule = color(ink.rule);
  const line = (x1: number, y1: number, x2: number, y2: number): void =>
    pdf.drawLine({ start: { x: px(x1), y: py(y1) }, end: { x: px(x2), y: py(y2) }, thickness: 0.75, color: rule });
  if (paper.template === 'ruled') {
    for (let y = gap * 1.5; y < ph - 4; y += gap) line(0, y, pw, y);
  } else if (paper.template === 'grid') {
    for (let x = gap; x < pw; x += gap) line(x, 0, x, ph);
    for (let y = gap; y < ph; y += gap) line(0, y, pw, y);
  } else if (paper.template === 'dot') {
    for (let x = gap; x < pw; x += gap) {
      for (let y = gap; y < ph; y += gap) pdf.drawCircle({ x: px(x), y: py(y), size: 1.3 * SCALE, color: rule });
    }
  }
}

async function embedDataUrl(doc: PDFDocument, src: string): Promise<Awaited<ReturnType<PDFDocument['embedPng']>>> {
  if (src.startsWith('data:image/jpeg') || src.startsWith('data:image/jpg')) return doc.embedJpg(src);
  if (src.startsWith('data:image/png')) return doc.embedPng(src);
  // anything else (SVG, GIF, WebP…): rasterise through a canvas
  const img = await loadImage(src);
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  c.getContext('2d')?.drawImage(img, 0, 0);
  return doc.embedPng(c.toDataURL('image/png'));
}

/** Greedy word wrap with the PDF font's own metrics, so lines break as they will print. */
function wrapPdf(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const fits = (s: string): boolean => font.widthOfTextAtSize(s, size) <= maxWidth;
  const lines: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(' ')) {
      const test = line ? `${line} ${word}` : word;
      if (fits(test)) {
        line = test;
        continue;
      }
      if (line) lines.push(line);
      line = '';
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
  return lines;
}

function drawTextEl(pdf: PDFPage, el: TextElement, paper: Paper, font: PDFFont, py: PyFn): void {
  const size = el.fontSize * SCALE;
  const lineHeight = el.fontSize * TEXT_LINE_HEIGHT;
  const lead = (lineHeight - el.fontSize) / 2;
  const ascent = el.fontSize * 0.78; // Helvetica cap-height + a little — lands the baseline where the canvas does
  const lines = wrapPdf(el.text, font, size, el.w * SCALE);
  const cx = el.x + el.w / 2;
  const cy = el.y + el.h / 2;
  const ink = color(resolveInkColor(el.color, paper));
  lines.forEach((line, i) => {
    if (!line) return;
    const [bx, by] = rotateAround(el.x, el.y + i * lineHeight + lead + ascent, cx, cy, el.rotation);
    pdf.drawText(line.replace(/[^\x20-\x7e -ÿ]/g, '?'), {
      x: px(bx),
      y: py(by),
      size,
      font,
      color: ink,
      rotate: degrees((-el.rotation * 180) / Math.PI),
    });
  });
}

function drawShapeEl(pdf: PDFPage, el: ShapeElement, paper: Paper, py: PyFn): void {
  const ink = color(resolveInkColor(el.color, paper));
  const thickness = el.size * SCALE;
  const cx = el.x + el.w / 2;
  const cy = el.y + el.h / 2;
  const R = (x: number, y: number): number[] => rotateAround(x, y, cx, cy, el.rotation);
  const seg = (a: number[], b: number[]): void =>
    pdf.drawLine({
      start: { x: px(a[0]), y: py(a[1]) },
      end: { x: px(b[0]), y: py(b[1]) },
      thickness,
      color: ink,
      lineCap: LineCapStyle.Round,
    });
  switch (el.shape) {
    case 'rect':
      pdf.drawSvgPath(polygonPath([R(el.x, el.y), R(el.x + el.w, el.y), R(el.x + el.w, el.y + el.h), R(el.x, el.y + el.h)]), {
        x: 0,
        y: py(0),
        scale: SCALE,
        borderColor: ink,
        borderWidth: thickness,
        borderLineCap: LineCapStyle.Round,
      });
      break;
    case 'ellipse':
      pdf.drawSvgPath(ellipsePath(el), { x: 0, y: py(0), scale: SCALE, borderColor: ink, borderWidth: thickness });
      break;
    case 'triangle':
      pdf.drawSvgPath(polygonPath((el.pts ?? [[0.5, 0], [1, 1], [0, 1]]).map(([fx, fy]) => R(el.x + fx * el.w, el.y + fy * el.h))), {
        x: 0,
        y: py(0),
        scale: SCALE,
        borderColor: ink,
        borderWidth: thickness,
        borderLineCap: LineCapStyle.Round,
      });
      break;
    case 'line':
      seg(R(el.x, cy), R(el.x + el.w, cy));
      break;
    case 'arrow': {
      const head = Math.max(el.size * 4, 12);
      const tipX = el.x + el.w;
      seg(R(el.x, cy), R(tipX, cy));
      seg(R(tipX - head * Math.cos(Math.PI / 6), cy - head * Math.sin(Math.PI / 6)), R(tipX, cy));
      seg(R(tipX - head * Math.cos(Math.PI / 6), cy + head * Math.sin(Math.PI / 6)), R(tipX, cy));
      break;
    }
  }
}

async function drawElementPdf(doc: PDFDocument, pdf: PDFPage, el: PageElement, paper: Paper, font: PDFFont, py: PyFn): Promise<void> {
  const cx = el.x + el.w / 2;
  const cy = el.y + el.h / 2;
  switch (el.kind) {
    case 'text':
      drawTextEl(pdf, el, paper, font, py);
      break;
    case 'shape':
      drawShapeEl(pdf, el, paper, py);
      break;
    case 'tape':
      pdf.drawSvgPath(
        polygonPath([
          rotateAround(el.x, el.y, cx, cy, el.rotation),
          rotateAround(el.x + el.w, el.y, cx, cy, el.rotation),
          rotateAround(el.x + el.w, el.y + el.h, cx, cy, el.rotation),
          rotateAround(el.x, el.y + el.h, cx, cy, el.rotation),
        ]),
        { x: 0, y: py(0), scale: SCALE, color: color(el.color), borderColor: rgb(0, 0, 0), borderWidth: 0.75, borderOpacity: 0.25 }
      );
      break;
    case 'image': {
      const img = await embedDataUrl(doc, el.src);
      // pdf-lib rotates an image about its bottom-left corner, so place that corner where it ends up after rotating about the box centre
      const [blx, bly] = rotateAround(el.x, el.y + el.h, cx, cy, el.rotation);
      pdf.drawImage(img, {
        x: px(blx),
        y: py(bly),
        width: el.w * SCALE,
        height: el.h * SCALE,
        rotate: degrees((-el.rotation * 180) / Math.PI),
      });
      break;
    }
  }
}

async function addPage(doc: PDFDocument, page: Page, font: PDFFont): Promise<void> {
  await preloadPageImages(page);
  const pw = pageW(page);
  const ph = pageH(page);
  const py: PyFn = (y) => (ph - y) * SCALE;
  const pdf = doc.addPage([px(pw), px(ph)]);
  drawPaper(pdf, page.paper, pw, ph, py);
  if (page.background) {
    // a v5 image background embeds as-is; a stored-PDF page is rendered (already cached by preloadPageImages) and embedded as JPEG.
    // A PDF-imported page's own w/h already match this image's aspect ratio
    // (see pdf-import.ts), so this fills edge-to-edge same as the on-screen
    // full-bleed rendering (canvas/elements.ts's drawBackground) — a legacy
    // v5 image background (rarely a whole-page aspect match) still contains
    // within the default-sized page as before.
    const bmp = backgroundBitmap(page.background);
    const src = page.background.src ?? (bmp ? (bmp.source as HTMLCanvasElement).toDataURL('image/jpeg', 0.85) : null);
    if (src) {
      const img = await embedDataUrl(doc, src);
      const s = Math.min(pw / img.width, ph / img.height);
      const w = img.width * s;
      const h = img.height * s;
      pdf.drawImage(img, { x: px((pw - w) / 2), y: py((ph - h) / 2 + h), width: w * SCALE, height: h * SCALE });
    }
  }
  for (const it of store.itemsOf(page.id)) {
    if (isStroke(it)) {
      const hi = it.tool === 'highlighter';
      pdf.drawSvgPath(polygonPath(strokeOutline(it.points, it.size, hi)), {
        x: 0,
        y: py(0),
        scale: SCALE,
        color: color(resolveInkColor(it.color, page.paper)),
        opacity: hi ? HIGHLIGHTER_ALPHA : 1,
      });
    } else {
      await drawElementPdf(doc, pdf, it, page.paper, font, py);
    }
  }
}

/**
 * Builds a PDF of the given pages (vector strokes, text, shapes and paper;
 * images and PDF backgrounds embedded as bitmaps) and downloads it.
 */
export async function exportPdf(nb: Notebook, pages: Page[], fileName: string): Promise<void> {
  const doc = await PDFDocument.create();
  doc.setTitle(nb.name);
  doc.setProducer('DubNotes');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const page of pages) await addPage(doc, page, font);
  const bytes = new Uint8Array(await doc.save()); // copy onto a plain ArrayBuffer so Blob accepts it
  downloadBlob(`${safeFileName(fileName)}.pdf`, new Blob([bytes], { type: 'application/pdf' }));
}
