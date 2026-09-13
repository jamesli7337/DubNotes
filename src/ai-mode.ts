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
import { icon } from './ui/icon';
import { el } from './ui/dom';
import { renderPageRegionImage } from './export/raster';
import { layoutText } from './canvas/elements';
import { itemBounds, unionRects } from './canvas/geom';
import { PAGE_H, PAGE_W } from './const';
import { store } from './store';
import type { Op } from './canvas/page-canvas';
import type { Page, TextElement } from './types';
import { uid } from './util';

/** How long a page must sit idle after new ink before a turn auto-submits. */
const IDLE_MS = 2000;
/** Vertical gap (page units) kept between the user's ink, a reply, and the next turn. */
const MARGIN = 24;
/** Reply text box: left/right inset from the page edges, and font size. */
const FONT_SIZE = 18;
const AI_COLOR = '#6d28d9';
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
  toggleBtn: HTMLButtonElement;
  sendBtn: HTMLButtonElement;
  statusEl: HTMLElement;
  active: boolean;
  sending: boolean;
  /** page-units Y: top of the region the next turn will be read from. */
  turnTop: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

/** What `AiMode` needs from `NotebookView`, injected rather than imported to avoid a cycle. */
export interface AiModeHost {
  /** Same undo/redo tracking every other page edit goes through. */
  pushOp(op: Op): void;
  /** Rebuilds the page list from the store (after inserting a continuation page). */
  syncPages(): void;
  /** Repaints a page's canvas from the store, if it's currently mounted. */
  refreshPage(pageId: string): void;
}

export class AiMode {
  private readonly pages = new Map<string, AiPageState>();

  constructor(private readonly host: AiModeHost) {}

  /** Called once per page, when its `.page-head`/`.page` DOM is first built. */
  attachPage(page: Page, headActions: HTMLElement, pageEl: HTMLElement): void {
    const pageId = page.id;

    const toggleBtn = el('button', {
      class: 'link ai-toggle',
      title: 'AI Assistant — read this page and reply with Gemini',
      'aria-label': 'AI Assistant',
      'aria-pressed': 'false',
    }) as HTMLButtonElement;
    toggleBtn.append(icon('ai', 'sm'));
    toggleBtn.addEventListener('click', () => this.toggle(pageId));

    const sendBtn = el('button', {
      class: 'link ai-send',
      title: 'Send this turn to Gemini now',
      'aria-label': 'Send this turn to Gemini now',
      hidden: true,
    }) as HTMLButtonElement;
    sendBtn.append(icon('send', 'sm'));
    sendBtn.addEventListener('click', () => this.sendNow(pageId));

    const statusEl = el('span', { class: 'ai-status' });

    headActions.append(statusEl, sendBtn, toggleBtn);

    this.pages.set(pageId, {
      pageEl,
      toggleBtn,
      sendBtn,
      statusEl,
      active: false,
      sending: false,
      turnTop: 0,
      idleTimer: null,
    });
  }

  /** Feed every committed page op through here — only `add-stroke` on an active page matters. */
  handleOp(op: Op): void {
    if (op.kind !== 'add-stroke') return;
    const st = this.pages.get(op.pageId);
    if (!st || !st.active || st.sending) return;
    const b = itemBounds(op.stroke);
    if (b.y + b.h < st.turnTop) return; // entirely above the active region: not this turn's ink
    this.armTimer(op.pageId, st);
  }

  /** True while a page is being torn down for good (not just scrolled out of view). */
  forgetPage(pageId: string): void {
    const st = this.pages.get(pageId);
    if (st?.idleTimer != null) clearTimeout(st.idleTimer);
    this.pages.delete(pageId);
  }

  private toggle(pageId: string): void {
    const st = this.pages.get(pageId);
    if (!st) return;
    st.active = !st.active;
    if (st.active) {
      st.turnTop = 0; // first turn: the whole page so far
    } else if (st.idleTimer != null) {
      clearTimeout(st.idleTimer);
      st.idleTimer = null;
    }
    this.applyVisual(pageId);
  }

  private sendNow(pageId: string): void {
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

  private applyVisual(pageId: string): void {
    const st = this.pages.get(pageId);
    if (!st) return;
    st.pageEl.classList.toggle('page--ai-active', st.active);
    st.toggleBtn.classList.toggle('active', st.active);
    st.toggleBtn.setAttribute('aria-pressed', String(st.active));
    st.sendBtn.hidden = !st.active;
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
        this.applyVisual(pageId);
      }
      const newSt = this.pages.get(targetPageId);
      if (newSt) newSt.active = true;
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
