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
 * A notebook has any number of separate chats (`AiChat`), one active at a
 * time, picked in the panel. Each turn is sent with the active chat's earlier
 * turns as text-only history (each turn's transcript + answer, never its
 * images — see buildHistory and api/gemini.ts).
 */
import { el } from './ui/dom';
import { icon } from './ui/icon';
import { confirmDialog } from './ui/dialog';
import { renderItemsImage, renderPageRegionImage } from './export/raster';
import { store } from './store';
import { deleteAiChat, getAiChats, getAiEntries, putAiChat, putAiTurn } from './db';
import { renderAiReply } from './ai-render';
import { callGemini } from './gemini-client';
import type { Op } from './canvas/page-canvas';
import type { AiChat, AiConversationEntry, Page } from './types';
import { uid } from './util';

/** The one AI accent colour — the page border and in-progress ink both use
 * exactly this, so "AI mode" reads as one consistent identity. */
export const AI_COLOR = '#6d28d9';

/** Character budget for the history sent with a turn — newest turns kept,
 * oldest dropped first (api/gemini.ts enforces its own, slightly higher cap). */
const HISTORY_CHAR_BUDGET = 24_000;
/** Longest side of a stored question thumbnail, in CSS pixels. */
const THUMB_MAX = 320;
const TITLE_MAX = 40;
/** localStorage key prefix for each notebook's active chat id. */
const ACTIVE_CHAT_PREFIX = 'noteapp.aichat.';

function readActiveChat(notebookId: string): string | null {
  try {
    return localStorage.getItem(ACTIVE_CHAT_PREFIX + notebookId);
  } catch {
    return null;
  }
}

function writeActiveChat(notebookId: string, chatId: string | null): void {
  try {
    if (chatId) localStorage.setItem(ACTIVE_CHAT_PREFIX + notebookId, chatId);
    else localStorage.removeItem(ACTIVE_CHAT_PREFIX + notebookId);
  } catch {
    // storage unavailable — the chat just isn't remembered
  }
}

/** A chat's title from its first transcript: whitespace collapsed, truncated. */
function titleFrom(transcript: string): string {
  const t = transcript.replace(/\s+/g, ' ').trim();
  return t.length > TITLE_MAX ? t.slice(0, TITLE_MAX - 1).trimEnd() + '…' : t;
}

/**
 * Earlier turns as text-only history: each resolved, non-error turn with a
 * transcript becomes a user (transcript) + model (answer) pair. Pairs are
 * kept newest-first until HISTORY_CHAR_BUDGET runs out, so the oldest are
 * dropped first. Entries without a transcript (errors, pre-chat entries) are
 * skipped.
 */
function buildHistory(entries: AiConversationEntry[]): { role: 'user' | 'model'; text: string }[] {
  const out: { role: 'user' | 'model'; text: string }[] = [];
  let used = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const { transcript, text, isError } = entries[i];
    if (isError || !transcript?.trim() || !text.trim()) continue;
    used += transcript.length + text.length;
    if (used > HISTORY_CHAR_BUDGET) break;
    out.unshift({ role: 'user', text: transcript }, { role: 'model', text });
  }
  return out;
}

/** Downscales the question crop to a small JPEG data URL for the panel and storage. */
async function questionThumbnail(img: { base64: string; mimeType: string }): Promise<string> {
  const src = new Image();
  src.src = `data:${img.mimeType};base64,${img.base64}`;
  await src.decode();
  const k = Math.min(1, THUMB_MAX / Math.max(src.naturalWidth, src.naturalHeight, 1));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(src.naturalWidth * k));
  c.height = Math.max(1, Math.round(src.naturalHeight * k));
  const ctx = c.getContext('2d');
  if (!ctx) return '';
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.8);
}

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
  /** The chat panel opened or closed — the left island shifts with it, so anything laid out against the islands' edges needs re-checking. */
  onPanelToggled?(): void;
}

export class AiMode {
  /** The one global on/off switch — see the module doc comment. */
  private active = false;
  /** True while a turn is in flight; blocks starting another until it resolves, on any page. */
  private sending = false;
  /** Which page a send in flight is for, so only that page's status shows "thinking". */
  private sendingPageId: string | null = null;
  private readonly pages = new Map<string, AiPageState>();
  /** this notebook's chats, most recently updated first */
  private chats: AiChat[] = [];
  /** null = an unsaved "New chat" draft: nothing is persisted until its first Send creates it */
  private activeChatId: string | null = null;
  /** the active chat's persisted entries, oldest first */
  private conversation: ConversationEntry[] = [];
  /** turns not yet persisted — in flight, or resolved and being written. Each
   * is bound to its own chat at send, and shown only while that chat is active. */
  private readonly unsaved = new Set<ConversationEntry>();
  /** bumped per chat switch, so a slower earlier load can't overwrite a newer one */
  private loadToken = 0;
  /** a storage failure to show at the bottom of the panel ('' = none) */
  private panelError = '';
  private panelEl: HTMLElement | null = null;
  private panelBody: HTMLElement | null = null;
  private chatSelect: HTMLSelectElement | null = null;
  private deleteChatBtn: HTMLButtonElement | null = null;
  private panelOpen = false;
  /** the notebook chrome root (`.nb`) — gets `.ai-panel-open` toggled on it so
   * the scroll area can shift out from under the panel; see setPanelOpen. */
  private hostEl: HTMLElement | null = null;

  constructor(
    private readonly notebookId: string,
    private readonly host: AiModeHost
  ) {}

  /** Loads this notebook's chats and opens the remembered one (else the most recently updated), then repaints the panel if it's already mounted. */
  async loadConversation(): Promise<void> {
    this.chats = await getAiChats(this.notebookId);
    const saved = readActiveChat(this.notebookId);
    await this.setActiveChat(this.chats.some((c) => c.id === saved) ? saved : (this.chats[0]?.id ?? null));
  }

  /** Switches the panel to `chatId` (null = a new, unsaved draft) and loads its entries. */
  private async setActiveChat(chatId: string | null): Promise<void> {
    this.activeChatId = chatId;
    this.panelError = '';
    writeActiveChat(this.notebookId, chatId);
    const token = ++this.loadToken;
    this.conversation = [];
    this.renderChats();
    this.renderConversation();
    if (!chatId) return;
    const rows = await getAiEntries(chatId);
    if (token !== this.loadToken) return;
    this.conversation = rows.map((r) => ({ ...r, pending: false }));
    this.renderConversation();
  }

  /** The active chat's entries as shown: persisted ones plus its own unsaved turns, oldest first. */
  private visibleEntries(): ConversationEntry[] {
    const ids = new Set(this.conversation.map((e) => e.id));
    const extra = [...this.unsaved].filter((e) => e.chatId === this.activeChatId && !ids.has(e.id));
    return [...this.conversation, ...extra].sort((a, b) => a.createdAt - b.createdAt);
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
    const newBtn = el('button', { class: 'iconbtn', title: 'New chat', 'aria-label': 'New chat' });
    newBtn.append(icon('plus'));
    newBtn.addEventListener('click', () => {
      if (this.activeChatId !== null) void this.setActiveChat(null);
    });
    const deleteBtn = el('button', { class: 'iconbtn', title: 'Delete chat', 'aria-label': 'Delete chat' });
    deleteBtn.append(icon('delete'));
    deleteBtn.addEventListener('click', () => void this.deleteActiveChat());
    const closeBtn = el('button', { class: 'iconbtn', title: 'Close', 'aria-label': 'Close AI panel' });
    closeBtn.append(icon('close'));
    closeBtn.addEventListener('click', () => this.closeAll());
    actions.append(newBtn, deleteBtn, closeBtn);
    header.append(actions);

    const select = el('select', { class: 'ai-panel__chat-select', 'aria-label': 'Chat' });
    select.addEventListener('change', () => void this.setActiveChat(select.value || null));
    const chatBar = el('div', { class: 'ai-panel__chats' }, select);

    const body = el('div', { class: 'ai-panel__body' });
    this.bindSwipeThrough(body);

    panel.append(header, chatBar, body);
    container.append(panel);
    this.panelEl = panel;
    this.panelBody = body;
    this.chatSelect = select;
    this.deleteChatBtn = deleteBtn;
    this.hostEl = container;
    this.renderChats();
    this.renderConversation();
  }

  /** Rebuilds the chat switcher's options and the delete button's enabled state. */
  private renderChats(): void {
    const select = this.chatSelect;
    if (!select) return;
    select.replaceChildren();
    if (this.activeChatId === null) select.append(el('option', { value: '', text: 'New chat' }));
    for (const chat of this.chats) select.append(el('option', { value: chat.id, text: chat.title || 'New chat' }));
    select.value = this.activeChatId ?? '';
    if (this.deleteChatBtn) this.deleteChatBtn.disabled = this.activeChatId === null;
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

  /** Confirms, then permanently deletes the active chat and its entries; switches to the most recently updated remaining chat (or a new draft). */
  private async deleteActiveChat(): Promise<void> {
    const chatId = this.activeChatId;
    if (!chatId) return;
    const ok = await confirmDialog({
      title: 'Delete chat?',
      message: 'Deletes this AI chat. The pages themselves are not affected. This can’t be undone.',
      confirmText: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteAiChat(chatId);
    } catch (err) {
      console.error('AI chat delete failed:', err);
      this.panelError = 'Couldn’t delete this chat.';
      this.renderConversation();
      return;
    }
    this.chats = this.chats.filter((c) => c.id !== chatId);
    if (this.activeChatId === chatId) await this.setActiveChat(this.chats[0]?.id ?? null);
    else this.renderChats();
  }

  /** Removes the panel from the DOM (called when the notebook view is torn down). */
  destroyPanel(): void {
    this.panelEl?.remove();
    this.hostEl?.classList.remove('ai-panel-open');
    this.panelEl = null;
    this.panelBody = null;
    this.chatSelect = null;
    this.deleteChatBtn = null;
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
    this.host.onPanelToggled?.();
  }

  /** Whether AI mode is on — one global switch, the same answer regardless of which page you ask about. */
  isActive(): boolean {
    return this.active;
  }

  /** Feed every committed page op through here. */
  handleOp(op: Op): void {
    if (!this.active) return;
    // only these kinds carry this turn's ink; everything else (including a
    // cross-page selection move, which has no single `pageId`) is a no-op
    // here — narrowed first so the `pageId` access below is well-typed.
    // 'remove-items'/'edit' are the eraser's two shapes (whole and partial),
    // and while AI mode is on the eraser can only ever have reached this
    // turn's own ink — PageCanvas refuses to hit anything else (see its
    // `erasable`). So they belong on this stack for the same reason the
    // creations do: Undo in AI mode must put back what Undo in AI mode took.
    if (op.kind !== 'add-stroke' && op.kind !== 'add-items' && op.kind !== 'remove-items' && op.kind !== 'edit') return;
    if (op.kind === 'add-items' && !op.aiInk) return;
    const st = this.pages.get(op.pageId);
    if (!st) return;
    if (op.kind === 'remove-items') {
      for (const it of op.items) st.inkIds.delete(it.id);
    } else if (op.kind === 'edit') {
      // a partial erase: the rubbed stroke is gone and its surviving segments
      // are new items with new ids. They are still this turn's ink, so they
      // have to be tracked as such — otherwise they would outlive the turn
      // and strand permanent violet marks on the page.
      for (const it of op.removed) st.inkIds.delete(it.id);
      for (const it of op.added) st.inkIds.add(it.id);
    } else if (op.kind === 'add-stroke') {
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

  /**
   * Whether this item is part of the current turn's ephemeral violet ink on
   * this page — i.e. something AI mode put there and will take away again.
   *
   * This is what confines the eraser while AI mode is on (see PageCanvas's
   * `erasable`). AI mode is meant to be a surface where you ask a question
   * and the page itself is only context, so the eraser being enabled there
   * must mean "rub out what I just asked", never "edit the note underneath".
   */
  isAiInk(pageId: string, itemId: string): boolean {
    return this.pages.get(pageId)?.inkIds.has(itemId) ?? false;
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

  /** Undoes one AI-ink op — a creation ('add-stroke'/'add-items') or an erase of this turn's ink ('remove-items'/'edit'); see handleOp for why those are the only four. */
  private invertInk(pageId: string, st: AiPageState, op: Op): void {
    if (op.kind === 'add-stroke') {
      store.removeStrokes(pageId, new Set([op.stroke.id]));
      st.inkIds.delete(op.stroke.id);
    } else if (op.kind === 'add-items') {
      const ids = new Set(op.items.map((it) => it.id));
      store.removeItems(pageId, ids);
      for (const id of ids) st.inkIds.delete(id);
    } else if (op.kind === 'remove-items') {
      const items = op.items.map((it) => ({ ...it }));
      store.addItems(items);
      for (const it of items) st.inkIds.add(it.id);
    } else if (op.kind === 'edit') {
      store.removeItems(pageId, new Set(op.added.map((it) => it.id)));
      for (const it of op.added) st.inkIds.delete(it.id);
      const back = op.removed.map((it) => ({ ...it }));
      store.addItems(back);
      for (const it of back) st.inkIds.add(it.id);
    }
    this.host.refreshPage(pageId);
  }

  /** Redoes one previously-undone AI-ink op, restoring the same ids. */
  private forwardInk(pageId: string, st: AiPageState, op: Op): void {
    if (op.kind === 'add-stroke') {
      store.addStroke({ ...op.stroke });
      st.inkIds.add(op.stroke.id);
    } else if (op.kind === 'add-items') {
      const items = op.items.map((it) => ({ ...it }));
      store.addItems(items);
      for (const it of items) st.inkIds.add(it.id);
    } else if (op.kind === 'remove-items') {
      store.removeItems(pageId, new Set(op.items.map((it) => it.id)));
      for (const it of op.items) st.inkIds.delete(it.id);
    } else if (op.kind === 'edit') {
      store.removeItems(pageId, new Set(op.removed.map((it) => it.id)));
      for (const it of op.removed) st.inkIds.delete(it.id);
      const again = op.added.map((it) => ({ ...it }));
      store.addItems(again);
      for (const it of again) st.inkIds.add(it.id);
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
    this.panelError = '';

    // bind this turn to its chat now: a draft becomes a real chat on its first
    // Send. Written ahead of the turn (IndexedDB runs readwrite transactions
    // on the same store in order), so putAiTurn below finds it.
    let chatId = this.activeChatId;
    if (!chatId) {
      const now = Date.now();
      const chat: AiChat = { id: uid(), notebookId: this.notebookId, title: '', createdAt: now, updatedAt: now };
      chatId = chat.id;
      this.chats.unshift(chat);
      this.activeChatId = chatId;
      writeActiveChat(this.notebookId, chatId);
      this.renderChats();
      putAiChat(chat).catch((err) => {
        console.error('AI chat save failed:', err);
        this.showSaveError();
      });
    }
    // history is this chat as it stands before this turn joins it
    const history = buildHistory(this.visibleEntries().filter((e) => !e.pending));

    // a placeholder entry shows immediately — opening the panel is how a
    // sent turn becomes visible at all now that nothing lands on the page.
    const entry: ConversationEntry = {
      id: uid(),
      notebookId: this.notebookId,
      chatId,
      pageId,
      thumbnail: '',
      text: '',
      isError: false,
      createdAt: Date.now(),
      pending: true,
    };
    this.unsaved.add(entry);
    this.openPanel();
    this.renderConversation();

    let text: string;
    let transcript = '';
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
      thumbnail = await questionThumbnail(question).catch((err) => {
        console.error('AI thumbnail failed:', err);
        return '';
      });

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

      ({ text, transcript, isError } = await callGemini({
        question: { image: question.base64, mimeType: question.mimeType },
        context: { image: context.base64, mimeType: context.mimeType },
        history,
      }));
    } catch (err) {
      console.error('AI mode send failed:', err);
      text = "DubNotes AI error: Couldn't reach the AI, check your internet connection.";
      isError = true;
    }

    this.sending = false;
    this.sendingPageId = null;
    this.applyVisual(pageId);

    entry.pending = false;
    entry.text = text;
    entry.isError = isError;
    entry.thumbnail = thumbnail;
    if (!isError && transcript) entry.transcript = transcript;
    this.renderConversation();
    void this.persistTurn(entry);
  }

  /**
   * Writes a resolved turn to its own chat — skipped by putAiTurn if that chat
   * was deleted meanwhile. Joins the visible list only if its chat is still
   * the active one; otherwise it simply shows up when that chat is next opened.
   */
  private async persistTurn(entry: ConversationEntry): Promise<void> {
    // `pending` is transient UI state, left out of storage
    const { pending: _pending, ...persisted } = entry;
    let saved: AiChat | null = null;
    let failed = false;
    try {
      saved = await putAiTurn(persisted, entry.transcript ? titleFrom(entry.transcript) : '');
    } catch (err) {
      console.error('AI turn save failed:', err);
      failed = true;
    }
    // no chat to write into, though it was never deleted here: its own
    // creation failed (putAiChat), which is a failed save, not a discard
    if (!saved && this.chats.some((c) => c.id === entry.chatId)) failed = true;
    this.unsaved.delete(entry);
    if (saved) {
      const chat = saved;
      this.chats = [chat, ...this.chats.filter((c) => c.id !== chat.id)].sort((a, b) => b.updatedAt - a.updatedAt);
      this.renderChats();
    }
    // a failed write still keeps the reply on screen for this session (it
    // won't survive a reload — the error says so)
    if ((saved || failed) && entry.chatId === this.activeChatId && !this.conversation.some((e) => e.id === entry.id)) {
      this.conversation.push(entry);
    }
    if (failed) this.showSaveError();
    else this.renderConversation();
  }

  private showSaveError(): void {
    this.panelError = 'Couldn’t save this reply on this device — it won’t be here after a reload.';
    this.renderConversation();
  }

  private renderConversation(): void {
    const body = this.panelBody;
    if (!body) return;
    body.replaceChildren();
    for (const entry of this.visibleEntries()) {
      const row = el('div', { class: 'ai-panel__entry' });
      // live lookup, not a stored snapshot — stays right if pages are reordered
      // later; falls back gracefully if the page itself was since deleted.
      const page = store.pageById(entry.pageId);
      row.append(el('span', { class: 'ai-panel__page', text: page ? `Page ${page.index + 1}` : 'Page removed' }));
      if (entry.thumbnail) {
        row.append(el('img', { class: 'ai-panel__thumb', src: entry.thumbnail, alt: 'Your question' }));
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
    if (this.panelError) body.append(el('div', { class: 'ai-panel__reply ai-panel__reply--error', text: this.panelError }));
    body.scrollTop = body.scrollHeight;
  }
}
