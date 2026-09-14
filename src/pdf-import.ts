import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { putAsset } from './db';
import { PAGE_H, PAGE_W } from './const';
import { store } from './store';
import type { Notebook, PdfAsset } from './types';
import { uid } from './util';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/** Same WASM decoders pdf-render.ts points at — see its own doc comment on PDFJS_WASM_URL. */
const PDFJS_WASM_URL = `${import.meta.env.BASE_URL}pdfjs-wasm/`;

/**
 * Converts one PDF page's own point dimensions into this app's page-unit
 * space: same aspect ratio as the source page, but keeping the same total
 * area as the app's default portrait page (w*h stays PAGE_W*PAGE_H) so a
 * landscape import reads as comfortably wide/short rather than being forced
 * into the fixed portrait box — which is what used to cause cropping (see
 * canvas/elements.ts's drawBackground cover-fit). For the app's own default
 * aspect ratio this reduces exactly to {PAGE_W, PAGE_H}.
 */
function notebookPageSize(pdfW: number, pdfH: number): { w: number; h: number } {
  if (!(pdfW > 0) || !(pdfH > 0)) return { w: PAGE_W, h: PAGE_H };
  const aspect = pdfW / pdfH;
  const area = PAGE_W * PAGE_H;
  return { w: Math.round(Math.sqrt(aspect * area)), h: Math.round(Math.sqrt(area / aspect)) };
}

/** Reads a PDF's bytes, page count, and each page's own notebook-page size (see notebookPageSize) without rasterising anything. */
async function readPdf(file: File): Promise<{ data: ArrayBuffer; total: number; sizes: { w: number; h: number }[] }> {
  const data = await file.arrayBuffer();
  // parse once just to validate the file, count its pages, and read each page's own dimensions
  const task = pdfjs.getDocument({ data: new Uint8Array(data.slice(0)), wasmUrl: PDFJS_WASM_URL });
  const doc = await task.promise;
  const total = doc.numPages;
  const sizes: { w: number; h: number }[] = [];
  for (let i = 1; i <= total; i++) {
    try {
      const p = await doc.getPage(i);
      const vp = p.getViewport({ scale: 1 });
      sizes.push(notebookPageSize(vp.width, vp.height));
    } catch {
      sizes.push({ w: PAGE_W, h: PAGE_H }); // a page whose own size can't be read falls back to the default aspect
    }
  }
  await task.destroy();
  return { data, total, sizes };
}

/**
 * Imports a PDF as a new notebook: the file is stored **once** as an asset and
 * each page becomes a notebook page whose background points at that asset +
 * page number, rendered on demand when the page scrolls into view (see
 * pdf-render.ts). Nothing is rasterised at import time, so importing is fast
 * and a long PDF costs its own file size, not one image per page.
 */
export async function importPdf(
  file: File,
  onProgress?: (done: number, total: number) => void
): Promise<Notebook> {
  const { data, total, sizes } = await readPdf(file);
  const name = file.name.replace(/\.pdf$/i, '').trim() || 'Imported PDF';
  const nb = store.createNotebook(name);
  const asset: PdfAsset = { id: uid(), notebookId: nb.id, kind: 'pdf', name: file.name, pages: total, data };
  await putAsset(asset);

  const first = store.pagesOf(nb.id)[0];
  for (let i = 1; i <= total; i++) {
    const target = i === 1 ? first : store.addPage(nb.id);
    store.setPaper(target.id, { template: 'blank' }, 'page');
    store.setPageSize(target.id, sizes[i - 1].w, sizes[i - 1].h);
    store.setBackground(target.id, { assetId: asset.id, page: i });
    onProgress?.(i, total);
  }
  return nb;
}

/**
 * Imports a PDF as new pages appended into an *existing* notebook, right
 * after `afterIndex` — same per-page setup as importPdf (blank paper
 * template + on-demand PDF-page background via a single shared asset), just
 * a different insertion point (append to this notebook vs. create a new
 * one). Returns the number of pages added.
 */
export async function importPdfPages(
  file: File,
  notebookId: string,
  afterIndex: number,
  onProgress?: (done: number, total: number) => void
): Promise<number> {
  const { data, total, sizes } = await readPdf(file);
  const asset: PdfAsset = { id: uid(), notebookId, kind: 'pdf', name: file.name, pages: total, data };
  await putAsset(asset);

  for (let i = 1; i <= total; i++) {
    const target = store.addPage(notebookId, afterIndex + i);
    store.setPaper(target.id, { template: 'blank' }, 'page');
    store.setPageSize(target.id, sizes[i - 1].w, sizes[i - 1].h);
    store.setBackground(target.id, { assetId: asset.id, page: i });
    onProgress?.(i, total);
  }
  return total;
}
