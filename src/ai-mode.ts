/**
 * AI mode: turns a page into a live handwritten conversation with Gemini.
 *
 * Deliberately decoupled from `PageCanvas` — it never touches pointer/canvas
 * internals. It listens to the same `Op` stream `NotebookView` already uses
 * for undo/redo (an `add-stroke` op is "new ink") and reads page content
 * through `store` (which works whether or not the page is currently
 * mounted). Capture/send is per-page (the region below the last turn on
 * *that* page); the reply, though, is notebook-wide: it renders in a single
 * slide-out chat panel (`mountPanel`/`renderConversation`) rather than as
 * page content, so the conversation reads the same regardless of which page
 * you're looking at or scroll to.
 */
import { el } from './ui/dom';
import { icon } from './ui/icon';
import { confirmDialog } from './ui/dialog';
import { renderPageRegionImage } from './export/raster';
import { itemBounds, unionRects } from './canvas/geom';
import { PAGE_H } from './const';
import { store } from './store';
import { clearAiEntries, getAiEntries, putAiEntry } from './db';
import { renderAiReply } from './ai-render';
import type { Op } from './canvas/page-canvas';
import type { AiConversationEntry, Page } from './types';
import { uid } from './util';

/** The one AI accent colour — the page border and in-progress ink both use
 * exactly this, so "AI mode" reads as one consistent identity. */
export const AI_COLOR = '#6d28d9';

/** Where the built-in Gemini endpoint lives. Same-origin `/api/gemini` by
 * default (set if the static site itself is ever served from the Vercel
 * project); override with an absolute URL via `VITE_GEMINI_ENDPOINT` when the
 * site is hosted elsewhere (e.g. GitHub Pages) and the function is not. */
const GEMINI_ENDPOINT = import.meta.env.VITE_GEMINI_ENDPOINT?.trim() || '/api/gemini';
const PROXY_SECRET = import.meta.env.VITE_GEMINI_PROXY_SECRET ?? '';

/** One turn's worth of conversation, shown in the panel. The persisted shape
 * (`AiConversationEntry`) plus a transient in-memory-only flag — an entry is
 * never written to IndexedDB while still pending; only once resolved. */
interface ConversationEntry extends AiConversationEntry {
  pending: boolean;
}

interface AiPageState {
  pageEl: HTMLElement;
  statusEl: HTMLElement;
  active: boolean;
  sending: boolean;
  /** page-units Y: top of the region the next turn will be read from. */
  turnTop: number;
  /** ids of strokes drawn while AI mode was active on this page — ephemeral:
   * never undoable, removed once their turn is sent (or discarded if AI mode
   * is turned off before that happens). Never holds a stroke the user drew
   * with AI mode off. */
  inkIds: Set<string>;
}

/** What `AiMode` needs from `NotebookView`, injected rather than imported to avoid a cycle. */
export interface AiModeHost {
  /** Repaints a page's canvas from the store, if it's currently mounted. */
  refreshPage(pageId: string): void;
  /** A page's active flag changed — lets the app-bar toggle/send buttons refresh if it's the current page. */
  onActiveChanged(pageId: string, active: boolean): void;
}

export class AiMode {
  private readonly pages = new Map<string, AiPageState>();
  private conversation: ConversationEntry[] = [];
  private panelEl: HTMLElement | null = null;
  private panelBody: HTMLElement | null = null;
  private panelOpen = false;
  /** the notebook chrome root (`.nb`) — gets `.ai-panel-open` toggled on it so
   * the scroll area can shift out from under the panel; see setPanelOpen. */
  private hostEl: HTMLElement | null = null;

  constructor(
    private readonly notebookId: string,
    private readonly host: AiModeHost
  ) {}

  /** Loads this notebook's persisted chat history, then repaints the panel if it's already mounted. */
  async loadConversation(): Promise<void> {
    const rows = await getAiEntries(this.notebookId);
    this.conversation = rows.map((r) => ({ ...r, pending: false }));
    this.renderConversation();
  }

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
      inkIds: new Set(),
    });
  }

  /** Builds the slide-out chat panel once and appends it to `container`. */
  mountPanel(container: HTMLElement): void {
    const panel = el('div', { class: 'ai-panel' });
    const header = el('div', { class: 'ai-panel__header' });
    header.append(el('span', { class: 'ai-panel__title', text: 'DubNotes AI' }));

    const actions = el('div', { class: 'ai-panel__header-actions' });
    const clearBtn = el('button', { class: 'iconbtn', title: 'Clear conversation', 'aria-label': 'Clear conversation' });
    clearBtn.append(icon('delete'));
    clearBtn.addEventListener('click', () => void this.clearConversation());
    const closeBtn = el('button', { class: 'iconbtn', title: 'Close', 'aria-label': 'Close AI panel' });
    closeBtn.append(icon('close'));
    closeBtn.addEventListener('click', () => this.setPanelOpen(false));
    actions.append(clearBtn, closeBtn);
    header.append(actions);

    const body = el('div', { class: 'ai-panel__body' });

    panel.append(header, body);
    container.append(panel);
    this.panelEl = panel;
    this.panelBody = body;
    this.hostEl = container;
    this.renderConversation();
  }

  /** Confirms, then permanently deletes this notebook's whole chat history. */
  private async clearConversation(): Promise<void> {
    if (!this.conversation.length) return;
    const ok = await confirmDialog({
      title: 'Clear conversation?',
      message: 'Deletes this notebook’s AI chat history. The pages themselves are not affected. This can’t be undone.',
      confirmText: 'Clear',
      danger: true,
    });
    if (!ok) return;
    this.conversation = [];
    await clearAiEntries(this.notebookId);
    this.renderConversation();
  }

  /** Removes the panel from the DOM (called when the notebook view is torn down). */
  destroyPanel(): void {
    this.panelEl?.remove();
    this.hostEl?.classList.remove('ai-panel-open');
    this.panelEl = null;
    this.panelBody = null;
    this.hostEl = null;
  }

  private openPanel(): void {
    this.setPanelOpen(true);
  }

  /**
   * `.ai-panel-open` on the chrome root shifts `.nb-scroll` right by the
   * panel's width (see styles.css) while it's open. Without this the panel —
   * `position: fixed`, full height, `z-index` above everything — visually and
   * interactively covers whatever's underneath at its own width from the left
   * edge: the drawable canvas for any page in view, once the panel auto-opens
   * on the first sent turn. A second stroke drawn there never reaches
   * `PageCanvas` (it hits the panel instead), so nothing arms the next turn
   * and "Send" finds nothing to send — this looked like a broken button, but
   * no stroke was ever actually created for it to send.
   */
  private setPanelOpen(open: boolean): void {
    this.panelOpen = open;
    this.panelEl?.classList.toggle('ai-panel--open', open);
    this.hostEl?.classList.toggle('ai-panel-open', open);
  }

  /** Whether AI mode is on for this page — the app-bar toggle button reflects this for the current page. */
  isActive(pageId: string): boolean {
    return this.pages.get(pageId)?.active ?? false;
  }

  /** Feed every committed page op through here. */
  handleOp(op: Op): void {
    const st = this.pages.get(op.pageId);
    if (!st || !st.active) return;
    if (op.kind === 'add-stroke') {
      // any stroke drawn while AI mode is active is ephemeral ink, regardless
      // of where on the page it lands — see PageCanvas's isAiActive hook, which
      // is what actually painted it violet instead of the user's pen colour.
      // Just tracked here; submission only ever happens via an explicit Send tap.
      st.inkIds.add(op.stroke.id);
    } else if (op.kind === 'add-items' && op.aiInk) {
      // a freehand stroke that got snap-recognized into a line: still the
      // same violet turn ink, just committed as a shape item instead of a
      // stroke — track it the same way so it's discarded the same way too.
      for (const it of op.items) st.inkIds.add(it.id);
    }
  }

  /**
   * Toggles AI mode for one page — called by the single app-bar button, for
   * whichever page is current. The panel follows: turning off dismisses it
   * (same as its own ×, history untouched), turning on reopens it.
   */
  toggle(pageId: string): void {
    const st = this.pages.get(pageId);
    if (!st) return;
    st.active = !st.active;
    if (st.active) {
      st.turnTop = 0; // first turn: the whole page so far
    } else {
      this.discardInk(pageId, st); // turned off with unsent violet ink still on the page: drop it
    }
    this.setPanelOpen(st.active);
    this.applyVisual(pageId);
    this.host.onActiveChanged(pageId, st.active);
  }

  /** True while a page is being torn down for good (not just scrolled out of view). */
  forgetPage(pageId: string): void {
    this.pages.delete(pageId);
  }

  /** Submits the current turn immediately — the only way a turn is ever sent, called by the app-bar send button, for whichever page is current. */
  sendNow(pageId: string): void {
    const st = this.pages.get(pageId);
    if (!st || !st.active || st.sending) return;
    void this.submitTurn(pageId);
  }

  /** Removes whatever ephemeral ink is still tracked (unsent) and repaints if any was. */
  private discardInk(pageId: string, st: AiPageState): void {
    if (!st.inkIds.size) return;
    const removed = store.removeItems(pageId, st.inkIds);
    st.inkIds.clear();
    if (removed.length) this.host.refreshPage(pageId);
  }

  private applyVisual(pageId: string): void {
    const st = this.pages.get(pageId);
    if (!st) return;
    st.pageEl.classList.toggle('page--ai-active', st.active);
    st.statusEl.classList.toggle('ai-status--busy', st.sending);
    st.statusEl.textContent = st.sending ? 'DubNotes AI is thinking…' : st.active ? 'AI mode' : '';
  }

  private async submitTurn(pageId: string): Promise<void> {
    const st = this.pages.get(pageId);
    if (!st || !st.active || st.sending) return;

    const page = store.pageById(pageId);
    if (!page) return;

    const top = st.turnTop;
    const items = store.itemsOf(pageId).filter((it) => itemBounds(it).y + itemBounds(it).h > top + 0.01);
    if (!items.length) return; // Send tapped but there's nothing new below the line (e.g. it was erased)

    const bounds = unionRects(items.map(itemBounds))!;
    const bottom = Math.min(Math.max(bounds.y + bounds.h + 12, top + 1), PAGE_H);

    st.sending = true;
    this.applyVisual(pageId);

    // a placeholder entry shows immediately — opening the panel is how a
    // sent turn becomes visible at all now that nothing lands on the page.
    const entry: ConversationEntry = {
      id: uid(),
      notebookId: this.notebookId,
      pageId,
      thumbnail: '',
      text: '',
      isError: false,
      createdAt: Date.now(),
      pending: true,
    };
    this.conversation.push(entry);
    this.openPanel();
    this.renderConversation();

    let text: string;
    let isError = false;
    let thumbnail = '';
    try {
      const rendered = await renderPageRegionImage(page, { top, bottom });
      thumbnail = `data:${rendered.mimeType};base64,${rendered.base64}`;

      // the image is captured — this ink's job is done. Discard whatever was
      // part of this turn (only items we ourselves marked ephemeral; never
      // touches pre-existing permanent content) so it never persists,
      // regardless of what the request below does. Freehand ink lands as
      // 'add-stroke' ops, but a stroke that got snap-recognized into a line
      // commits as a 'shape' item instead (see PageCanvas.commitLine) — both
      // end up tracked in inkIds the same way, so both are removed here.
      const sentIds = new Set(items.map((it) => it.id).filter((id) => st.inkIds.has(id)));
      if (sentIds.size) {
        store.removeItems(pageId, sentIds);
        for (const id of sentIds) st.inkIds.delete(id);
        this.host.refreshPage(pageId);
      }

      const res = await fetch(GEMINI_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-NoteApp-Secret': PROXY_SECRET },
        body: JSON.stringify({ image: rendered.base64, mimeType: rendered.mimeType }),
      });
      const data: { text?: unknown; error?: unknown } | null = await res.json().catch(() => null);
      if (res.ok && typeof data?.text === 'string' && data.text) {
        text = data.text;
      } else {
        const reason = typeof data?.error === 'string' ? data.error : `request failed (${res.status})`;
        text = `DubNotes AI error: ${reason}`;
        isError = true;
      }
    } catch (err) {
      text = `DubNotes AI error: could not reach the endpoint (${err instanceof Error ? err.message : 'network error'}).`;
      isError = true;
    }

    st.sending = false;
    st.turnTop = bottom; // next turn starts below whatever was just captured, same as before
    this.applyVisual(pageId);

    entry.pending = false;
    entry.text = text;
    entry.isError = isError;
    entry.thumbnail = thumbnail;
    this.renderConversation();
    // written once, resolved — never while pending (see ConversationEntry's doc
    // comment); `pending` itself is transient UI state, left out of storage.
    const { pending: _pending, ...persisted } = entry;
    void putAiEntry(persisted);
  }

  private renderConversation(): void {
    const body = this.panelBody;
    if (!body) return;
    body.replaceChildren();
    for (const entry of this.conversation) {
      const row = el('div', { class: 'ai-panel__entry' });
      // live lookup, not a stored snapshot — stays right if pages are reordered
      // later; falls back gracefully if the page itself was since deleted.
      const page = store.pageById(entry.pageId);
      row.append(el('span', { class: 'ai-panel__page', text: page ? `Page ${page.index + 1}` : 'Page removed' }));
      if (entry.thumbnail) {
        row.append(el('img', { class: 'ai-panel__thumb', src: entry.thumbnail, alt: 'Captured handwriting' }));
      }
      const cls =
        'ai-panel__reply' + (entry.isError ? ' ai-panel__reply--error' : '') + (entry.pending ? ' ai-panel__reply--pending' : '');
      const replyEl = el('div', { class: cls });
      if (entry.pending) replyEl.textContent = 'DubNotes AI is thinking…';
      else if (entry.isError) replyEl.textContent = entry.text; // an app-generated message, not Gemini markdown/LaTeX
      else renderAiReply(replyEl, entry.text);
      row.append(replyEl);
      body.append(row);
    }
    body.scrollTop = body.scrollHeight;
  }
}
