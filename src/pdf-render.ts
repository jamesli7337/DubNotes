import { PAGE_H } from './const';
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
/** Target size (page units) for a rendered PDF page's *longer* side — same
 *  physical scale as the app's default portrait page (whose longer side is
 *  PAGE_H), but applied to whichever side is actually longest so a landscape
 *  source page (imported at matching notebook-page proportions — see
 *  pdf-import.ts) gets rendered at full resolution too, instead of being
 *  bounded by a fixed portrait-shaped box. */
const RENDER_TARGET = PAGE_H;

/**
 * pdf.js 6.x decodes JBIG2 and CCITT-fax images (both share the same
 * decoder) and JPEG2000 through WASM modules it fetches on demand from this
 * base directory (see scripts/copy-pdfjs-wasm.mjs, which copies them out of
 * node_modules/pdfjs-dist/wasm at predev/prebuild so they're served at a
 * stable, un-hashed path `wasmUrl` can append its own filenames to). Without
 * this option, pdf.js can't load those decoders — and instead of throwing,
 * `page.render()` resolves "successfully" having silently painted nothing.
 */
const PDFJS_WASM_URL = `${import.meta.env.BASE_URL}pdfjs-wasm/`;

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
      return lib.getDocument({ data: new Uint8Array(asset.data.slice(0)), wasmUrl: PDFJS_WASM_URL }).promise;
    })();
    docs.set(assetId, p);
    p.catch(() => docs.delete(assetId)); // let a failed load be retried later
  }
  return p;
}

/**
 * Registers a PDF that is *not* an entry in the app's `assets` store, so it
 * can be rendered by the same pipeline as one that is.
 *
 * `document()` above can only reach a PDF that lives in the notebook database
 * (via `getAsset`). The split pane's reference PDFs deliberately do not live
 * there — they belong to the pane, not to any notebook, and must stay out of
 * `exportAll`'s backup sweep — so they hand their bytes in here instead, under
 * a key of the caller's choosing. Everything downstream (`ensurePdfPage`,
 * `getPdfPage`, `isPdfPageFailed`, the rendered-page LRU, the blank-render
 * backstop, the failure memo) then works on that key exactly as it does on an
 * asset id, with no other behaviour change and nothing new for existing
 * callers to care about.
 *
 * Idempotent: registering an already-known key keeps the parsed document.
 * Pair with `releasePdfBytes` when the caller is finished with it.
 */
export function registerPdfBytes(key: string, data: ArrayBuffer): void {
  if (docs.has(key)) return;
  const p = (async () => {
    const lib = await pdfjs();
    return lib.getDocument({ data: new Uint8Array(data.slice(0)), wasmUrl: PDFJS_WASM_URL }).promise;
  })();
  docs.set(key, p);
  p.catch(() => docs.delete(key)); // let a failed load be retried later, same as document()
}

/** True once `registerPdfBytes` has been called for `key` and not released since. */
export function hasPdfBytes(key: string): boolean {
  return docs.has(key);
}

/** Forgets a document registered by `registerPdfBytes`, along with its rendered pages and failure memo. */
export function releasePdfBytes(key: string): void {
  const doc = docs.get(key);
  docs.delete(key);
  // `cleanup()` frees the parsed page data; the worker-side document is
  // collected once nothing references the proxy
  void doc?.then((d) => d.cleanup()).catch(() => undefined);
  for (const k of [...rendered.keys()]) if (k.startsWith(`${key}#`)) rendered.delete(k);
  for (const k of [...failed]) if (k.startsWith(`${key}#`)) failed.delete(k);
}

/**
 * Each page's own size in PDF points (its viewport at scale 1). The split
 * pane lays a reference PDF out in these units directly, rather than fitting
 * every page into the app's own page box the way an import does.
 */
export async function pdfPageSizes(key: string): Promise<Array<{ w: number; h: number }>> {
  const doc = await document(key);
  const out: Array<{ w: number; h: number }> = [];
  for (let i = 1; i <= doc.numPages; i++) {
    try {
      const p = await doc.getPage(i);
      const vp = p.getViewport({ scale: 1 });
      out.push({ w: vp.width, h: vp.height });
      p.cleanup();
    } catch {
      out.push({ w: 612, h: 792 }); // a page whose size can't be read falls back to US Letter
    }
  }
  return out;
}

const rendered = new Map<string, HTMLCanvasElement>(); // insertion order = age
const inFlight = new Map<string, Promise<HTMLCanvasElement>>();
const key = (assetId: string, page: number): string => `${assetId}#${page}`;

/**
 * True if every sampled pixel is (near-)white, i.e. nothing but the pre-fill
 * survived the render. pdf.js can resolve `render().promise` successfully
 * while having silently failed to paint an image it can't decode (seen with
 * certain CCITT-fax-encoded scans — no exception, no rejected promise, just
 * an empty page) — this is the general backstop for that whole class of
 * failure, not specific to CCITT. Sampled on a stride rather than every pixel
 * (a full page canvas can be a few megapixels) since a real failure leaves
 * the *entire* canvas untouched, so a stride can't miss it.
 */
function looksBlank(ctx: CanvasRenderingContext2D, width: number, height: number): boolean {
  const { data } = ctx.getImageData(0, 0, width, height);
  const stride = 4 * 97; // steps by 97 pixels; prime-ish so it doesn't alias a regular pattern
  for (let i = 0; i < data.length; i += stride) {
    if (data[i] < 250 || data[i + 1] < 250 || data[i + 2] < 250) return false;
  }
  return true;
}

async function render(assetId: string, page: number): Promise<HTMLCanvasElement> {
  const doc = await document(assetId);
  const p = await doc.getPage(page);
  const base = p.getViewport({ scale: 1 });
  const scale = (RENDER_TARGET * RENDER_DPR) / Math.max(base.width, base.height);
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
  if (looksBlank(ctx, c.width, c.height)) {
    throw new Error(`PDF page ${page} rendered blank (an image on it may use an unsupported codec)`);
  }
  return c;
}

/** Pages that failed to render (an exception, or looksBlank) — remembered so a permanently-broken page isn't retried forever. */
const failed = new Set<string>();

/** True once a page has been tried and failed (see `failed`'s own doc comment). */
export function isPdfPageFailed(assetId: string, page: number): boolean {
  return failed.has(key(assetId, page));
}

/** Resolves with the rendered page (cached), or rejects if it failed to render (also cached — see `failed`). */
export function ensurePdfPage(assetId: string, page: number): Promise<HTMLCanvasElement> {
  const k = key(assetId, page);
  const hit = rendered.get(k);
  if (hit) return Promise.resolve(hit);
  if (failed.has(k)) return Promise.reject(new Error('PDF page previously failed to render'));
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
      .catch((err) => {
        failed.add(k);
        throw err;
      })
      .finally(() => inFlight.delete(k));
    inFlight.set(k, p);
  }
  return p;
}

/**
 * Synchronous accessor for painting: the rendered page if it is ready, else
 * null — `onReady` fires once rendering settles, whether it succeeded (call
 * `getPdfPage` again to get the bitmap) or failed (call `isPdfPageFailed` to
 * tell a genuine failure apart from "still loading").
 */
export function getPdfPage(assetId: string, page: number, onReady?: () => void): HTMLCanvasElement | null {
  const hit = rendered.get(key(assetId, page));
  if (hit) {
    // touch: keep pages that are still being looked at from being evicted
    rendered.delete(key(assetId, page));
    rendered.set(key(assetId, page), hit);
    return hit;
  }
  if (failed.has(key(assetId, page))) return null;
  const p = ensurePdfPage(assetId, page);
  if (onReady) p.then(onReady, onReady);
  return null;
}
