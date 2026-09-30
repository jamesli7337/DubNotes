import { DPR } from '../const';
import { store } from '../store';
import { ERASER_RADIUS, resolveDrawTool, toolState } from '../tools';
import type { Notebook, Paper, PageItem, Stroke } from '../types';
import { isStroke, nearPolyline, uid } from '../util';
import { itemBounds, type Camera, type Rect } from './geom';
import { drawStroke } from './freehand';
import { drawElement } from './elements';
import { drawTemplate } from './templates';
import type { Op } from './page-canvas';

/**
 * A board's whole visible surface: one canvas the size of the viewport,
 * redrawn from `store.boardItemsIn` culled to the visible world rect. There
 * are no pages and no tiles — the spike (src/ui/board-spike.ts) measured 9.9ms
 * for a worst case of 1861 visible items at zoom 0.2 on an iPad, so a single
 * culled repaint fits the frame budget and tiling can wait.
 *
 * Two canvases, for the same reason PageCanvas has two:
 *  - `settled` holds the paper plus every committed item, rendered for a world
 *    rect a margin larger than the viewport. A pan that stays inside that
 *    margin is a straight `drawImage` at an offset — no item is touched.
 *  - `view` is what the user sees: each frame it blits `settled` and paints
 *    only what is in flight (the live stroke).
 *
 * Crossing the margin, or any zoom change, re-renders `settled` for the new
 * rect. A committed stroke is drawn straight into `settled` rather than
 * invalidating it, so finishing a stroke never costs a full repaint.
 *
 * Coordinates are global board units throughout — nothing here remaps into a
 * chunk's space, because chunks are only a persistence detail (see
 * `Page.col`/`row`).
 */

/** How much larger than the viewport the settled copy is rendered, per side. */
const MARGIN = 0.25;
/** Opacity for strokes the eraser is hovering, before they are actually removed — matches PageCanvas. */
const PENDING_OPACITY = 0.25;

export interface BoardHooks {
  /** An undoable edit happened; the notebook's own history takes it from here. */
  onOp: (op: Op) => void;
}

export class BoardCanvas {
  private readonly nb: Notebook;
  private readonly camera: Camera;
  private readonly hooks: BoardHooks;

  private host: HTMLElement | null = null;
  private view: HTMLCanvasElement | null = null;
  private vctx: CanvasRenderingContext2D | null = null;
  private settled: HTMLCanvasElement | null = null;
  private sctx: CanvasRenderingContext2D | null = null;

  /** World rect the settled copy currently holds, and the zoom it was rendered at. Null means it holds nothing usable. */
  private settledRect: Rect | null = null;
  private settledZoom = 0;

  private raf = 0;
  private cssW = 0;
  private cssH = 0;

  /** Live stroke state — the board's whole tool surface in phase 1. */
  private mode: 'draw' | 'erase' | null = null;
  private pointerId = -1;
  private live: number[][] = [];
  private liveTool: { kind: 'pen' | 'highlighter'; color: string; size: number } = { kind: 'pen', color: '#000', size: 3 };
  /** ids the current eraser drag will delete on release (whole-stroke mode) */
  private erased = new Set<string>();
  /** partial eraser: stroke id -> indices rubbed out so far, applied on release */
  private partial = new Map<string, Set<number>>();

  constructor(nb: Notebook, camera: Camera, hooks: BoardHooks) {
    this.nb = nb;
    this.camera = camera;
    this.hooks = hooks;
  }

  get busy(): boolean {
    return this.mode != null;
  }

  private paper(): Paper {
    return store.boardPaper(this.nb.id);
  }

  // --------------------------------------------------------------- lifecycle
  mount(host: HTMLElement): void {
    if (this.view) return;
    this.host = host;
    const view = document.createElement('canvas');
    view.className = 'board-canvas';
    this.view = view;
    this.vctx = view.getContext('2d');
    this.settled = document.createElement('canvas');
    this.sctx = this.settled.getContext('2d');
    host.appendChild(view);

    view.addEventListener('pointerdown', this.onDown);
    view.addEventListener('pointermove', this.onMove);
    view.addEventListener('pointerup', this.onUp);
    view.addEventListener('pointercancel', this.onUp);
    this.resize();
  }

  unmount(): void {
    const v = this.view;
    if (v) {
      v.removeEventListener('pointerdown', this.onDown);
      v.removeEventListener('pointermove', this.onMove);
      v.removeEventListener('pointerup', this.onUp);
      v.removeEventListener('pointercancel', this.onUp);
      v.remove();
    }
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.view = this.settled = null;
    this.vctx = this.sctx = null;
    this.settledRect = null;
    this.host = null;
  }

  /** Re-measures the viewport and re-renders; call on resize and whenever the surrounding chrome changes the stage's box. */
  resize(): void {
    const host = this.host;
    const view = this.view;
    if (!host || !view || !this.settled) return;
    const r = host.getBoundingClientRect();
    this.cssW = r.width;
    this.cssH = r.height;
    view.width = Math.max(1, Math.round(this.cssW * DPR));
    view.height = Math.max(1, Math.round(this.cssH * DPR));
    view.style.width = `${this.cssW}px`;
    view.style.height = `${this.cssH}px`;
    this.settledRect = null; // the margin box changed shape
    this.schedule();
  }

  /** The paper template changed — the settled copy has it baked in. */
  paperChanged(): void {
    this.invalidate();
  }

  /** Drop the settled copy and repaint from the store (undo/redo, an external edit). */
  invalidate(): void {
    this.settledRect = null;
    this.schedule();
  }

  schedule(): void {
    if (!this.raf && this.view) this.raf = requestAnimationFrame(this.frame);
  }

  // ----------------------------------------------------------------- geometry
  /** The world rect currently on screen. */
  private visibleRect(): Rect {
    const z = this.camera.zoom || 1;
    return { x: this.camera.x, y: this.camera.y, w: this.cssW / z, h: this.cssH / z };
  }

  /** Screen (client) point -> board coordinates. */
  private toBoard(e: PointerEvent): number[] {
    const r = this.view!.getBoundingClientRect();
    const z = this.camera.zoom || 1;
    let p = e.pressure;
    if (!p || p <= 0) p = 0.5; // some styluses report 0 on contact
    return [(e.clientX - r.left) / z + this.camera.x, (e.clientY - r.top) / z + this.camera.y, p];
  }

  // ------------------------------------------------------------------ painting
  /** Re-renders the settled copy for a margin box around `v`. */
  private renderSettled(v: Rect): void {
    const c = this.settled;
    const ctx = this.sctx;
    if (!c || !ctx) return;
    const z = this.camera.zoom || 1;
    const rect: Rect = {
      x: v.x - v.w * MARGIN,
      y: v.y - v.h * MARGIN,
      w: v.w * (1 + MARGIN * 2),
      h: v.h * (1 + MARGIN * 2),
    };
    const s = z * DPR;
    const w = Math.max(1, Math.round(rect.w * s));
    const h = Math.max(1, Math.round(rect.h * s));
    if (c.width !== w) c.width = w;
    if (c.height !== h) c.height = h;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    // board units -> device px, so everything below draws in plain board units
    ctx.setTransform(s, 0, 0, s, -rect.x * s, -rect.y * s);

    const paper = this.paper();
    // drawTemplate lays its ruling out from wherever the transform puts (0, 0)
    // and snaps to device pixels itself, so translating to a whole multiple of
    // the largest spacing keeps the ruling locked to the board as we pan
    // instead of shifting phase with the margin box.
    const PHASE = 54 * 4; // a multiple of every SPACING_PX value (26/38/54)
    const gx = Math.floor(rect.x / PHASE) * PHASE;
    const gy = Math.floor(rect.y / PHASE) * PHASE;
    ctx.save();
    ctx.translate(gx, gy);
    drawTemplate(ctx, paper, rect.x + rect.w - gx + PHASE, rect.y + rect.h - gy + PHASE);
    ctx.restore();

    const pending = this.pendingIds();
    for (const it of store.boardItemsIn(this.nb.id, rect)) {
      if (this.partial.has(it.id)) continue; // the view paints what survives
      this.paintItem(ctx, it, pending.has(it.id) ? PENDING_OPACITY : 1);
    }

    this.settledRect = rect;
    this.settledZoom = z;
  }

  private paintItem(ctx: CanvasRenderingContext2D, it: PageItem, opacity = 1): void {
    const paper = this.paper();
    if (isStroke(it)) drawStroke(ctx, it, paper, opacity);
    else drawElement(ctx, it, paper, opacity, () => this.invalidate());
  }

  /** ids the eraser is currently hovering (drawn dimmed, not yet removed). */
  private pendingIds(): Set<string> {
    return this.mode === 'erase' ? this.erased : new Set();
  }

  private frame = (): void => {
    this.raf = 0;
    const view = this.view;
    const v = this.vctx;
    const settled = this.settled;
    if (!view || !v || !settled) return;

    const vis = this.visibleRect();
    const z = this.camera.zoom || 1;
    const r = this.settledRect;
    const stale =
      !r ||
      this.settledZoom !== z ||
      vis.x < r.x ||
      vis.y < r.y ||
      vis.x + vis.w > r.x + r.w ||
      vis.y + vis.h > r.y + r.h;
    if (stale) this.renderSettled(vis);

    const rect = this.settledRect;
    v.setTransform(1, 0, 0, 1, 0, 0);
    v.clearRect(0, 0, view.width, view.height);
    if (rect) {
      // 1:1 blit — the settled copy is already at this exact device scale, so
      // a pan inside the margin costs one drawImage and no item work at all
      const s = z * DPR;
      v.drawImage(settled, Math.round((vis.x - rect.x) * s), Math.round((vis.y - rect.y) * s), view.width, view.height, 0, 0, view.width, view.height);
    }

    // in flight, painted on top in board units
    const s = z * DPR;
    v.setTransform(s, 0, 0, s, -vis.x * s, -vis.y * s);
    const paper = this.paper();
    if (this.mode === 'draw' && this.live.length) {
      drawStroke(v, { tool: this.liveTool.kind, color: this.liveTool.color, size: this.liveTool.size, points: this.live }, paper);
    }
    for (const [id, gone] of this.partial) {
      const st = this.strokeById(id);
      if (st) for (const seg of surviving(st, gone)) drawStroke(v, { ...st, points: seg }, paper);
    }
  };

  private strokeById(id: string): Stroke | undefined {
    const it = store.boardItem(this.nb.id, id);
    return it && isStroke(it) ? it : undefined;
  }

  // ------------------------------------------------------------------ pointer
  /**
   * Pen and mouse draw; touch is left alone so it reaches the notebook's own
   * pan/pinch gestures on `.nb-scroll`. That also makes palm rejection free
   * here: a palm is a touch, and a touch never draws on a board.
   */
  private onDown = (e: PointerEvent): void => {
    if (e.pointerType === 'touch' || this.mode) return;
    if (toolState.kind !== 'pen' && toolState.kind !== 'highlighter' && toolState.kind !== 'eraser') return;
    const t = resolveDrawTool();
    if (toolState.kind !== 'eraser' && !t) return;
    e.preventDefault();
    this.pointerId = e.pointerId;
    try {
      this.view?.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    const pt = this.toBoard(e);
    if (toolState.kind === 'eraser') {
      this.mode = 'erase';
      this.erased.clear();
      this.partial.clear();
      this.eraseAt(pt);
    } else {
      this.mode = 'draw';
      this.liveTool = { kind: t!.kind, color: t!.color, size: t!.size };
      this.live = [pt];
    }
    this.schedule();
  };

  private onMove = (e: PointerEvent): void => {
    if (e.pointerId !== this.pointerId || !this.mode) return;
    e.preventDefault();
    const evs = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    const list = evs.length ? evs : [e];
    if (this.mode === 'draw') {
      for (const ev of list) this.live.push(this.toBoard(ev));
    } else {
      for (const ev of list) this.eraseAt(this.toBoard(ev));
    }
    this.schedule();
  };

  private onUp = (e: PointerEvent): void => {
    if (e.pointerId !== this.pointerId) return;
    const mode = this.mode;
    this.mode = null;
    this.pointerId = -1;
    if (mode === 'draw') this.commitStroke();
    else if (mode === 'erase') this.commitErase();
    this.schedule();
  };

  // --------------------------------------------------------------------- ink
  private commitStroke(): void {
    const pts = this.live;
    this.live = [];
    if (!pts.length) return;
    if (pts.length === 1) {
      const [x, y, p] = pts[0];
      pts.push([x + 0.1, y + 0.1, p]); // a tap becomes a dot
    }
    const b = boundsOfPoints(pts);
    const stroke: Stroke = {
      id: uid(),
      // the chunk is chosen once here, from the bounding box origin, and never
      // affects how the stroke draws or hit-tests
      pageId: store.boardChunkAt(this.nb.id, b.x, b.y),
      notebookId: this.nb.id,
      tool: this.liveTool.kind,
      color: this.liveTool.color,
      size: this.liveTool.size,
      points: pts,
      createdAt: Date.now(),
    };
    store.addStroke(stroke);
    // paint it straight into the settled copy rather than invalidating: a
    // finished stroke should never cost a full repaint
    const ctx = this.sctx;
    const rect = this.settledRect;
    if (ctx && rect) {
      const s = this.settledZoom * DPR;
      ctx.setTransform(s, 0, 0, s, -rect.x * s, -rect.y * s);
      drawStroke(ctx, stroke, this.paper());
    }
    this.hooks.onOp({ kind: 'add-stroke', pageId: stroke.pageId, stroke });
  }

  // ------------------------------------------------------------------- eraser
  private eraseAt(pt: number[]): void {
    const z = this.camera.zoom || 1;
    const r = ERASER_RADIUS / z; // a constant size on screen, like the page eraser
    const hit: Rect = { x: pt[0] - r, y: pt[1] - r, w: r * 2, h: r * 2 };
    const whole = toolState.eraserMode !== 'partial';
    for (const it of store.boardItemsIn(this.nb.id, hit)) {
      if (!isStroke(it)) continue;
      if (whole) {
        if (nearPolyline(pt[0], pt[1], it.points, r + it.size / 2)) this.erased.add(it.id);
        continue;
      }
      let gone = this.partial.get(it.id);
      for (let i = 0; i < it.points.length; i++) {
        const p = it.points[i];
        if (Math.hypot(p[0] - pt[0], p[1] - pt[1]) > r + it.size / 2) continue;
        if (!gone) {
          gone = new Set();
          this.partial.set(it.id, gone);
        }
        gone.add(i);
      }
    }
    if (this.erased.size) this.invalidate(); // dimming is baked into the settled copy
  }

  private commitErase(): void {
    if (this.erased.size) {
      const ids = new Set(this.erased);
      this.erased.clear();
      const removed = collectByPage(this.nb.id, ids);
      for (const [pageId, items] of removed) {
        const gone = store.removeItems(pageId, new Set(items.map((i) => i.id)));
        const strokes = gone.filter(isStroke);
        if (strokes.length) this.hooks.onOp({ kind: 'erase', pageId, strokes });
      }
      this.invalidate();
      return;
    }
    if (!this.partial.size) return;

    // A partial erase removes the originals and puts back whatever survives as
    // fresh strokes — the same shape as the page eraser's own 'edit' op, so
    // undo/redo needs nothing board-specific.
    const byPage = new Map<string, { removed: PageItem[]; added: PageItem[] }>();
    for (const [id, gone] of this.partial) {
      const st = this.strokeById(id);
      if (!st) continue;
      const bucket = byPage.get(st.pageId) ?? { removed: [], added: [] };
      bucket.removed.push(st);
      for (const seg of surviving(st, gone)) {
        if (seg.length < 2) continue;
        const b = boundsOfPoints(seg);
        bucket.added.push({
          ...st,
          id: uid(),
          pageId: store.boardChunkAt(this.nb.id, b.x, b.y),
          points: seg,
        });
      }
      byPage.set(st.pageId, bucket);
    }
    this.partial.clear();
    for (const [pageId, { removed, added }] of byPage) {
      store.removeItems(pageId, new Set(removed.map((r) => r.id)));
      store.addItems(added);
      this.hooks.onOp({ kind: 'edit', pageId, removed, added });
    }
    this.invalidate();
  }
}

/** Groups the items of `ids` by the chunk they are stored in, so each removal is one store call. Resolved by id against the board registry rather than by scanning the board. */
function collectByPage(notebookId: string, ids: Set<string>): Map<string, PageItem[]> {
  const out = new Map<string, PageItem[]>();
  for (const id of ids) {
    const it = store.boardItem(notebookId, id);
    if (!it) continue;
    const arr = out.get(it.pageId);
    if (arr) arr.push(it);
    else out.set(it.pageId, [it]);
  }
  return out;
}

/** The runs of a stroke's points that a partial erase left behind. */
function surviving(stroke: Stroke, gone: Set<number>): number[][][] {
  const runs: number[][][] = [];
  let cur: number[][] = [];
  for (let i = 0; i < stroke.points.length; i++) {
    if (gone.has(i)) {
      if (cur.length > 1) runs.push(cur);
      cur = [];
    } else {
      cur.push(stroke.points[i]);
    }
  }
  if (cur.length > 1) runs.push(cur);
  return runs;
}

function boundsOfPoints(pts: number[][]): Rect {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of pts) {
    if (p[0] < x0) x0 = p[0];
    if (p[0] > x1) x1 = p[0];
    if (p[1] < y0) y0 = p[1];
    if (p[1] > y1) y1 = p[1];
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Re-exported so NotebookView can size a board's initial camera without importing geom itself. */
export { itemBounds };
