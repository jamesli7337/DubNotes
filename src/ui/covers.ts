import type { CoverPattern, NotebookCover } from '../types';

/** The cover colour palette offered in the cover picker. */
export const COVER_COLORS = [
  '#1b2a4a',
  '#0e7490',
  '#047857',
  '#b45309',
  '#be123c',
  '#6d28d9',
  '#374151',
  '#d97706',
];

export const COVER_PATTERNS: CoverPattern[] = ['dots', 'grid', 'stripes', 'waves', 'chevron'];

const svg = (body: string, w: number, h: number): string =>
  `url("data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}' viewBox='0 0 ${w} ${h}'>${body}</svg>`
  )}")`;

/**
 * CSS `background` for a cover: the colour, with the chosen pattern drawn over
 * it in translucent white. Patterns are procedural (CSS gradients or a tiny
 * inline SVG tile), so covers add nothing to the offline bundle.
 */
export function coverBackground(cover: NotebookCover): string {
  const c = cover.color;
  const ink = 'rgba(255,255,255,0.4)';
  switch (cover.pattern) {
    case 'dots':
      return `radial-gradient(circle, ${ink} 2px, transparent 2.6px) 0 0 / 14px 14px, ${c}`;
    case 'grid':
      return (
        `linear-gradient(${ink} 1px, transparent 1px) 0 0 / 16px 16px, ` +
        `linear-gradient(90deg, ${ink} 1px, transparent 1px) 0 0 / 16px 16px, ${c}`
      );
    case 'stripes':
      return `repeating-linear-gradient(45deg, ${ink} 0 6px, transparent 6px 16px), ${c}`;
    case 'waves':
      return (
        svg(`<path d='M0 8 Q8 0 16 8 T32 8' fill='none' stroke='${ink}' stroke-width='2'/>`, 32, 16) +
        ` 0 0 / 32px 16px, ${c}`
      );
    case 'chevron':
      return (
        svg(`<path d='M0 12 L10 2 L20 12' fill='none' stroke='${ink}' stroke-width='2'/>`, 20, 14) +
        ` 0 0 / 20px 14px, ${c}`
      );
    default:
      return c;
  }
}
