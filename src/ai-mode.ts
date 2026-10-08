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
 * mounted). A turn is all the violet ink on every page since the last Send
 * (at most MAX_TURN_PAGES pages). For each of those pages Send captures *two*
 * images: the violet ink alone (cropped to just those strokes, via
 * `renderItemsImage`) as the question, and the whole page (via
 * `renderPageRegionImage`) as background context — sent to api/gemini.ts as
 * structurally distinct, labeled images, not pixels mixed into one picture,
 * so Gemini is never asked to itself pick the question out of a mixed photo. The reply, though, is notebook-wide: it
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
import { confirmDialog, textPrompt } from './ui/dialog';
import { renderItemsImage, renderPageRegionImage } from './export/raster';
import { store } from './store';
import { deleteAiChat, getAiChats, getAiEntries, putAiChat, putAiTurn, renameAiChat } from './db';
import { renderAiReply, renderChatTitle } from './ai-render';
import { callGemini } from './gemini-client';
import type { Op } from './canvas/page-canvas';
import type { AiChat, AiConversationEntry, Page } from './types';
import { uid } from './util';

/** The one AI accent colour — the page border and in-progress ink both use
 * exactly this, so "AI mode" reads as one consistent identity. */
export const AI_COLOR = '#6d28d9';

/** While AI mode is on, every page's own (non-AI) content is shown at this
 * opacity so the violet question ink stands out — display only; captures
 * and exports render from the store at full opacity. */
export const AI_FADE_OPACITY = 0.25;
/** How long the fade in/out takes on toggle. */
export const AI_FADE_MS = 150;

/** Character budget for the history sent with a turn — newest turns kept,
 * oldest dropped first (api/gemini.ts enforces its own, slightly higher cap). */
const HISTORY_CHAR_BUDGET = 24_000;
/** Widest a stored question thumbnail gets, in CSS pixels. */
const THUMB_MAX = 320;
/** Pixel area of a stored thumbnail — the budget a single crop had when its
 * longest side was capped at THUMB_MAX, now shared by a turn's stacked crops. */
const THUMB_AREA = THUMB_MAX * THUMB_MAX;
/** Space between two pages' crops in a stacked thumbnail, in source pixels. */
const THUMB_GAP = 12;
/** Most pages one turn may include — api/gemini.ts enforces the same cap. */
const MAX_TURN_PAGES = 6;
/** Largest request body Send will POST (Vercel rejects a function request body over 4.5 MB). */
const MAX_BODY_CHARS = 4_000_000;
/** JPEG quality of each page's whole-page context image (question crops stay PNG). */
const CONTEXT_JPEG_QUALITY = 0.9;
const TITLE_MAX = 40;
/** How far (px) a one-finger vertical swipe on the empty chat body has to travel to change page — see bindSwipeThrough. */
const SWIPE_PAGE_MIN_PX = 40;
/** An untitled chat's label in the picker: when it was started, e.g. "Oct 8, 2:37 PM". */
const CHAT_DATE_FORMAT = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
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

interface TurnImage {
  base64: string;
  mimeType: string;
}

/**
 * A turn's question crops (one per page, in page order) stacked vertically
 * into one small JPEG data URL for the panel and storage: at most THUMB_MAX
 * wide and THUMB_AREA in total, with a hairline between pages.
 */
async function questionThumbnail(imgs: TurnImage[]): Promise<string> {
  const srcs = await Promise.all(
    imgs.map(async (img) => {
      const src = new Image();
      src.src = `data:${img.mimeType};base64,${img.base64}`;
      await src.decode();
      return src;
    })
  );
  const w = Math.max(1, ...srcs.map((s) => s.naturalWidth));
  const h = Math.max(1, srcs.reduce((n, s) => n + s.naturalHeight, 0) + THUMB_GAP * (srcs.length - 1));
  const k = Math.min(1, THUMB_MAX / w, Math.sqrt(THUMB_AREA / (w * h)));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * k));
  c.height = Math.max(1, Math.round(h * k));
  const ctx = c.getContext('2d');
  if (!ctx) return '';
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, c.width, c.height);
  let y = 0;
  srcs.forEach((src, i) => {
    if (i) {
      ctx.fillStyle = '#d4d4d8';
      ctx.fillRect(0, Math.round((y - THUMB_GAP / 2) * k), c.width, 1);
    }
    ctx.drawImage(src, 0, y * k, src.naturalWidth * k, src.naturalHeight * k);
    y += src.naturalHeight + THUMB_GAP;
  });
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
}

/** Same cap as NotebookView's main undo history (see its pushOp). */
const MAX_AI_HISTORY = 200;

/** What `AiMode` needs from `NotebookView`, injected rather than imported to avoid a cycle. */
export interface AiModeHost {
  /** Repaints a page's canvas from the store, if it's currently mounted. */
  refreshPage(pageId: string): void;
  /** AI mode's global on/off state changed — lets the app-bar toggle/send buttons refresh. */
  onActiveChanged(active: boolean): void;
  /** AI mode's undo/redo history changed — lets the app-bar undo/redo buttons refresh their enabled state. */
  onAiHistoryChanged(): void;
  /** The chat panel opened or closed — the left island shifts with it, so anything laid out against the islands' edges needs re-checking. */
  onPanelToggled?(): void;
  /** Jumps one page forward (1) or back (-1) from the current one, the way the page manager jumps to a page — a no-op past either end. */
  goToAdjacentPage(delta: 1 | -1): void;
}

export class AiMode {
  /** The one global on/off switch — see the module doc comment. */
  private active = false;
  /** True while a turn is being captured or is in flight; blocks starting another until it resolves. */
  private sending = false;
  /** True only while a turn's pages are being rendered (the first part of `sending`); AI undo/redo are paused meanwhile — see canUndo/undo. */
  private capturing = false;
  /** The pages a turn in flight was sent from, so only their status shows "thinking". */
  private sendingPageIds = new Set<string>();
  private readonly pages = new Map<string, AiPageState>();
  /**
   * AI mode's own undo/redo history: one for the whole notebook, like
   * NotebookView's main one, holding every page's AI-ink ops (draw, erase,
   * partial erase, snapped line/shape — see handleOp) in the order they
   * happened. Entirely separate from the main history, which never sees AI
   * ink (and this never sees anything else). Cleared when AI mode turns off,
   * and per page once that page's ink is sent (submitTurn).
   */
  private readonly undoStack: Op[] = [];
  private readonly redoStack: Op[] = [];
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
  private chatPicker: HTMLButtonElement | null = null;
  private chatPickerLabel: HTMLElement | null = null;
  private chatMenu: HTMLElement | null = null;
  private chatMenuOpen = false;
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
    });
    this.applyVisual(pageId); // a page can mount while AI mode is already on (e.g. scrolling to a new one)
  }

  /** Builds the slide-out chat panel once and appends it to `container`. */
  mountPanel(container: HTMLElement): void {
    const panel = el('div', { class: 'ai-panel' });
    const header = el('div', { class: 'ai-panel__header' });
    header.append(el('span', { class: 'ai-panel__title', text: 'DubNotes AI' }));

    const actions = el('div', { class: 'ai-panel__header-actions' });
    const closeBtn = el('button', { class: 'iconbtn', title: 'Close', 'aria-label': 'Close AI panel' });
    closeBtn.append(icon('close'));
    closeBtn.addEventListener('click', () => this.closeAll());
    actions.append(closeBtn);
    header.append(actions);

    // chat picker: a button showing the active chat's title, opening a custom
    // menu right under it (new chat, every chat with its own delete)
    const pickerLabel = el('span', { class: 'ai-chatpick__label' });
    const picker = el(
      'button',
      { class: 'ai-chatpick', 'aria-label': 'Chat', 'aria-haspopup': 'listbox', 'aria-expanded': 'false' },
      pickerLabel,
      icon('chevron-down')
    );
    picker.addEventListener('click', () => this.setChatMenuOpen(!this.chatMenuOpen));
    const menu = el('div', { class: 'ai-chatmenu', role: 'listbox' });
    menu.hidden = true;
    const chatBar = el('div', { class: 'ai-panel__chats' }, picker, menu);

    const body = el('div', { class: 'ai-panel__body' });
    this.bindSwipeThrough(body);

    panel.append(header, chatBar, body);
    container.append(panel);
    this.panelEl = panel;
    this.panelBody = body;
    this.chatPicker = picker;
    this.chatPickerLabel = pickerLabel;
    this.chatMenu = menu;
    this.hostEl = container;
    this.renderChats();
    this.renderConversation();
  }

  /** Rebuilds the chat picker's label and its menu's rows. */
  private renderChats(): void {
    const menu = this.chatMenu;
    if (!menu || !this.chatPickerLabel) return;
    this.renderChatLabel(this.chatPickerLabel, this.chats.find((c) => c.id === this.activeChatId) ?? null);

    const newRow = el('button', { class: 'ai-chatmenu__new' }, icon('plus'), el('span', { text: 'New chat' }));
    newRow.addEventListener('click', () => {
      this.setChatMenuOpen(false);
      if (this.activeChatId !== null) void this.setActiveChat(null);
    });
    menu.replaceChildren(newRow);

    for (const chat of this.chats) {
      const isActive = chat.id === this.activeChatId;
      const pick = el(
        'button',
        { class: 'ai-chatmenu__pick', role: 'option', 'aria-selected': String(isActive) },
        icon('check', 'ai-chatmenu__check'),
        this.renderChatLabel(el('span', { class: 'ai-chatmenu__title' }), chat)
      );
      pick.addEventListener('click', () => {
        this.setChatMenuOpen(false);
        if (!isActive) void this.setActiveChat(chat.id);
      });
      const rename = el('button', { class: 'iconbtn ai-chatmenu__rename', title: 'Rename chat', 'aria-label': 'Rename chat' });
      rename.append(icon('rename'));
      rename.addEventListener('click', () => {
        this.setChatMenuOpen(false);
        void this.renameChat(chat.id);
      });
      const del = el('button', { class: 'iconbtn ai-chatmenu__delete', title: 'Delete chat', 'aria-label': 'Delete chat' });
      del.append(icon('delete'));
      del.addEventListener('click', () => {
        this.setChatMenuOpen(false);
        void this.deleteChat(chat.id);
      });
      menu.append(el('div', { class: 'ai-chatmenu__row' + (isActive ? ' ai-chatmenu__row--active' : '') }, pick, rename, del));
    }
  }

  /**
   * A chat's label, the same in the picker and every menu row (display only):
   * its title, with any $…$ math rendered (see renderChatTitle); or, untitled,
   * when it was started. "New chat" is only for a chat with no messages yet —
   * the unsaved draft (`null`); a saved chat always has at least one turn, as
   * it's created by its first Send.
   */
  private renderChatLabel(target: HTMLElement, chat: AiChat | null): HTMLElement {
    if (!chat) target.replaceChildren('New chat');
    else if (chat.title) renderChatTitle(target, chat.title);
    else target.replaceChildren(CHAT_DATE_FORMAT.format(chat.createdAt));
    return target;
  }

  /** Opens/closes the chat picker's menu; while open, a tap anywhere outside it (or the picker) closes it. */
  private setChatMenuOpen(open: boolean): void {
    if (!this.chatMenu || !this.chatPicker) return;
    this.chatMenuOpen = open;
    this.chatMenu.hidden = !open;
    this.chatPicker.setAttribute('aria-expanded', String(open));
    if (open) {
      this.chatMenu.scrollTop = 0;
      document.addEventListener('pointerdown', this.onChatMenuOutside, true);
    } else {
      document.removeEventListener('pointerdown', this.onChatMenuOutside, true);
    }
  }

  private readonly onChatMenuOutside = (e: PointerEvent): void => {
    const t = e.target as Node | null;
    if (t && (this.chatMenu?.contains(t) || this.chatPicker?.contains(t))) return;
    this.setChatMenuOpen(false);
  };

  /**
   * Lets a vertical swipe on the (short, common-case) chat body still switch
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
   *
   * The page change goes through the camera, as a jump to the next/previous
   * page on release (host.goToAdjacentPage, the page manager's jump) — never
   * through `.nb-scroll`'s scroll position. That element isn't a scroller any
   * more, but its overflowing camera layer still lets scrollTop take effect,
   * which slid the pages out from under the camera (scrollbar, mounted pages
   * and current page all going stale, and the offset never reset).
   */
  private bindSwipeThrough(body: HTMLElement): void {
    let dragging = false;
    let startY = 0;
    let lastY = 0;

    const hasOwnScroll = (): boolean => body.scrollHeight > body.clientHeight + 1;

    body.addEventListener(
      'touchstart',
      (e) => {
        if (hasOwnScroll() || e.touches.length !== 1) {
          dragging = false;
          return;
        }
        dragging = true;
        startY = lastY = e.touches[0].clientY;
        e.preventDefault();
      },
      { passive: false }
    );
    body.addEventListener(
      'touchmove',
      (e) => {
        if (!dragging) return;
        lastY = e.touches[0].clientY;
        e.preventDefault();
      },
      { passive: false }
    );
    body.addEventListener('touchend', () => {
      if (!dragging) return;
      dragging = false;
      const dy = lastY - startY;
      // swiping up moves on to the next page, as dragging a page up would
      if (Math.abs(dy) >= SWIPE_PAGE_MIN_PX) this.host.goToAdjacentPage(dy < 0 ? 1 : -1);
    });
    body.addEventListener('touchcancel', () => {
      dragging = false;
    });
  }

  /** Asks for a new title (prefilled with the current one; empty is rejected) and saves it as a manual title that no model title overwrites. */
  private async renameChat(chatId: string): Promise<void> {
    const current = this.chats.find((c) => c.id === chatId);
    if (!current) return;
    const input = await textPrompt({
      title: 'Rename chat',
      value: current.title,
      confirmText: 'Rename',
      dismissable: false,
    });
    const title = input?.replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX).trim();
    if (!title) return; // cancelled, or empty — rejected, the title is unchanged
    let saved: AiChat | null = null;
    try {
      saved = await renameAiChat(chatId, title);
    } catch (err) {
      console.error('AI chat rename failed:', err);
      this.panelError = 'Couldn’t rename this chat.';
      this.renderConversation();
      return;
    }
    if (!saved) return; // deleted meanwhile
    const renamed = saved;
    this.chats = this.chats.map((c) => (c.id === chatId ? renamed : c));
    this.renderChats();
  }

  /** Confirms, then permanently deletes `chatId` and its entries; if it was the active chat, switches to the most recently updated remaining chat (or a new draft). */
  private async deleteChat(chatId: string): Promise<void> {
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
    this.setChatMenuOpen(false);
    this.chatPicker = null;
    this.chatPickerLabel = null;
    this.chatMenu = null;
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
    if (!open) this.setChatMenuOpen(false);
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
    // AI mode's own history: a fresh piece of ink, on any page, invalidates
    // redo — same convention (and cap) as NotebookView's main stack (see pushOp).
    this.undoStack.push(op);
    if (this.undoStack.length > MAX_AI_HISTORY) this.undoStack.shift();
    this.redoStack.length = 0;
    this.host.onAiHistoryChanged();
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
    this.undoStack.length = 0;
    this.redoStack.length = 0;
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

  /** Whether there is any AI-mode action left to undo, on any page (false while a turn is being captured) — only meaningful while AI mode is active. */
  canUndo(): boolean {
    return !this.capturing && this.undoStack.length > 0;
  }

  /** Whether there is any undone AI-mode action left to redo, on any page (false while a turn is being captured) — only meaningful while AI mode is active. */
  canRedo(): boolean {
    return !this.capturing && this.redoStack.length > 0;
  }

  /**
   * Reverts the most recent AI-mode action, whichever page it was on. Like
   * the main Undo, it never scrolls: an off-screen page changes in the store
   * and repaints when it's next mounted (host.refreshPage is the same
   * rebuildIfMounted main undo uses, split pane included). An action whose
   * page has since been torn down is dropped and the next one tried. A
   * no-op while a turn's pages are being captured (every route — buttons,
   * keyboard — lands here).
   */
  undo(): void {
    if (this.capturing) return;
    for (let op = this.undoStack.pop(); op; op = this.undoStack.pop()) {
      const pageId = (op as { pageId: string }).pageId;
      const st = this.pages.get(pageId);
      if (!st) continue;
      this.invertInk(pageId, st, op);
      this.redoStack.push(op);
      break;
    }
    this.host.onAiHistoryChanged();
  }

  /** Reapplies the most recently undone AI-mode action, whichever page it was on — see undo. */
  redo(): void {
    if (this.capturing) return;
    for (let op = this.redoStack.pop(); op; op = this.redoStack.pop()) {
      const pageId = (op as { pageId: string }).pageId;
      const st = this.pages.get(pageId);
      if (!st) continue;
      this.forwardInk(pageId, st, op);
      this.undoStack.push(op);
      break;
    }
    this.host.onAiHistoryChanged();
  }

  /** Drops every AI-history action on these pages (both directions). */
  private forgetHistory(pageIds: Set<string>): void {
    const keep = (op: Op): boolean => !pageIds.has((op as { pageId: string }).pageId);
    const u = this.undoStack.filter(keep);
    const r = this.redoStack.filter(keep);
    if (u.length === this.undoStack.length && r.length === this.redoStack.length) return;
    this.undoStack.splice(0, this.undoStack.length, ...u);
    this.redoStack.splice(0, this.redoStack.length, ...r);
    this.host.onAiHistoryChanged();
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

  /** Sends the current turn — the only way a turn is ever sent, called by the app-bar send button. A turn is every page's pending violet ink at once, whichever page is current or in view. */
  sendNow(): void {
    if (!this.active || this.sending) return;
    void this.submitTurn();
  }

  /** Removes whatever ephemeral ink is still tracked (unsent) and repaints if any was. (Its undo history goes with AI mode itself — see deactivateAll.) */
  private discardInk(pageId: string, st: AiPageState): void {
    if (!st.inkIds.size) return;
    const removed = store.removeItems(pageId, st.inkIds);
    st.inkIds.clear();
    if (removed.length) this.host.refreshPage(pageId);
  }

  private applyVisual(pageId: string): void {
    const st = this.pages.get(pageId);
    if (!st) return;
    const busy = this.sending && this.sendingPageIds.has(pageId);
    st.pageEl.classList.toggle('page--ai-active', this.active);
    st.statusEl.classList.toggle('ai-status--busy', busy);
    st.statusEl.textContent = busy ? 'DubNotes AI is thinking…' : this.active ? 'AI mode' : '';
  }

  /** Pages with this turn's violet ink still on them, in page order. Tracked per page whether or not it is mounted. */
  private turnPages(): { page: Page; st: AiPageState }[] {
    const out: { page: Page; st: AiPageState }[] = [];
    for (const [pageId, st] of this.pages) {
      if (!st.inkIds.size) continue;
      const page = store.pageById(pageId);
      if (!page || !store.itemsOf(pageId).some((it) => st.inkIds.has(it.id))) continue;
      out.push({ page, st });
    }
    return out.sort((a, b) => a.page.index - b.page.index);
  }

  /** Shows why Send didn't go. Every page's ink stays where it is, to fix and send again. */
  private blockSend(message: string): void {
    this.panelError = message;
    this.openPanel();
    this.renderConversation();
  }

  private endSending(): void {
    const ids = this.sendingPageIds;
    this.sending = false;
    this.sendingPageIds = new Set();
    for (const id of ids) this.applyVisual(id);
  }

  private async submitTurn(): Promise<void> {
    if (!this.active || this.sending) return;
    const turn = this.turnPages();
    if (!turn.length) return; // nothing drawn anywhere to ask about
    this.panelError = '';
    if (turn.length > MAX_TURN_PAGES) {
      this.blockSend(
        `AI ink is on ${turn.length} pages, but one turn can include at most ${MAX_TURN_PAGES}. ` +
          `Remove the AI ink from ${turn.length - MAX_TURN_PAGES} of them with the eraser, then send again. ` +
          `(Undo takes back the most recent AI ink, whichever page it's on.)`
      );
      return;
    }

    this.sending = true;
    this.sendingPageIds = new Set(turn.map((t) => t.page.id));
    for (const id of this.sendingPageIds) this.applyVisual(id);

    // Per page, two separate captures, sent as two separate labeled images
    // (see api/gemini.ts) — never merged into one. `question` is just the
    // violet ink (cropped to it, on a blank canvas), the actual thing to
    // answer; `context` is the whole page (every pre-existing note plus the
    // ink), there purely as background — a JPEG, which is far smaller than a
    // PNG for a busy page and reads the same. Captured before the ink is
    // removed below, since `question` needs it on the page to render. `ids`
    // snapshots the ink being sent, so a stroke landing mid-capture isn't
    // discarded unsent — it stays for the next turn.
    const captured: { page: Page; st: AiPageState; ids: Set<string>; question: TurnImage; context: TurnImage }[] = [];
    // AI undo/redo pause until the capture finishes or fails: undoing ink the
    // capture is about to render would pull it out from under the crop
    this.capturing = true;
    this.host.onAiHistoryChanged();
    try {
      for (const { page, st } of turn) {
        const ids = new Set(st.inkIds);
        captured.push({
          page,
          st,
          ids,
          question: await renderItemsImage(page, ids),
          context: await renderPageRegionImage(page, undefined, undefined, 'image/jpeg', CONTEXT_JPEG_QUALITY),
        });
      }
    } catch (err) {
      console.error('AI mode capture failed:', err);
      this.endSending();
      this.blockSend('Couldn’t capture this turn’s pages. Try sending again.');
      return;
    } finally {
      this.capturing = false;
      this.host.onAiHistoryChanged();
    }
    // AI mode switched off mid-capture: its ink is already gone, and so is the turn
    if (!this.active) {
      this.endSending();
      return;
    }

    // history is the active chat as it stands before this turn joins it
    const history = buildHistory(this.visibleEntries().filter((e) => !e.pending));
    const body = {
      pages: captured.map((c) => ({
        pageIndex: c.page.index,
        question: { image: c.question.base64, mimeType: c.question.mimeType },
        context: { image: c.context.base64, mimeType: c.context.mimeType },
      })),
      history,
    };
    const size = JSON.stringify(body).length; // base64 + JSON: one byte per char
    if (size > MAX_BODY_CHARS) {
      this.endSending();
      const mb = (n: number): string => (n / 1_000_000).toFixed(1);
      this.blockSend(
        `This turn is too large to send (${mb(size)} MB; the limit is ${mb(MAX_BODY_CHARS)} MB). ` +
          `Send fewer pages at a time: erase or undo the ink on some pages, send, then ask about the rest.`
      );
      return;
    }

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

    // a placeholder entry shows immediately — opening the panel is how a
    // sent turn becomes visible at all now that nothing lands on the page.
    const entry: ConversationEntry = {
      id: uid(),
      notebookId: this.notebookId,
      chatId,
      pageId: captured[0].page.id,
      pageIds: captured.map((c) => c.page.id),
      thumbnail: '',
      text: '',
      isError: false,
      createdAt: Date.now(),
      pending: true,
    };
    this.unsaved.add(entry);
    this.openPanel();
    this.renderConversation();

    const thumbnail = await questionThumbnail(captured.map((c) => c.question)).catch((err) => {
      console.error('AI thumbnail failed:', err);
      return '';
    });

    // everything is captured — this ink's job is done, on every page it was
    // on. Discard it (only items we ourselves marked ephemeral; never touches
    // pre-existing permanent content) so it never persists, regardless of
    // what the request below does.
    const sentPages = new Set<string>();
    for (const { page, st, ids } of captured) {
      store.removeItems(page.id, ids);
      for (const id of ids) st.inkIds.delete(id);
      this.host.refreshPage(page.id);
      // the AI history's actions on this page referred only to ink that's now
      // sent (and removed above) — dropped, as AI mode turning off drops them
      // all (left alone if ink drawn mid-capture is still pending here)
      if (!st.inkIds.size) sentPages.add(page.id);
    }
    this.forgetHistory(sentPages);

    let text: string;
    let transcript = '';
    let model = '';
    let title = '';
    let isError = false;
    try {
      ({ text, transcript, model, title, isError } = await callGemini(body));
    } catch (err) {
      console.error('AI mode send failed:', err);
      text = "DubNotes AI error: Couldn't reach the AI, check your internet connection.";
      isError = true;
    }

    this.endSending();

    entry.pending = false;
    entry.text = text;
    entry.isError = isError;
    entry.thumbnail = thumbnail;
    if (!isError && transcript) entry.transcript = transcript;
    if (!isError && model) entry.model = model;
    this.renderConversation();
    void this.persistTurn(entry, title);
  }

  /**
   * Writes a resolved turn to its own chat — skipped by putAiTurn if that chat
   * was deleted meanwhile. Joins the visible list only if its chat is still
   * the active one; otherwise it simply shows up when that chat is next opened.
   */
  private async persistTurn(entry: ConversationEntry, title: string): Promise<void> {
    // `pending` is transient UI state, left out of storage
    const { pending: _pending, ...persisted } = entry;
    let saved: AiChat | null = null;
    let failed = false;
    try {
      saved = await putAiTurn(persisted, title);
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
      // later; falls back gracefully if a page itself was since deleted.
      const ids = entry.pageIds ?? [entry.pageId];
      const nums = ids
        .map((id) => store.pageById(id))
        .filter((p): p is Page => !!p)
        .map((p) => p.index + 1)
        .sort((x, y) => x - y);
      const label = !nums.length
        ? ids.length > 1 ? 'Pages removed' : 'Page removed'
        : ids.length > 1 ? `Pages ${nums.join(', ')}` : `Page ${nums[0]}`;
      row.append(el('span', { class: 'ai-panel__page', text: label }));
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
      // which model answered — the server may have fallen back from its primary
      if (!entry.pending && !entry.isError && entry.model) row.append(el('div', { class: 'ai-panel__model', text: entry.model }));
      body.append(row);
    }
    if (this.panelError) body.append(el('div', { class: 'ai-panel__reply ai-panel__reply--error', text: this.panelError }));
    body.scrollTop = body.scrollHeight;
  }
}
