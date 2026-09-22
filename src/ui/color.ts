import { AUTO_COLOR } from '../canvas/freehand';
import { el } from './dom';
import { icon } from './icon';
import { openAnchoredModal, type Modal } from './dialog';

/** Deleted presets offered back at the top of the picker (see buildSwatches' "+" handler) — clicking one restores it instead of opening the hue/sat editor. */
export interface RestorableColors {
  colors: string[];
  onRestore: (color: string) => void;
}

// ------------------------------------------------------------ conversions
export function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex(r: number, g: number, b: number): string {
  const h = (v: number): string => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** h 0–360, s 0–1, v 0–1 → 0–255 rgb */
export function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

export function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  if (h < 0) h += 360;
  return [h, max ? d / max : 0, max];
}

// ----------------------------------------------------------------- picker
/**
 * Hue strip + saturation/value square + hex field. Resolves with the chosen
 * hex when "Add colour" is pressed, or null when dismissed. Anchored to the
 * dock button that opened it.
 */
export function pickColor(anchor: HTMLElement, initial: string, restorable?: RestorableColors): Promise<string | null> {
  return new Promise((resolve) => {
    const start = hexToRgb(initial) ?? [37, 99, 235];
    let [h, s, v] = rgbToHsv(...start);

    const panel = el('div', { class: 'cpick' });
    const sv = el('canvas', { class: 'cpick__sv', width: '220', height: '150', 'aria-label': 'Saturation and value' }) as HTMLCanvasElement;
    const svDot = el('span', { class: 'cpick__dot' });
    const svWrap = el('div', { class: 'cpick__svwrap' });
    svWrap.append(sv, svDot);
    const hue = el('input', {
      type: 'range',
      class: 'cpick__hue',
      min: '0',
      max: '360',
      step: '1',
      value: String(Math.round(h)),
      'aria-label': 'Hue',
    }) as HTMLInputElement;
    const hex = el('input', {
      type: 'text',
      class: 'dlg__input cpick__hex',
      maxlength: '7',
      spellcheck: 'false',
      autocomplete: 'off',
      'aria-label': 'Hex colour',
    }) as HTMLInputElement;
    const preview = el('span', { class: 'cpick__preview' });
    const add = el('button', { class: 'primary cpick__add', text: 'Add colour' });
    add.prepend(icon('plus', 'sm'));

    const current = (): string => rgbToHex(...hsvToRgb(h, s, v));
    const paintSquare = (): void => {
      const ctx = sv.getContext('2d');
      if (!ctx) return;
      const [r, g, b] = hsvToRgb(h, 1, 1);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(0, 0, sv.width, sv.height);
      const white = ctx.createLinearGradient(0, 0, sv.width, 0);
      white.addColorStop(0, 'rgba(255,255,255,1)');
      white.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = white;
      ctx.fillRect(0, 0, sv.width, sv.height);
      const black = ctx.createLinearGradient(0, 0, 0, sv.height);
      black.addColorStop(0, 'rgba(0,0,0,0)');
      black.addColorStop(1, 'rgba(0,0,0,1)');
      ctx.fillStyle = black;
      ctx.fillRect(0, 0, sv.width, sv.height);
    };
    const sync = (fromHex = false): void => {
      if (!fromHex) hex.value = current();
      preview.style.background = current();
      svDot.style.left = `${s * 100}%`;
      svDot.style.top = `${(1 - v) * 100}%`;
      hue.value = String(Math.round(h));
      hue.style.setProperty('--hue-thumb', `hsl(${h} 100% 50%)`);
    };

    const pickSv = (e: PointerEvent): void => {
      const r = sv.getBoundingClientRect();
      s = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      v = 1 - Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
      sync();
    };
    let dragging = false;
    svWrap.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      dragging = true;
      svWrap.setPointerCapture(e.pointerId);
      pickSv(e);
    });
    svWrap.addEventListener('pointermove', (e) => {
      if (dragging) pickSv(e);
    });
    const stop = (): void => {
      dragging = false;
    };
    svWrap.addEventListener('pointerup', stop);
    svWrap.addEventListener('pointercancel', stop);
    hue.addEventListener('input', () => {
      h = parseFloat(hue.value);
      paintSquare();
      sync();
    });
    hex.addEventListener('input', () => {
      const rgb = hexToRgb(hex.value.startsWith('#') ? hex.value : `#${hex.value}`);
      if (!rgb) return;
      [h, s, v] = rgbToHsv(...rgb);
      paintSquare();
      sync(true);
    });

    let settled = false;
    let modal: Modal | null = null;
    const finish = (val: string | null): void => {
      if (settled) return;
      settled = true;
      resolve(val);
      modal?.close();
    };
    add.addEventListener('click', () => finish(current()));
    hex.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(current());
      }
    });

    const row = el('div', { class: 'cpick__row' });
    row.append(preview, hex);
    if (restorable && restorable.colors.length) {
      panel.append(el('span', { class: 'hint', text: 'Restore a deleted colour' }));
      const restoreRow = el('div', { class: 'cpick__restore' });
      for (const c of restorable.colors) {
        const isAuto = c === AUTO_COLOR;
        const b = el('button', {
          class: 'swatch' + (isAuto ? ' swatch--auto' : ''),
          style: isAuto ? '' : `background:${c}`,
          title: isAuto ? 'Restore Auto' : `Restore ${c}`,
          'aria-label': isAuto ? 'Restore Auto ink' : `Restore ${c}`,
        });
        b.addEventListener('click', () => {
          restorable.onRestore(c);
          finish(null);
        });
        restoreRow.append(b);
      }
      panel.append(restoreRow);
    }
    panel.append(svWrap, hue, row, add);
    paintSquare();
    sync();
    modal = openAnchoredModal(anchor, panel, { onClose: () => finish(null) });
    // a repeat tap on the same "add colour" button while its picker is open
    // closes the existing one (openAnchoredModal above) rather than opening a
    // second — that existing picker's own onClose settles its promise, but
    // *this* call's promise still needs settling since nothing opened for it.
    if (!modal) finish(null);
  });
}
