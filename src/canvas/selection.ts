import { icon } from '../ui/icon';
import { rotateAround, type Frame } from './geom';

type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const CORNERS = new Set<Handle>(['nw', 'ne', 'se', 'sw']);

/** Smallest box a drag can shrink a selection to, in page units. */
const MIN_SIZE = 8;

export interface OverlayOptions {
  /** show the rotate grip (single elements only) */
  rotate: boolean;
  /** corner drags keep the aspect ratio (text boxes: the type scales with the box) */
  aspect: boolean;
  /** which edge (non-corner) handles to show */
  edges: 'all' | 'horizontal' | 'none';
  /** the body lets pointer events through (while a text box is being edited) */
  passThrough: boolean;
}

export interface OverlayHooks {
  onDragStart: () => void;
  onDrag: (frame: Frame) => void;
  /** `null` = the drag was cancelled (or never moved); restore the pre-drag state */
  onDragEnd: (frame: Frame | null) => void;
  /** a press on the box body that never moved — page-space point */
  onTap: (x: number, y: number) => void;
  onDelete: () => void;
}

/**
 * The bounding box drawn around a selection: a rotated, absolutely positioned
 * div with resize handles on its edges, a rotate grip above it and a delete
 * button at its corner. It owns the handle geometry — dragging the body moves
 * the frame, a handle resizes it (anchored on the opposite side, in the frame's
 * own rotated space) and the grip rotates it — and reports the resulting frame
 * to its hooks; the page canvas maps that onto the selected items.
 */
export class SelectionOverlay {
  private readonly host: HTMLElement;
  private readonly hooks: OverlayHooks;
  private readonly box: HTMLElement;
  private readonly handleEls = new Map<Handle, HTMLElement>();
  private readonly rotEl: HTMLElement;
  /** the page this overlay lives on, in page units — for the screen→page coordinate conversion in toPage. */
  private readonly pw: number;
  private readonly ph: number;
  private frame: Frame | null = null;
  private opts: OverlayOptions = { rotate: false, aspect: false, edges: 'all', passThrough: false };

  private drag: {
    pointerId: number;
    kind: 'move' | 'resize' | 'rotate';
    handle: Handle | null;
    start: Frame;
    startPt: [number, number];
    startAngle: number;
  } | null = null;

  constructor(host: HTMLElement, hooks: OverlayHooks, pw: number, ph: number) {
    this.host = host;
    this.hooks = hooks;
    this.pw = pw;
    this.ph = ph;

    this.box = document.createElement('div');
    this.box.className = 'sel-box';
    this.box.hidden = true;

    for (const h of HANDLES) {
      const d = document.createElement('div');
      d.className = `sel-h sel-h--${h}`;
      d.dataset.h = h;
      this.handleEls.set(h, d);
      this.box.append(d);
    }

    this.rotEl = document.createElement('div');
    this.rotEl.className = 'sel-rot';
    this.rotEl.title = 'Rotate';
    this.rotEl.append(icon('rotate', 'sm'));
    this.box.append(this.rotEl);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'sel-del';
    del.title = 'Delete';
    del.setAttribute('aria-label', 'Delete selection');
    del.append(icon('close', 'sm'));
    del.addEventListener('pointerdown', (e) => e.stopPropagation());
    del.addEventListener('click', () => this.hooks.onDelete());
    this.box.append(del);

    this.box.addEventListener('pointerdown', this.onDown);
    this.box.addEventListener('pointermove', this.onMove);
    this.box.addEventListener('pointerup', this.onUp);
    this.box.addEventListener('pointercancel', this.onUp);
    host.append(this.box);
  }

  get visible(): boolean {
    return !this.box.hidden;
  }

  get dragging(): boolean {
    return this.drag != null;
  }

  show(frame: Frame, opts: OverlayOptions): void {
    this.frame = { ...frame };
    this.opts = opts;
    this.box.hidden = false;
    this.box.classList.toggle('sel-box--pass', opts.passThrough);
    this.rotEl.hidden = !opts.rotate;
    for (const [h, d] of this.handleEls) {
      const isCorner = CORNERS.has(h);
      const horizontal = h === 'e' || h === 'w';
      d.hidden = !isCorner && (opts.edges === 'none' || (opts.edges === 'horizontal' && !horizontal));
    }
    this.place();
  }

  hide(): void {
    this.box.hidden = true;
    this.frame = null;
    this.drag = null;
  }

  /** Repositions to a new frame without changing the handle set (e.g. as text grows while typing). */
  update(frame: Frame): void {
    if (this.box.hidden) return;
    this.frame = { ...frame };
    this.place();
  }

  destroy(): void {
    this.box.remove();
  }

  private place(): void {
    const f = this.frame;
    if (!f) return;
    const s = this.box.style;
    s.left = `${f.x}px`;
    s.top = `${f.y}px`;
    s.width = `${f.w}px`;
    s.height = `${f.h}px`;
    s.transform = f.rot ? `rotate(${f.rot}rad)` : '';
  }

  private toPage(e: PointerEvent): [number, number] {
    const r = this.host.getBoundingClientRect();
    return [
      (e.clientX - r.left) * (this.pw / r.width),
      (e.clientY - r.top) * (this.ph / r.height),
    ];
  }

  private onDown = (e: PointerEvent): void => {
    if (this.drag || !this.frame) return;
    const target = e.target as HTMLElement;
    const handleEl = target.closest<HTMLElement>('.sel-h');
    const isRot = !!target.closest('.sel-rot');
    e.preventDefault();
    e.stopPropagation();
    try {
      this.box.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    const pt = this.toPage(e);
    const f = this.frame;
    const cx = f.x + f.w / 2;
    const cy = f.y + f.h / 2;
    this.drag = {
      pointerId: e.pointerId,
      kind: isRot ? 'rotate' : handleEl ? 'resize' : 'move',
      handle: handleEl ? (handleEl.dataset.h as Handle) : null,
      start: { ...f },
      startPt: pt,
      startAngle: Math.atan2(pt[1] - cy, pt[0] - cx),
    };
    this.hooks.onDragStart();
  };

  private onMove = (e: PointerEvent): void => {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointerId) return;
    e.preventDefault();
    const pt = this.toPage(e);
    let next: Frame;
    if (d.kind === 'move') {
      next = { ...d.start, x: d.start.x + pt[0] - d.startPt[0], y: d.start.y + pt[1] - d.startPt[1] };
    } else if (d.kind === 'rotate') {
      const cx = d.start.x + d.start.w / 2;
      const cy = d.start.y + d.start.h / 2;
      const ang = Math.atan2(pt[1] - cy, pt[0] - cx);
      next = { ...d.start, rot: d.start.rot + (ang - d.startAngle) };
    } else {
      next = this.resized(d.start, d.handle!, pt);
    }
    this.frame = next;
    this.place();
    this.hooks.onDrag(next);
  };

  private onUp = (e: PointerEvent): void => {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointerId) return;
    e.preventDefault();
    try {
      this.box.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    this.drag = null;
    if (e.type === 'pointercancel') {
      this.frame = { ...d.start };
      this.place();
      this.hooks.onDragEnd(null);
      return;
    }
    const moved =
      this.frame &&
      (this.frame.x !== d.start.x ||
        this.frame.y !== d.start.y ||
        this.frame.w !== d.start.w ||
        this.frame.h !== d.start.h ||
        this.frame.rot !== d.start.rot);
    this.hooks.onDragEnd(moved ? this.frame : null);
    if (!moved && d.kind === 'move') {
      const pt = this.toPage(e);
      this.hooks.onTap(pt[0], pt[1]);
    }
  };

  /**
   * New frame for dragging `handle` to page point `pt`: the opposite side stays
   * put, measured in the frame's own (rotated) space. Corners keep the aspect
   * ratio when `opts.aspect` is set.
   */
  private resized(start: Frame, handle: Handle, pt: [number, number]): Frame {
    const cx = start.x + start.w / 2;
    const cy = start.y + start.h / 2;
    const [px, py] = rotateAround(pt[0], pt[1], cx, cy, -start.rot);
    const lx = px - start.x;
    const ly = py - start.y;

    let l = 0;
    let t = 0;
    let r = start.w;
    let b = start.h;
    if (handle.includes('w')) l = Math.min(lx, r - MIN_SIZE);
    if (handle.includes('e')) r = Math.max(lx, l + MIN_SIZE);
    if (handle.includes('n')) t = Math.min(ly, b - MIN_SIZE);
    if (handle.includes('s')) b = Math.max(ly, t + MIN_SIZE);

    if (this.opts.aspect && CORNERS.has(handle) && start.w > 0 && start.h > 0) {
      const s = Math.max((r - l) / start.w, (b - t) / start.h);
      const w = Math.max(start.w * s, MIN_SIZE);
      const h = Math.max(start.h * s, MIN_SIZE);
      if (handle.includes('w')) l = r - w;
      else r = l + w;
      if (handle.includes('n')) t = b - h;
      else b = t + h;
    }

    // the new box's centre, back in page space (rotation is about the old centre)
    const [ncx, ncy] = rotateAround(start.x + (l + r) / 2, start.y + (t + b) / 2, cx, cy, start.rot);
    const w = r - l;
    const h = b - t;
    return { x: ncx - w / 2, y: ncy - h / 2, w, h, rot: start.rot };
  }
}
