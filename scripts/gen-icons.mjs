/* Generates public/icons/ from assets/app-icon-source.jpg.
 *
 * The generated PNGs are committed, and this script exits immediately when they
 * are all present — which is the case in predev/prebuild and in CI, so the
 * normal build never depends on anything below. It only actually renders when
 * an icon is missing, or when FORCE_ICONS=1 asks for a rebuild after the source
 * image or a crop box changes.
 *
 * Rendering needs a browser: this project has no image library (and shouldn't
 * grow one just for this), so the decode/crop/resample runs in headless Chrome
 * over CDP — the same tool the project already uses to verify behaviour. Set
 * CHROME_PATH if Chrome isn't in one of the standard locations.
 *
 * Run: node scripts/gen-icons.mjs        (skips if the icons are present)
 *      FORCE_ICONS=1 node scripts/gen-icons.mjs   (re-render from the source)
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public', 'icons');
const SOURCE = join(ROOT, 'assets', 'app-icon-source.jpg');

/* Crop boxes into the source image's own pixel grid (3024x4032).
 *  tight — the shipped square: the subject's head fills the frame, with
 *          headroom above so iOS's rounded corners take only background.
 *  safe  — the `maskable` variant: same subject pulled back to the full source
 *          width, so `tight`'s framing is what survives Android's inner-80%
 *          safe-zone circle instead of being cropped into. */
const CROPS = {
  tight: { x: 0, y: 250, s: 2800 },
  safe: { x: 0, y: 0, s: 3024 },
};

/* The icon set, matching what index.html and manifest.webmanifest reference.
 *  - apple-touch-icon.png 180: iOS/iPadOS home screen (the 180 retina size;
 *    iPadOS scales it for the few other slots it wants).
 *  - icon-192 / icon-512: the manifest's `any` icons.
 *  - icon-512-maskable: the manifest's `maskable` icon. */
const TARGETS = [
  ['icon-192.png', 192, 'tight'],
  ['icon-512.png', 512, 'tight'],
  ['apple-touch-icon.png', 180, 'tight'],
  ['icon-512-maskable.png', 512, 'safe'],
];

const missing = TARGETS.filter(([name]) => !existsSync(join(OUT, name))).map(([name]) => name);
if (!missing.length && !process.env.FORCE_ICONS) {
  console.log('gen-icons: icons already present');
  process.exit(0);
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean);
  const hit = candidates.find((p) => existsSync(p));
  if (!hit) {
    throw new Error(
      `gen-icons: need Chrome to render ${missing.join(', ') || 'the icons'} from ${SOURCE}.\n` +
        'Set CHROME_PATH, or restore the committed PNGs in public/icons/ (git checkout public/icons).'
    );
  }
  return hit;
}

if (!existsSync(SOURCE)) throw new Error(`gen-icons: missing source image ${SOURCE}`);

const PORT = 9222 + (process.pid % 500);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Draws one square crop of the source down to `size`, halving in steps so the
 * ~2800px -> 180px reduction doesn't alias, onto an opaque background. The fill
 * matters: it guarantees the PNG has no transparent pixels at all, so iOS can
 * never composite the home-screen icon's edges against black. */
const PAGE = (jpgBase64) => `<!doctype html><meta charset=utf-8><body><script>
window.__img = new Image();
window.__ready = new Promise(r => { __img.onload = () => r([__img.naturalWidth, __img.naturalHeight]); });
__img.src = 'data:image/jpeg;base64,${jpgBase64}';
window.render = function (crop, size) {
  let cur = document.createElement('canvas');
  cur.width = cur.height = crop.s;
  cur.getContext('2d').drawImage(__img, crop.x, crop.y, crop.s, crop.s, 0, 0, crop.s, crop.s);
  let w = crop.s;
  while (w / 2 > size) {
    const next = document.createElement('canvas');
    next.width = next.height = Math.floor(w / 2);
    const c = next.getContext('2d');
    c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'high';
    c.drawImage(cur, 0, 0, next.width, next.height);
    cur = next; w = next.width;
  }
  const out = document.createElement('canvas');
  out.width = out.height = size;
  const g = out.getContext('2d');
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  g.fillStyle = '#faf9f4'; g.fillRect(0, 0, size, size);
  g.drawImage(cur, 0, 0, size, size);
  return out.toDataURL('image/png');
};
</script>`;

let msgId = 0;
function send(ws, method, params) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    const on = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== id) return;
      ws.removeEventListener('message', on);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    };
    ws.addEventListener('message', on);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(ws, expression) {
  const r = await send(ws, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
}

const chromePath = findChrome();
const profile = mkdtempSync(join(tmpdir(), 'dubnotes-icons-'));
const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${PORT}`,
    'about:blank',
  ],
  { stdio: 'ignore' }
);

try {
  let wsUrl;
  for (let i = 0; i < 80 && !wsUrl; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      wsUrl = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl;
    } catch {
      /* not listening yet */
    }
    if (!wsUrl) await sleep(250);
  }
  if (!wsUrl) throw new Error('gen-icons: headless Chrome did not start');

  const ws = new WebSocket(wsUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));

  const html = PAGE(readFileSync(SOURCE).toString('base64'))
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$');
  await evaluate(ws, `document.open(); document.write(\`${html}\`); document.close(); 1`);
  const [sw, sh] = await evaluate(ws, 'window.__ready');

  mkdirSync(OUT, { recursive: true });
  for (const [name, size, which] of TARGETS) {
    const crop = CROPS[which];
    if (crop.x + crop.s > sw || crop.y + crop.s > sh) {
      throw new Error(`gen-icons: ${which} crop falls outside the ${sw}x${sh} source`);
    }
    const dataUrl = await evaluate(ws, `window.render(${JSON.stringify(crop)}, ${size})`);
    writeFileSync(join(OUT, name), Buffer.from(dataUrl.split(',')[1], 'base64'));
  }
  ws.close();
  console.log(`gen-icons: wrote ${TARGETS.length} file(s) to ${OUT}`);
} finally {
  chrome.kill();
  await sleep(300);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    /* Chrome may still hold the profile; it's in the OS temp dir either way */
  }
}
