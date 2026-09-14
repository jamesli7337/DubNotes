import { AiMode } from '../ai-mode';
import { AUTO_COLOR, resolveInkColor } from '../canvas/freehand';
import { rotateAround, type Frame } from '../canvas/geom';
import type { GuideKind } from '../canvas/guide';
import { PageCanvas } from '../canvas/page-canvas';
import type { Op } from '../canvas/page-canvas';
import { DEFAULT_PAPER, PAGE_W } from '../const';
import { store } from '../store';
import {
  addCustomColor,
  HI_COLORS,
  LASSO_SHAPES,
  PEN_COLORS,
  PLACED_SHAPES,
  removeCustomColor,
  saveToolState,
  sizeRange,
  toolState,
  type EraserMode,
  type LassoShape,
  type PlacedShape,
  type SizeRange,
  type ToolKind,
} from '../tools';
import { pickColor } from './color';
import { paperBg } from '../canvas/templates';
import type {
  Notebook,
  Page,
  PageElement,
  PageItem,
  Paper,
  PaperColor,
  PaperSpacing,
  PaperTemplate,
  Stroke,
} from '../types';
import { clamp, isStroke } from '../util';
import { loadImageFile } from '../media';
import { alertDialog, confirmDialog, openAnchoredModal, openModal, textPrompt, type Modal } from './dialog';
import { blockGestures, el } from './dom';
import { icon, type IconName } from './icon';

type ViewOp = Op | { kind: 'del-page'; page: Page; strokes: Stroke[]; elements: PageElement[] };

/** Offset applied when pasting back onto the page the items were copied from. */
const PASTE_OFFSET = 24;

/** The lasso's selection shapes, in dock order. */
const LASSO_OPTIONS: Record<LassoShape, { icon: IconName; label: string }> = {
  free: { icon: 'lasso', label: 'Freehand lasso' },
  box: { icon: 'shape-rect', label: 'Box select' },
  circle: { icon: 'shape-ellipse', label: 'Circle select' },
};

/** The Shapes tool's sub-options, in dock order. */
const SHAPE_OPTIONS: Record<PlacedShape, { icon: IconName; label: string }> = {
  rect: { icon: 'shape-rect', label: 'Rectangle' },
  ellipse: { icon: 'shape-ellipse', label: 'Ellipse' },
  arrow: { icon: 'shape-arrow', label: 'Arrow' },
  triangle: { icon: 'shape-triangle', label: 'Triangle' },
};
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;

export function mountNotebook(root: HTMLElement, notebookId: string): void {
  const nb = store.notebooks.get(notebookId);
  if (!nb) {
    location.hash = '#/';
    return;
  }
  new NotebookView(root, nb);
}

class NotebookView {
  private readonly root: HTMLElement;
  private nb: Notebook;

  private scrollEl!: HTMLElement;
  private toolsEl!: HTMLElement;
  /** Fixed-size row of tool icons + undo/redo — never changes with the active tool. */
  private toolsTopEl!: HTMLElement;
  /** Fixed-height row below it showing the active tool's own options (swatches, size, hints). */
  private toolsOptionsEl!: HTMLElement;
  private titleEl!: HTMLElement;
  private imageInput!: HTMLInputElement;
  private pdfInput!: HTMLInputElement;
  private undoBtn!: HTMLButtonElement;
  private redoBtn!: HTMLButtonElement;
  /** Single app-bar AI-mode controls, acting on whichever page is "current" (see setCurrentPage). */
  private aiToggleBtn!: HTMLButtonElement;
  private aiSendBtn!: HTMLButtonElement;
  /** View zoom (1 = 100%); pages are CSS-scaled, so pointer maths stays in page units. */
  private zoom = 1;
  private pinch: { d0: number; z0: number; mx: number; my: number; cx: number; cy: number } | null = null;
  /** Hand tool, mouse only — touch/pen panning is native (touch-action), see bindHandToolGestures. */
  private handPan: { pointerId: number; x: number; y: number; scrollLeft: number; scrollTop: number } | null = null;

  private observer: IntersectionObserver;
  private readonly pcByPage = new Map<string, PageCanvas>();
  private readonly wrapById = new Map<string, HTMLElement>();
  private readonly mounted = new Set<string>();
  private sizePopover: Modal | null = null;

  /** Tracks which page is most visible, for the "auto" ink swatch/dot preview. */
  private viewObserver: IntersectionObserver;
  private readonly pageVisibility = new Map<string, number>();
  private currentPageId: string | null = null;
  private colorRefreshers: Array<() => void> = [];

  private readonly undoStack: ViewOp[] = [];
  private readonly redoStack: ViewOp[] = [];

  /** The page holding the current selection, if any (only one page at a time). */
  private selPc: PageCanvas | null = null;
  /** In-app clipboard: deep copies of the last copied items and where they came from. */
  private clipboard: PageItem[] = [];
  private clipboardPage: string | null = null;
  /**
   * Guards the paper-settings button against its own touch ghost-click: on a
   * touch device, dismissing the (non-anchored, centred) paper menu via a tap
   * on its backdrop still lets the browser's own compatibility `click` event
   * through afterward — unlike mousedown/mouseup, it isn't reliably
   * suppressed by calling preventDefault() on pointerdown (see openModal's
   * backdrop-dismiss handler). That synthetic click lands on whatever the
   * backdrop's removal just revealed — the paper button itself — and
   * reopens the menu it just closed. Sidesteps the same-icon `if already
   * open, close` toggle the anchored popovers use (this modal has no such
   * state to check, and shouldn't gain click-through-clearance semantics
   * just to work around this) by simply ignoring the button's click for a
   * brief window right after an outside-tap dismiss.
   */
  private paperMenuGuardUntil = 0;
  /** Same touch-ghost-click guard as paperMenuGuardUntil, for the page-manager button. */
  private pageMgrGuardUntil = 0;
  /** Ruler / protractor: view-only, lives on one page, re-shown when that page remounts. */
  private guideKind: GuideKind | null = null;
  private guidePageId: string | null = null;

  /**
   * Floating iOS-callout-style popover for a lasso selection (copy/cut/paste/
   * delete/duplicate) — see showSelectionCallout. `calloutPc` is which page's
   * selection it's currently showing for, so a *different* page's own
   * deselect event (firing after a fresh selection elsewhere already opened
   * the callout there — see onSelectionFrame) doesn't hide it out from under
   * the new one.
   */
  private calloutEl: HTMLElement | null = null;
  /** The visible pill inside calloutEl — a separate element so its `overflow: hidden` (which rounds the outer buttons' corners to match the pill) doesn't also clip the arrow, which lives on calloutEl itself. */
  private calloutPill: HTMLElement | null = null;
  private calloutPc: PageCanvas | null = null;
  /** The frame the callout is currently positioned against — re-placed (not re-shown) on scroll/resize, since neither changes the frame itself, only where it lands on screen. */
  private calloutFrame: Frame | null = null;
  /** Bound so the same reference can be added to and removed from `window` — see the scroll/resize wiring in buildChrome and its cleanup in onLeave. */
  private readonly repositionCallout = (): void => {
    if (!this.calloutEl || !this.calloutPc || !this.calloutFrame) return;
    const pageRect = this.calloutPc.pageRect();
    if (!pageRect) return;
    this.positionCallout(this.calloutEl, this.calloutFrame, pageRect);
  };

  private readonly onKey: (e: KeyboardEvent) => void;
  private readonly onLeave: () => void;

  private readonly aiMode: AiMode;

  constructor(root: HTMLElement, nb: Notebook) {
    this.root = root;
    this.nb = nb;
    this.aiMode = new AiMode(nb.id, {
      refreshPage: (pageId) => this.rebuildIfMounted(pageId),
      onActiveChanged: (pageId) => {
        if (pageId === this.currentPageId) this.refreshAiControls();
      },
    });
    void this.aiMode.loadConversation(); // async; resolves after buildChrome's mountPanel has run

    this.buildChrome();

    this.observer = new IntersectionObserver((entries) => this.onIntersect(entries), {
      root: this.scrollEl,
      rootMargin: '1200px 0px',
      threshold: 0,
    });
    this.viewObserver = new IntersectionObserver((entries) => this.onViewIntersect(entries), {
      root: this.scrollEl,
      threshold: [0, 0.1, 0.25, 0.5, 0.75, 1],
    });
    store.enforceTrailingBlank(this.nb.id);
    this.syncPages();

    this.onKey = (e) => {
      if (!this.root.contains(this.scrollEl)) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const k = e.key.toLowerCase();
      if (!(e.metaKey || e.ctrlKey)) {
        if (e.key === 'Delete' || e.key === 'Backspace') {
          if (this.selPc?.hasSelection) {
            e.preventDefault();
            this.selPc.deleteSelection();
          }
        } else if (e.key === 'Escape') {
          this.selPc?.clearSelection();
        }
        return;
      }
      if (k === 'z' && !e.shiftKey) {
        e.preventDefault();
        this.undo();
      } else if ((k === 'z' && e.shiftKey) || k === 'y') {
        e.preventDefault();
        this.redo();
      } else if (k === 'c') {
        if (this.copySelection()) e.preventDefault();
      } else if (k === 'x') {
        if (this.cutSelection()) e.preventDefault();
      } else if (k === 'v') {
        if (this.pasteClipboard()) e.preventDefault();
      } else if (k === 'd') {
        if (this.duplicateSelection()) e.preventDefault();
      }
    };
    this.onLeave = () => {
      window.removeEventListener('keydown', this.onKey);
      window.removeEventListener('hashchange', this.onLeave);
      window.removeEventListener('resize', this.repositionCallout);
      this.hideSelectionCallout();
      this.deactivateAll(); // commit an open text edit before the canvases go away
      for (const id of this.mounted) this.pcByPage.get(id)?.unmount();
      this.observer.disconnect();
      this.viewObserver.disconnect();
      this.aiMode.destroyPanel();
      store.flushNow();
    };
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('hashchange', this.onLeave);
  }

  // --------------------------------------------------------------- chrome
  private buildChrome(): void {
    const view = el('div', { class: 'nb' });

    const bar = el('header', { class: 'nb-appbar' });

    const back = el('button', {
      class: 'iconbtn',
      title: 'Back to library',
      'aria-label': 'Back to library',
    });
    back.append(icon('arrow-left'));
    back.addEventListener('click', () => {
      location.hash = this.nb.folderId ? `#/f/${this.nb.folderId}` : '#/'; // back to the notebook's folder
    });

    this.titleEl = el('span', {
      class: 'nb-appbar__title',
      text: this.nb.name,
      title: 'Rename notebook',
    });
    this.titleEl.addEventListener('click', async () => {
      const name = await textPrompt({
        title: 'Rename notebook',
        value: this.nb.name,
        confirmText: 'Rename',
      });
      if (name == null) return;
      store.renameNotebook(this.nb.id, name);
      this.titleEl.textContent = this.nb.name;
    });

    this.undoBtn = el('button', {
      class: 'iconbtn',
      title: 'Undo',
      'aria-label': 'Undo',
    }) as HTMLButtonElement;
    this.undoBtn.append(icon('undo'));
    this.redoBtn = el('button', {
      class: 'iconbtn',
      title: 'Redo',
      'aria-label': 'Redo',
    }) as HTMLButtonElement;
    this.redoBtn.append(icon('redo'));
    this.undoBtn.addEventListener('click', () => this.undo());
    this.redoBtn.addEventListener('click', () => this.redo());

    this.aiToggleBtn = el('button', {
      class: 'iconbtn ai-toggle',
      title: 'AI Assistant — read this page and reply with NoteApp AI',
      'aria-label': 'AI Assistant',
      'aria-pressed': 'false',
    }) as HTMLButtonElement;
    this.aiToggleBtn.append(icon('ai'));
    this.aiToggleBtn.addEventListener('click', () => {
      // toggle() itself opens/closes the panel to match the resulting state
      if (this.currentPageId) this.aiMode.toggle(this.currentPageId);
    });

    this.aiSendBtn = el('button', {
      class: 'iconbtn ai-send',
      title: 'Send this turn to NoteApp AI now',
      'aria-label': 'Send this turn to NoteApp AI now',
      hidden: true,
    }) as HTMLButtonElement;
    this.aiSendBtn.append(icon('send'));
    this.aiSendBtn.addEventListener('click', () => {
      if (this.currentPageId) this.aiMode.sendNow(this.currentPageId);
    });

    // formerly a dock button ("insert actions" in the tools row); moved here
    // so it's reachable regardless of the active tool. Same file input/handler
    // as before, just relocated — functionality unchanged.
    const imgBtn = el('button', { class: 'iconbtn', title: 'Insert image', 'aria-label': 'Insert image' });
    imgBtn.append(icon('image'));
    imgBtn.addEventListener('click', () => this.imageInput.click());

    // appends a PDF's pages after the page in view, vs. the library's own
    // "Import file" which creates a whole new notebook from a PDF — same
    // underlying pdf-import.ts parsing, different insertion point.
    const pdfBtn = el('button', { class: 'iconbtn', title: 'Import PDF pages', 'aria-label': 'Import PDF pages' });
    pdfBtn.append(icon('import'));
    pdfBtn.addEventListener('click', () => this.pdfInput.click());

    const exportBtn = el('button', { class: 'iconbtn', title: 'Export', 'aria-label': 'Export' });
    exportBtn.append(icon('export'));
    exportBtn.addEventListener('click', () => this.openExportMenu(exportBtn));

    // formerly an inline "Paper" link on each page's own header; moved here
    // so it's reachable without scrolling to the page, and acts on whichever
    // page is currently in view (same page this bar's other per-page actions
    // — AI toggle/send — already target).
    const paperBtn = el('button', { class: 'iconbtn', title: 'Customize paper', 'aria-label': 'Customize paper' });
    paperBtn.append(icon('paper'));
    paperBtn.addEventListener('click', () => {
      if (Date.now() < this.paperMenuGuardUntil) return; // swallow the touch ghost-click right after a dismiss — see the field's own doc comment
      const page = this.currentPageId ? store.pages.get(this.currentPageId) : undefined;
      if (page) this.openPaperMenu(page);
    });

    // lists every page as a thumbnail: reorder / duplicate / delete, and jump
    // to one by tapping it. Page deletion now lives here (see openPageManager's
    // own doc comment) rather than in the paper-settings menu.
    const pagesBtn = el('button', { class: 'iconbtn', title: 'Manage pages', 'aria-label': 'Manage pages' });
    pagesBtn.append(icon('pages'));
    pagesBtn.addEventListener('click', () => {
      if (Date.now() < this.pageMgrGuardUntil) return; // same touch ghost-click guard as the paper button, see paperMenuGuardUntil
      void this.openPageManager();
    });

    // three grid zones (back | title | actions) so the title sits truly
    // centered in the bar regardless of how many buttons end up on each side
    // — undo/redo used to live in the right zone; now that they're in the
    // dock's top row instead, this keeps the bar from reading lopsided.
    const rightGroup = el('div', { class: 'nb-appbar__right' });
    rightGroup.append(this.aiToggleBtn, this.aiSendBtn, imgBtn, pdfBtn, exportBtn, pagesBtn, paperBtn);
    bar.append(back, this.titleEl, rightGroup);

    // Notability-style dock: a fixed top row (tools + undo/redo, never reflows)
    // and a fixed-height options row below it for the active tool's own
    // controls, so switching tools never shifts the top row or the page below.
    this.toolsEl = el('div', { class: 'nb-dock nb-dock--collapsed' });
    this.toolsTopEl = el('div', { class: 'nb-dock__row nb-dock__row--tools' });
    this.toolsOptionsEl = el('div', { class: 'nb-dock__row nb-dock__row--options' });
    this.toolsEl.append(this.toolsTopEl, this.toolsOptionsEl);
    this.scrollEl = el('div', { class: 'nb-scroll' });
    blockGestures(this.scrollEl);
    this.bindZoomGestures();
    this.bindHandToolGestures();
    // scrolling/resizing changes where the selection lands on screen without
    // changing its frame — reposition the callout (if open) to match; a fresh
    // pageRect() picks up the new scroll/zoom, same idea as openModal's
    // anchored popovers re-placing themselves on resize/orientationchange.
    // A bound method (not a local closure) so onLeave can remove the same
    // reference from `window` — otherwise every notebook visit would leak
    // one more resize listener onto it for the life of the tab.
    this.scrollEl.addEventListener('scroll', this.repositionCallout, { passive: true });
    window.addEventListener('resize', this.repositionCallout);

    this.imageInput = el('input', {
      type: 'file',
      accept: 'image/*',
      style: 'display:none',
      'aria-hidden': 'true',
    }) as HTMLInputElement;
    this.imageInput.addEventListener('change', () => {
      const file = this.imageInput.files?.[0];
      this.imageInput.value = '';
      if (file) void this.insertImage(file);
    });

    this.pdfInput = el('input', {
      type: 'file',
      accept: 'application/pdf,.pdf',
      style: 'display:none',
      'aria-hidden': 'true',
    }) as HTMLInputElement;
    this.pdfInput.addEventListener('change', () => {
      const file = this.pdfInput.files?.[0];
      this.pdfInput.value = '';
      if (file) void this.importPdfPagesHere(file);
    });

    view.append(bar, this.toolsEl, this.scrollEl, this.imageInput, this.pdfInput);
    this.aiMode.mountPanel(view); // fixed-position, so it overlays regardless of where it sits in the DOM
    this.root.replaceChildren(view);

    this.renderTools();
    this.syncHistory();
    this.refreshAiControls();
    // start fitted to the width on narrow screens, 100% otherwise
    this.setZoom(Math.min(1, (this.scrollEl.clientWidth - 24) / PAGE_W) || 1);
  }

  // ----------------------------------------------------------------- zoom
  private setZoom(z: number, anchor?: { x: number; y: number }): void {
    const next = clamp(Math.round(z * 100) / 100, ZOOM_MIN, ZOOM_MAX);
    const prev = this.zoom;
    const s = this.scrollEl;
    // keep the content under `anchor` (viewport point) where it is
    const ax = anchor ? anchor.x - s.getBoundingClientRect().left : s.clientWidth / 2;
    const ay = anchor ? anchor.y - s.getBoundingClientRect().top : s.clientHeight / 2;
    const contentX = (s.scrollLeft + ax) / prev;
    const contentY = (s.scrollTop + ay) / prev;
    this.zoom = next;
    s.style.setProperty('--zoom', String(next));
    s.scrollLeft = contentX * next - ax;
    s.scrollTop = contentY * next - ay;
    this.refreshAutoColors(); // the size dot previews at the on-screen stroke width
    for (const pc of this.pcByPage.values()) pc.zoomChanged(); // a pending line's handles stay screen-sized
  }

  /** Pinch with two fingers (native one-finger scrolling is untouched) and ctrl/⌘ + wheel on desktop. */
  private bindZoomGestures(): void {
    const s = this.scrollEl;
    const dist = (t: TouchList): number => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    s.addEventListener(
      'touchstart',
      (e) => {
        if (e.touches.length !== 2) return;
        const mx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        const my = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        this.pinch = { d0: dist(e.touches), z0: this.zoom, mx, my, cx: mx, cy: my };
      },
      { passive: true }
    );
    s.addEventListener(
      'touchmove',
      (e) => {
        const p = this.pinch;
        if (!p || e.touches.length !== 2) return;
        e.preventDefault(); // we own the two-finger gesture: zoom + pan
        const mx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        const my = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        this.setZoom((p.z0 * dist(e.touches)) / p.d0, { x: mx, y: my });
        s.scrollLeft -= mx - p.cx; // pan with the midpoint
        s.scrollTop -= my - p.cy;
        p.cx = mx;
        p.cy = my;
      },
      { passive: false }
    );
    const end = (e: TouchEvent): void => {
      if (e.touches.length < 2) this.pinch = null;
    };
    s.addEventListener('touchend', end);
    s.addEventListener('touchcancel', end);
    s.addEventListener(
      'wheel',
      (e) => {
        if (!(e.ctrlKey || e.metaKey)) return;
        e.preventDefault();
        this.setZoom(this.zoom * Math.exp(-e.deltaY * 0.002), { x: e.clientX, y: e.clientY });
      },
      { passive: false }
    );
  }

  /**
   * Hand tool: drag anywhere to pan. Touch and pen already pan for free —
   * `touch-action: pan-x pan-y` on .nb-scroll covers both (PageCanvas's own
   * onDown steps aside entirely for this tool, see its own comment there,
   * and lets the event bubble here rather than consuming it). Mice have no
   * such native gesture, so this handles that one case manually — scoped to
   * `pointerType === 'mouse'` specifically, so it never double-pans a touch
   * or pen drag that the browser is already panning on its own.
   */
  private bindHandToolGestures(): void {
    const s = this.scrollEl;
    s.addEventListener('pointerdown', (e) => {
      if (toolState.kind !== 'hand' || e.pointerType !== 'mouse') return;
      this.handPan = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, scrollLeft: s.scrollLeft, scrollTop: s.scrollTop };
      try {
        s.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    });
    s.addEventListener('pointermove', (e) => {
      const p = this.handPan;
      if (!p || e.pointerId !== p.pointerId) return;
      s.scrollLeft = p.scrollLeft - (e.clientX - p.x);
      s.scrollTop = p.scrollTop - (e.clientY - p.y);
    });
    const end = (e: PointerEvent): void => {
      if (this.handPan?.pointerId === e.pointerId) this.handPan = null;
    };
    s.addEventListener('pointerup', end);
    s.addEventListener('pointercancel', end);
  }

  // --------------------------------------------------------------- export
  private openExportMenu(anchor: HTMLElement): void {
    const current = this.currentPageId ? store.pages.get(this.currentPageId) : undefined;
    const page = current ?? store.pagesOf(this.nb.id)[0];
    const n = page ? page.index + 1 : 1;
    const menu = el('div', { class: 'menu', role: 'menu' });
    let modal: Modal | null = null;
    const item = (label: string, run: () => Promise<void>): void => {
      const b = el('button', { class: 'menu__item menu__item--icon', role: 'menuitem' });
      b.append(icon('export', 'sm'), el('span', { text: label }));
      b.addEventListener('click', () => {
        modal?.close();
        void this.runExport(run);
      });
      menu.append(b);
    };
    if (page) {
      item(`Page ${n} as PDF`, async () => {
        const { exportPdf } = await import('../export/pdf');
        await exportPdf(this.nb, [page], `${this.nb.name} - page ${n}`);
      });
    }
    item('Whole notebook as PDF', async () => {
      const { exportPdf } = await import('../export/pdf');
      await exportPdf(this.nb, this.contentPages(), this.nb.name);
    });
    if (page) {
      item(`Page ${n} as PNG`, async () => {
        const { exportPageImage } = await import('../export/raster');
        await exportPageImage(this.nb, page, 'png');
      });
      item(`Page ${n} as JPEG`, async () => {
        const { exportPageImage } = await import('../export/raster');
        await exportPageImage(this.nb, page, 'jpeg');
      });
    }
    modal = openAnchoredModal(anchor, menu);
  }

  /** Every page except the automatic trailing blank one (when there is more than one page). */
  private contentPages(): Page[] {
    const pages = store.pagesOf(this.nb.id);
    if (pages.length > 1 && store.isBlankPage(pages[pages.length - 1].id)) return pages.slice(0, -1);
    return pages;
  }

  private async runExport(run: () => Promise<void>): Promise<void> {
    this.deactivateAll(); // commit any open text edit first so it is included
    const box = el('div', { class: 'dlg' });
    box.append(el('h2', { class: 'dlg__title', text: 'Exporting…' }), el('p', { class: 'dlg__msg', text: 'Preparing the file.' }));
    const progress = openModal(box, { dismissable: false });
    try {
      await run();
    } catch (err) {
      await alertDialog({ title: 'Export failed', message: (err as Error).message || undefined });
    } finally {
      progress.close();
    }
  }

  /**
   * Shows the dock's options row. Called when a tool is first selected (its
   * colour/size/etc. controls are probably what you tapped it for) — never on
   * a timer, an outside tap, or starting to draw, so once open it stays open
   * until you explicitly close it (see closeDockOptions/toggleDockOptions).
   */
  private openDockOptions(): void {
    this.toolsEl.classList.remove('nb-dock--collapsed');
  }

  /** Hides the options row; also drops the size popover, whose anchor button lives in it. */
  private closeDockOptions(): void {
    this.sizePopover?.close();
    this.toolsEl.classList.add('nb-dock--collapsed');
  }

  /** Re-tapping the already-active tool's icon toggles the options row, the only way it closes. */
  private toggleDockOptions(): void {
    if (this.toolsEl.classList.contains('nb-dock--collapsed')) this.openDockOptions();
    else this.closeDockOptions();
  }

  private renderTools(): void {
    this.sizePopover?.close(); // switching tools (or any dock rebuild) dismisses the size popover
    this.colorRefreshers = []; // old closures would target elements this rebuild is about to discard
    this.scrollEl.classList.toggle('nb-scroll--hand', toolState.kind === 'hand'); // grab cursor, mouse-drag-to-pan feedback
    // `top`: the fixed row (tool icons + undo/redo) — same content/size no
    // matter what's selected. `opts`: the fixed-height row below it, whose
    // *content* changes per tool but whose height (via CSS) never does, so
    // neither row ever shifts the page below when a tool is switched.
    const top = this.toolsTopEl;
    const opts = this.toolsOptionsEl;
    top.replaceChildren();
    opts.replaceChildren();

    const toolBtn = (kind: ToolKind, name: IconName, label: string) => {
      const b = el('button', {
        class: 'tool' + (toolState.kind === kind ? ' active' : ''),
        title: label,
        'aria-label': label,
      });
      b.append(icon(name));
      b.addEventListener('click', () => {
        if (toolState.kind === kind) {
          // re-tapping the already-active tool: eraser's icon doubles as its
          // mode dropdown (its own anchored popover, toggled the same way);
          // every other tool toggles its options row closed/open again.
          if (kind === 'eraser') this.openEraserMenu(b);
          else this.toggleDockOptions();
          return;
        }
        this.deactivateAll(); // finish any text edit, drop any selection
        toolState.kind = kind;
        saveToolState();
        this.renderTools();
        this.openDockOptions(); // a freshly selected tool's own options are worth surfacing
      });
      return b;
    };
    top.append(
      toolBtn('pen', 'pen', 'Pen'),
      toolBtn('highlighter', 'highlighter', 'Highlighter'),
      toolBtn('eraser', 'eraser', 'Eraser'),
      toolBtn('lasso', 'lasso', 'Lasso select'),
      toolBtn('text', 'text', 'Text'),
      toolBtn('shapes', 'shapes', 'Shapes'),
      toolBtn('tape', 'tape', 'Tape'),
      toolBtn('laser', 'laser', 'Laser pointer'),
      toolBtn('hand', 'hand', 'Hand — drag to pan with pen or mouse, like a finger'),
      el('span', { class: 'divider' })
    );

    switch (toolState.kind) {
      case 'eraser': {
        const partial = toolState.eraserMode === 'partial';
        const modeBtn = el('button', {
          class: 'mode-btn',
          title: 'Eraser mode',
          'aria-label': 'Eraser mode',
          'aria-haspopup': 'menu',
        });
        modeBtn.append(ERASER_MODES[toolState.eraserMode].label, icon('chevron-down'));
        modeBtn.addEventListener('click', () => this.openEraserMenu(modeBtn));
        opts.append(
          modeBtn,
          el('span', {
            class: 'hint',
            text: partial ? 'Rub out just the parts you touch.' : 'Drag the pencil across a stroke to erase it.',
          })
        );
        break;
      }
      case 'lasso':
        this.renderLassoTools(opts);
        break;
      case 'tape':
        opts.append(
          el('span', {
            class: 'hint',
            text: 'Drag to cover an area. Tap a strip to peel it back; tap again to cover it.',
          })
        );
        break;
      case 'laser':
        opts.append(el('span', { class: 'hint', text: 'Point and drag: the trail fades and is never saved.' }));
        break;
      case 'hand':
        opts.append(el('span', { class: 'hint', text: 'Drag anywhere — with the pen, a finger, or the mouse — to pan the page.' }));
        break;
      case 'text':
        opts.append(
          this.buildSwatches(
            PEN_COLORS,
            toolState.textColor,
            (c) => {
              toolState.textColor = c;
              saveToolState();
              this.renderTools();
            },
            'pen'
          ),
          el('span', { class: 'hint', text: 'Tap to place text. Tap a box to edit it.' })
        );
        break;
      case 'shapes': {
        // which shape a drag places, then the outline's colour and width (the pen's)
        const picker = el('div', { class: 'dock-group', role: 'radiogroup', 'aria-label': 'Shape' });
        for (const kind of PLACED_SHAPES) {
          const opt = SHAPE_OPTIONS[kind];
          const active = toolState.shapeKind === kind;
          const b = el('button', {
            class: 'tool' + (active ? ' active' : ''),
            title: opt.label,
            'aria-label': opt.label,
            role: 'radio',
            'aria-checked': active ? 'true' : 'false',
          });
          b.append(icon(opt.icon));
          b.addEventListener('click', () => {
            if (toolState.shapeKind === kind) return;
            toolState.shapeKind = kind;
            saveToolState();
            this.renderTools();
          });
          picker.append(b);
        }
        opts.append(
          picker,
          el('span', { class: 'divider' }),
          this.buildSwatches(
            PEN_COLORS,
            toolState.penColor,
            (c) => {
              toolState.penColor = c;
              saveToolState();
              this.renderTools();
            },
            'pen'
          ),
          this.buildSizeControl(true)
        );
        // a shape is selected (freshly placed, or tapped to readjust): give it
        // the same reliable Delete action the Lasso tool's own selection row
        // has, rather than leaving the on-canvas × as the only way to delete
        // it — that button can end up rendered under the floating dock (see
        // the delete-bug report) when the shape sits near the top of the page,
        // where a lasso-based deletion still has this dock button to fall
        // back on but a shapes-tool selection previously didn't.
        if (this.selPc?.hasSelection) {
          opts.append(el('span', { class: 'divider' }), this.actionBtn('delete', 'Delete', () => this.selPc?.deleteSelection()));
        }
        opts.append(el('span', { class: 'hint', text: 'Drag to place a shape sized to the drag. Tap a shape to adjust it.' }));
        break;
      }
      default: {
        const isPen = toolState.kind === 'pen';
        const swatches = this.buildSwatches(
          isPen ? PEN_COLORS : HI_COLORS,
          isPen ? toolState.penColor : toolState.hiColor,
          (c) => {
            if (isPen) toolState.penColor = c;
            else toolState.hiColor = c;
            saveToolState();
            this.renderTools();
          },
          isPen ? 'pen' : 'highlighter'
        );
        opts.append(swatches, this.buildSizeControl(isPen));
        // line-snap lives on the pen only: draw a straight-ish stroke, hold
        // still, and it becomes a line you can adjust by its ends
        if (isPen) {
          opts.append(el('span', { class: 'hint', text: 'Hold still at the end of a straight stroke to snap it to a line.' }));
        }
      }
    }

    // drawing aids + undo/redo — independent of the active tool, so they live
    // in the fixed top row alongside the tool icons (the divider ending the
    // block above already separates them from the tools). Insert-image used
    // to live here too; it's now in the app bar (see buildChrome).
    const guideBtn = (kind: GuideKind, name: IconName, label: string): HTMLElement => {
      const b = el('button', {
        class: 'tool' + (this.guideKind === kind ? ' active' : ''),
        title: label,
        'aria-label': label,
        'aria-pressed': this.guideKind === kind ? 'true' : 'false',
      });
      b.append(icon(name));
      b.addEventListener('click', () => this.toggleGuide(kind));
      return b;
    };
    top.append(guideBtn('ruler', 'ruler', 'Ruler'), guideBtn('protractor', 'protractor', 'Protractor'));
    top.append(el('span', { class: 'divider' }), this.undoBtn, this.redoBtn);
  }

  /** Reads a picked photo / GIF and drops it on the page in view, selected, with the lasso tool active. */
  private async insertImage(file: File): Promise<void> {
    const target = this.currentPageId ? this.pcByPage.get(this.currentPageId) : null;
    if (!target?.mounted) return;
    let loaded;
    try {
      loaded = await loadImageFile(file);
    } catch (err) {
      await alertDialog({ title: 'Could not insert image', message: (err as Error).message || undefined });
      return;
    }
    if (toolState.kind !== 'lasso') {
      this.deactivateAll();
      toolState.kind = 'lasso';
      saveToolState();
    }
    target.insertImage(loaded.src, loaded.w, loaded.h);
    this.renderTools();
  }

  /**
   * Imports a PDF's pages, appended right after the page in view, via the
   * same pdf-import.ts parsing the library's "Import file" uses for a
   * whole new notebook — this just targets "append to this notebook"
   * instead. A non-dismissable progress dialog covers the read + per-page
   * setup so a large PDF never looks like a frozen screen.
   */
  private async importPdfPagesHere(file: File): Promise<void> {
    const pages = store.pagesOf(this.nb.id);
    const current = this.currentPageId ? store.pages.get(this.currentPageId) : undefined;
    const afterIndex = current?.index ?? pages.length - 1;

    const box = el('div', { class: 'dlg' });
    const msg = el('p', { class: 'dlg__msg', text: 'Reading PDF…' });
    box.append(el('h2', { class: 'dlg__title', text: `Importing ${file.name}` }), msg);
    const progress = openModal(box, { dismissable: false });
    try {
      const { importPdfPages } = await import('../pdf-import'); // pdf.js is loaded only when needed
      await importPdfPages(file, this.nb.id, afterIndex, (done, total) => {
        msg.textContent = `Preparing page ${done} of ${total}…`;
      });
      progress.close();
      store.enforceTrailingBlank(this.nb.id); // an imported PDF page isn't blank, so this may add one back
      this.syncPages();
    } catch (err) {
      progress.close();
      await alertDialog({ title: 'Import failed', message: (err as Error).message || undefined });
    }
  }

  /** Anchored dropdown with the two eraser modes; the choice is remembered in tool state. */
  private openEraserMenu(anchor: HTMLElement): void {
    const menu = el('div', { class: 'menu', role: 'menu' });
    let modal: Modal | null = null;
    for (const mode of ['whole', 'partial'] as EraserMode[]) {
      const item = el('button', {
        class: 'menu__item' + (toolState.eraserMode === mode ? ' active' : ''),
        role: 'menuitemradio',
        'aria-checked': toolState.eraserMode === mode ? 'true' : 'false',
      });
      const label = el('span');
      label.append(ERASER_MODES[mode].label, el('span', { class: 'menu__sub', text: ERASER_MODES[mode].sub }));
      item.append(icon('check'), label);
      item.addEventListener('click', () => {
        toolState.eraserMode = mode;
        saveToolState();
        modal?.close();
        this.renderTools();
      });
      menu.append(item);
    }
    modal = openAnchoredModal(anchor, menu);
  }

  /** Shows the ruler / protractor on the page in view, or hides it if it's already shown. */
  private toggleGuide(kind: GuideKind): void {
    const prev = this.guidePageId ? this.pcByPage.get(this.guidePageId) : null;
    prev?.hideGuide();
    if (this.guideKind === kind) {
      this.guideKind = this.guidePageId = null;
    } else {
      const target = this.currentPageId ? this.pcByPage.get(this.currentPageId) : null;
      if (!target?.mounted) return;
      target.showGuide(kind);
      this.guideKind = kind;
      this.guidePageId = target.page.id;
    }
    this.renderTools();
  }

  /** A single icon button for a dock action row (Delete, Copy, Duplicate, Paste, …). */
  private actionBtn(name: IconName, label: string, onClick: () => void): HTMLElement {
    const b = el('button', { class: 'tool', title: label, 'aria-label': label });
    b.append(icon(name));
    b.addEventListener('click', onClick);
    return b;
  }

  /**
   * Lasso dock: the selection-shape picker and recolour swatches. Copy / cut /
   * paste / delete / duplicate used to live here too — they're in the
   * floating selection callout now (see showSelectionCallout), so this only
   * renders a hint (nothing selected) or the recolour swatches (something is).
   */
  private renderLassoTools(t: HTMLElement): void {
    const items = this.selPc?.selectedItems() ?? [];
    const action = this.actionBtn;

    // how the next selection is drawn: freehand, or a box / circle from corner to corner
    const picker = el('div', { class: 'dock-group', role: 'radiogroup', 'aria-label': 'Selection shape' });
    for (const shape of LASSO_SHAPES) {
      const opt = LASSO_OPTIONS[shape];
      const active = toolState.lassoShape === shape;
      const b = el('button', {
        class: 'tool' + (active ? ' active' : ''),
        title: opt.label,
        'aria-label': opt.label,
        role: 'radio',
        'aria-checked': active ? 'true' : 'false',
      });
      b.append(icon(opt.icon));
      b.addEventListener('click', () => {
        if (toolState.lassoShape === shape) return;
        toolState.lassoShape = shape;
        saveToolState();
        this.renderTools();
      });
      picker.append(b);
    }
    t.append(picker, el('span', { class: 'divider' }));

    if (!items.length) {
      const how = toolState.lassoShape === 'free' ? 'Draw around items' : 'Drag across items';
      t.append(el('span', { class: 'hint', text: `${how} to select them.` }));
      if (this.clipboard.length) t.append(action('paste', 'Paste', () => this.pasteClipboard()));
      return;
    }

    const strokes = items.filter(isStroke);
    const hasPen = strokes.some((s) => s.tool === 'pen');
    const hasHi = strokes.some((s) => s.tool === 'highlighter');
    if (hasPen || hasHi) t.append(el('span', { class: 'divider' }));
    if (hasPen) {
      t.append(this.buildSwatches(PEN_COLORS, null, (c) => this.selPc?.recolorSelection('pen', c), 'pen'));
    }
    if (hasHi) {
      t.append(
        this.buildSwatches(HI_COLORS, null, (c) => this.selPc?.recolorSelection('highlighter', c), 'highlighter')
      );
    }
  }

  /**
   * A row of colour swatches: the presets, then the tool's custom colours, then
   * an "add colour" button that opens the picker. The "auto" swatch paints
   * itself from the page in view. Long-press / right-click a custom swatch to
   * remove it.
   */
  private buildSwatches(
    colors: string[],
    current: string | null,
    onPick: (c: string) => void,
    tool?: 'pen' | 'highlighter'
  ): HTMLElement {
    const swatches = el('div', { class: 'dock-group' });
    const custom = tool ? (tool === 'pen' ? toolState.customPen : toolState.customHi) : [];
    const add = (c: string, isCustom: boolean): void => {
      const isAuto = c === AUTO_COLOR;
      const s = el('button', {
        class: 'swatch' + (isAuto ? ' swatch--auto' : '') + (isCustom ? ' swatch--custom' : '') + (c === current ? ' active' : ''),
        style: isAuto ? '' : `background:${c}`,
        title: isAuto ? 'Auto — adapts to paper' : isCustom ? `${c} (custom — hold to remove)` : c,
        'aria-label': isAuto ? 'Ink auto — adapts to paper' : `Ink ${c}`,
      });
      if (isAuto) {
        const paint = (): void => {
          s.style.background = resolveInkColor(AUTO_COLOR, this.currentPaper());
        };
        paint();
        this.colorRefreshers.push(paint);
      }
      s.addEventListener('click', () => onPick(c));
      if (isCustom && tool) {
        const remove = (e: Event): void => {
          e.preventDefault();
          removeCustomColor(tool, c);
          saveToolState();
          this.renderTools();
        };
        s.addEventListener('contextmenu', remove);
        let hold: ReturnType<typeof setTimeout> | null = null;
        s.addEventListener('pointerdown', () => {
          hold = setTimeout(() => remove(new Event('hold')), 600);
        });
        for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) {
          s.addEventListener(ev, () => {
            if (hold != null) clearTimeout(hold);
            hold = null;
          });
        }
      }
      swatches.append(s);
    };
    for (const c of colors) add(c, false);
    for (const c of custom) add(c, true);
    if (tool) {
      const plus = el('button', { class: 'swatch swatch--add', title: 'Add colour', 'aria-label': 'Add colour' });
      plus.append(icon('plus', 'sm'));
      plus.addEventListener('click', async () => {
        const seed = tool === 'pen' ? toolState.penColor : toolState.hiColor;
        const hex = await pickColor(plus, seed === AUTO_COLOR ? '#2563eb' : seed);
        if (!hex) return;
        addCustomColor(tool, hex);
        saveToolState();
        onPick(hex.toLowerCase()); // the new colour becomes the current one
      });
      swatches.append(plus);
    }
    return swatches;
  }

  // ------------------------------------------------------------ selection
  private onSelection(pc: PageCanvas, count: number): void {
    if (count > 0) {
      const prev = this.selPc;
      this.selPc = pc;
      if (prev && prev !== pc) prev.clearSelection(); // one selection at a time
    } else if (this.selPc === pc) {
      this.selPc = null;
    }
    // the dock shows selection actions for both: lasso's own action row, and
    // the Shapes tool's Delete action (see the 'shapes' case in renderTools) —
    // a shape select-to-readjust (or a fresh placement) needs its own re-render
    // to pick up the newly-selected/deselected state.
    if (toolState.kind === 'lasso' || toolState.kind === 'shapes') this.renderTools();
  }

  /**
   * A lasso selection's frame changed (selected, dragged, resized, rotated,
   * or cleared — `frame` is null then). Shows/repositions/hides the floating
   * callout accordingly; a no-op outside the lasso tool (the Shapes tool's
   * own selection keeps using the dock's Delete action, unchanged).
   */
  private onSelectionFrame(pc: PageCanvas, frame: Frame | null): void {
    if (frame && toolState.kind === 'lasso') {
      this.calloutPc = pc;
      this.showSelectionCallout(pc, frame);
    } else if (pc === this.calloutPc) {
      // only the page the callout is currently anchored to gets to hide it —
      // deselecting a *different* page (e.g. the previous one, when a fresh
      // selection elsewhere just replaced it) must not hide the new one.
      this.calloutPc = null;
      this.hideSelectionCallout();
    }
  }

  private hideSelectionCallout(): void {
    this.calloutEl?.remove();
    this.calloutEl = null;
    this.calloutPill = null;
    this.calloutFrame = null;
  }

  /** Rebuilds the callout's buttons in place (e.g. Paste appearing right after a Copy) without moving it. */
  private refreshSelectionCallout(): void {
    if (!this.calloutPill) return;
    this.renderCalloutButtons(this.calloutPill);
  }

  /** Text-label items, iOS-callout order — Duplicate, Cut, Copy, [Paste], Delete. */
  private renderCalloutButtons(container: HTMLElement): void {
    container.replaceChildren();
    const items: Array<[string, () => void]> = [
      ['Duplicate', () => this.duplicateSelection()],
      ['Cut', () => this.cutSelection()],
      ['Copy', () => this.copySelection()],
    ];
    if (this.clipboard.length) items.push(['Paste', () => this.pasteClipboard()]);
    items.push(['Delete', () => this.selPc?.deleteSelection()]);

    items.forEach(([label, onClick], i) => {
      if (i > 0) container.append(el('span', { class: 'sel-callout__divider' }));
      const b = el('button', { class: 'sel-callout__btn', role: 'menuitem', text: label });
      b.addEventListener('click', onClick);
      container.append(b);
    });
  }

  /**
   * Floating popover mimicking iOS's text-selection callout (rounded pill,
   * light background, dark text, small arrow) — the real system menu isn't
   * reachable for canvas content, so this stands in for it. Lives in
   * `document.body` (position: fixed), never inside the zoomed `.page`
   * subtree — an element there can't out-rank the dock's z-index no matter
   * its own value (see the dock's own comment on this same trap), and this
   * needs to float above everything the same way. Positioned from `frame`
   * (this page's own units) via `pc.pageRect()` (that page's live screen
   * rect) so it tracks scroll/zoom/drag for free, each time it's told the
   * frame changed.
   */
  private showSelectionCallout(pc: PageCanvas, frame: Frame): void {
    const pageRect = pc.pageRect();
    if (!pageRect) {
      this.hideSelectionCallout();
      return;
    }
    if (!this.calloutEl) {
      this.calloutEl = el('div', { class: 'sel-callout', role: 'menu' });
      this.calloutPill = el('div', { class: 'sel-callout__pill' });
      this.calloutEl.append(this.calloutPill);
      document.body.append(this.calloutEl);
    }
    this.renderCalloutButtons(this.calloutPill!);
    this.calloutFrame = frame;
    this.positionCallout(this.calloutEl, frame, pageRect);
  }

  /**
   * Places the callout centred above `frame`'s (rotation-aware) bounding box,
   * flipping below if that would go off the top of the viewport. Hides it
   * outright (rather than clamping to an edge) if the selection has scrolled
   * fully out of view, and keeps it clear of the AI side panel when that's
   * open, shifting right past it rather than rendering underneath.
   */
  private positionCallout(callout: HTMLElement, frame: Frame, pageRect: DOMRect): void {
    const scale = pageRect.width / PAGE_W;
    const cx = frame.x + frame.w / 2;
    const cy = frame.y + frame.h / 2;
    const corners = [
      [frame.x, frame.y],
      [frame.x + frame.w, frame.y],
      [frame.x + frame.w, frame.y + frame.h],
      [frame.x, frame.y + frame.h],
    ].map(([x, y]) => rotateAround(x, y, cx, cy, frame.rot));
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [x, y] of corners) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    const box = {
      left: pageRect.left + minX * scale,
      top: pageRect.top + minY * scale,
      right: pageRect.left + maxX * scale,
      bottom: pageRect.top + maxY * scale,
    };

    const GAP = 10; // between the callout (or its arrow tip) and the selection
    const MARGIN = 8; // keep clear of the viewport edge
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;

    // the selection has scrolled fully out of view — hide rather than clamp
    // to whichever edge it last crossed, which would otherwise leave a
    // callout floating there with nothing visible for it to point at
    const offscreen = box.right < 0 || box.left > vw || box.bottom < 0 || box.top > vh;
    callout.hidden = offscreen;
    if (offscreen) return;

    // offsetWidth/Height reflect the callout's own content size regardless of
    // its current left/top, so no need to move it away to measure first —
    // that would just add a visible jump on every reposition during a drag.
    const cw = callout.offsetWidth;
    const ch = callout.offsetHeight;

    const spaceAbove = box.top - GAP - ch;
    const below = spaceAbove < MARGIN;
    callout.classList.toggle('sel-callout--below', below);

    const top = below ? box.bottom + GAP : spaceAbove;
    let left = (box.left + box.right) / 2 - cw / 2;
    // the AI panel (position: fixed, left: 0, up to 340px wide) sits above
    // everything at a higher z-index than the callout — if it's open, keep
    // clear of it rather than centring underneath/behind it. Always safe to
    // read: closed, it's slid off-screen via transform, so its own rect's
    // right edge is off past the left of the viewport and this no-ops.
    const panelRight = document.querySelector('.ai-panel')?.getBoundingClientRect().right ?? -Infinity;
    const minLeft = Math.max(MARGIN, panelRight + MARGIN);
    left = Math.max(minLeft, Math.min(left, vw - cw - MARGIN));
    const clampedTop = Math.max(MARGIN, Math.min(top, vh - ch - MARGIN));

    callout.style.left = `${Math.round(left)}px`;
    callout.style.top = `${Math.round(clampedTop)}px`;
    // the arrow points at the selection's horizontal centre even when the
    // callout itself got clamped sideways away from directly above it
    const arrowX = Math.max(12, Math.min((box.left + box.right) / 2 - left, cw - 12));
    callout.style.setProperty('--sel-callout-arrow-x', `${Math.round(arrowX)}px`);
  }

  /** Finishes any text edit and drops any selection on every page. */
  private deactivateAll(): void {
    for (const pc of this.pcByPage.values()) pc.deactivate();
    this.selPc = null;
  }

  private copySelection(): boolean {
    const items = this.selPc?.selectedItems() ?? [];
    if (!items.length || !this.selPc) return false;
    this.clipboard = items.map((it) => JSON.parse(JSON.stringify(it)) as PageItem);
    this.clipboardPage = this.selPc.page.id;
    if (toolState.kind === 'lasso') {
      this.renderTools(); // the dock's own "nothing selected" hint picks up Paste too
      this.refreshSelectionCallout(); // still open on the same selection — Paste now belongs in it
    }
    return true;
  }

  /** Copies the selection, then deletes it — the callout's "Cut". */
  private cutSelection(): boolean {
    if (!this.copySelection()) return false;
    this.selPc?.deleteSelection();
    return true;
  }

  /** Pastes onto the page with the selection, else the page in view; nudged when it's the source page. */
  private pasteClipboard(): boolean {
    if (!this.clipboard.length) return false;
    const target = this.selPc ?? (this.currentPageId ? this.pcByPage.get(this.currentPageId) : null);
    if (!target?.mounted) return false;
    const nudge = target.page.id === this.clipboardPage ? PASTE_OFFSET : 0;
    const items = this.clipboard.map((it) => PageCanvas.cloneItem(it, target.page.id, this.nb.id, nudge, nudge));
    // pasting again lands the next copy one step further along
    if (nudge) this.clipboard = items.map((it) => JSON.parse(JSON.stringify(it)) as PageItem);
    target.pasteItems(items);
    return true;
  }

  private duplicateSelection(): boolean {
    const pc = this.selPc;
    const items = pc?.selectedItems() ?? [];
    if (!pc || !items.length) return false;
    pc.pasteItems(items.map((it) => PageCanvas.cloneItem(it, pc.page.id, this.nb.id, PASTE_OFFSET, PASTE_OFFSET)));
    return true;
  }

  /**
   * Collapsed size control: a "Size" button whose only content is a black
   * preview dot (true on-page size, capped) — always black, regardless of the
   * tool's ink colour, so the size reads clearly even for light colours that
   * would otherwise blend into the dock; the button's own outline (CSS) keeps
   * the control itself findable. Tapping it opens the slider in an anchored
   * popover; the dot keeps updating during drag.
   */
  private buildSizeControl(isPen: boolean): HTMLElement {
    const sizeNow = (): number => (isPen ? toolState.penSize : toolState.hiSize);

    const btn = el('button', { class: 'size-btn', 'aria-label': 'Size', title: 'Size' });
    const dot = el('span', { class: 'size-btn__dot' });
    btn.append(dot);

    const paintDot = (v: number): void => {
      const d = Math.min(v * this.pageScale(), 18); // 18px caps the dot inside the (now 32px) .size-btn box; bigger reads from the number
      dot.style.width = `${d}px`;
      dot.style.height = isPen ? `${d}px` : `${Math.max(3, d * 0.5)}px`;
      dot.style.borderRadius = isPen ? '50%' : '2px';
      dot.style.background = '#000';
      dot.style.opacity = isPen ? '1' : '0.5';
    };
    paintDot(sizeNow());
    // re-paints on zoom changes too (pageScale depends on the current zoom), not just colour
    this.colorRefreshers.push(() => paintDot(sizeNow()));

    btn.addEventListener('click', () => {
      const { panel, refreshTicks } = this.buildSizePanel(isPen, paintDot);
      this.sizePopover = openAnchoredModal(btn, panel, {
        onReposition: refreshTicks, // build/rebuild ticks once mounted, and on resize/orientation
        onClose: () => {
          this.sizePopover = null;
        },
      });
    });

    return btn;
  }

  /**
   * The slider panel shown inside the popover: continuous range (no snapping),
   * a tick layer, and the numeric readout. Drag updates `toolState`, the readout
   * and the dock dot via `onLiveSize` — never a dock re-render; saved on release.
   * `refreshTicks` (re)builds the tick layer from the input's real rendered size.
   */
  private buildSizePanel(
    isPen: boolean,
    onLiveSize: (v: number) => void
  ): { panel: HTMLElement; refreshTicks: () => void } {
    const range = sizeRange(isPen ? 'pen' : 'highlighter');
    const current = isPen ? toolState.penSize : toolState.hiSize;

    const panel = el('div', { class: 'size-panel' });
    const row = el('div', { class: 'size-slider' });
    const ticks = el('div', { class: 'size-slider__ticks', 'aria-hidden': 'true' });

    const input = el('input', {
      type: 'range',
      class: 'size-slider__range',
      min: String(range.min),
      max: String(range.max),
      step: '0.1',
      value: String(current),
      'aria-label': `${isPen ? 'Pen' : 'Highlighter'} size`,
    }) as HTMLInputElement;

    const valueEl = el('span', { class: 'size-slider__value' });
    valueEl.textContent = current.toFixed(1);

    input.addEventListener('input', () => {
      const v = clamp(parseFloat(input.value), range.min, range.max);
      if (isPen) toolState.penSize = v;
      else toolState.hiSize = v;
      valueEl.textContent = v.toFixed(1);
      onLiveSize(v);
    });
    input.addEventListener('change', () => saveToolState());

    row.append(ticks, input);
    panel.append(row, valueEl);
    return { panel, refreshTicks: () => buildSizeTicks(ticks, input, range) };
  }

  /** Page-unit → CSS-px factor the mounted page canvases render at (matches `toLocal`). */
  private pageScale(): number {
    const w = this.scrollEl.querySelector('canvas')?.getBoundingClientRect().width;
    return w && w > 0 ? w / PAGE_W : 1;
  }

  // ---------------------------------------------------------------- pages

  /**
   * Reconciles the rendered page list against the store: departed pages are torn
   * down, new pages are built and inserted at the right spot, and survivors keep
   * their mounted canvases untouched. Only the page-number label and paper
   * background are refreshed in place.
   */
  private syncPages(): void {
    const pages = store.pagesOf(this.nb.id);
    const wanted = new Set(pages.map((p) => p.id));

    for (const id of [...this.pcByPage.keys()]) {
      if (!wanted.has(id)) this.disposePage(id);
    }

    pages.forEach((page, i) => {
      const wrap = this.wrapById.get(page.id) ?? this.buildPageWrap(page);

      const at = this.scrollEl.children.item(i);
      if (at !== wrap) this.scrollEl.insertBefore(wrap, at);

      const label = wrap.querySelector('.page-head span');
      const text = `Page ${i + 1}`;
      if (label && label.textContent !== text) label.textContent = text;

      this.applyPaperBg(wrap, page);
    });
  }

  private buildPageWrap(page: Page): HTMLElement {
    const wrap = el('div', { class: 'page-wrap' });

    const headEl = el('div', { class: 'page-head' });
    headEl.append(el('span', { text: `Page ${page.index + 1}` }));
    // grouped so `.page-head`'s space-between only ever sees two children —
    // the label and this group — regardless of how many action buttons live here
    // (the "Paper" link that used to open here moved to the app bar, top right)
    const headActions = el('div', { class: 'page-head__actions' });
    headEl.append(headActions);

    const pageEl = el('div', { class: 'page' });
    pageEl.dataset.pageId = page.id;
    pageEl.style.background = paperBg(page.paper);
    blockGestures(pageEl);
    this.aiMode.attachPage(page, headActions, pageEl);

    // the frame takes the zoomed size in layout; the page inside is CSS-scaled
    const frame = el('div', { class: 'page-frame' });
    frame.append(pageEl);
    wrap.append(headEl, frame);

    const pc = new PageCanvas(page, this.nb, {
      onOp: (op) => {
        // ink drawn while AI mode is active is ephemeral (see AiMode) — it
        // never enters undo history, only turn-detection sees it.
        const isAiInk = op.kind === 'add-stroke' && this.aiMode.isActive(op.pageId);
        if (!isAiInk) this.pushOp(op);
        this.aiMode.handleOp(op);
      },
      onSelection: (p, n) => this.onSelection(p, n),
      onSelectionFrame: (p, frame) => this.onSelectionFrame(p, frame),
      isAiActive: () => this.aiMode.isActive(page.id),
    });
    this.pcByPage.set(page.id, pc);
    this.wrapById.set(page.id, wrap);
    this.observer.observe(pageEl);
    this.viewObserver.observe(pageEl);
    return wrap;
  }

  private disposePage(id: string): void {
    this.aiMode.forgetPage(id);
    const wrap = this.wrapById.get(id);
    if (wrap) {
      const pageEl = wrap.querySelector('.page');
      if (pageEl) {
        this.observer.unobserve(pageEl);
        this.viewObserver.unobserve(pageEl);
      }
      wrap.remove();
    }
    const pc = this.pcByPage.get(id);
    pc?.unmount();
    if (pc && this.selPc === pc) this.selPc = null;
    if (id === this.guidePageId) this.guideKind = this.guidePageId = null;
    this.pcByPage.delete(id);
    this.wrapById.delete(id);
    this.mounted.delete(id);
    this.pageVisibility.delete(id);
    // Don't leave the dock resolving auto ink against a page that no longer
    // exists, even for one tick — pick the next most visible page right away.
    if (this.currentPageId === id) this.setCurrentPage(this.bestVisiblePage());
  }

  private applyPaperBg(wrap: HTMLElement, page: Page): void {
    const pageEl = wrap.querySelector<HTMLElement>('.page');
    if (!pageEl) return;
    const bg = paperBg(page.paper);
    if (pageEl.style.background !== bg) pageEl.style.background = bg;
  }

  /** Re-applies a single page's paper: background now, cache canvas if it is mounted. */
  private refreshPagePaper(page: Page): void {
    const wrap = this.wrapById.get(page.id);
    if (wrap) this.applyPaperBg(wrap, page);
    if (this.mounted.has(page.id)) this.pcByPage.get(page.id)?.paperChanged();
  }

  private onIntersect(entries: IntersectionObserverEntry[]): void {
    for (const e of entries) {
      const id = (e.target as HTMLElement).dataset.pageId;
      if (!id) continue;
      const pc = this.pcByPage.get(id);
      if (!pc) continue;
      if (e.isIntersecting) {
        pc.mount(e.target as HTMLElement);
        this.mounted.add(id);
        if (this.guideKind && id === this.guidePageId) pc.showGuide(this.guideKind);
      } else {
        pc.unmount();
        if (!pc.mounted) this.mounted.delete(id);
      }
    }
  }

  /** Tracks the page with the greatest on-screen visibility as the "current" one. */
  private onViewIntersect(entries: IntersectionObserverEntry[]): void {
    for (const e of entries) {
      const id = (e.target as HTMLElement).dataset.pageId;
      if (!id) continue;
      if (e.intersectionRatio > 0) this.pageVisibility.set(id, e.intersectionRatio);
      else this.pageVisibility.delete(id);
    }
    // Keep the last page when nothing is visible for a moment (e.g. mid-layout).
    const best = this.bestVisiblePage();
    if (best) this.setCurrentPage(best);
  }

  /** The visible page with the greatest intersection ratio, or null if none is on screen. */
  private bestVisiblePage(): string | null {
    let best: string | null = null;
    let bestRatio = 0;
    for (const [id, ratio] of this.pageVisibility) {
      if (ratio > bestRatio) {
        bestRatio = ratio;
        best = id;
      }
    }
    return best;
  }

  /** Sets the "current" page and repaints auto-ink dock elements if it changed. */
  private setCurrentPage(id: string | null): void {
    if (id === this.currentPageId) return;
    this.currentPageId = id;
    this.refreshAutoColors();
    this.refreshAiControls();
  }

  /** Reflects the current page's AI-mode state on the single app-bar toggle + send buttons. */
  private refreshAiControls(): void {
    const active = this.currentPageId ? this.aiMode.isActive(this.currentPageId) : false;
    this.aiToggleBtn.classList.toggle('active', active);
    this.aiToggleBtn.setAttribute('aria-pressed', String(active));
    this.aiSendBtn.hidden = !active;
  }

  /** Paper of the page currently in view, for resolving the "auto" ink token. */
  private currentPaper(): Paper {
    const current = this.currentPageId ? store.pages.get(this.currentPageId) : undefined;
    return current?.paper ?? store.pagesOf(this.nb.id)[0]?.paper ?? DEFAULT_PAPER;
  }

  /** Repaints every dock element whose colour depends on the current page's paper. */
  private refreshAutoColors(): void {
    for (const fn of this.colorRefreshers) fn();
  }

  // ----------------------------------------------------------- paper menu
  /**
   * Template/spacing/colour/scope are all staged in `draft`/`scope` — picking
   * an option only updates the segmented control's own selected-state (see
   * segmented()) and this local state, nothing is written to the store or
   * rendered onto the page until Confirm. Closing the menu any other way
   * (outside tap, Escape, navigating away) discards the draft with no effect,
   * since nothing was ever applied to discard.
   */
  private openPaperMenu(page: Page): void {
    const TEMPLATES: PaperTemplate[] = ['blank', 'ruled', 'grid', 'dot'];
    const SPACINGS: PaperSpacing[] = ['narrow', 'medium', 'wide'];
    const COLORS: PaperColor[] = ['white', 'cream', 'dark'];

    let scope: 'page' | 'all' = 'all';
    let draft: Paper = { ...page.paper };

    // spacing only means something once there's ruling to space — dim it for
    // blank, but keep the stored value so it comes back for ruled/grid/dot
    const spacingRow = segmented(
      ['Narrow', 'Medium', 'Wide'],
      SPACINGS.indexOf(draft.spacing),
      (i) => {
        draft = { ...draft, spacing: SPACINGS[i] };
      }
    );
    setSegmentedDisabled(spacingRow, draft.template === 'blank');

    const templateRow = segmented(
      ['Blank', 'Ruled', 'Grid', 'Dot'],
      TEMPLATES.indexOf(draft.template),
      (i) => {
        draft = { ...draft, template: TEMPLATES[i] };
        setSegmentedDisabled(spacingRow, TEMPLATES[i] === 'blank');
      }
    );

    const wrap = el('div', { class: 'dlg paper-menu' });
    wrap.append(
      el('h2', { class: 'dlg__title', text: `Page ${page.index + 1} paper` }),
      field('Template', templateRow),
      field('Line spacing', spacingRow),
      field(
        'Paper color',
        segmented(['White', 'Cream', 'Dark'], COLORS.indexOf(draft.color), (i) => {
          draft = { ...draft, color: COLORS[i] };
        })
      ),
      field(
        'Apply to',
        segmented(['This page', 'All pages'], 1, (i) => {
          scope = i === 0 ? 'page' : 'all';
        })
      )
    );

    const confirmBtn = el('button', { class: 'primary dlg__wide', text: 'Confirm' });
    wrap.append(confirmBtn);

    const modal = openModal(wrap, {
      // see paperMenuGuardUntil's own doc comment: arms on every close, not
      // just a backdrop-tap dismiss, since the Confirm button's own ghost
      // click can't land on the paper button anyway — simplest to just always set it.
      onClose: () => {
        this.paperMenuGuardUntil = Date.now() + 400;
      },
    });
    confirmBtn.addEventListener('click', () => {
      store.setPaper(page.id, draft, scope);
      if (scope === 'all') for (const p of store.pagesOf(this.nb.id)) this.refreshPagePaper(p);
      else this.refreshPagePaper(page);
      this.refreshAutoColors();
      modal.close();
    });
  }

  /**
   * Deletes a page (undo-tracked). Was previously unreferenced — a "Delete
   * page" button in openPaperMenu was removed on request, leaving this ready
   * to rewire; the page manager (openPageManager) is now that place, per the
   * same request.
   */
  private removePage(page: Page): void {
    const strokes = store.strokesOf(page.id).map((s) => ({ ...s }));
    const elements = store.elementsOf(page.id).map((e) => ({ ...e }));
    store.deletePage(page.id);
    this.pushOp({ kind: 'del-page', page: { ...page }, strokes, elements });
    this.syncPages();
  }

  /** Runs the "one trailing blank page" invariant; reconciles pages if it changed structure. */
  private enforceAndMaybeRerender(): void {
    if (store.enforceTrailingBlank(this.nb.id)) this.syncPages();
  }

  /** Scrolls to a page and marks it "current" right away (rather than waiting for the scroll to settle and the view-intersection observer to catch up). */
  private goToPage(pageId: string): void {
    this.wrapById.get(pageId)?.scrollIntoView({ block: 'start' });
    this.setCurrentPage(pageId);
  }

  /**
   * Full-screen page manager: every page as a thumbnail, in order — reorder
   * (move up/down; drag-and-drop was skipped in favour of buttons, which are
   * simpler to get right across mouse/touch/pen than a DnD implementation,
   * per the task's own suggested fallback), duplicate, delete, or tap one to
   * jump to it. Thumbnails are rendered once per open and cached in `thumbs`
   * for the rest of the session — reordering/deleting just redraws the list
   * from the cache; only a freshly duplicated page renders new pixels.
   */
  private async openPageManager(): Promise<void> {
    const { renderPageCanvas } = await import('../export/raster'); // pulls in the (lazy) export/render code only when this opens
    // rendered wider than the CSS grid's minimum column (150px) since the
    // thumbnail box stretches to fill wider columns on a big screen —
    // the canvas would otherwise upscale and look soft
    const THUMB_W = 260;
    const thumbs = new Map<string, HTMLCanvasElement>();

    const wrap = el('div', { class: 'pagemgr' });
    const head = el('div', { class: 'pagemgr__head' });
    head.append(el('h2', { class: 'pagemgr__title', text: 'Pages' }));
    const closeBtn = el('button', { class: 'iconbtn', title: 'Close', 'aria-label': 'Close' });
    closeBtn.append(icon('close'));
    head.append(closeBtn);
    const grid = el('div', { class: 'pagemgr__grid' });
    wrap.append(head, grid);

    const modal = openModal(wrap, {
      cardClass: 'modal-card--pages',
      onClose: () => {
        this.pageMgrGuardUntil = Date.now() + 400; // see pageMgrGuardUntil's own doc comment
      },
    });
    closeBtn.addEventListener('click', () => modal.close());

    const actionBtn = (name: IconName, label: string, disabled: boolean, run: () => void): HTMLButtonElement => {
      const b = el('button', { class: 'iconbtn', title: label, 'aria-label': label }) as HTMLButtonElement;
      b.append(icon(name));
      b.disabled = disabled;
      b.addEventListener('click', run);
      return b;
    };

    const render = (): void => {
      const pages = store.pagesOf(this.nb.id);
      grid.replaceChildren();
      pages.forEach((page, i) => {
        const card = el('div', { class: 'pagemgr__card' });

        const thumbBtn = el('button', {
          class: 'pagemgr__thumbbtn',
          title: `Go to page ${i + 1}`,
          'aria-label': `Go to page ${i + 1}`,
        });
        const thumbBox = el('span', { class: 'pagemgr__thumb' });
        thumbBtn.append(thumbBox, el('span', { class: 'pagemgr__num', text: `Page ${i + 1}` }));
        thumbBtn.addEventListener('click', () => {
          modal.close();
          this.goToPage(page.id);
        });

        const cached = thumbs.get(page.id);
        if (cached) {
          thumbBox.append(cached);
        } else {
          void renderPageCanvas(page, THUMB_W / PAGE_W)
            .then((c) => {
              c.className = 'pagemgr__canvas';
              thumbs.set(page.id, c);
              thumbBox.replaceChildren(c);
            })
            .catch(() => {
              /* a page whose background image fails to decode just keeps a blank thumbnail */
            });
        }

        const actions = el('div', { class: 'pagemgr__actions' });
        actions.append(
          actionBtn('arrow-up', 'Move page up', i === 0, () => {
            store.movePage(page.id, -1);
            this.syncPages();
            render();
          }),
          actionBtn('arrow-down', 'Move page down', i === pages.length - 1, () => {
            store.movePage(page.id, 1);
            this.syncPages();
            render();
          }),
          actionBtn('duplicate', 'Duplicate page', false, () => {
            store.duplicatePage(page.id);
            store.enforceTrailingBlank(this.nb.id);
            this.syncPages();
            render();
          }),
          actionBtn('delete', 'Delete page', false, async () => {
            const ok = await confirmDialog({
              title: `Delete page ${i + 1}?`,
              message: 'Its strokes and content will be removed from this notebook.',
              confirmText: 'Delete page',
              danger: true,
            });
            if (!ok) return;
            thumbs.delete(page.id);
            this.removePage(page);
            render();
          })
        );

        card.append(thumbBtn, actions);
        grid.append(card);
      });
    };
    render();
  }

  // -------------------------------------------------------------- history
  private pushOp(op: ViewOp): void {
    this.undoStack.push(op);
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack.length = 0;
    this.syncHistory();
    this.enforceAndMaybeRerender();
  }

  private undo(): void {
    const op = this.undoStack.pop();
    if (!op) return;
    this.invert(op);
    this.redoStack.push(op);
    this.syncHistory();
    this.enforceAndMaybeRerender();
  }

  private redo(): void {
    const op = this.redoStack.pop();
    if (!op) return;
    this.forward(op);
    this.undoStack.push(op);
    this.syncHistory();
    this.enforceAndMaybeRerender();
  }

  private invert(op: ViewOp): void {
    switch (op.kind) {
      case 'add-stroke':
        store.removeStrokes(op.pageId, new Set([op.stroke.id]));
        this.rebuildIfMounted(op.pageId);
        break;
      case 'erase':
        for (const s of op.strokes) store.addStroke({ ...s });
        this.rebuildIfMounted(op.pageId);
        break;
      case 'add-items':
        store.removeItems(op.pageId, new Set(op.items.map((it) => it.id)));
        this.rebuildIfMounted(op.pageId);
        break;
      case 'remove-items':
        store.addItems(op.items.map((it) => ({ ...it })));
        this.rebuildIfMounted(op.pageId);
        break;
      case 'replace-items':
        store.replaceItems(op.pageId, op.before.map((it) => ({ ...it })));
        this.rebuildIfMounted(op.pageId);
        break;
      case 'edit':
        store.removeItems(op.pageId, new Set(op.added.map((it) => it.id)));
        store.addItems(op.removed.map((it) => ({ ...it })));
        this.rebuildIfMounted(op.pageId);
        break;
      case 'del-page':
        store.insertPage({ ...op.page }, op.page.index);
        for (const s of op.strokes) store.addStroke({ ...s });
        for (const e of op.elements) store.addElement({ ...e });
        this.syncPages();
        break;
    }
  }

  private forward(op: ViewOp): void {
    switch (op.kind) {
      case 'add-stroke':
        store.addStroke({ ...op.stroke });
        this.rebuildIfMounted(op.pageId);
        break;
      case 'erase':
        store.removeStrokes(op.pageId, new Set(op.strokes.map((s) => s.id)));
        this.rebuildIfMounted(op.pageId);
        break;
      case 'add-items':
        store.addItems(op.items.map((it) => ({ ...it })));
        this.rebuildIfMounted(op.pageId);
        break;
      case 'remove-items':
        store.removeItems(op.pageId, new Set(op.items.map((it) => it.id)));
        this.rebuildIfMounted(op.pageId);
        break;
      case 'replace-items':
        store.replaceItems(op.pageId, op.after.map((it) => ({ ...it })));
        this.rebuildIfMounted(op.pageId);
        break;
      case 'edit':
        store.removeItems(op.pageId, new Set(op.removed.map((it) => it.id)));
        store.addItems(op.added.map((it) => ({ ...it })));
        this.rebuildIfMounted(op.pageId);
        break;
      case 'del-page':
        store.deletePage(op.page.id);
        this.syncPages();
        break;
    }
  }

  /** After undo/redo touched a page: drop any selection there (it may reference gone items) and repaint. */
  private rebuildIfMounted(pageId: string): void {
    if (this.mounted.has(pageId)) this.pcByPage.get(pageId)?.refresh();
  }

  private syncHistory(): void {
    this.undoBtn.disabled = this.undoStack.length === 0;
    this.redoBtn.disabled = this.redoStack.length === 0;
  }
}

const ERASER_MODES: Record<EraserMode, { label: string; sub: string }> = {
  whole: { label: 'Whole stroke', sub: 'Removes any stroke you touch' },
  partial: { label: 'Partial', sub: 'Removes only the parts you touch' },
};

/** A row of mutually-exclusive pill buttons; calls `onPick` with the chosen index. */
function segmented(labels: string[], activeIndex: number, onPick: (i: number) => void): HTMLElement {
  const row = el('div', { class: 'seg' });
  const btns: HTMLButtonElement[] = [];
  labels.forEach((label, i) => {
    const b = el('button', {
      type: 'button',
      class: 'seg__btn' + (i === activeIndex ? ' active' : ''),
      text: label,
    }) as HTMLButtonElement;
    b.addEventListener('click', () => {
      for (const x of btns) x.classList.remove('active');
      b.classList.add('active');
      onPick(i);
    });
    btns.push(b);
    row.append(b);
  });
  return row;
}

function field(label: string, control: HTMLElement): HTMLElement {
  const f = el('div', { class: 'dlg__field' });
  f.append(el('span', { class: 'dlg__flabel', text: label }), control);
  return f;
}

/** Dims a `segmented()` row without removing it — its buttons pick up the shared button:disabled style. */
function setSegmentedDisabled(row: HTMLElement, disabled: boolean): void {
  for (const b of row.querySelectorAll<HTMLButtonElement>('.seg__btn')) b.disabled = disabled;
}

/** Smallest of 1 / 2 / 5 whose spacing over `usablePx` is at least 8px (else 5). */
function tickStep(span: number, usablePx: number): number {
  const pxPerUnit = usablePx / span;
  for (const s of [1, 2, 5]) if (s * pxPerUnit >= 8) return s;
  return 5;
}

/**
 * (Re)fills a positioned tick layer. Geometry comes from the input itself — its
 * actual rendered width and the `--size-thumb-w` custom property — so ticks stay
 * aligned to the thumb centre (thumb-width inset at both ends) even if the track
 * has been squeezed. Step adapts to keep minor ticks >= 8px apart; a major tick
 * every 5 steps.
 */
function buildSizeTicks(layer: HTMLElement, input: HTMLInputElement, range: SizeRange): void {
  const trackW = input.getBoundingClientRect().width;
  if (!trackW) return;
  const thumb = parseFloat(getComputedStyle(input).getPropertyValue('--size-thumb-w')) || 16;
  const usable = trackW - thumb;
  const span = range.max - range.min;
  const step = tickStep(span, usable);
  const majorEvery = step * 5;

  layer.replaceChildren();
  for (let v = Math.ceil(range.min / step) * step; v <= range.max + 1e-9; v += step) {
    const x = thumb / 2 + ((v - range.min) / span) * usable;
    const major = Math.abs(v % majorEvery) < 1e-9;
    const tick = el('span', {
      class: major ? 'size-slider__tick size-slider__tick--major' : 'size-slider__tick',
    });
    tick.style.left = `${x}px`;
    layer.append(tick);
  }
}
