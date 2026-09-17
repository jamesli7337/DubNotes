/**
 * AI mode: turns the notebook into a live handwritten conversation with
 * Gemini. One global on/off switch for the whole notebook (not per page) —
 * turning it on applies to wherever you currently are, and drawing on *any*
 * page while it's on inks in the AI accent colour there; turning it off
 * (the app-bar toggle, or the panel's own ×) ends it everywhere at once,
 * discarding any unsent ink on every page, not just whichever one is current.
 *
 * Deliberately decoupled from `PageCanvas` — it never touches pointer/canvas
 * internals. It listens to the same `Op` stream `NotebookView` already uses
 * for undo/redo (an `add-stroke` op is "new ink") and reads page content
 * through `store` (which works whether or not the page is currently
 * mounted). Send captures *two* images: the violet ink alone (cropped to
 * just those strokes, via `renderItemsImage`) as the actual question, and
 * the whole current page (via `renderPageRegionImage`) as background
 * context — sent to api/gemini.ts as two structurally distinct request
 * fields, not pixels mixed into one picture, so Gemini is never asked to
 * itself pick the question out of a mixed photo. The reply, though, is notebook-wide: it
 * renders in a single slide-out chat panel (`mountPanel`/`renderConversation`)
 * rather than as page content, so the conversation reads the same regardless
 * of which page you're looking at or scroll to.
 *
 * Holding on a reply in that panel branches a separate, full-screen thread
 * scoped to it (`ai-thread.ts`) — typed or handwritten (transcribed to text
 * first) follow-ups, one level deep, stored as ordinary `aiConversations`
 * rows tagged with `branchedFromEntryId` rather than a whole parallel data
 * structure. See `bindHold`/`openThreadFor`/`threadRoots` below. This module
 * imports `openAiThread` from `ai-thread.ts`, so nothing shared between the
 * two (`callGemini`, `AI_COLOR`) is *also* imported the other way — both
 * live in their own dependency-free modules (`gemini-client.ts`, `const.ts`)
 * instead, the same "injected/relocated rather than imported" avoidance
 * `AiModeHost` already uses for its own would-be cycle with notebook.ts.
 */
import { el } from './ui/dom';
import { icon } from './ui/icon';
import { confirmDialog } from './ui/dialog';
import { renderItemsImage, renderPageRegionImage } from './export/raster';
import { store } from './store';
import { clearAiEntries, getAiEntries, putAiEntry } from './db';
import { renderAiReply } from './ai-render';
import { openAiThread } from './ai-thread';
import { callGemini } from './gemini-client';
import { AI_COLOR } from './const';
import type { Op } from './canvas/page-canvas';
import type { AiConversationEntry, Page } from './types';
import { uid } from './util';

// re-exported so page-canvas.ts's existing `import { AI_COLOR } from '../ai-mode'`
// keeps working — the value itself now lives in const.ts (a dependency-free
// module) so ai-thread.ts can use it without importing this file at all; see
// this module's own doc comment on avoiding a cycle with ai-thread.ts.
export { AI_COLOR };

/** How long a still press on a reply takes to open a branched thread from it — long enough that a scroll/swipe (which moves) never fires it, short enough to feel deliberate rather than sluggish. */
const THREAD_HOLD_MS = 550;
/** Pointer movement past this (px) while holding cancels it — the same "was this actually a hold, or a drag that started here" check as the canvas's own TAP_SLOP-style gestures, just local to the panel since nothing else here needs it. */
const HOLD_SLOP = 10;

/** One turn's worth of conversation, shown in the panel. The persisted shape
 * (`AiConversationEntry`) plus a transient in-memory-only flag — an entry is
 * never written to IndexedDB while still pending; only once resolved. */
interface ConversationEntry extends AiConversationEntry {
  pending: boolean;
}

interface AiPageState {
  pageEl: HTMLElement;
  statusEl: HTMLElement;
  /** ids of strokes drawn on this page while AI mode was globally active —
   * ephemeral: removed once sent (or discarded if AI mode is turned off
   * before that happens). Never holds a stroke the user drew with AI mode
   * off. Also what `sendNow` checks to know this page has a question to ask —
   * position on the page is irrelevant now that a turn always captures the
   * whole page, not a region below some remembered line. */
  inkIds: Set<string>;
  /** This turn's own undo/redo history — only ever holds the 'add-stroke'/
   * 'add-items' ops that created this page's pending ink (see handleOp),
   * entirely separate from NotebookView's main undo stack (which never sees
   * AI ink at all). Cleared whenever the ink itself is cleared: on
   * deactivation (discardInk) and once sent (submitTurn). */
  aiUndo: Op[];
  aiRedo: Op[];
}

/** What `AiMode` needs from `NotebookView`, injected rather than imported to avoid a cycle. */
export interface AiModeHost {
  /** Repaints a page's canvas from the store, if it's currently mounted. */
  refreshPage(pageId: string): void;
  /** AI mode's global on/off state changed — lets the app-bar toggle/send buttons refresh. */
  onActiveChanged(active: boolean): void;
  /** This page's AI-scoped undo/redo stacks changed — lets the app-bar undo/redo buttons refresh (enabled state) if it's the current page. */
  onAiHistoryChanged(pageId: string): void;
}

export class AiMode {
  /** The one global on/off switch — see the module doc comment. */
  private active = false;
  /** True while a turn is in flight; blocks starting another until it resolves, on any page. */
  private sending = false;
  /** Which page a send in flight is for, so only that page's status shows "thinking". */
  private sendingPageId: string | null = null;
  private readonly pages = new Map<string, AiPageState>();
  private conversation: ConversationEntry[] = [];
  /** ids of main-conversation entries that already have a branched thread — drives the "reopen thread" badge in renderConversation (see AiConversationEntry.branchedFromEntryId). */
  private threadRoots = new Set<string>();
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

  /** Loads this notebook's persisted chat history, then repaints the panel if it's already mounted. `getAiEntries` returns main-conversation and thread entries mixed (they share the same notebookId index) — split here on `branchedFromEntryId` rather than adding a second db query. */
  async loadConversation(): Promise<void> {
    const rows = await getAiEntries(this.notebookId);
    this.conversation = rows.filter((r) => !r.branchedFromEntryId).map((r) => ({ ...r, pending: false }));
    this.threadRoots = new Set(rows.filter((r) => r.branchedFromEntryId).map((r) => r.branchedFromEntryId!));
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
      inkIds: new Set(),
      aiUndo: [],
      aiRedo: [],
    });
    this.applyVisual(pageId); // a page can mount while AI mode is already on (e.g. scrolling to a new one)
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
    closeBtn.addEventListener('click', () => this.closeAll());
    actions.append(clearBtn, closeBtn);
    header.append(actions);

    const body = el('div', { class: 'ai-panel__body' });
    this.bindSwipeThrough(body);

    panel.append(header, body);
    container.append(panel);
    this.panelEl = panel;
    this.panelBody = body;
    this.hostEl = container;
    this.renderConversation();
  }

  /**
   * Lets a vertical drag on the (short, common-case) chat body still switch
   * notebook pages instead of doing nothing. `.ai-panel` is `position: fixed`
   * and sits to the left of `.nb-scroll` (a sibling, not an ancestor) — a
   * touch never falls through one element to whatever's visually behind it,
   * so once the panel is open, its own screen-width strip (up to 340px/88vw)
   * silently swallows any swipe that starts there: `.ai-panel__body` has
   * `overflow-y: auto`, and with a short conversation there's nothing in it
   * to actually scroll, so the touch just does nothing at all — on a narrow
   * screen that's a large fraction of the width dead to "swipe to switch
   * pages". Only kicks in when the body has no scrollable content of its own
   * (checked fresh at touchstart): a long conversation still scrolls exactly
   * as before, untouched, and can still reach the page-switch gesture via the
   * visible page area to the right of the panel, same as always.
   *
   * preventDefault() on `touchstart` (not just `touchmove`) is what actually
   * secures the gesture before the browser's own native-pan recognizer can
   * claim it — the same non-passive-listener technique page-canvas.ts's
   * blockNativeGesture uses for the analogous "own this touch before iOS
   * does" problem.
   */
  private bindSwipeThrough(body: HTMLElement): void {
    let dragging = false;
    let startY = 0;
    let startScrollTop = 0;

    const scroller = (): HTMLElement | null => this.hostEl?.querySelector<HTMLElement>('.nb-scroll') ?? null;
    const hasOwnScroll = (): boolean => body.scrollHeight > body.clientHeight + 1;

    body.addEventListener(
      'touchstart',
      (e) => {
        const s = scroller();
        if (hasOwnScroll() || e.touches.length !== 1 || !s) {
          dragging = false;
          return;
        }
        dragging = true;
        startY = e.touches[0].clientY;
        startScrollTop = s.scrollTop;
        e.preventDefault();
      },
      { passive: false }
    );
    body.addEventListener(
      'touchmove',
      (e) => {
        if (!dragging) return;
        const s = scroller();
        if (!s) return;
        s.scrollTop = startScrollTop - (e.touches[0].clientY - startY);
        e.preventDefault();
      },
      { passive: false }
    );
    const end = (): void => {
      dragging = false;
    };
    body.addEventListener('touchend', end);
    body.addEventListener('touchcancel', end);
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

  /** Whether AI mode is on — one global switch, the same answer regardless of which page you ask about. */
  isActive(): boolean {
    return this.active;
  }

  /** Feed every committed page op through here. */
  handleOp(op: Op): void {
    if (!this.active) return;
    // only these two kinds carry this turn's ink; everything else (including
    // a cross-page selection move, which has no single `pageId`) is a no-op
    // here — narrowed first so the `pageId` access below is well-typed.
    if (op.kind !== 'add-stroke' && op.kind !== 'add-items') return;
    if (op.kind === 'add-items' && !op.aiInk) return;
    const st = this.pages.get(op.pageId);
    if (!st) return;
    if (op.kind === 'add-stroke') {
      // any stroke drawn while AI mode is active is ephemeral ink, regardless
      // of where on the page it lands — see PageCanvas's isAiActive hook, which
      // is what actually painted it violet instead of the user's pen colour.
      // Just tracked here; submission only ever happens via an explicit Send tap.
      st.inkIds.add(op.stroke.id);
    } else {
      // a freehand stroke that got snap-recognized into a line: still the
      // same violet turn ink, just committed as a shape item instead of a
      // stroke — track it the same way so it's discarded the same way too.
      for (const it of op.items) st.inkIds.add(it.id);
    }
    // this turn's own undo history: a fresh piece of ink invalidates redo,
    // same convention as NotebookView's main stack (see pushOp).
    st.aiUndo.push(op);
    st.aiRedo.length = 0;
    this.host.onAiHistoryChanged(op.pageId);
  }

  /**
   * Toggles AI mode globally — called by the single app-bar button. The
   * panel follows: turning off dismisses it, turning on reopens it. (The
   * panel's own × goes through the same deactivation path — see closeAll.)
   */
  toggle(): void {
    if (this.active) {
      this.deactivateAll();
    } else {
      this.active = true;
      for (const pageId of this.pages.keys()) this.applyVisual(pageId);
      this.host.onActiveChanged(true);
    }
    this.setPanelOpen(this.active);
  }

  /**
   * Ends AI mode everywhere: every page's unsent violet ink is discarded, not
   * just whichever one is "current" — this is a single global mode, so there
   * is no such thing as "still on" for some other page once it's off. Used
   * both by the app-bar toggle (turning off) and the panel's own × (which
   * used to just hide the panel while leaving the session running underneath
   * — indistinguishable from AI mode staying on).
   */
  private deactivateAll(): void {
    this.active = false;
    for (const [pageId, st] of this.pages) {
      this.discardInk(pageId, st);
      this.applyVisual(pageId);
    }
    this.host.onActiveChanged(false);
  }

  /** The panel's own close button: ends the session (if any) and hides the panel either way. */
  private closeAll(): void {
    if (this.active) this.deactivateAll();
    this.setPanelOpen(false);
  }

  /** True while a page is being torn down for good (not just scrolled out of view). */
  forgetPage(pageId: string): void {
    this.pages.delete(pageId);
  }

  /** Whether this page has any AI-mode ink left to undo — only meaningful while AI mode is active. */
  canUndo(pageId: string): boolean {
    return (this.pages.get(pageId)?.aiUndo.length ?? 0) > 0;
  }

  /** Whether this page has any undone AI-mode ink left to redo — only meaningful while AI mode is active. */
  canRedo(pageId: string): boolean {
    return (this.pages.get(pageId)?.aiRedo.length ?? 0) > 0;
  }

  /** Removes the most recently created piece of this turn's AI-mode ink. */
  undo(pageId: string): void {
    const st = this.pages.get(pageId);
    if (!st || !st.aiUndo.length) return;
    const op = st.aiUndo.pop()!;
    this.invertInk(pageId, st, op);
    st.aiRedo.push(op);
    this.host.onAiHistoryChanged(pageId);
  }

  /** Restores the most recently undone piece of this turn's AI-mode ink. */
  redo(pageId: string): void {
    const st = this.pages.get(pageId);
    if (!st || !st.aiRedo.length) return;
    const op = st.aiRedo.pop()!;
    this.forwardInk(pageId, st, op);
    st.aiUndo.push(op);
    this.host.onAiHistoryChanged(pageId);
  }

  /** Undoes one AI-ink creation op (only ever 'add-stroke' or 'add-items' — see handleOp). */
  private invertInk(pageId: string, st: AiPageState, op: Op): void {
    if (op.kind === 'add-stroke') {
      store.removeStrokes(pageId, new Set([op.stroke.id]));
      st.inkIds.delete(op.stroke.id);
    } else if (op.kind === 'add-items') {
      const ids = new Set(op.items.map((it) => it.id));
      store.removeItems(pageId, ids);
      for (const id of ids) st.inkIds.delete(id);
    }
    this.host.refreshPage(pageId);
  }

  /** Redoes one previously-undone AI-ink creation op, restoring the same ids. */
  private forwardInk(pageId: string, st: AiPageState, op: Op): void {
    if (op.kind === 'add-stroke') {
      store.addStroke({ ...op.stroke });
      st.inkIds.add(op.stroke.id);
    } else if (op.kind === 'add-items') {
      const items = op.items.map((it) => ({ ...it }));
      store.addItems(items);
      for (const it of items) st.inkIds.add(it.id);
    }
    this.host.refreshPage(pageId);
  }

  /** Submits the current page's pending turn immediately — the only way a turn is ever sent, called by the app-bar send button, for whichever page is current. */
  sendNow(pageId: string): void {
    if (!this.active || this.sending) return;
    const st = this.pages.get(pageId);
    if (!st || !st.inkIds.size) return; // nothing new drawn here to ask about
    void this.submitTurn(pageId);
  }

  /** Removes whatever ephemeral ink is still tracked (unsent) and repaints if any was; also clears this turn's own undo/redo history, since it referred only to ink that just went away. */
  private discardInk(pageId: string, st: AiPageState): void {
    st.aiUndo.length = 0;
    st.aiRedo.length = 0;
    if (!st.inkIds.size) return;
    const removed = store.removeItems(pageId, st.inkIds);
    st.inkIds.clear();
    if (removed.length) this.host.refreshPage(pageId);
  }

  private applyVisual(pageId: string): void {
    const st = this.pages.get(pageId);
    if (!st) return;
    const busy = this.sending && this.sendingPageId === pageId;
    st.pageEl.classList.toggle('page--ai-active', this.active);
    st.statusEl.classList.toggle('ai-status--busy', busy);
    st.statusEl.textContent = busy ? 'DubNotes AI is thinking…' : this.active ? 'AI mode' : '';
  }

  private async submitTurn(pageId: string): Promise<void> {
    const st = this.pages.get(pageId);
    if (!this.active || this.sending || !st || !st.inkIds.size) return;

    const page = store.pageById(pageId);
    if (!page) return;

    this.sending = true;
    this.sendingPageId = pageId;
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
      // Two separate captures, sent as two separate request fields (see
      // api/gemini.ts) — never merged into one image. `question` is just the
      // violet ink itself (cropped to it, on a blank canvas), so it's the
      // actual thing to answer; `context` is the whole page (every
      // pre-existing note plus the new ink, same as always — see the module
      // doc comment), there purely as background. Both captured before the
      // ink is removed below, since `question` needs it to still be on the
      // page to render.
      const question = await renderItemsImage(page, st.inkIds);
      const context = await renderPageRegionImage(page);
      thumbnail = `data:${context.mimeType};base64,${context.base64}`;

      // both images are captured — this ink's job is done. Discard it (only
      // items we ourselves marked ephemeral; never touches pre-existing
      // permanent content) so it never persists, regardless of what the
      // request below does.
      store.removeItems(pageId, st.inkIds);
      st.inkIds.clear();
      this.host.refreshPage(pageId);
      // this turn's own undo/redo history referred only to ink that's now
      // sent (and removed above) — matches discardInk's clearing on deactivation.
      if (st.aiUndo.length || st.aiRedo.length) {
        st.aiUndo.length = 0;
        st.aiRedo.length = 0;
        this.host.onAiHistoryChanged(pageId);
      }

      ({ text, isError } = await callGemini({
        kind: 'ask',
        question: { image: question.base64, mimeType: question.mimeType },
        context: { image: context.base64, mimeType: context.mimeType },
      }));
    } catch (err) {
      text = `DubNotes AI error: could not reach the endpoint (${err instanceof Error ? err.message : 'network error'}).`;
      isError = true;
    }

    this.sending = false;
    this.sendingPageId = null;
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
      // A pending entry has no persisted reply yet to branch from — hold/reopen
      // only ever apply once it's resolved (below), same as everywhere else
      // that treats a pending entry as "not really here yet".
      if (!entry.pending) {
        this.bindHold(replyEl, () => this.openThreadFor(entry));
        if (this.threadRoots.has(entry.id)) {
          const badge = el('button', { class: 'ai-panel__thread-badge', type: 'button', title: 'Open thread' });
          badge.textContent = 'Thread ›';
          badge.addEventListener('click', () => this.openThreadFor(entry));
          row.append(badge);
        }
      }
      body.append(row);
    }
    body.scrollTop = body.scrollHeight;
  }

  /**
   * Opens the full-screen thread branched from `entry` (creating it, if this
   * is the first hold on it — see ai-thread.ts's own doc comment for why
   * that's just "open the panel with zero entries yet", not a separate
   * step). `onChanged` fires once the thread gains its first entry, so the
   * "Thread ›" badge appears without waiting for the next full reload.
   */
  private openThreadFor(entry: ConversationEntry): void {
    openAiThread({
      notebookId: this.notebookId,
      rootEntry: entry,
      onChanged: () => {
        this.threadRoots.add(entry.id);
        this.renderConversation();
      },
    });
  }

  /**
   * A still `pointerdown` on `el` for THREAD_HOLD_MS runs `onHold` — used to
   * turn "hold on a reply" into "branch a thread from it" without touching
   * anything on `.page canvas` at all (this only ever binds to
   * `.ai-panel__reply` elements inside the DOM chat panel, a completely
   * separate surface from PageCanvas's own pointer state machine). Cancelled
   * by any movement past HOLD_SLOP (a scroll/swipe starting here, or the
   * panel's own bindSwipeThrough drag) or by lifting/leaving early — so a
   * plain tap keeps doing nothing, exactly as before this existed.
   */
  private bindHold(el: HTMLElement, onHold: () => void): void {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let startX = 0;
    let startY = 0;
    const cancel = (): void => {
      if (timer != null) clearTimeout(timer);
      timer = null;
      el.classList.remove('ai-panel__reply--holding');
    };
    el.addEventListener('pointerdown', (e) => {
      cancel();
      startX = e.clientX;
      startY = e.clientY;
      el.classList.add('ai-panel__reply--holding');
      timer = setTimeout(() => {
        timer = null;
        el.classList.remove('ai-panel__reply--holding');
        onHold();
      }, THREAD_HOLD_MS);
    });
    el.addEventListener('pointermove', (e) => {
      if (timer != null && Math.hypot(e.clientX - startX, e.clientY - startY) > HOLD_SLOP) cancel();
    });
    el.addEventListener('pointerup', cancel);
    el.addEventListener('pointerleave', cancel);
    el.addEventListener('pointercancel', cancel);
  }
}
