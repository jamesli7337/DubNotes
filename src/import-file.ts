import { store } from './store';
import { alertDialog, openModal } from './ui/dialog';
import { el } from './ui/dom';

/** What the "Import file" picker accepts. PDF only for now; image types may follow. */
export const IMPORT_ACCEPT = 'application/pdf,.pdf';

/** Name of the cache the service worker parks a shared file in, and the key it uses (see public/sw.js). */
const SHARE_CACHE = 'noteapp-share';
const SHARE_KEY = 'shared-file';

function isPdf(file: File): boolean {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
}

/**
 * Imports a file the user picked (Files / Google Drive) or shared into the app
 * as a new notebook and opens it. A PDF goes through the PDF-import path: one
 * notebook, one page per PDF page. A blocking progress dialog covers reading
 * and page setup so a large file never looks like a frozen screen.
 */
export async function importFile(file: File, folderId: string | null): Promise<void> {
  if (!isPdf(file)) {
    await alertDialog({ title: "Can't import that file", message: 'Only PDF files can be imported for now.' });
    return;
  }
  const box = el('div', { class: 'dlg' });
  const msg = el('p', { class: 'dlg__msg', text: 'Reading PDF…' });
  box.append(el('h2', { class: 'dlg__title', text: `Importing ${file.name}` }), msg);
  const progress = openModal(box, { dismissable: false });
  try {
    const { importPdf } = await import('./pdf-import'); // pdf.js is loaded only when needed
    const nb = await importPdf(file, (done, total) => {
      msg.textContent = `Preparing page ${done} of ${total}…`;
    });
    if (folderId) store.moveNotebook(nb.id, folderId); // lands in the folder being viewed
    progress.close();
    location.hash = `#/nb/${nb.id}`;
  } catch (err) {
    progress.close();
    await alertDialog({ title: 'Import failed', message: (err as Error).message || undefined });
  }
}

/**
 * Takes the file a share-target launch handed over, if any. The service worker
 * receives the share sheet's POST, parks the file in a cache and redirects to
 * the app with `?shared=1`; this reads it back out (once) as a File.
 */
export async function takeSharedFile(): Promise<File | null> {
  if (!('caches' in window)) return null;
  try {
    const cache = await caches.open(SHARE_CACHE);
    const res = await cache.match(SHARE_KEY);
    if (!res) return null;
    await cache.delete(SHARE_KEY);
    const name = decodeURIComponent(res.headers.get('X-File-Name') || '') || 'Shared.pdf';
    const blob = await res.blob();
    return new File([blob], name, { type: res.headers.get('Content-Type') || blob.type });
  } catch {
    return null;
  }
}
