/**
 * BOARD PHASE-0 SPIKE — THROWAWAY. Not part of the app.
 *
 * Reachable only at `#board-spike` (one entry in main.ts's `route`); nothing
 * in the UI links here. Its whole job is to let you feel a 2-D infinite canvas
 * on the iPad before any of it is designed for real: pan and pinch in every
 * direction, ~2000 seeded strokes over a large area, and Pencil drawing in
 * global coordinates with no page and no clamping.
 *
 * Deliberately self-contained:
 *  - nothing here touches `store`, `db`, `toolState` or any notebook state;
 *    every stroke lives in a plain array and dies with the route;
 *  - no CSS is added to styles.css — everything is inline on elements this
 *    file creates;
 *  - the camera/gesture code is a minimal re-implementation, not an import.
 *    NotebookView's own is a set of private methods welded to the dock, the
 *    selection overlay, the scrollbar thumb and AI mode, and prising it out
 *    would mean changing the main view's behaviour, which this spike must not
 *    do. Only the *painting* primitives are shared (`drawStroke`,
 *    `drawTemplate`), which is the part the real thing would reuse anyway.
 *
 * What it is meant to answer: does one viewport-sized canvas, redrawn from
 * items culled to the visible world rect, hold a usable frame rate on iPad —
 * or is tiling needed from the start?
 */
import { drawStroke, type Drawable } from '../canvas/freehand';
import { drawTemplate } from '../canvas/templates';
import { DPR } from '../const';
import type { Paper } from '../types';
import { clamp } from '../util';
import { el } from './dom';

/** One seeded or drawn stroke, plus the bounding box culling tests against. */
interface Item extends Drawable {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const PAPER: Paper = { template: 'grid', spacing: 'medium', color: 'white' };
/**
 * `SPACING_PX.medium` from canvas/templates.ts, which doesn't export it.
 * Duplicated rather than plumbed through, because this is a spike and the
 * only consequence of drift is a grid that shifts phase as you pan — which is
 * exactly the thing being checked here, so it would be obvious immediately.
 */
const GRID_GAP = 38;

/** Matches the main view's own limits so the pinch feels the same. */
const ZOOM_MIN = 0.2;
const ZOOM_MAX = 4;

/**
 * How far the seeded strokes are scattered, in world units, centred on the
 * origin. Sized so a viewport at 100% holds ~50-80 strokes (a realistic
 * page's worth) and zooming out to the floor brings most of the 2000 into
 * view at once — which is the case worth watching the frame time on.
 */
const SEED_SPREAD_X = 6000;
const SEED_SPREAD_Y = 4500;
const SEED_COUNT = 2000;

const SEED_COLORS = ['#1f2530', '#2563eb', '#dc2626', '#059669', '#d97706', '#7c3aed'];

function bounds(points: number[][], size: number): Pick<Item, 'minX' | 'minY' | 'maxX' | 'maxY'> {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[1] > maxY) maxY = p[1];
  }
  // perfect-freehand fattens a stroke by up to about its own size either side
  const pad = size;
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}

function makeItem(points: number[][], tool: 'pen' | 'highlighter', color: string, size: number): Item {
  return { tool, color, size, points, ...bounds(points, size) };
}

/** A deterministic PRNG, so every run seeds the identical board and two runs are comparable. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** ~SEED_COUNT short squiggles scattered over SEED_SPREAD_X × SEED_SPREAD_Y. */
function seedItems(): Item[] {
  const rand = rng(20260929);
  const items: Item[] = [];
  for (let i = 0; i < SEED_COUNT; i++) {
    const cx = (rand() - 0.5) * SEED_SPREAD_X;
    const cy = (rand() - 0.5) * SEED_SPREAD_Y;
    const len = 40 + rand() * 160;
    const ang = rand() * Math.PI * 2;
    const wob = 8 + rand() * 26;
    const n = 8 + Math.floor(rand() * 10);
    const points: number[][] = [];
    for (let j = 0; j < n; j++) {
      const t = j / (n - 1);
      const along = t * len;
      const across = Math.sin(t * Math.PI * (1 + rand() * 2)) * wob;
      points.push([
        cx + Math.cos(ang) * along - Math.sin(ang) * across,
        cy + Math.sin(ang) * along + Math.cos(ang) * across,
        0.4 + rand() * 0.5,
      ]);
    }
    const highlighter = rand() < 0.12;
    items.push(
      makeItem(points, highlighter ? 'highlighter' : 'pen', SEED_COLORS[i % SEED_COLORS.length], highlighter ? 16 : 2 + rand() * 4)
    );
  }
  return items;
}

export function mountBoardSpike(root: HTMLElement): void {
  root.innerHTML = '';

  const wrap = el('div', { class: 'board-spike' });
  wrap.style.cssText = 'position:fixed;inset:0;overflow:hidden;background:#eef1f5;touch-action:none;';

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;';
  wrap.append(canvas);

  const back = el('button', { text: '‹ Library' });
  back.style.cssText =
    'position:absolute;left:12px;top:12px;z-index:2;padding:8px 14px;border-radius:999px;border:0;' +
    'background:rgba(20,26,38,0.82);color:#fff;font:600 14px system-ui;cursor:pointer;';
  back.addEventListener('click', () => {
    location.hash = '#/';
  });

  const readout = el('div');
  readout.style.cssText =
    'position:absolute;right:12px;top:12px;z-index:2;padding:8px 10px;border-radius:8px;' +
    'background:rgba(20,26,38,0.82);color:#d7e2f2;font:500 11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;' +
    'white-space:pre;pointer-events:none;';
  wrap.append(back, readout);
  root.append(wrap);

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const items = seedItems();
  const camera = { x: -600, y: -400, zoom: 1 };

  // ------------------------------------------------------------- readout
  /** Ring of recent draw() durations (ms) — the average is what the readout shows. */
  const frames: number[] = [];
  let lastMs = 0;
  let visible = 0;
  let cssW = 0;
  let cssH = 0;

  const paintReadout = (): void => {
    const avg = frames.length ? frames.reduce((a, b) => a + b, 0) / frames.length : 0;
    readout.textContent =
      `draw  ${lastMs.toFixed(1)}ms  avg ${avg.toFixed(1)}ms\n` +
      `items ${visible} / ${items.length}\n` +
      `canvas ${canvas.width}x${canvas.height} (dpr ${DPR})\n` +
      `zoom  ${camera.zoom.toFixed(2)}`;
  };

  // --------------------------------------------------------------- render
  let raf = 0;
  const draw = (): void => {
    raf = 0;
    const t0 = performance.now();
    const z = camera.zoom;
    const s = z * DPR;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // world → device px, so everything below is drawn in plain world units
    ctx.setTransform(s, 0, 0, s, -camera.x * s, -camera.y * s);

    const left = camera.x;
    const top = camera.y;
    const right = left + cssW / z;
    const bottom = top + cssH / z;

    // Grid: drawTemplate lays its lines at gap, 2*gap, … from whatever origin
    // the transform puts at (0, 0), so translating to a world multiple of the
    // gap is what keeps the grid from shifting phase as the camera moves.
    const gx = Math.floor(left / GRID_GAP) * GRID_GAP - GRID_GAP;
    const gy = Math.floor(top / GRID_GAP) * GRID_GAP - GRID_GAP;
    ctx.save();
    ctx.translate(gx, gy);
    drawTemplate(ctx, PAPER, right - gx + GRID_GAP, bottom - gy + GRID_GAP);
    ctx.restore();

    // cull to the visible world rect — the whole point of the spike
    let n = 0;
    for (const it of items) {
      if (it.maxX < left || it.minX > right || it.maxY < top || it.minY > bottom) continue;
      drawStroke(ctx, it, PAPER);
      n++;
    }
    if (live) {
      drawStroke(ctx, live, PAPER);
      n++;
    }
    visible = n;

    lastMs = performance.now() - t0;
    frames.push(lastMs);
    if (frames.length > 30) frames.shift();
    paintReadout();
  };

  const schedule = (): void => {
    if (!raf) raf = requestAnimationFrame(draw);
  };

  const resize = (): void => {
    const r = wrap.getBoundingClientRect();
    cssW = r.width;
    cssH = r.height;
    canvas.width = Math.max(1, Math.round(cssW * DPR));
    canvas.height = Math.max(1, Math.round(cssH * DPR));
    schedule();
  };

  // ---------------------------------------------------------------- input
  /** The stroke in flight (pen/mouse), in world units — no page, so nothing is clamped. */
  let live: Item | null = null;
  let drawPointer = -1;
  /** While the Pencil is down, finger contacts are ignored outright — the spike's whole palm story. */
  let penDown = false;

  const toWorld = (clientX: number, clientY: number): [number, number] => {
    const r = canvas.getBoundingClientRect();
    return [(clientX - r.left) / camera.zoom + camera.x, (clientY - r.top) / camera.zoom + camera.y];
  };

  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') return; // panning, handled by the touch listeners below
    e.preventDefault();
    penDown = true;
    pan = null;
    pinch = null;
    drawPointer = e.pointerId;
    const [x, y] = toWorld(e.clientX, e.clientY);
    live = makeItem([[x, y, e.pressure || 0.5]], 'pen', '#1f2530', 3);
    canvas.setPointerCapture(e.pointerId);
    schedule();
  });

  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerId !== drawPointer || !live) return;
    e.preventDefault();
    const evs = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [e];
    for (const ev of evs.length ? evs : [e]) {
      const [x, y] = toWorld(ev.clientX, ev.clientY);
      live.points.push([x, y, ev.pressure || 0.5]);
    }
    Object.assign(live, bounds(live.points, live.size));
    schedule();
  });

  const endStroke = (e: PointerEvent): void => {
    if (e.pointerId !== drawPointer) return;
    if (live && live.points.length > 1) items.push(live);
    live = null;
    drawPointer = -1;
    penDown = false;
    schedule();
  };
  canvas.addEventListener('pointerup', endStroke);
  canvas.addEventListener('pointercancel', endStroke);

  // Pan / pinch, touch only. Minimal on purpose: no momentum, no rubber band,
  // no palm rejection — just enough to judge whether an unbounded 2-D camera
  // over a culled redraw feels right.
  let pan: { id: number; x: number; y: number } | null = null;
  let pinch: { d0: number; z0: number; mx: number; my: number; cx: number; cy: number } | null = null;

  const dist = (a: Touch, b: Touch): number => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);

  wrap.addEventListener(
    'touchstart',
    (e) => {
      if (penDown) return;
      e.preventDefault();
      const t = e.touches;
      if (t.length >= 2) {
        pan = null;
        const mx = (t[0].clientX + t[1].clientX) / 2;
        const my = (t[0].clientY + t[1].clientY) / 2;
        pinch = { d0: dist(t[0], t[1]) || 1, z0: camera.zoom, mx, my, cx: mx, cy: my };
      } else if (t.length === 1) {
        pinch = null;
        pan = { id: t[0].identifier, x: t[0].clientX, y: t[0].clientY };
      }
    },
    { passive: false }
  );

  wrap.addEventListener(
    'touchmove',
    (e) => {
      if (penDown) return;
      e.preventDefault();
      const t = e.touches;
      if (pinch && t.length >= 2) {
        const mx = (t[0].clientX + t[1].clientX) / 2;
        const my = (t[0].clientY + t[1].clientY) / 2;
        const next = clamp((pinch.z0 * dist(t[0], t[1])) / pinch.d0, ZOOM_MIN, ZOOM_MAX);
        // keep the world point under the pinch midpoint pinned, then follow
        // the midpoint's own travel — the same closed-form the main view uses
        const r = canvas.getBoundingClientRect();
        const sx = pinch.mx - r.left;
        const sy = pinch.my - r.top;
        const wx = sx / camera.zoom + camera.x;
        const wy = sy / camera.zoom + camera.y;
        camera.zoom = next;
        camera.x = wx - sx / next - (mx - pinch.cx) / next;
        camera.y = wy - sy / next - (my - pinch.cy) / next;
        pinch.cx = mx;
        pinch.cy = my;
        pinch.mx = mx;
        pinch.my = my;
        schedule();
        return;
      }
      if (!pan) return;
      const touch = Array.from(t).find((c) => c.identifier === pan?.id);
      if (!touch) return;
      // no clamping anywhere: the board is unbounded in all four directions
      camera.x -= (touch.clientX - pan.x) / camera.zoom;
      camera.y -= (touch.clientY - pan.y) / camera.zoom;
      pan.x = touch.clientX;
      pan.y = touch.clientY;
      schedule();
    },
    { passive: false }
  );

  const endTouch = (e: TouchEvent): void => {
    if (e.touches.length === 0) {
      pan = null;
      pinch = null;
    } else if (e.touches.length === 1) {
      pinch = null;
      pan = { id: e.touches[0].identifier, x: e.touches[0].clientX, y: e.touches[0].clientY };
    }
  };
  wrap.addEventListener('touchend', endTouch);
  wrap.addEventListener('touchcancel', endTouch);

  // trackpad / mouse wheel, for checking the thing on a desktop browser too
  wrap.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      if (e.ctrlKey) {
        const r = canvas.getBoundingClientRect();
        const sx = e.clientX - r.left;
        const sy = e.clientY - r.top;
        const wx = sx / camera.zoom + camera.x;
        const wy = sy / camera.zoom + camera.y;
        camera.zoom = clamp(camera.zoom * Math.exp(-e.deltaY / 240), ZOOM_MIN, ZOOM_MAX);
        camera.x = wx - sx / camera.zoom;
        camera.y = wy - sy / camera.zoom;
      } else {
        camera.x += e.deltaX / camera.zoom;
        camera.y += e.deltaY / camera.zoom;
      }
      schedule();
    },
    { passive: false }
  );

  // -------------------------------------------------------------- teardown
  const onLeave = (): void => {
    window.removeEventListener('hashchange', onLeave);
    window.removeEventListener('resize', resize);
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    // everything the spike made was in-memory only; dropping the array and the
    // DOM is the whole of "leaving discards it"
    items.length = 0;
    live = null;
    wrap.remove();
  };
  window.addEventListener('hashchange', onLeave);
  window.addEventListener('resize', resize);

  resize();
}
