/* Generates flat placeholder PNG icons into public/icons/ with zero deps.
 * Run: node scripts/gen-icons.mjs  (also runs automatically before dev/build) */
import zlib from 'node:zlib';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

function crc32(buf) {
  let c = ~0 >>> 0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(w, h, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  const stride = w * 4;
  const raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

function icon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const bg = [79, 70, 229];
  const page = [255, 255, 255];
  const rule = [176, 186, 235];

  const px0 = size * 0.24;
  const px1 = size * 0.76;
  const py0 = size * 0.16;
  const py1 = size * 0.84;
  const rad = size * 0.06;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let col = bg;
      if (x >= px0 && x <= px1 && y >= py0 && y <= py1) {
        let inside = true;
        const cx = Math.min(x - px0, px1 - x);
        const cy = Math.min(y - py0, py1 - y);
        if (cx < rad && cy < rad) {
          const dx = rad - cx;
          const dy = rad - cy;
          if (dx * dx + dy * dy > rad * rad) inside = false;
        }
        if (inside) {
          col = page;
          for (const f of [0.36, 0.52, 0.68]) {
            const ly = py0 + (py1 - py0) * f;
            if (Math.abs(y - ly) < size * 0.02 && x > px0 + size * 0.06 && x < px1 - size * 0.06) {
              col = rule;
            }
          }
        }
      }
      const i = (y * size + x) * 4;
      rgba[i] = col[0];
      rgba[i + 1] = col[1];
      rgba[i + 2] = col[2];
      rgba[i + 3] = 255;
    }
  }
  return encodePNG(size, size, rgba);
}

mkdirSync(OUT, { recursive: true });
const targets = [
  ['icon-192.png', 192],
  ['icon-512.png', 512],
  ['apple-touch-icon.png', 180],
];
let wrote = 0;
for (const [name, size] of targets) {
  const path = join(OUT, name);
  if (existsSync(path) && !process.env.FORCE_ICONS) continue;
  writeFileSync(path, icon(size));
  wrote++;
}
console.log(wrote ? `gen-icons: wrote ${wrote} file(s) to ${OUT}` : 'gen-icons: icons already present');
