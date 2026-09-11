import { PAGE_H, PAGE_W } from './const';
import { getAsset } from './db';

/**
 * On-demand rendering of stored PDF assets. Documents are parsed once per
 * session and pages are rendered into canvases when first needed, kept in a
 * small in-memory cache (a rendered page is ~14 MB of pixels at 2×), so a
 * long PDF costs memory only for the pages near the viewport.
 */

type PdfJs = typeof import('pdfjs-dist');
type PdfDoc = Awaited<ReturnType<PdfJs['getDocument']>['promise']>;

/** Rendered pages kept around; mounted pages are ~3–4 at a time. */
const CACHE_MAX = 8;
/** Render scale: crisp at 2× on high-DPR screens, never more. */
const RENDER_DPR = Math.min(Math.max(window.devicePixelRatio || 1, 1), 2);

let pdfjsPromise: Promise<PdfJs> | null = null;
function pdfjs(): Promise<PdfJs> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const lib = await import('pdfjs-dist');
      const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
      lib.GlobalWorkerOptions.workerSrc = worker.default;
      return lib;
    })();
  }
  return pdfjsPromise;
}

const docs = new Map<string, Promise<PdfDoc>>();
function document(assetId: string): Promise<PdfDoc> {
  let p = docs.get(assetId);
  if (!p) {
    p = (async () => {
      const [lib, asset] = await Promise.all([pdfjs(), getAsset(assetId)]);
      if (!asset) throw new Error('PDF asset not found');
      return lib.getDocument({ data: new Uint8Array(asset.data.slice(0)) }).promise;
    })();
    docs.set(assetId, p);
    p.catch(() => docs.delete(assetId)); // let a failed load be retried later
  }
  return p;
}

const rendered = new Map<string, HTMLCanvasElement>(); // insertion order = age
const inFlight = new Map<string, Promise<HTMLCanvasElement>>();
const key = (assetId: string, page: number): string => `${assetId}#${page}`;

async function render(assetId: string, page: number): Promise<HTMLCanvasElement> {
  const doc = await document(assetId);
  const p = await doc.getPage(page);
  const base = p.getViewport({ scale: 1 });
  const scale = Math.min((PAGE_W * RENDER_DPR) / base.width, (PAGE_H * RENDER_DPR) / base.height);
  const viewport = p.getViewport({ scale });
  const c = window.document.createElement('canvas');
  c.width = Math.ceil(viewport.width);
  c.height = Math.ceil(viewport.height);
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('Could not create a canvas.');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, c.width, c.height);
  await p.render({ canvas: c, canvasContext: ctx, viewport }).promise;
  p.cleanup();
  return c;
}

/** Resolves with the rendered page (cached). */
export function ensurePdfPage(assetId: string, page: number): Promise<HTMLCanvasElement> {
  const k = key(assetId, page);
  const hit = rendered.get(k);
  if (hit) return Promise.resolve(hit);
  let p = inFlight.get(k);
  if (!p) {
    p = render(assetId, page)
      .then((c) => {
        rendered.delete(k);
        rendered.set(k, c);
        while (rendered.size > CACHE_MAX) {
          const oldest = rendered.keys().next().value;
          if (oldest === undefined) break;
          rendered.delete(oldest);
        }
        return c;
      })
      .finally(() => inFlight.delete(k));
    inFlight.set(k, p);
  }
  return p;
}

/**
 * Synchronous accessor for painting: the rendered page if it is ready, else
 * null — and `onReady` fires once it is (or never, if rendering fails).
 */
export function getPdfPage(assetId: string, page: number, onReady?: () => void): HTMLCanvasElement | null {
  const hit = rendered.get(key(assetId, page));
  if (hit) {
    // touch: keep pages that are still being looked at from being evicted
    rendered.delete(key(assetId, page));
    rendered.set(key(assetId, page), hit);
    return hit;
  }
  const p = ensurePdfPage(assetId, page);
  if (onReady) p.then(onReady, () => undefined);
  return null;
}
