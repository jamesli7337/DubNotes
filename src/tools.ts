import { AUTO_COLOR } from './canvas/freehand';
import { clamp } from './util';

export type ToolKind = 'pen' | 'highlighter' | 'eraser' | 'lasso' | 'text' | 'shapes' | 'tape' | 'laser' | 'hand';

/** What the Shapes tool places on a drag. Lines are the pen's business (hold-to-snap), not this tool's. */
export type PlacedShape = 'rect' | 'ellipse' | 'arrow' | 'triangle';
export const PLACED_SHAPES: PlacedShape[] = ['rect', 'ellipse', 'triangle', 'arrow'];

/** How long a laser-pointer trail takes to fade out completely. */
export const LASER_FADE_MS = 3500;
export const LASER_COLOR = '#ef4444';
/** Custom colours kept per tool (newest first). */
export const CUSTOM_COLORS_MAX = 8;

/**
 * Line-snap (pen tool only): the pen must stay still, at the end of a stroke
 * that is already nearly straight, for this long before the pending line is
 * shown ghosted as a cue — and for SHAPE_HOLD_MS before it snaps into the
 * adjustable line. Both stages are deliberately long so an ordinary pause
 * mid-writing doesn't read as "about to snap."
 */
export const SHAPE_CUE_MS = 500;
export const SHAPE_HOLD_MS = 1100;

/** Default type size for a freshly placed text box, in page units. */
export const TEXT_DEFAULT_SIZE = 20;
/** Default width for a freshly placed text box, in page units. */
export const TEXT_DEFAULT_WIDTH = 260;

export interface ResolvedTool {
  kind: 'pen' | 'highlighter';
  color: string;
  size: number;
}

/** First pen swatch is the "auto" token, not a fixed hex — resolved per page at render time. */
export const PEN_COLORS = [AUTO_COLOR, '#2563eb', '#dc2626', '#059669', '#d97706'];
export const HI_COLORS = ['#fde047', '#fca5a5', '#86efac', '#93c5fd', '#f0abfc'];

export interface SizeRange {
  min: number;
  max: number;
}

/** Size-slider bounds in page units, per drawing tool. */
export const PEN_SIZE_RANGE: SizeRange = { min: 0.5, max: 12 };
export const HI_SIZE_RANGE: SizeRange = { min: 4, max: 40 };

export function sizeRange(kind: 'pen' | 'highlighter'): SizeRange {
  return kind === 'pen' ? PEN_SIZE_RANGE : HI_SIZE_RANGE;
}

/** Extra pointer radius, in page units, added to a stroke's own width when hit-testing the eraser. */
export const ERASER_RADIUS = 14;

/** Whole: a touched stroke goes entirely. Partial: only the touched parts go, splitting the stroke. */
export type EraserMode = 'whole' | 'partial';

/** How the lasso selects: a freehand loop, or a box / circle dragged from corner to corner. */
export type LassoShape = 'free' | 'box' | 'circle';
export const LASSO_SHAPES: LassoShape[] = ['free', 'box', 'circle'];

interface ToolState {
  kind: ToolKind;
  penColor: string;
  penSize: number;
  hiColor: string;
  hiSize: number;
  /** ink for new text boxes — a pen swatch, including "auto" */
  textColor: string;
  eraserMode: EraserMode;
  /** which shape the Shapes tool places; outline uses the pen colour and size */
  shapeKind: PlacedShape;
  lassoShape: LassoShape;
  /** user-added hex colours shown after the presets (pen swatches also serve text and shapes) */
  customPen: string[];
  customHi: string[];
}

const KEY = 'noteapp.tools';
const DEFAULTS: ToolState = {
  kind: 'pen',
  penColor: PEN_COLORS[0],
  penSize: 4.5,
  hiColor: HI_COLORS[0],
  hiSize: 24,
  textColor: PEN_COLORS[0],
  eraserMode: 'whole',
  shapeKind: 'rect',
  lassoShape: 'free',
  customPen: [],
  customHi: [],
};

const HEX = /^#[0-9a-f]{6}$/i;

function cleanCustom(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const c of v) {
    if (typeof c === 'string' && HEX.test(c) && !out.includes(c.toLowerCase())) out.push(c.toLowerCase());
  }
  return out.slice(0, CUSTOM_COLORS_MAX);
}

/** Puts a colour at the front of a tool's custom list (deduplicated, capped). */
export function addCustomColor(tool: 'pen' | 'highlighter', hex: string): void {
  const key = tool === 'pen' ? 'customPen' : 'customHi';
  const c = hex.toLowerCase();
  toolState[key] = [c, ...toolState[key].filter((x) => x !== c)].slice(0, CUSTOM_COLORS_MAX);
}

export function removeCustomColor(tool: 'pen' | 'highlighter', hex: string): void {
  const key = tool === 'pen' ? 'customPen' : 'customHi';
  toolState[key] = toolState[key].filter((x) => x !== hex.toLowerCase());
}

/** Coerce a stored size (including old S/M/L preset values) into the current slider range. */
function migrateSize(v: unknown, range: SizeRange, fallback: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return clamp(n, range.min, range.max);
}

function load(): ToolState {
  const st: ToolState = { ...DEFAULTS };
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) Object.assign(st, JSON.parse(raw) as Partial<ToolState>);
  } catch {
    /* ignore */
  }
  st.penSize = migrateSize(st.penSize, PEN_SIZE_RANGE, DEFAULTS.penSize);
  st.hiSize = migrateSize(st.hiSize, HI_SIZE_RANGE, DEFAULTS.hiSize);
  if (st.eraserMode !== 'whole' && st.eraserMode !== 'partial') st.eraserMode = DEFAULTS.eraserMode;
  if (!PLACED_SHAPES.includes(st.shapeKind)) st.shapeKind = DEFAULTS.shapeKind;
  if (!LASSO_SHAPES.includes(st.lassoShape)) st.lassoShape = DEFAULTS.lassoShape;
  st.customPen = cleanCustom(st.customPen);
  st.customHi = cleanCustom(st.customHi);
  // a device that last saved with the old draw-then-snap shape tool active (its
  // kind was 'shape'; today's Shapes tool is 'shapes') reopens on the pen;
  // write the fix straight back (not via saveToolState() —
  // the module-level `toolState` binding this function returns into doesn't
  // exist yet while `load()` itself is still running)
  if ((st.kind as string) === 'shape') {
    st.kind = 'pen';
    try {
      localStorage.setItem(KEY, JSON.stringify(st));
    } catch {
      /* ignore */
    }
  }
  return st;
}

export const toolState: ToolState = load();

export function saveToolState(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(toolState));
  } catch {
    /* ignore */
  }
}

/** Resolves the current tool for drawing; returns null for tools that don't ink (eraser, lasso, text). */
export function resolveDrawTool(): ResolvedTool | null {
  if (toolState.kind === 'pen') {
    return { kind: 'pen', color: toolState.penColor, size: toolState.penSize };
  }
  if (toolState.kind === 'highlighter') {
    return { kind: 'highlighter', color: toolState.hiColor, size: toolState.hiSize };
  }
  return null;
}
