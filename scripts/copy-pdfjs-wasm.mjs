/* Copies pdfjs-dist's WASM decoders (JBIG2/CCITT-fax, OpenJPEG, qcms) into
 * public/pdfjs-wasm/ so they're served at a stable URL (see pdf-render.ts's
 * and pdf-import.ts's `wasmUrl` option) instead of Vite's hashed asset names,
 * which `wasmUrl` — a directory pdf.js appends its own filenames to — can't
 * use. Always overwrites, so an upgraded pdfjs-dist's WASM never goes stale.
 * Run: node scripts/copy-pdfjs-wasm.mjs  (also runs automatically before dev/build) */
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'node_modules', 'pdfjs-dist', 'wasm');
const OUT = join(ROOT, 'public', 'pdfjs-wasm');

mkdirSync(OUT, { recursive: true });
const files = readdirSync(SRC).filter((f) => f.endsWith('.wasm'));
for (const f of files) copyFileSync(join(SRC, f), join(OUT, f));
console.log(`copy-pdfjs-wasm: copied ${files.length} file(s) to ${OUT}`);
