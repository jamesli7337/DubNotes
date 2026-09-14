import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { putAsset } from './db';
import { store } from './store';
import type { Notebook, PdfAsset } from './types';
import { uid } from './util';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/** Reads a PDF's bytes and page count without rasterising anything. */
async function readPdf(file: File): Promise<{ data: ArrayBuffer; total: number }> {
  const data = await file.arrayBuffer();
  // parse once just to validate the file and count its pages
  const task = pdfjs.getDocument({ data: new Uint8Array(data.slice(0)) });
  const doc = await task.promise;
  const total = doc.numPages;
  await task.destroy();
  return { data, total };
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
  const { data, total } = await readPdf(file);
  const name = file.name.replace(/\.pdf$/i, '').trim() || 'Imported PDF';
  const nb = store.createNotebook(name);
  const asset: PdfAsset = { id: uid(), notebookId: nb.id, kind: 'pdf', name: file.name, pages: total, data };
  await putAsset(asset);

  const first = store.pagesOf(nb.id)[0];
  for (let i = 1; i <= total; i++) {
    const target = i === 1 ? first : store.addPage(nb.id);
    store.setPaper(target.id, { template: 'blank' }, 'page');
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
  const { data, total } = await readPdf(file);
  const asset: PdfAsset = { id: uid(), notebookId, kind: 'pdf', name: file.name, pages: total, data };
  await putAsset(asset);

  for (let i = 1; i <= total; i++) {
    const target = store.addPage(notebookId, afterIndex + i);
    store.setPaper(target.id, { template: 'blank' }, 'page');
    store.setBackground(target.id, { assetId: asset.id, page: i });
    onProgress?.(i, total);
  }
  return total;
}
