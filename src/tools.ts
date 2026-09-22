import { AUTO_COLOR } from './canvas/freehand';
import { clamp } from './util';

export type ToolKind = 'pen' | 'highlighter' | 'eraser' | 'lasso' | 'text' | 'shapes' | 'tape' | 'laser' | 'hand';

/** What the Shapes tool places on a drag. Lines are the pen's business (hold-to-snap), not this tool's. */
export type PlacedShape = 'rect' | 'ellipse' | 'arrow' | 'triangle';
export const PLACED_SHAPES: PlacedShape[] = ['rect', 'ellipse', 'triangle', 'arrow'];

/** How long a laser-pointer trail takes to fade out completely. */
export const LASER_FADE_MS = 3500;
export const LASER_COLOR = '#ef4444';
/** Cap on how many user-added (non-preset) colours a tool's swatch row can hold. */
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

/** Extra pointer radius, in screen px (counter-scaled for zoom — see PageCanvas.zoom()), added to a stroke's own width when hit-testing the eraser. */
export const ERASER_RADIUS = 6;

/** Pointer travel (page units) that turns a tap into a drag — shared by every tap-vs-drag decision in the canvas layer, including SelectionOverlay's box-body handling. */
export const TAP_SLOP = 4;

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
  /**
   * Every swatch shown for a tool — presets and user-added colours
   * interleaved, in on-screen/drag order (pen swatches also serve text and
   * shapes). Position 0 is that tool's primary/default colour.
   */
  penSwatches: string[];
  hiSwatches: string[];
  /**
   * Presets dragged off the swatch row — offered back in the "add colour"
   * popover. Custom colours removed the same way are dropped for good, so
   * they're never added here.
   */
  penDeletedPresets: string[];
  hiDeletedPresets: string[];
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
  penSwatches: [...PEN_COLORS],
  hiSwatches: [...HI_COLORS],
  penDeletedPresets: [],
  hiDeletedPresets: [],
};

const HEX = /^#[0-9a-f]{6}$/i;

function swatchKey(tool: 'pen' | 'highlighter'): 'penSwatches' | 'hiSwatches' {
  return tool === 'pen' ? 'penSwatches' : 'hiSwatches';
}

function deletedKey(tool: 'pen' | 'highlighter'): 'penDeletedPresets' | 'hiDeletedPresets' {
  return tool === 'pen' ? 'penDeletedPresets' : 'hiDeletedPresets';
}

function presets(tool: 'pen' | 'highlighter'): string[] {
  return tool === 'pen' ? PEN_COLORS : HI_COLORS;
}

/** True for a factory colour (including "auto"), false for a user-added one. */
function isPresetColor(tool: 'pen' | 'highlighter', color: string): boolean {
  return presets(tool).includes(color);
}

function cleanSwatches(v: unknown, tool: 'pen' | 'highlighter'): string[] {
  const seed = presets(tool);
  if (!Array.isArray(v)) return [...seed];
  const out: string[] = [];
  for (const c of v) {
    if (typeof c !== 'string') continue;
    if (c !== AUTO_COLOR && !HEX.test(c)) continue;
    const norm = c === AUTO_COLOR ? c : c.toLowerCase();
    if (!out.includes(norm)) out.push(norm);
  }
  return out.length ? out : [...seed];
}

function cleanDeletedPresets(v: unknown, tool: 'pen' | 'highlighter'): string[] {
  if (!Array.isArray(v)) return [];
  const seed = presets(tool);
  const out: string[] = [];
  for (const c of v) {
    if (typeof c === 'string' && seed.includes(c) && !out.includes(c)) out.push(c);
  }
  return out;
}

/**
 * Appends a new user-picked colour to a tool's swatch row (deduplicated,
 * evicting the longest-standing custom colour once the cap is hit).
 */
export function addCustomColor(tool: 'pen' | 'highlighter', hex: string): void {
  const key = swatchKey(tool);
  const c = hex.toLowerCase();
  let list = toolState[key].filter((x) => x !== c);
  const customCount = list.filter((x) => !isPresetColor(tool, x)).length;
  if (customCount >= CUSTOM_COLORS_MAX) {
    const evictAt = list.findIndex((x) => !isPresetColor(tool, x));
    if (evictAt >= 0) list = [...list.slice(0, evictAt), ...list.slice(evictAt + 1)];
  }
  toolState[key] = [...list, c];
}

/**
 * Removes a swatch by dragging it off the toolbar. The colour currently in
 * position 0 (the primary/default) can't be removed this way. A preset goes
 * to that tool's "deleted presets" list (offered back in the colour picker);
 * a custom colour is dropped for good.
 */
export function removeSwatch(tool: 'pen' | 'highlighter', color: string): void {
  const key = swatchKey(tool);
  const list = toolState[key];
  if (list[0] === color) return;
  toolState[key] = list.filter((x) => x !== color);
  if (isPresetColor(tool, color)) {
    const dKey = deletedKey(tool);
    toolState[dKey] = [color, ...toolState[dKey].filter((x) => x !== color)];
  }
}

/** Commits a full reordering of a tool's swatch row (drag-to-reorder) — `order` must hold exactly the colours currently in the row, just resequenced. */
export function setSwatchOrder(tool: 'pen' | 'highlighter', order: string[]): void {
  const key = swatchKey(tool);
  const current = toolState[key];
  if (order.length !== current.length || !current.every((c) => order.includes(c))) return;
  toolState[key] = order;
}

/** Brings a deleted preset back, appended to the end of the swatch row. */
export function restorePreset(tool: 'pen' | 'highlighter', color: string): void {
  const dKey = deletedKey(tool);
  toolState[dKey] = toolState[dKey].filter((x) => x !== color);
  const key = swatchKey(tool);
  if (!toolState[key].includes(color)) toolState[key] = [...toolState[key], color];
}

/** Coerce a stored size (including old S/M/L preset values) into the current slider range. */
function migrateSize(v: unknown, range: SizeRange, fallback: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return clamp(n, range.min, range.max);
}

/** A pre-reorder save has its custom colours in a separate list; fold them onto the end of the unified swatch row (capped, deduplicated), skipping ones already present. */
function foldLegacyCustoms(swatches: string[], tool: 'pen' | 'highlighter', legacyList: unknown): string[] {
  if (!Array.isArray(legacyList)) return swatches;
  const out = [...swatches];
  for (const raw of legacyList) {
    if (typeof raw !== 'string') continue;
    const c = raw.toLowerCase();
    if (!HEX.test(c) || out.includes(c)) continue;
    if (out.filter((x) => !isPresetColor(tool, x)).length >= CUSTOM_COLORS_MAX) continue;
    out.push(c);
  }
  return out;
}

function load(): ToolState {
  const st: ToolState = { ...DEFAULTS };
  let legacy: { customPen?: unknown; customHi?: unknown } = {};
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ToolState> & { customPen?: unknown; customHi?: unknown };
      legacy = parsed;
      Object.assign(st, parsed);
    }
  } catch {
    /* ignore */
  }
  st.penSize = migrateSize(st.penSize, PEN_SIZE_RANGE, DEFAULTS.penSize);
  st.hiSize = migrateSize(st.hiSize, HI_SIZE_RANGE, DEFAULTS.hiSize);
  if (st.eraserMode !== 'whole' && st.eraserMode !== 'partial') st.eraserMode = DEFAULTS.eraserMode;
  if (!PLACED_SHAPES.includes(st.shapeKind)) st.shapeKind = DEFAULTS.shapeKind;
  if (!LASSO_SHAPES.includes(st.lassoShape)) st.lassoShape = DEFAULTS.lassoShape;
  st.penSwatches = foldLegacyCustoms(cleanSwatches(st.penSwatches, 'pen'), 'pen', legacy.customPen);
  st.hiSwatches = foldLegacyCustoms(cleanSwatches(st.hiSwatches, 'highlighter'), 'highlighter', legacy.customHi);
  st.penDeletedPresets = cleanDeletedPresets(st.penDeletedPresets, 'pen');
  st.hiDeletedPresets = cleanDeletedPresets(st.hiDeletedPresets, 'highlighter');
  if (!st.penSwatches.includes(st.penColor)) st.penColor = st.penSwatches[0];
  if (!st.hiSwatches.includes(st.hiColor)) st.hiColor = st.hiSwatches[0];
  if (!st.penSwatches.includes(st.textColor)) st.textColor = st.penSwatches[0];
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

/** Resets the pen/highlighter/text ink back to each tool's primary colour — called when leaving a note, so a colour picked mid-session doesn't leak into the next one. */
export function resetActiveColorsToPrimary(): void {
  toolState.penColor = toolState.penSwatches[0];
  toolState.hiColor = toolState.hiSwatches[0];
  toolState.textColor = toolState.penSwatches[0];
  saveToolState();
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
