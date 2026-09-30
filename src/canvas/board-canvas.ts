import { AI_COLOR } from '../ai-mode';
import { DPR } from '../const';
import { store } from '../store';
import {
  ERASER_RADIUS,
  resolveDrawTool,
  TAP_SLOP,
  TEXT_DEFAULT_SIZE,
  TEXT_DEFAULT_WIDTH,
  toolState,
} from '../tools';
import type {
  ImageElement,
  Notebook,
  Paper,
  PageElement,
  PageItem,
  ShapeElement,
  Stroke,
  TapeElement,
  TextElement,
} from '../types';
import { isStroke, nearPolyline, uid } from '../util';
import {
  aabb,
  elementInPolygon,
  itemBounds,
  itemsFrame,
  mapPoint,
  pointInElement,
  pointInPolygon,
  strokeInPolygon,
  transformItems,
  translateItems,
  type Camera,
  type Frame,
  type Rect,
} from './geom';
import { drawStroke, resolveInkColor } from './freehand';
import {
  drawElement,
  layoutText,
  TAPE_COLOR,
  TEXT_FONT_FAMILY,
  TEXT_LINE_HEIGHT,
  textHeight,
} from './elements';
import { lineFit, type ShapeFit } from './recognize';
import {
  cloneItem,
  IMAGE_FIT,
  marqueePolygon,
  sameText,
  selectionView,
  SHAPE_MIN,
  strokeLassoPath,
  survivingSegments,
  TAP_RADIUS,
  topElementAt,
  topItemAt,
  type ItemSurface,
  type SurfaceHooks,
} from './item-surface';
import { drawTemplate } from './templates';
import { TAPE_MIN } from './page-canvas';

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

/**
 * A board raises exactly the shared surface hooks and nothing more — the
 * page-only ones (another page to repaint, a cross-page lasso to adopt, the
 * notebook-level drag-preview canvas) have no meaning here: there is one
 * surface, and it is already viewport-sized, so a dragged item can never be
 * clipped by leaving it.
 */
export type BoardHooks = SurfaceHooks;

/** Max gap between two taps (ms) and how far apart they may land to still count as one double-tap. */
const DOUBLE_TAP_MS = 350;
const DOUBLE_TAP_SLOP = 24;

interface BoardTextEditor {
  /** the element being edited — for a new box this is not in the store yet */
  el: TextElement;
  isNew: boolean;
  area: HTMLTextAreaElement;
}

export class BoardCanvas implements ItemSurface {
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

  /**
   * The textarea for an in-place text edit lives in its own layer rather than
   * on the canvas. A page can put it straight into `.page-clip` in page units
   * and let `.nb-camera`'s CSS transform scale it; a board draws its camera
   * into the canvas instead, so there is no transformed DOM layer to inherit.
   * `editorCam` is that missing layer: the same `scale(z) translate(-x, -y)`
   * the page view applies to `.nb-camera`, re-applied whenever the camera
   * moves — which lets the textarea itself be positioned in plain board units,
   * identically to the page path.
   */
  private editorLayer: HTMLElement | null = null;
  private editorCam: HTMLElement | null = null;

  /** Live gesture state. */
  private mode:
    | 'draw'
    | 'erase'
    | 'lasso'
    | 'shapes'
    | 'shape-press'
    | 'tape'
    | 'tape-tap'
    | 'text-press'
    | null = null;
  private pointerId = -1;
  private live: number[][] = [];
  private liveTool: { kind: 'pen' | 'highlighter'; color: string; size: number } = { kind: 'pen', color: '#000', size: 3 };
  /** ids the current eraser drag will delete on release (whole-stroke mode) */
  private erased = new Set<string>();
  /** partial eraser: stroke id -> indices rubbed out so far, applied on release */
  private partial = new Map<string, Set<number>>();

  /** lasso: the polygon being drawn, and the latest point (for the tap-vs-drag test) */
  private lasso: number[][] = [];
  private lassoPt: number[] = [0, 0];
  /** the finalized polygon of the current lasso selection, drawn as a dashed echo — null for every other way of selecting */
  private lastLassoPath: number[][] | null = null;
  private pressPt: number[] = [0, 0];
  private tapeHit: string | null = null;
  private shapeHit: string | null = null;
  private lastTapAt = 0;
  private lastTapPt: number[] = [0, 0];

  /** view-only: which tape strips are peeled back. Never stored, same as a page. */
  private readonly peeled = new Set<string>();
  private tapeResizeOrig: TapeElement | null = null;

  /** selection + transform state, mirroring PageCanvas's own */
  private selected = new Set<string>();
  private xfOrig: PageItem[] | null = null;
  private xfFrame: Frame | null = null;
  private xfCur: Frame | null = null;
  private xfLive: PageItem[] | null = null;
  private xfLassoOrig: number[][] | null = null;
  private editor: BoardTextEditor | null = null;

  constructor(nb: Notebook, camera: Camera, hooks: BoardHooks) {
    this.nb = nb;
    this.camera = camera;
    this.hooks = hooks;
  }

  get busy(): boolean {
    return this.mode != null || this.xfOrig != null || this.editor != null;
  }

  get mounted(): boolean {
    return this.view != null;
  }

  get hasSelection(): boolean {
    return this.selected.size > 0;
  }

  /** New items are filed under the origin chunk by default; `pasteItems` re-files each by its own bounds. */
  get page(): { id: string } {
    return { id: `${this.nb.id}:0,0` };
  }

  private zoom(): number {
    return this.camera.zoom > 0 ? this.camera.zoom : 1;
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

    // above the canvas, below the dock; only the textarea inside it takes events
    const layer = document.createElement('div');
    layer.className = 'board-editor-layer';
    const cam = document.createElement('div');
    cam.className = 'board-editor-camera';
    layer.appendChild(cam);
    host.appendChild(layer);
    this.editorLayer = layer;
    this.editorCam = cam;

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
    this.commitEdit();
    this.editorLayer?.remove();
    this.editorLayer = this.editorCam = null;
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
    const hidden = this.hiddenIds();
    for (const it of store.boardItemsIn(this.nb.id, rect)) {
      if (hidden?.has(it.id)) continue; // mid-drag / mid-edit: the view paints it
      if (this.partial.has(it.id)) continue; // the view paints what survives
      this.paintItem(ctx, it, pending.has(it.id) ? PENDING_OPACITY : 1);
    }

    this.settledRect = rect;
    this.settledZoom = z;
  }

  private paintItem(ctx: CanvasRenderingContext2D, it: PageItem, opacity = 1): void {
    const paper = this.paper();
    if (isStroke(it)) drawStroke(ctx, it, paper, opacity);
    else drawElement(ctx, it, paper, opacity, () => this.invalidate(), this.peeled);
  }

  /** Items the settled copy must leave out because the view is painting a live version of them. */
  private hiddenIds(): Set<string> | null {
    if (!this.xfOrig && !this.editor && !this.partial.size) return null;
    const ids = new Set<string>();
    if (this.xfOrig) for (const it of this.xfOrig) ids.add(it.id);
    if (this.editor) ids.add(this.editor.el.id);
    for (const id of this.partial.keys()) ids.add(id);
    return ids;
  }

  /** ids the eraser is currently hovering (drawn dimmed, not yet removed). */
  private pendingIds(): Set<string> {
    return this.mode === 'erase' ? this.erased : new Set();
  }

  private frame = (): void => {
    this.raf = 0;
    // the textarea is DOM, not canvas, so it needs the camera written to it
    // separately — every frame, which is exactly when the canvas gets it too
    this.syncEditorCamera();
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
      if (!st) continue;
      drawStroke(v, st, paper, PENDING_OPACITY); // what is being rubbed out, dimmed
      for (const seg of survivingSegments(st.points, gone)) drawStroke(v, { ...st, points: seg }, paper);
    }
    // the items being dragged / resized / rotated, plus the outline riding along
    if (this.xfLive) {
      const editing = this.editor?.el.id;
      for (const it of this.xfLive) if (it.id !== editing) this.paintItem(v, it); // the textarea shows that one
    }
    if (this.mode === 'tape' && this.live.length > 1) {
      drawElement(v, this.tapeFromDrag(), paper, 0.7); // preview of the strip being laid
    }
    if (this.mode === 'shapes' && this.live.length > 1) {
      const sh = this.shapeFromDrag();
      if (sh) drawElement(v, sh, paper, 0.7); // preview of the shape being sized
    }
    if (this.mode === 'lasso' && this.lasso.length > 1) {
      strokeLassoPath(v, this.lasso, toolState.lassoShape !== 'free', this.zoom());
    } else if (this.lastLassoPath && this.lastLassoPath.length > 1) {
      // decorative echo of the finalized selection's shape — unlike a page,
      // this stays on the one canvas even mid-drag, because that canvas is the
      // whole viewport and nothing can be clipped by leaving a page's bitmap
      strokeLassoPath(v, this.lastLassoPath, true, this.zoom());
    }
  };

  private strokeById(id: string): Stroke | undefined {
    const it = store.boardItem(this.nb.id, id);
    return it && isStroke(it) ? it : undefined;
  }

  // ------------------------------------------------------------------ pointer
  /**
   * Pen and mouse drive every tool; touch is left alone so it reaches the
   * notebook's own pan/pinch gestures on `.nb-scroll`. That also makes palm
   * rejection free: a palm is a touch, and a touch never marks a board. A
   * finger can still move a selection, because the SelectionOverlay's handles
   * are real DOM elements with their own palm rules — it just cannot start one
   * from the canvas.
   */
  private onDown = (e: PointerEvent): void => {
    if (e.pointerType === 'touch' || this.mode) return;
    const kind = toolState.kind;
    if (kind === 'hand') return; // the notebook's own hand-drag pan handles this
    e.preventDefault();
    this.capture(e);
    const pt = this.toBoard(e);
    this.pressPt = pt;

    // a press on a tape strip is a peel / cover tap unless it turns into a drag
    const tape = kind === 'lasso' ? null : this.topTapeAt(pt[0], pt[1]);
    if (tape) {
      this.commitEdit();
      this.mode = 'tape-tap';
      this.tapeHit = tape.id;
      return;
    }

    if (kind === 'tape') {
      this.commitEdit();
      this.mode = 'tape';
      this.live = [pt];
      this.schedule();
      return;
    }

    if (kind === 'shapes') {
      this.commitEdit();
      const hit = this.topShapeAt(pt[0], pt[1]);
      if (hit) {
        // over an existing shape: a tap selects it to readjust, a drag places a
        // new one on top — decided on move/up
        this.mode = 'shape-press';
        this.shapeHit = hit.id;
        return;
      }
      this.clearSelection();
      this.beginShapeDrag(pt);
      this.schedule();
      return;
    }

    if (kind === 'text') {
      if (this.editor) {
        this.commitEdit(); // tapping outside the box just finishes the edit
        return;
      }
      const hit = this.topTextAt(pt[0], pt[1]);
      if (hit) {
        this.setSelection([hit.id]);
        this.mode = 'text-press';
      } else {
        this.startEdit(this.newText(pt[0], pt[1]), true);
      }
      return;
    }

    if (kind === 'lasso') {
      this.commitEdit();
      this.clearSelection();
      this.mode = 'lasso';
      this.lasso = [pt];
      this.lassoPt = pt;
      this.schedule();
      return;
    }

    if (kind === 'eraser') {
      this.mode = 'erase';
      this.erased.clear();
      this.partial.clear();
      this.eraseAt(pt);
      this.schedule();
      return;
    }

    const t = resolveDrawTool();
    if (!t) {
      this.mode = null;
      return;
    }
    this.commitEdit();
    this.mode = 'draw';
    this.liveTool = { kind: t.kind, color: this.aiInkColor(t.color), size: t.size };
    this.live = [pt];
    this.schedule();
  };

  private capture(e: PointerEvent): void {
    this.pointerId = e.pointerId;
    try {
      this.view?.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  }

  private onMove = (e: PointerEvent): void => {
    if (e.pointerId !== this.pointerId || !this.mode) return;
    e.preventDefault();
    const evs = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    const list = evs.length ? evs : [e];
    const slop = TAP_SLOP / this.zoom();
    for (const ev of list) {
      const pt = this.toBoard(ev);
      switch (this.mode) {
        case 'draw':
          this.live.push(pt);
          break;
        case 'erase':
          this.eraseAt(pt);
          break;
        case 'lasso':
          this.lassoPt = pt;
          if (toolState.lassoShape === 'free') this.lasso.push(pt);
          else this.lasso = marqueePolygon(toolState.lassoShape, this.pressPt, pt);
          break;
        case 'tape':
        case 'shapes':
          this.live.push(pt);
          break;
        case 'shape-press':
          // moved: a new shape from the press point, not a tap on the old one
          if (Math.hypot(pt[0] - this.pressPt[0], pt[1] - this.pressPt[1]) < slop) break;
          this.shapeHit = null;
          this.clearSelection();
          this.beginShapeDrag(this.pressPt);
          this.live.push(pt);
          break;
        case 'tape-tap': {
          // moved off the strip: it wasn't a tap after all — carry on with the real tool
          if (Math.hypot(pt[0] - this.pressPt[0], pt[1] - this.pressPt[1]) < slop) break;
          this.tapeHit = null;
          const kind = toolState.kind;
          if (kind === 'eraser') {
            this.mode = 'erase';
            this.erased.clear();
            this.partial.clear();
            this.eraseAt(this.pressPt);
            this.eraseAt(pt);
          } else if (kind === 'tape') {
            this.mode = 'tape';
            this.live = [this.pressPt, pt];
          } else if (kind === 'shapes') {
            this.clearSelection();
            this.beginShapeDrag(this.pressPt);
            this.live.push(pt);
          } else if (kind === 'text') {
            this.mode = null; // the text tool has nothing to drag here
          } else {
            const t = resolveDrawTool();
            if (!t) {
              this.mode = null;
              break;
            }
            this.mode = 'draw';
            this.liveTool = { kind: t.kind, color: this.aiInkColor(t.color), size: t.size };
            this.live = [this.pressPt, pt];
          }
          break;
        }
        case 'text-press': {
          const dx = pt[0] - this.pressPt[0];
          const dy = pt[1] - this.pressPt[1];
          if (!this.xfOrig && Math.hypot(dx, dy) < slop) break;
          if (!this.xfOrig) this.beginTransform();
          if (this.xfOrig && this.xfFrame) {
            this.updateTransform({ ...this.xfFrame, x: this.xfFrame.x + dx, y: this.xfFrame.y + dy });
          }
          break;
        }
      }
    }
    this.schedule();
  };

  private onUp = (e: PointerEvent): void => {
    if (e.pointerId !== this.pointerId || !this.mode) return;
    const cancelled = e.type === 'pointercancel';
    const mode = this.mode;
    try {
      this.view?.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }

    switch (mode) {
      case 'draw':
        this.reset();
        if (!cancelled) this.commitStroke();
        else this.live = [];
        break;
      case 'erase':
        if (cancelled) {
          this.erased.clear();
          this.partial.clear();
          this.reset();
          this.invalidate();
        } else {
          this.reset();
          this.commitErase();
        }
        break;
      case 'lasso':
        this.finishLasso(cancelled);
        break;
      case 'tape-tap': {
        const id = this.tapeHit;
        this.reset();
        if (id && !cancelled) this.handleTapeTap(id);
        break;
      }
      case 'shape-press': {
        const id = this.shapeHit;
        this.reset();
        if (id && !cancelled) this.setSelection([id]); // a tap: select it for readjusting
        break;
      }
      case 'tape': {
        const tape = this.live.length > 1 ? this.tapeFromDrag() : null;
        this.live = [];
        this.reset();
        if (tape && !cancelled && tape.w >= TAPE_MIN && tape.h >= TAPE_MIN) this.addNewItems([tape]);
        break;
      }
      case 'shapes': {
        const shape = this.live.length > 1 ? this.shapeFromDrag() : null;
        this.live = [];
        this.reset();
        if (shape && !cancelled) {
          this.addNewItems([shape]);
          this.setSelection([shape.id]);
        }
        break;
      }
      case 'text-press': {
        const wasDragging = this.xfOrig != null;
        const frame = this.xfCur;
        const id = [...this.selected][0];
        this.reset();
        if (wasDragging) {
          this.endTransform(cancelled ? null : frame);
          return;
        }
        const el = id ? store.boardItem(this.nb.id, id) : undefined;
        if (el && !isStroke(el) && el.kind === 'text' && !cancelled) this.startEdit(el, false);
        break;
      }
      default:
        this.reset();
    }
    this.schedule();
  };

  private reset(): void {
    this.mode = null;
    this.pointerId = -1;
    this.lasso = [];
    this.tapeHit = null;
    this.shapeHit = null;
  }

  /** While AI mode is on a fresh mark inks in the AI accent colour, matching the page path. */
  private aiInkColor(base: string): string {
    return this.hooks.isAiActive() ? AI_COLOR : base;
  }

  /** Adds freshly created items as one undo step, filed under the chunk their own bounds fall in. */
  private addNewItems(items: PageItem[]): void {
    if (!items.length) return;
    const pageId = items[0].pageId;
    store.addItems(items);
    this.invalidate();
    this.hooks.onOp({ kind: 'add-items', pageId, items, aiInk: this.hooks.isAiActive() });
  }

  /** Resolves a finished lasso gesture: a tap selects (or clears), a real drag selects everything the polygon encloses. */
  private finishLasso(cancelled: boolean): void {
    const path = this.lasso;
    const pt = this.lassoPt;
    this.reset();
    if (cancelled) return;
    const travelled = Math.hypot(pt[0] - this.pressPt[0], pt[1] - this.pressPt[1]);
    if (path.length < 3 || travelled < TAP_SLOP / this.zoom()) {
      if (this.lastLassoPath && pointInPolygon(pt[0], pt[1], this.lastLassoPath)) {
        if (this.isDoubleTap(pt[0], pt[1])) {
          const frame = itemsFrame(this.selectedItems());
          if (frame) this.hooks.onSelectionFrame(this, frame);
        }
      } else {
        const hit = topItemAt(this.itemsNear(pt[0], pt[1], TAP_RADIUS), pt[0], pt[1]);
        this.setSelection(hit ? [hit.id] : []);
      }
      return;
    }
    const box = aabb(path);
    const ids: string[] = [];
    for (const it of store.boardItemsIn(this.nb.id, box)) {
      const inside = isStroke(it) ? strokeInPolygon(it.points, path) : elementInPolygon(it, path);
      if (inside) ids.push(it.id);
    }
    this.setSelection(ids, ids.length ? path : null);
    if (!ids.length) this.hooks.onEmptyLassoSelection(this, { ...box, rot: 0 });
  }

  /**
   * True on the second of two taps landing close together in time and space —
   * gates the Duplicate/Cut/Copy/Delete callout so it only ever appears on a
   * deliberate double-tap, never from the initial select or from a drag.
   */
  private isDoubleTap(x: number, y: number): boolean {
    const now = performance.now();
    const isDouble =
      now - this.lastTapAt <= DOUBLE_TAP_MS &&
      Math.hypot(x - this.lastTapPt[0], y - this.lastTapPt[1]) <= DOUBLE_TAP_SLOP;
    this.lastTapAt = isDouble ? 0 : now;
    this.lastTapPt = [x, y];
    return isDouble;
  }

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
      for (const seg of survivingSegments(st.points, gone)) {
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

  // ------------------------------------------------------------ hit testing
  /**
   * Items whose bounds fall within `pad` of a point. Everything on a board is
   * found through the spatial index rather than by scanning a page's list, so
   * a hit test costs what is *near* the finger, not what is on the board.
   * `itemBounds` already includes a stroke's nib width, so padding by
   * TAP_RADIUS covers exactly the tolerance `topItemAt` then applies.
   */
  private itemsNear(x: number, y: number, pad: number): PageItem[] {
    return store.boardItemsIn(this.nb.id, { x: x - pad, y: y - pad, w: pad * 2, h: pad * 2 });
  }

  private elementsNear(x: number, y: number): PageElement[] {
    return this.itemsNear(x, y, TAP_RADIUS).filter((it): it is PageElement => !isStroke(it));
  }

  private topTextAt(x: number, y: number): TextElement | null {
    return topElementAt(this.elementsNear(x, y), 'text', x, y);
  }

  private topShapeAt(x: number, y: number): ShapeElement | null {
    return topElementAt(this.elementsNear(x, y), 'shape', x, y);
  }

  private topTapeAt(x: number, y: number): TapeElement | null {
    return topElementAt(this.elementsNear(x, y), 'tape', x, y);
  }

  // ----------------------------------------------------------- new elements
  /** The chunk an item whose bounds start at `b` is filed under. */
  private chunkFor(b: Rect): string {
    return store.boardChunkAt(this.nb.id, b.x, b.y);
  }

  private beginShapeDrag(pt: number[]): void {
    const t = resolveDrawTool();
    this.liveTool = {
      kind: 'pen',
      color: this.aiInkColor(t ? t.color : toolState.penColor),
      size: t ? t.size : toolState.penSize,
    };
    this.mode = 'shapes';
    this.live = [pt];
  }

  private shapeFromFit(fit: ShapeFit, color: string, size: number): ShapeElement {
    return {
      id: uid(),
      kind: 'shape',
      pageId: this.chunkFor({ x: fit.x, y: fit.y, w: fit.w, h: fit.h }),
      notebookId: this.nb.id,
      shape: fit.shape,
      x: fit.x,
      y: fit.y,
      w: fit.w,
      h: fit.h,
      rotation: fit.rotation,
      color,
      size,
      createdAt: Date.now(),
      ...(fit.pts ? { pts: fit.pts } : {}),
    };
  }

  /** The shape a Shapes drag would place, or null while it is still too small. */
  private shapeFromDrag(): ShapeElement | null {
    const a = this.live[0];
    const b = this.live[this.live.length - 1];
    const kind = toolState.shapeKind;
    const { color, size } = this.liveTool;
    const shapeMin = SHAPE_MIN / this.zoom();
    if (kind === 'arrow') {
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) < shapeMin) return null;
      return this.shapeFromFit(lineFit('arrow', a, b, size), color, size);
    }
    const w = Math.abs(b[0] - a[0]);
    const h = Math.abs(b[1] - a[1]);
    if (w < shapeMin || h < shapeMin) return null;
    const fit: ShapeFit = { shape: kind, x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w, h, rotation: 0 };
    if (kind === 'triangle') fit.pts = [[0.5, 0], [1, 1], [0, 1]]; // apex up, base along the bottom
    return this.shapeFromFit(fit, color, size);
  }

  private tapeFromDrag(): TapeElement {
    const a = this.live[0];
    const b = this.live[this.live.length - 1];
    const x = Math.min(a[0], b[0]);
    const y = Math.min(a[1], b[1]);
    const w = Math.abs(b[0] - a[0]);
    const h = Math.abs(b[1] - a[1]);
    return {
      id: uid(),
      kind: 'tape',
      pageId: this.chunkFor({ x, y, w, h }),
      notebookId: this.nb.id,
      x,
      y,
      w,
      h,
      rotation: 0,
      color: this.aiInkColor(TAPE_COLOR),
      createdAt: Date.now(),
    };
  }

  /**
   * Places a loaded image centred on the *view* rather than on a page — a board
   * has no page to centre in, and dropping it at the origin would put it
   * somewhere the user cannot see. Fitted to a fraction of the visible width,
   * so it arrives at a sensible size whatever the zoom.
   */
  insertImage(src: string, naturalW: number, naturalH: number): void {
    const v = this.visibleRect();
    const scale = Math.min((v.w * IMAGE_FIT) / naturalW, (v.h * IMAGE_FIT) / naturalH, 1);
    const w = Math.max(24, naturalW * scale);
    const h = Math.max(24, naturalH * scale);
    const x = v.x + (v.w - w) / 2;
    const y = v.y + (v.h - h) / 2;
    const el: ImageElement = {
      id: uid(),
      kind: 'image',
      pageId: this.chunkFor({ x, y, w, h }),
      notebookId: this.nb.id,
      x,
      y,
      w,
      h,
      rotation: 0,
      src,
      createdAt: Date.now(),
    };
    this.pasteItems([el]);
  }

  // ------------------------------------------------------------- tape strips
  private getTape(id: string): TapeElement | undefined {
    const it = store.boardItem(this.nb.id, id);
    return it && !isStroke(it) && it.kind === 'tape' ? it : undefined;
  }

  /** Peels a covering strip back, or covers a peeled one. View-only: nothing is stored. */
  private toggleTape(id: string): void {
    if (this.peeled.has(id)) this.peeled.delete(id);
    else this.peeled.add(id);
    this.invalidate();
  }

  private handleTapeTap(id: string): void {
    if (toolState.kind !== 'tape') {
      this.toggleTape(id);
      return;
    }
    const t = this.getTape(id);
    if (t) this.hooks.onTapeTap(this, id, { x: t.x, y: t.y, w: t.w, h: t.h, rot: t.rotation });
  }

  isPeeled(id: string): boolean {
    return this.peeled.has(id);
  }

  beginTapeResize(id: string): TapeElement | null {
    const t = this.getTape(id);
    this.tapeResizeOrig = t ? { ...t } : null;
    return this.tapeResizeOrig;
  }

  previewTapeResize(id: string, w: number, h: number): void {
    const t = this.getTape(id);
    if (!t) return;
    store.replaceItems(t.pageId, [{ ...t, w: Math.max(TAPE_MIN, w), h: Math.max(TAPE_MIN, h) }]);
    this.invalidate();
  }

  commitTapeResize(id: string): void {
    const before = this.tapeResizeOrig;
    this.tapeResizeOrig = null;
    if (!before) return;
    const after = this.getTape(id);
    if (!after || (after.w === before.w && after.h === before.h)) return;
    this.hooks.onOp({ kind: 'replace-items', pageId: before.pageId, before: [before], after: [after] });
  }

  tapeGeometry(id: string): { w: number; h: number } | null {
    const t = this.getTape(id);
    return t ? { w: t.w, h: t.h } : null;
  }

  deleteTape(id: string): void {
    const t = this.getTape(id);
    if (!t) return;
    const removed = store.removeItems(t.pageId, new Set([id]));
    if (!removed.length) return;
    this.peeled.delete(id);
    this.invalidate();
    this.hooks.onOp({ kind: 'remove-items', pageId: t.pageId, items: removed });
  }

  /** A board has no page to bound a strip by, so the slider spans what is on screen. */
  tapeSizeLimit(): { w: number; h: number } {
    const v = this.visibleRect();
    return { w: Math.max(TAPE_MIN * 4, v.w), h: Math.max(TAPE_MIN * 4, v.h) };
  }

  // -------------------------------------------------------------- selection
  /**
   * The selected items, in z-order. A text box mid-edit is represented by the
   * editor's working copy, which for a brand-new box is not in the store yet.
   */
  selectedItems(): PageItem[] {
    if (!this.selected.size) return [];
    const ed = this.editor;
    const items: PageItem[] = [];
    for (const id of this.selected) {
      if (ed && id === ed.el.id) continue;
      const it = store.boardItem(this.nb.id, id);
      if (it) items.push(it);
    }
    items.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
    if (ed && this.selected.has(ed.el.id)) items.push(ed.el);
    return items;
  }

  private setSelection(ids: string[], lassoPath: number[][] | null = null): void {
    this.selected = new Set(ids);
    this.lastLassoPath = lassoPath;
    this.showSelection();
    this.hooks.onSelection(this, this.selected.size);
    this.schedule();
  }

  private showSelection(): void {
    const view = selectionView(this.selectedItems(), this.lastLassoPath, this.editor != null);
    if (!view) {
      this.hooks.hideSelection(this);
      this.hooks.onSelectionFrame(this, null);
      return;
    }
    this.hooks.showSelection(this, view.frame, view.opts);
    this.hooks.onSelectionFrame(this, null);
  }

  clearSelection(): boolean {
    const had = this.editor !== null || this.selected.size > 0 || this.lastLassoPath !== null;
    this.commitEdit();
    if (this.selected.size) {
      this.setSelection([]);
    } else {
      this.lastLassoPath = null;
      this.hooks.hideSelection(this);
      this.hooks.onSelectionFrame(this, null);
    }
    if (had) this.schedule();
    return had;
  }

  /** Called by the notebook when the active tool changes. */
  deactivate(): void {
    this.clearSelection();
  }

  /** Called by the shared SelectionOverlay's onTap hook. */
  tapSelection(x: number, y: number): void {
    if (this.lastLassoPath) {
      if (pointInPolygon(x, y, this.lastLassoPath)) {
        this.hooks.onSelectionFrame(this, { ...aabb(this.lastLassoPath), rot: 0 });
      } else {
        const hit = topItemAt(this.itemsNear(x, y, TAP_RADIUS), x, y);
        this.setSelection(hit ? [hit.id] : []);
      }
      return;
    }
    if (!this.selected.size) return;
    if (toolState.kind === 'text' && !this.editor) {
      const items = this.selectedItems();
      const el = items.length === 1 && !isStroke(items[0]) ? items[0] : null;
      if (el?.kind === 'text' && pointInElement(el, x, y)) {
        this.startEdit(el, false);
        return;
      }
    }
    const frame = itemsFrame(this.selectedItems());
    if (frame) this.hooks.onSelectionFrame(this, frame);
  }

  deleteSelection(): void {
    if (this.editor) {
      const ed = this.editor;
      this.editor = null;
      ed.area.remove();
      if (ed.isNew) {
        this.setSelection([]);
        this.invalidate();
        return;
      }
    }
    const items = this.selectedItems();
    if (!items.length) return;
    const pageId = items[0].pageId;
    this.selected = new Set();
    this.lastLassoPath = null;
    // removeItems resolves each id to its own chunk on a board, so a selection
    // spanning several still comes off in one call — and so stays one undo step
    const removed = store.removeItems(pageId, new Set(items.map((it) => it.id)));
    this.hooks.hideSelection(this);
    this.invalidate();
    this.hooks.onSelection(this, 0);
    this.hooks.onSelectionFrame(this, null);
    if (removed.length) this.hooks.onOp({ kind: 'remove-items', pageId, items: removed });
  }

  recolorSelection(tool: 'pen' | 'highlighter', color: string): void {
    const before = this.selectedItems().filter((it): it is Stroke => isStroke(it) && it.tool === tool);
    if (!before.length) return;
    const after = before.map((st) => ({ ...st, color }));
    store.replaceItems(before[0].pageId, after);
    this.invalidate();
    this.hooks.onOp({ kind: 'replace-items', pageId: before[0].pageId, before, after });
  }

  /**
   * Adds already-cloned items as one undo step and selects them — the shared
   * landing point for paste, Duplicate and image-insert. Each item is re-filed
   * under the chunk its own bounds fall in: the caller cloned them against this
   * surface's nominal page, but on a board the chunk follows the geometry.
   */
  pasteItems(items: PageItem[]): void {
    if (!items.length) return;
    this.commitEdit();
    const aiInk = this.hooks.isAiActive();
    const toAdd = items.map((it) => {
      const filed = { ...it, pageId: this.chunkFor(itemBounds(it)) } as PageItem;
      return aiInk && 'color' in filed ? ({ ...filed, color: AI_COLOR } as PageItem) : filed;
    });
    store.addItems(toAdd);
    this.invalidate();
    this.hooks.onOp({ kind: 'add-items', pageId: toAdd[0].pageId, items: toAdd, aiInk });
    this.setSelection(toAdd.map((it) => it.id));
  }

  /** The store changed under us (undo/redo): drop any selection and repaint. */
  refresh(): void {
    this.clearSelection();
    this.invalidate();
  }

  // -------------------------------------------------------------- transform
  beginTransform(): void {
    const items = this.selectedItems();
    // must match showSelection()'s frame exactly, or the overlay's drag math
    // and ours disagree about what "from" means on the very first tick
    const frame = this.lastLassoPath ? { ...aabb(this.lastLassoPath), rot: 0 } : itemsFrame(items);
    if (!items.length || !frame) return;
    this.xfOrig = items;
    this.xfFrame = frame;
    this.xfCur = frame;
    this.xfLive = items;
    this.xfLassoOrig = this.lastLassoPath;
    this.hooks.onSelectionFrame(this, null); // a drag must never keep the callout open
    this.invalidate(); // hides the originals; the view paints the live copies
  }

  updateTransform(frame: Frame): void {
    if (!this.xfOrig || !this.xfFrame) return;
    const same = frame.w === this.xfFrame.w && frame.h === this.xfFrame.h && frame.rot === this.xfFrame.rot;
    this.xfLive = same
      ? translateItems(this.xfOrig, frame.x - this.xfFrame.x, frame.y - this.xfFrame.y)
      : transformItems(this.xfOrig, this.xfFrame, frame);
    // remapped fresh from the frozen pre-drag snapshot each tick, never from
    // the previous tick's result, so repeated remaps do not compound
    if (this.xfLassoOrig) {
      const from = this.xfFrame;
      this.lastLassoPath = this.xfLassoOrig.map((pt) => mapPoint(pt[0], pt[1], from, frame));
    }
    this.xfCur = frame;
    this.syncEditor(this.xfLive[0]);
    this.hooks.updateSelection(this, frame);
    this.schedule();
  }

  /**
   * Commits a finished drag/resize/rotate. There is no cross-page branch here —
   * a board is one surface, so a move can never leave it. The item's `pageId`
   * deliberately does not follow it across a chunk boundary either (see
   * Store.replaceItems), which is what keeps this a plain `replace-items` op
   * and so leaves undo/redo with nothing board-specific to know.
   */
  endTransform(frame: Frame | null): void {
    const orig = this.xfOrig;
    const from = this.xfFrame;
    const lassoOrig = this.xfLassoOrig;
    this.xfOrig = this.xfFrame = this.xfCur = this.xfLive = null;
    this.xfLassoOrig = null;
    if (!orig || !from) return;

    if (frame) {
      const same = frame.w === from.w && frame.h === from.h && frame.rot === from.rot;
      const after = same
        ? translateItems(orig, frame.x - from.x, frame.y - from.y)
        : transformItems(orig, from, frame).map((it) =>
            !isStroke(it) && it.kind === 'text' ? { ...it, h: textHeight(it) } : it
          );
      const ed = this.editor;
      const midEdit = ed && orig.length === 1 && orig[0].id === ed.el.id;
      if (midEdit) {
        // keep the geometry on the working copy; commitEdit records the whole
        // edit (typing + moves) as a single undo step
        ed.el = after[0] as TextElement;
      } else {
        store.replaceItems(orig[0].pageId, after);
        this.hooks.onOp({ kind: 'replace-items', pageId: orig[0].pageId, before: orig, after });
      }
      // commit the outline's new shape permanently, so it does not snap back on
      // the next showSelection() and a second drag starts where this one ended
      if (lassoOrig) this.lastLassoPath = lassoOrig.map((pt) => mapPoint(pt[0], pt[1], from, frame));
    } else if (lassoOrig) {
      this.lastLassoPath = lassoOrig; // cancelled: items never changed, restore the outline too
    }
    this.invalidate();
    this.showSelection();
    this.syncEditor();
  }

  // -------------------------------------------------------------- text edit
  private newText(x: number, y: number): TextElement {
    const fontSize = TEXT_DEFAULT_SIZE;
    const w = TEXT_DEFAULT_WIDTH;
    const ty = y - fontSize * TEXT_LINE_HEIGHT * 0.5;
    return {
      id: uid(),
      kind: 'text',
      pageId: this.chunkFor({ x, y: ty, w, h: fontSize * TEXT_LINE_HEIGHT }),
      notebookId: this.nb.id,
      x,
      // no page edge to clamp against — a board box starts exactly where tapped
      y: ty,
      w,
      h: fontSize * TEXT_LINE_HEIGHT,
      rotation: 0,
      text: '',
      color: this.aiInkColor(toolState.textColor),
      fontSize,
      createdAt: Date.now(),
    };
  }

  private startEdit(el: TextElement, isNew: boolean): void {
    const cam = this.editorCam;
    if (!cam) return;
    this.commitEdit();
    const area = document.createElement('textarea');
    area.className = 'text-editor';
    area.rows = 1;
    area.spellcheck = false;
    area.setAttribute('aria-label', 'Text box');
    area.value = el.text;
    this.editor = { el: { ...el }, isNew, area };
    cam.append(area);
    this.syncEditor();

    area.addEventListener('input', () => {
      const ed = this.editor;
      if (!ed) return;
      ed.el = { ...ed.el, text: area.value, h: layoutText(area.value, ed.el.fontSize, ed.el.w).height };
      this.syncEditor();
      const f = itemsFrame([ed.el]);
      if (f) this.hooks.updateSelection(this, f);
    });
    area.addEventListener('keydown', (e) => {
      e.stopPropagation(); // typing must not trigger app shortcuts
      if (e.key === 'Escape') {
        e.preventDefault();
        this.commitEdit();
      }
    });
    area.addEventListener('pointerdown', (e) => e.stopPropagation());

    this.selected = new Set([el.id]);
    this.lastLassoPath = null;
    this.invalidate(); // hides the committed copy while the textarea shows it
    this.showSelection();
    this.hooks.onSelection(this, 1);
    requestAnimationFrame(() => {
      area.focus();
      area.setSelectionRange(area.value.length, area.value.length);
    });
  }

  /** Positions the textarea over its element, in board units — `editorCam` carries the camera. */
  private syncEditor(live?: PageItem): void {
    const ed = this.editor;
    if (!ed) return;
    const el = live && live.id === ed.el.id && !isStroke(live) && live.kind === 'text' ? live : ed.el;
    const st = ed.area.style;
    st.left = `${el.x}px`;
    st.top = `${el.y}px`;
    st.width = `${el.w}px`;
    st.height = `${Math.max(el.h, el.fontSize * TEXT_LINE_HEIGHT)}px`;
    st.font = `400 ${el.fontSize}px ${TEXT_FONT_FAMILY}`;
    st.lineHeight = String(TEXT_LINE_HEIGHT);
    st.color = resolveInkColor(el.color, this.paper());
    st.transform = el.rotation ? `rotate(${el.rotation}rad)` : '';
  }

  /** Writes the camera onto the text-editor layer, so the textarea tracks pan/zoom exactly as the canvas does. */
  private syncEditorCamera(): void {
    const cam = this.editorCam;
    if (!cam) return;
    const { x, y, zoom } = this.camera;
    cam.style.transform = `scale(${zoom}) translate(${-x}px, ${-y}px)`;
  }

  /** Finishes the current text edit: adds / updates / removes the element as one undo step. */
  commitEdit(): void {
    const ed = this.editor;
    if (!ed) return;
    this.editor = null;
    ed.area.remove();
    const text = ed.area.value;

    if (!text.trim()) {
      if (!ed.isNew) {
        const removed = store.removeItems(ed.el.pageId, new Set([ed.el.id]));
        if (removed.length) this.hooks.onOp({ kind: 'remove-items', pageId: ed.el.pageId, items: removed });
      }
      this.selected = new Set();
      this.lastLassoPath = null;
      this.hooks.hideSelection(this);
      this.invalidate();
      this.hooks.onSelection(this, 0);
      return;
    }

    const next: TextElement = { ...ed.el, text, h: layoutText(text, ed.el.fontSize, ed.el.w).height };
    if (ed.isNew) {
      store.addItems([next]);
      this.hooks.onOp({ kind: 'add-items', pageId: next.pageId, items: [next], aiInk: next.color === AI_COLOR });
    } else {
      const cur = store.boardItem(this.nb.id, next.id);
      if (cur && !isStroke(cur) && !sameText(cur, next)) {
        store.replaceItems(next.pageId, [next]);
        this.hooks.onOp({ kind: 'replace-items', pageId: next.pageId, before: [cur], after: [next] });
      }
    }
    this.invalidate();
    this.showSelection(); // stays selected (draggable) until the user taps elsewhere
  }

  // ------------------------------------------------------------- screen map
  /**
   * See ItemSurface.calloutBasis. A board has no per-item element to measure,
   * so this hands back the canvas rect shifted by the camera: with `pw` set to
   * the viewport's own width in board units, `frameScreenBox`'s
   * `rect.left + local * (rect.width / pw)` resolves world units against the
   * same origin the canvas draws them at.
   */
  calloutBasis(): { rect: DOMRect; pw: number } | null {
    const view = this.view;
    if (!view) return null;
    const r = view.getBoundingClientRect();
    const z = this.zoom();
    const shifted = new DOMRect(r.left - this.camera.x * z, r.top - this.camera.y * z, r.width, r.height);
    return { rect: shifted, pw: r.width / z };
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
