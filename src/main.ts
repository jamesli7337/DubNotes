import './styles.css';
import { importFile, takeSharedFile } from './import-file';
import { store } from './store';
import { registerSW } from './sw-register';
import { mountLibrary } from './ui/library';
import { mountNotebook } from './ui/notebook';

async function boot(): Promise<void> {
  try {
    await navigator.storage?.persist?.();
  } catch {
    /* not fatal */
  }

  await store.init();

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') store.flushNow();
  });
  window.addEventListener('pagehide', () => store.flushNow());
  window.addEventListener('hashchange', route);

  route();
  registerSW();

  // launched from the share sheet ("Open in NoteApp" on a PDF): the service
  // worker has parked the file and sent us here with ?shared=1
  if (new URLSearchParams(location.search).has('shared')) {
    history.replaceState(null, '', location.pathname + location.hash); // a reload must not re-import
    const file = await takeSharedFile();
    if (file) await importFile(file, null);
  }
}

function route(): void {
  const app = document.getElementById('app');
  if (!app) return;
  const m = location.hash.match(/^#\/nb\/([^/]+)/);
  const f = location.hash.match(/^#\/f\/([^/]+)/);
  if (m && store.notebooks.has(m[1])) {
    mountNotebook(app, m[1]);
  } else if (f && store.folders.has(f[1])) {
    mountLibrary(app, f[1]);
  } else {
    if (location.hash && location.hash !== '#/') {
      location.hash = '#/';
      return; // hashchange fires route() again
    }
    mountLibrary(app, null);
  }
}

void boot();
