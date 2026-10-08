/**
 * Chrome colours the canvases paint themselves — selection/edit overlays and
 * placeholders — as opposed to ink and paper, which come from the stored data
 * (`resolveInkColor`, `templates.ts`). Read through `uiColors()` at paint time
 * so a `themechange` repaint picks up the active theme's palette.
 */
export interface UiColors {
  /** the lasso's dashed path while it's being drawn */
  lasso: string;
  /** outline of edit handles: a pending line's endpoints, a pending shape's handles, mind-map nodes, a connector being dragged out */
  handleStroke: string;
  /** fill of those handles (a mind-map node's connect source fills with `handleStroke` instead) */
  handleFill: string;
  /** a PDF page that failed to render: the box... */
  placeholderBg: string;
  /** ...and its "couldn't be rendered" message */
  placeholderText: string;
  /** hairline frame round a library thumbnail, so an empty page still reads as a page */
  thumbFrame: string;
}

const LIGHT: UiColors = {
  lasso: 'rgba(37, 99, 235, 0.9)',
  handleStroke: '#2563eb',
  handleFill: '#ffffff',
  placeholderBg: '#e3e1da',
  placeholderText: '#79766c',
  thumbFrame: 'rgba(4, 21, 52, 0.14)',
};

/** Same as light until the dark palette lands. */
const DARK: UiColors = LIGHT;

/** The palette for the theme currently set on `<html data-theme>`. */
export function uiColors(): UiColors {
  return document.documentElement.dataset.theme === 'dark' ? DARK : LIGHT;
}
