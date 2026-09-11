import { PAGE_H, PAGE_W } from '../const';
import { icon } from '../ui/icon';

export type GuideKind = 'ruler' | 'protractor';

/** The ruler spans the whole page width. */
export const RULER_LEN = PAGE_W;
export const RULER_THICK = 64;
export const PROTRACTOR_R = 200;
/** Page units are CSS px at 96 dpi, so the scales read in real centimetres and inches. */
const PX_PER_INCH = 96;
const PX_PER_CM = PX_PER_INCH / 2.54;
/** How close (page units) a pen-down must be to a straight edge to snap to it. */
const SNAP_DIST = 24;

/** A straight edge in page space: a point on it and its unit direction. */
export interface EdgeLine {
  px: number;
  py: number;
  ux: number;
  uy: number;
}

/** Projects a page point onto an edge line. */
export function projectOnEdge(e: EdgeLine, x: number, y: number): [number, number] {
  const t = (x - e.px) * e.ux + (y - e.py) * e.uy;
  return [e.px + t * e.ux, e.py + t * e.uy];
}

/** Screen angle (radians, y down) → protractor-style degrees, counter-clockwise, 0–359. */
function degrees(rad: number): number {
  const d = Math.round((-rad * 180) / Math.PI);
  return ((d % 360) + 360) % 360;
}

/**
 * An on-page drawing aid — a ruler bar or a protractor semicircle — that the
 * user drags around and rotates. It is view state only: never stored. Pen
 * strokes that start next to its straight edge are snapped onto that edge by
 * the page canvas (see `edgeNear`).
 */
export class Guide {
  readonly kind: GuideKind;
  private readonly host: HTMLElement;
  private readonly root: HTMLElement;
  private readonly angleEl: HTMLElement;
  private cx: number;
  private cy: number;
  private angle = 0;
  private drag: { pointerId: number; kind: 'move' | 'rotate'; startPt: [number, number]; cx: number; cy: number } | null =
    null;

  constructor(host: HTMLElement, kind: GuideKind) {
    this.host = host;
    this.kind = kind;
    this.cx = PAGE_W / 2;
    this.cy = kind === 'ruler' ? PAGE_H * 0.4 : PAGE_H * 0.45;

    this.root = document.createElement('div');
    this.root.className = `guide guide--${kind}`;
    this.root.append(kind === 'ruler' ? rulerSvg() : protractorSvg());
    const rot = el('div', 'guide__rot');
    rot.title = 'Rotate';
    rot.append(icon('rotate', 'sm'));
    this.angleEl = el('span', 'guide__angle');
    this.angleEl.hidden = kind === 'ruler'; // the ruler only shows its angle while rotating
    this.root.append(rot, this.angleEl);

    this.root.addEventListener('pointerdown', this.onDown);
    this.root.addEventListener('pointermove', this.onMove);
    this.root.addEventListener('pointerup', this.onUp);
    this.root.addEventListener('pointercancel', this.onUp);
    host.append(this.root);
    this.place();
  }

  destroy(): void {
    this.root.remove();
  }

  /** The guide's rotation in protractor degrees (0–359, counter-clockwise). */
  get degrees(): number {
    return degrees(this.angle);
  }

  /**
   * If (x, y) is within snapping distance of one of the guide's straight edges
   * (the ruler's two long sides, the protractor's baseline), returns that edge.
   */
  edgeNear(x: number, y: number): EdgeLine | null {
    const ux = Math.cos(this.angle);
    const uy = Math.sin(this.angle);
    const nx = -uy;
    const ny = ux;
    const dx = x - this.cx;
    const dy = y - this.cy;
    const t = dx * ux + dy * uy; // along the edge
    const d = dx * nx + dy * ny; // across it
    if (this.kind === 'ruler') {
      if (Math.abs(t) > RULER_LEN / 2 + 10) return null;
      const half = RULER_THICK / 2;
      if (Math.abs(Math.abs(d) - half) > SNAP_DIST) return null;
      const side = d < 0 ? -half : half;
      return { px: this.cx + nx * side, py: this.cy + ny * side, ux, uy };
    }
    if (Math.abs(t) > PROTRACTOR_R + 10 || Math.abs(d) > SNAP_DIST) return null;
    return { px: this.cx, py: this.cy, ux, uy };
  }

  private place(): void {
    const s = this.root.style;
    if (this.kind === 'ruler') {
      s.left = `${this.cx - RULER_LEN / 2}px`;
      s.top = `${this.cy - RULER_THICK / 2}px`;
      s.width = `${RULER_LEN}px`;
      s.height = `${RULER_THICK}px`;
    } else {
      // box = the semicircle; its bottom edge (the baseline) passes through the centre
      s.left = `${this.cx - PROTRACTOR_R}px`;
      s.top = `${this.cy - PROTRACTOR_R}px`;
      s.width = `${PROTRACTOR_R * 2}px`;
      s.height = `${PROTRACTOR_R}px`;
    }
    s.transform = `rotate(${this.angle}rad)`;
    this.root.style.setProperty('--guide-unrot', `${-this.angle}rad`);
    this.angleEl.textContent = `${this.degrees}°`;
  }

  private toPage(e: PointerEvent): [number, number] {
    const r = this.host.getBoundingClientRect();
    return [(e.clientX - r.left) * (PAGE_W / r.width), (e.clientY - r.top) * (PAGE_H / r.height)];
  }

  private onDown = (e: PointerEvent): void => {
    if (this.drag) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      this.root.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    const isRot = !!(e.target as HTMLElement).closest('.guide__rot');
    this.drag = { pointerId: e.pointerId, kind: isRot ? 'rotate' : 'move', startPt: this.toPage(e), cx: this.cx, cy: this.cy };
    if (isRot) this.angleEl.hidden = false;
  };

  private onMove = (e: PointerEvent): void => {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointerId) return;
    e.preventDefault();
    const pt = this.toPage(e);
    if (d.kind === 'move') {
      this.cx = Math.min(Math.max(d.cx + pt[0] - d.startPt[0], 0), PAGE_W);
      this.cy = Math.min(Math.max(d.cy + pt[1] - d.startPt[1], 0), PAGE_H);
    } else {
      // the grip sits at the ruler's right end / the protractor's apex
      let a = Math.atan2(pt[1] - this.cy, pt[0] - this.cx);
      if (this.kind === 'protractor') a += Math.PI / 2;
      const deg = Math.round((a * 180) / Math.PI); // whole degrees, like a real protractor
      this.angle = (deg * Math.PI) / 180;
    }
    this.place();
  };

  private onUp = (e: PointerEvent): void => {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointerId) return;
    try {
      this.root.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    this.drag = null;
    if (this.kind === 'ruler') this.angleEl.hidden = true;
  };
}

function el(tag: string, cls: string): HTMLElement {
  const d = document.createElement(tag);
  d.className = cls;
  return d;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgLine(x1: number, y1: number, x2: number, y2: number, cls: string): SVGLineElement {
  const l = document.createElementNS(SVG_NS, 'line');
  l.setAttribute('x1', String(x1));
  l.setAttribute('y1', String(y1));
  l.setAttribute('x2', String(x2));
  l.setAttribute('y2', String(y2));
  l.setAttribute('class', cls);
  return l;
}

function svgText(x: number, y: number, text: string, cls: string, anchor = 'middle'): SVGTextElement {
  const t = document.createElementNS(SVG_NS, 'text');
  t.setAttribute('x', String(x));
  t.setAttribute('y', String(y));
  t.setAttribute('class', cls);
  t.style.textAnchor = anchor; // inline, so it beats the stylesheet's default `middle`
  t.textContent = text;
  return t;
}

/**
 * The ruler bar: centimetres along the top edge (a tick every millimetre,
 * longer at 5 mm and 1 cm, numbered every centimetre) and inches along the
 * bottom (a tick every 1/16", longer at 1/8", 1/4", 1/2" and 1", numbered
 * every inch). Both scales start at the left end.
 */
function rulerSvg(): SVGSVGElement {
  const W = RULER_LEN;
  const H = RULER_THICK;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const body = document.createElementNS(SVG_NS, 'rect');
  body.setAttribute('class', 'guide__body');
  body.setAttribute('x', '0');
  body.setAttribute('y', '0');
  body.setAttribute('width', String(W));
  body.setAttribute('height', String(H));
  body.setAttribute('rx', '4');
  svg.append(body);

  // top: millimetres
  for (let mm = 0; (mm * PX_PER_CM) / 10 <= W; mm++) {
    const x = (mm * PX_PER_CM) / 10;
    const cm = mm % 10 === 0;
    const len = cm ? 18 : mm % 5 === 0 ? 12 : 7;
    svg.append(svgLine(x, 0, x, len, cm ? 'guide__tick guide__tick--major' : 'guide__tick'));
    // the origin carries the unit tag instead of a "0", as on a real ruler
    if (cm && mm === 0) svg.append(svgText(x + 3, 27, 'cm', 'guide__label guide__label--unit', 'start'));
    else if (cm) svg.append(svgText(x, 27, String(mm / 10), 'guide__label'));
  }

  // bottom: sixteenths of an inch
  for (let s = 0; (s * PX_PER_INCH) / 16 <= W; s++) {
    const x = (s * PX_PER_INCH) / 16;
    const inch = s % 16 === 0;
    const len = inch ? 18 : s % 8 === 0 ? 13 : s % 4 === 0 ? 9 : 5;
    svg.append(svgLine(x, H, x, H - len, inch ? 'guide__tick guide__tick--major' : 'guide__tick'));
    if (inch && s === 0) svg.append(svgText(x + 3, H - 25, 'in', 'guide__label guide__label--unit', 'start'));
    else if (inch) svg.append(svgText(x, H - 25, String(s / 16), 'guide__label'));
  }
  return svg;
}

/**
 * Semicircle with a tick every degree (longer at 5° and 10°), numbered every
 * 10° on the outer scale (0° at the right, like a real protractor) and again,
 * reading the other way, on a smaller inner scale.
 */
function protractorSvg(): SVGSVGElement {
  const R = PROTRACTOR_R;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${R * 2} ${R}`);
  const body = document.createElementNS(SVG_NS, 'path');
  body.setAttribute('class', 'guide__body');
  body.setAttribute('d', `M0 ${R} A${R} ${R} 0 0 1 ${R * 2} ${R} Z`);
  svg.append(body);
  const on = (deg: number, r: number): [number, number] => {
    const a = (deg * Math.PI) / 180;
    return [R + r * Math.cos(a), R - r * Math.sin(a)];
  };
  // guide rays from the origin every 10°, stopping short of the inner scale so
  // the numbers stay clear; the 0° / 90° / 180° axes are heavier. A drawn
  // angle is lined up on the origin and its arm read against these.
  for (let deg = 0; deg <= 180; deg += 10) {
    const [x, y] = on(deg, R - 64);
    svg.append(svgLine(R, R, x, y, deg % 90 === 0 ? 'guide__ray guide__ray--axis' : 'guide__ray'));
  }
  for (let deg = 0; deg <= 180; deg++) {
    const ten = deg % 10 === 0;
    const len = ten ? 22 : deg % 5 === 0 ? 14 : 7;
    const [x1, y1] = on(deg, R);
    const [x2, y2] = on(deg, R - len);
    svg.append(svgLine(x1, y1, x2, y2, ten ? 'guide__tick guide__tick--major' : 'guide__tick'));
    if (ten) {
      const [tx, ty] = on(deg, R - 36);
      svg.append(svgText(tx, ty, String(deg), 'guide__label'));
      if (deg > 0 && deg < 180) {
        const [ix, iy] = on(deg, R - 56);
        svg.append(svgText(ix, iy, String(180 - deg), 'guide__label guide__label--inner'));
      }
    }
  }
  // inner arc separating the two scales, and the centre mark on the baseline
  const inner = document.createElementNS(SVG_NS, 'path');
  inner.setAttribute('class', 'guide__tick');
  inner.setAttribute('d', `M${R - (R - 46)} ${R} A${R - 46} ${R - 46} 0 0 1 ${R + (R - 46)} ${R}`);
  inner.setAttribute('fill', 'none');
  svg.append(inner);
  // the origin: a dot with a ring on the baseline's midpoint, where the vertex of the angle goes
  const ring = document.createElementNS(SVG_NS, 'circle');
  ring.setAttribute('class', 'guide__origin-ring');
  ring.setAttribute('cx', String(R));
  ring.setAttribute('cy', String(R));
  ring.setAttribute('r', '9');
  const dot = document.createElementNS(SVG_NS, 'circle');
  dot.setAttribute('class', 'guide__origin');
  dot.setAttribute('cx', String(R));
  dot.setAttribute('cy', String(R));
  dot.setAttribute('r', '3.5');
  svg.append(ring, dot);
  return svg;
}
