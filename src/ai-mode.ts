/**
 * AI mode: turns a page into a live handwritten conversation with Gemini.
 *
 * Deliberately decoupled from `PageCanvas` — it never touches pointer/canvas
 * internals. It listens to the same `Op` stream `NotebookView` already uses
 * for undo/redo (an `add-stroke` op is "new ink"), reads page content through
 * `store` (which works whether or not the page is currently mounted), and
 * writes replies back the same way the text tool commits a new text box:
 * `store.addItems` + the same `pushOp` undo tracking. Visual feedback (the
 * toggle/send buttons, the "thinking" status, the active-page border) is the
 * one place this does own its own small bit of DOM, via elements handed to it
 * once by `NotebookView.buildPageWrap`.
 */
import { el } from './ui/dom';
import { renderPageRegionImage } from './export/raster';
import { layoutText } from './canvas/elements';
import { itemBounds, unionRects } from './canvas/geom';
import { PAGE_H, PAGE_W } from './const';
import { store } from './store';
import type { Op } from './canvas/page-canvas';
import type { Page, TextElement } from './types';
import { isStroke, uid } from './util';

/** How long a page must sit idle after new ink before a turn auto-submits. */
const IDLE_MS = 2000;
/** Vertical gap (page units) kept between the user's ink, a reply, and the next turn. */
const MARGIN = 24;
/** Reply text box: left/right inset from the page edges, and font size. */
const FONT_SIZE = 18;
/** The one AI accent colour — the page border, in-progress ink, and a reply's
 * text all use exactly this, so "AI mode" reads as one consistent identity. */
export const AI_COLOR = '#6d28d9';
const AI_BG = 'rgba(109, 40, 217, 0.10)';
const ERROR_COLOR = '#ba1a1a';
const ERROR_BG = 'rgba(186, 26, 26, 0.10)';

/** Where the built-in Gemini endpoint lives. Same-origin `/api/gemini` by
 * default (set if the static site itself is ever served from the Vercel
 * project); override with an absolute URL via `VITE_GEMINI_ENDPOINT` when the
 * site is hosted elsewhere (e.g. GitHub Pages) and the function is not. */
const GEMINI_ENDPOINT = import.meta.env.VITE_GEMINI_ENDPOINT?.trim() || '/api/gemini';
const PROXY_SECRET = import.meta.env.VITE_GEMINI_PROXY_SECRET ?? '';

interface AiPageState {
  pageEl: HTMLElement;
  statusEl: HTMLElement;
  active: boolean;
  sending: boolean;
  /** page-units Y: top of the region the next turn will be read from. */
  turnTop: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** ids of strokes drawn while AI mode was active on this page — ephemeral:
   * never undoable, removed once their turn is sent (or discarded if AI mode
   * is turned off before that happens). Never holds a stroke the user drew
   * with AI mode off. */
  inkIds: Set<string>;
}

/** What `AiMode` needs from `NotebookView`, injected rather than imported to avoid a cycle. */
export interface AiModeHost {
  /** Same undo/redo tracking every other page edit goes through. */
  pushOp(op: Op): void;
  /** Rebuilds the page list from the store (after inserting a continuation page). */
  syncPages(): void;
  /** Repaints a page's canvas from the store, if it's currently mounted. */
  refreshPage(pageId: string): void;
  /** A page's active flag changed (toggle, or the conversation moving to a continuation page) —
   * lets the single app-bar toggle button refresh if it's currently showing this page. */
  onActiveChanged(pageId: string, active: boolean): void;
}

export class AiMode {
  private readonly pages = new Map<string, AiPageState>();

  constructor(private readonly host: AiModeHost) {}

  /**
   * Called once per page, when its `.page-head`/`.page` DOM is first built.
   * Both AI controls (toggle, send) live once in the app bar (`NotebookView`),
   * acting on whichever page is "current" — only the status text is per-page.
   */
  attachPage(page: Page, headActions: HTMLElement, pageEl: HTMLElement): void {
    const pageId = page.id;

    const statusEl = el('span', { class: 'ai-status' });
    headActions.append(statusEl);

    this.pages.set(pageId, {
      pageEl,
      statusEl,
      active: false,
      sending: false,
      turnTop: 0,
      idleTimer: null,
      inkIds: new Set(),
    });
  }

  /** Whether AI mode is on for this page — the app-bar toggle button reflects this for the current page. */
  isActive(pageId: string): boolean {
    return this.pages.get(pageId)?.active ?? false;
  }

  /** Feed every committed page op through here. */
  handleOp(op: Op): void {
    if (op.kind !== 'add-stroke') return;
    const st = this.pages.get(op.pageId);
    if (!st || !st.active) return;
    // any stroke drawn while AI mode is active is ephemeral ink, regardless
    // of where on the page it lands — see PageCanvas's isAiActive hook, which
    // is what actually painted it violet instead of the user's pen colour.
    st.inkIds.add(op.stroke.id);
    if (st.sending) return; // still track it; just don't restart the timer mid-send
    const b = itemBounds(op.stroke);
    if (b.y + b.h < st.turnTop) return; // above the active region: doesn't (re)arm the timer
    this.armTimer(op.pageId, st);
  }

  /** Toggles AI mode for one page — called by the single app-bar button, for whichever page is current. */
  toggle(pageId: string): void {
    const st = this.pages.get(pageId);
    if (!st) return;
    st.active = !st.active;
    if (st.active) {
      st.turnTop = 0; // first turn: the whole page so far
    } else {
      if (st.idleTimer != null) {
        clearTimeout(st.idleTimer);
        st.idleTimer = null;
      }
      this.discardInk(pageId, st); // turned off with unsent violet ink still on the page: drop it
    }
    this.applyVisual(pageId);
    this.host.onActiveChanged(pageId, st.active);
  }

  /** True while a page is being torn down for good (not just scrolled out of view). */
  forgetPage(pageId: string): void {
    const st = this.pages.get(pageId);
    if (st?.idleTimer != null) clearTimeout(st.idleTimer);
    this.pages.delete(pageId);
  }

  /** Submits the current turn immediately — called by the app-bar send button, for whichever page is current. */
  sendNow(pageId: string): void {
    const st = this.pages.get(pageId);
    if (!st || !st.active || st.sending) return;
    if (st.idleTimer != null) {
      clearTimeout(st.idleTimer);
      st.idleTimer = null;
    }
    void this.submitTurn(pageId);
  }

  private armTimer(pageId: string, st: AiPageState): void {
    if (st.idleTimer != null) clearTimeout(st.idleTimer);
    st.idleTimer = setTimeout(() => {
      st.idleTimer = null;
      void this.submitTurn(pageId);
    }, IDLE_MS);
  }

  /** Removes whatever ephemeral ink is still tracked (unsent) and repaints if any was. */
  private discardInk(pageId: string, st: AiPageState): void {
    if (!st.inkIds.size) return;
    const removed = store.removeStrokes(pageId, st.inkIds);
    st.inkIds.clear();
    if (removed.length) this.host.refreshPage(pageId);
  }

  private applyVisual(pageId: string): void {
    const st = this.pages.get(pageId);
    if (!st) return;
    st.pageEl.classList.toggle('page--ai-active', st.active);
    st.statusEl.classList.toggle('ai-status--busy', st.sending);
    st.statusEl.textContent = st.sending ? 'Gemini is thinking…' : st.active ? 'AI mode' : '';
  }

  private async submitTurn(pageId: string): Promise<void> {
    const st = this.pages.get(pageId);
    if (!st || !st.active || st.sending) return;

    const page = store.pageById(pageId);
    if (!page) return;

    const top = st.turnTop;
    const items = store.itemsOf(pageId).filter((it) => itemBounds(it).y + itemBounds(it).h > top + 0.01);
    if (!items.length) return; // the timer fired but there's nothing new below the line (e.g. it was erased)

    const bounds = unionRects(items.map(itemBounds))!;
    const bottom = Math.min(Math.max(bounds.y + bounds.h + 12, top + 1), PAGE_H);

    st.sending = true;
    this.applyVisual(pageId);

    let text: string;
    let isError = false;
    try {
      const { base64, mimeType } = await renderPageRegionImage(page, { top, bottom });

      // the image is captured — this ink's job is done. Discard the strokes
      // that were part of this turn (only ones we ourselves marked ephemeral;
      // never touches pre-existing permanent content) so they never persist,
      // regardless of what the request below does.
      const sentIds = new Set(items.filter(isStroke).map((it) => it.id).filter((id) => st.inkIds.has(id)));
      if (sentIds.size) {
        store.removeStrokes(pageId, sentIds);
        for (const id of sentIds) st.inkIds.delete(id);
        this.host.refreshPage(pageId);
      }

      const res = await fetch(GEMINI_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-NoteApp-Secret': PROXY_SECRET },
        body: JSON.stringify({ image: base64, mimeType }),
      });
      const data: { text?: unknown; error?: unknown } | null = await res.json().catch(() => null);
      if (res.ok && typeof data?.text === 'string' && data.text) {
        text = data.text;
      } else {
        const reason = typeof data?.error === 'string' ? data.error : `request failed (${res.status})`;
        text = `Gemini error: ${reason}`;
        isError = true;
      }
    } catch (err) {
      text = `Gemini error: could not reach the endpoint (${err instanceof Error ? err.message : 'network error'}).`;
      isError = true;
    }

    // re-check: the page could have been deleted while the request was in flight
    if (!this.pages.has(pageId)) return;
    st.sending = false;
    const freshPage = store.pageById(pageId) ?? page;
    this.insertReply(pageId, freshPage, bottom, text, isError);
  }

  /** Places the reply below `afterY`; continues on a fresh page first if it wouldn't fit. */
  private insertReply(pageId: string, page: Page, afterY: number, text: string, isError: boolean): void {
    const width = PAGE_W - MARGIN * 2;
    const boxH = layoutText(text, FONT_SIZE, width).height;

    let targetPageId = pageId;
    let targetPage = page;
    let y = afterY + MARGIN;

    if (y + boxH + 12 + MARGIN > PAGE_H) {
      const next = store.addPage(page.notebookId, page.index + 1);
      this.host.syncPages(); // builds the new page's DOM, including its AiMode state
      targetPageId = next.id;
      targetPage = next;
      y = MARGIN;

      const oldSt = this.pages.get(pageId);
      if (oldSt) {
        oldSt.active = false;
        if (oldSt.idleTimer != null) {
          clearTimeout(oldSt.idleTimer);
          oldSt.idleTimer = null;
        }
        this.discardInk(pageId, oldSt); // anything left over (e.g. drawn above the line) doesn't carry over
        this.applyVisual(pageId);
        this.host.onActiveChanged(pageId, false);
      }
      const newSt = this.pages.get(targetPageId);
      if (newSt) {
        newSt.active = true;
        this.host.onActiveChanged(targetPageId, true);
      }
    }

    const reply: TextElement = {
      id: uid(),
      kind: 'text',
      pageId: targetPageId,
      notebookId: targetPage.notebookId,
      x: MARGIN,
      y,
      w: width,
      h: boxH,
      rotation: 0,
      text,
      color: isError ? ERROR_COLOR : AI_COLOR,
      bg: isError ? ERROR_BG : AI_BG,
      fontSize: FONT_SIZE,
      createdAt: Date.now(),
    };
    store.addItems([reply]);
    this.host.pushOp({ kind: 'add-items', pageId: targetPageId, items: [reply] });
    this.host.refreshPage(targetPageId);

    const targetSt = this.pages.get(targetPageId);
    if (targetSt) targetSt.turnTop = y + boxH + MARGIN;
    this.applyVisual(targetPageId);
  }
}
