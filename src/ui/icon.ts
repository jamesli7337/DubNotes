/* Inline SVG icons (Lucide), bundled as strings by Vite. An icon font would add
 * ~3.8 MB to the offline precache; these few glyphs are a handful of KB. */
import arrowLeft from 'lucide-static/icons/arrow-left.svg?raw';
import chevronLeft from 'lucide-static/icons/chevron-left.svg?raw';
import undo2 from 'lucide-static/icons/undo-2.svg?raw';
import redo2 from 'lucide-static/icons/redo-2.svg?raw';
import plus from 'lucide-static/icons/plus.svg?raw';
import penTool from 'lucide-static/icons/pen-tool.svg?raw';
import eraser from 'lucide-static/icons/eraser.svg?raw';

/* Hand-drawn chisel-tip marker — reads clearly as a highlighter rather than a
 * pencil at dock size. Same 24px / stroke style as the Lucide set. */
const marker = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3.5h10v9.5H7z"/><path d="M7.5 13h9l-2 4h-5z"/><path d="M9.5 17h5v3.5h-5z"/><path d="M7 8h10"/></svg>`;
import download from 'lucide-static/icons/download.svg?raw';
import upload from 'lucide-static/icons/upload.svg?raw';
import ellipsisVertical from 'lucide-static/icons/ellipsis-vertical.svg?raw';
import pencilLine from 'lucide-static/icons/pencil-line.svg?raw';
import trash2 from 'lucide-static/icons/trash-2.svg?raw';
import bookText from 'lucide-static/icons/book-text.svg?raw';
import lassoSelect from 'lucide-static/icons/lasso-select.svg?raw';
import type from 'lucide-static/icons/type.svg?raw';
import copy from 'lucide-static/icons/copy.svg?raw';
import copyPlus from 'lucide-static/icons/copy-plus.svg?raw';
import clipboardPaste from 'lucide-static/icons/clipboard-paste.svg?raw';
import x from 'lucide-static/icons/x.svg?raw';
import rotateCw from 'lucide-static/icons/rotate-cw.svg?raw';
import ruler from 'lucide-static/icons/ruler.svg?raw';
import check from 'lucide-static/icons/check.svg?raw';
import chevronDown from 'lucide-static/icons/chevron-down.svg?raw';
import imagePlus from 'lucide-static/icons/image-plus.svg?raw';
import fileText from 'lucide-static/icons/file-text.svg?raw';
import stickyNote from 'lucide-static/icons/sticky-note.svg?raw';
import folder from 'lucide-static/icons/folder.svg?raw';
import folderOpen from 'lucide-static/icons/folder-open.svg?raw';
import folderPlus from 'lucide-static/icons/folder-plus.svg?raw';
import folderInput from 'lucide-static/icons/folder-input.svg?raw';
import chevronRight from 'lucide-static/icons/chevron-right.svg?raw';
import palette from 'lucide-static/icons/palette.svg?raw';
import separatorHorizontal from 'lucide-static/icons/separator-horizontal.svg?raw';
import arrowUp from 'lucide-static/icons/arrow-up.svg?raw';
import arrowDown from 'lucide-static/icons/arrow-down.svg?raw';
import fileDown from 'lucide-static/icons/file-down.svg?raw';
import circleDot from 'lucide-static/icons/circle-dot.svg?raw';
import shapes from 'lucide-static/icons/shapes.svg?raw';
import square from 'lucide-static/icons/square.svg?raw';
import circle from 'lucide-static/icons/circle.svg?raw';
import triangle from 'lucide-static/icons/triangle.svg?raw';
import moveUpRight from 'lucide-static/icons/move-up-right.svg?raw';
import bot from 'lucide-static/icons/bot.svg?raw';
import send from 'lucide-static/icons/send.svg?raw';
import scissors from 'lucide-static/icons/scissors.svg?raw';

/* Hand-drawn protractor (Lucide has none): a semicircle on a baseline with a few ticks. */
const protractor = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17a9 9 0 0 1 18 0"/><path d="M3 17h18"/><path d="M12 8v3"/><path d="M6.4 11.6l2.1 2.1"/><path d="M17.6 11.6l-2.1 2.1"/></svg>`;

export type IconName =
  | 'arrow-left'
  | 'chevron-left'
  | 'undo'
  | 'redo'
  | 'plus'
  | 'pen'
  | 'highlighter'
  | 'eraser'
  | 'lasso'
  | 'text'
  | 'copy'
  | 'duplicate'
  | 'paste'
  | 'close'
  | 'rotate'
  | 'ruler'
  | 'protractor'
  | 'check'
  | 'chevron-down'
  | 'image'
  | 'pdf'
  | 'tape'
  | 'folder'
  | 'folder-open'
  | 'folder-plus'
  | 'move-to'
  | 'chevron-right'
  | 'palette'
  | 'divider'
  | 'arrow-up'
  | 'arrow-down'
  | 'export'
  | 'laser'
  | 'shapes'
  | 'shape-rect'
  | 'shape-ellipse'
  | 'shape-triangle'
  | 'shape-arrow'
  | 'download'
  | 'upload'
  | 'more'
  | 'rename'
  | 'delete'
  | 'book'
  | 'ai'
  | 'send'
  | 'cut';

const ICONS: Record<IconName, string> = {
  'arrow-left': arrowLeft,
  'chevron-left': chevronLeft,
  undo: undo2,
  redo: redo2,
  plus,
  pen: penTool,
  highlighter: marker,
  eraser,
  lasso: lassoSelect,
  text: type,
  copy,
  duplicate: copyPlus,
  paste: clipboardPaste,
  close: x,
  rotate: rotateCw,
  ruler,
  protractor,
  check,
  'chevron-down': chevronDown,
  image: imagePlus,
  pdf: fileText,
  tape: stickyNote,
  folder,
  'folder-open': folderOpen,
  'folder-plus': folderPlus,
  'move-to': folderInput,
  'chevron-right': chevronRight,
  palette,
  divider: separatorHorizontal,
  'arrow-up': arrowUp,
  'arrow-down': arrowDown,
  export: fileDown,
  laser: circleDot,
  shapes,
  'shape-rect': square,
  'shape-ellipse': circle,
  'shape-triangle': triangle,
  'shape-arrow': moveUpRight,
  download,
  upload,
  more: ellipsisVertical,
  rename: pencilLine,
  delete: trash2,
  book: bookText,
  ai: bot,
  send,
  cut: scissors,
};

/** Returns a <span class="icon"> wrapping the raw SVG; `currentColor` inherits text colour. */
export function icon(name: IconName, cls = ''): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = cls ? `icon ${cls}` : 'icon';
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = ICONS[name];
  return span;
}
