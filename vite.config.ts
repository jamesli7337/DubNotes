import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/**
 * Stamps the built asset list into dist/sw.js so the service worker can
 * precache every chunk — including lazily imported ones like pdf-import, whose
 * absence from the cache used to break "Import PDF pages" offline.
 *
 * It rewrites the two `__SW_*__` tokens in public/sw.js (see that file):
 *  - __SW_PRECACHE__: index.html, manifest.webmanifest, every emitted .js/.css
 *    (Vite's fingerprinted chunks and the pdf.js worker .mjs), the un-hashed
 *    pdfjs-wasm/*.wasm copies that scripts/copy-pdfjs-wasm.mjs puts in public/,
 *    and the app icons in public/icons/.
 *  - __SW_BUILD__: a digest of that list plus the bytes of every un-fingerprinted
 *    entry (WASM, icons, manifest), which names the
 *    cache. Because it lands in sw.js itself, the file's bytes change on every
 *    deploy that changes an asset — that byte diff is what makes the browser
 *    pick up the new worker at all.
 * Runs in closeBundle, after Vite has copied public/ into dist/.
 */
function swPrecache(): Plugin {
  let emitted: string[] = [];
  return {
    name: 'sw-precache',
    apply: 'build',
    writeBundle(_options, bundle) {
      // .mjs matters: pdfjs-dist's worker is emitted as pdf.worker.min-*.mjs
      emitted = Object.keys(bundle).filter((f) => /\.(js|mjs|css)$/.test(f));
    },
    closeBundle() {
      const dist = join(process.cwd(), 'dist');
      const wasm = readdirSync(join(dist, 'pdfjs-wasm'))
        .filter((f) => f.endsWith('.wasm'))
        .map((f) => `pdfjs-wasm/${f}`);
      const icons = readdirSync(join(dist, 'icons'))
        .filter((f) => f.endsWith('.png'))
        .map((f) => `icons/${f}`);
      // The app icons and the manifest are precached for the same reason
      // index.html is: they're served from fixed, un-fingerprinted URLs, so the
      // install-time `cache: 'reload'` fetch is the only thing that reliably
      // replaces them (and the icons specifically) on a deploy.
      const list = ['index.html', 'manifest.webmanifest', ...emitted.sort(), ...wasm.sort(), ...icons.sort()];

      const digest = createHash('sha256');
      digest.update(list.join('\n'));
      // hashed names cover the chunks; the WASM, icon and manifest paths never
      // change, so hash their contents too — otherwise a pdfjs upgrade, or a
      // new app icon, would reuse the old cache name and every already-installed
      // client would keep serving the previous file out of cache forever.
      for (const f of [...wasm, ...icons, 'manifest.webmanifest']) digest.update(readFileSync(join(dist, f)));
      const build = digest.digest('hex').slice(0, 12);

      const swPath = join(dist, 'sw.js');
      const src = readFileSync(swPath, 'utf8');
      const tokens: [string, string][] = [
        ["/*__SW_BUILD__*/ 'dev'", JSON.stringify(build)],
        ['/*__SW_PRECACHE__*/ []', JSON.stringify(list)],
      ];
      let out = src;
      for (const [token, value] of tokens) {
        if (!out.includes(token)) throw new Error(`sw-precache: ${token} not found in dist/sw.js`);
        out = out.replace(token, value);
      }
      writeFileSync(swPath, out);
      this.info(`sw-precache: build ${build}, ${list.length} precached asset(s)`);
    },
  };
}

// base: '/DubNotes/' — GitHub Pages serves this project at
// https://<user>.github.io/DubNotes/, so every built asset URL must carry that
// sub-path prefix. Vite bakes `base` into the JS/CSS bundle references in
// dist/index.html and exposes it at runtime as import.meta.env.BASE_URL (used
// by sw-register.ts to register the worker at the right scope); everything
// else (manifest.webmanifest, sw.js, the app's own relative "./" references)
// resolves against the page's own URL, so it follows this automatically.
// Deploying to a different host? Set this back to './' (works at a domain
// root or under any sub-path without rebuilding per-target) or that host's
// own sub-path.
export default defineConfig({
  base: '/DubNotes/',
  plugins: [swPrecache()],
  server: { host: true, port: 5173 },
  preview: { host: true, port: 4173 },
  build: { target: 'es2020', outDir: 'dist' },
});
