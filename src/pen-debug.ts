/**
 * TEMPORARY diagnostic logging for the pencil-drops-to-touch investigation.
 * Draws a live, on-screen scrolling log pinned to the bottom of the screen —
 * readable directly on the iPad, no Mac/Safari remote inspector required —
 * and mirrors every line to console.log for whichever is easier to read back.
 *
 * Remove this whole file, its import in page-canvas.ts, and every
 * penDebug(...)/penDebugNote(...) call (search for "pen-debug") once the bug
 * is diagnosed and fixed.
 */

let panel: HTMLElement | null = null;
const lines: string[] = [];
const MAX_LINES = 160;

function ensurePanel(): HTMLElement {
  if (panel) return panel;
  panel = document.createElement('pre');
  panel.id = 'pen-debug-panel';
  panel.style.cssText =
    'position:fixed;left:0;right:0;bottom:0;max-height:40vh;overflow:auto;margin:0;padding:6px 8px;' +
    'font:10px/1.4 ui-monospace,Menlo,Consolas,monospace;background:rgba(0,0,0,.86);color:#5f5;' +
    'z-index:2147483647;white-space:pre-wrap;pointer-events:none;';
  document.body.appendChild(panel);
  return panel;
}

function render(): void {
  const p = ensurePanel();
  p.textContent = lines.join('\n');
  p.scrollTop = p.scrollHeight;
}

function fmt(v: unknown): string {
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2);
  return JSON.stringify(v);
}

function push(line: string): void {
  lines.push(line);
  if (lines.length > MAX_LINES) lines.shift();
  render();
  // eslint-disable-next-line no-console
  console.log('[pen-dbg]', line);
}

/** Logs a pointer event in full: complete pointerId (never shortened), type, pressure, position, plus whatever call-site context is passed (mode, captured id, grace state, ...). */
export function penDebug(tag: string, e: PointerEvent, extra: Record<string, unknown> = {}): void {
  const parts = [
    `t=${performance.now().toFixed(0)}`,
    tag,
    `id=${e.pointerId}`,
    `type=${e.pointerType}`,
    `pressure=${e.pressure.toFixed(2)}`,
    `xy=${Math.round(e.clientX)},${Math.round(e.clientY)}`,
    ...Object.entries(extra).map(([k, v]) => `${k}=${fmt(v)}`),
  ];
  push(parts.join(' '));
}

/** Logs a non-event note — a setPointerCapture/releasePointerCapture call, a touch-action change, a grace-window transition — with whatever context is passed. */
export function penDebugNote(tag: string, extra: Record<string, unknown> = {}): void {
  const parts = [`t=${performance.now().toFixed(0)}`, tag, ...Object.entries(extra).map(([k, v]) => `${k}=${fmt(v)}`)];
  push(parts.join(' '));
}
