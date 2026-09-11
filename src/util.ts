import type { PageItem, Stroke } from './types';

export const uid = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Strokes carry raw points; every element carries a `kind`. */
export const isStroke = (item: PageItem): item is Stroke => 'points' in item;

function distToSegmentSq(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return (px - cx) ** 2 + (py - cy) ** 2;
}

/** True if (x, y) is within `tol` of the polyline defined by `pts`. */
export function nearPolyline(x: number, y: number, pts: number[][], tol: number): boolean {
  const t2 = tol * tol;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    if ((x - a[0]) ** 2 + (y - a[1]) ** 2 <= t2) return true;
    const b = pts[i + 1];
    if (b && distToSegmentSq(x, y, a[0], a[1], b[0], b[1]) <= t2) return true;
  }
  return false;
}

export function download(name: string, text: string, type = 'application/json'): void {
  downloadBlob(name, new Blob([text], { type }));
}

export function downloadBlob(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A string safe to use as a download file name. */
export function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim() || 'notebook';
}

export function timestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}
