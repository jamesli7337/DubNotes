/**
 * A branched AI-mode thread: a separate, scoped conversation that starts
 * from one main-panel reply (see ai-mode.ts's bindHold/openThreadFor) and
 * opens full-screen. Two ways to ask a follow-up — typed, or handwritten —
 * but either way what's actually sent as the question is plain text: typed
 * text needs no round-trip, and handwriting is transcribed first (Gemini's
 * 'transcribe' request kind, via api/gemini.ts) and shown, editable, before
 * it's sent — so inconsistent handwriting never silently gets misread into
 * the wrong question. Unlike the main flow, a thread's own turns ('thread'
 * request kind) are plain multi-turn text, no images — seeded with the root
 * reply as the first turn, so the model has that context without re-sending
 * the original page.
 *
 * Deliberately doesn't touch `store` or any page: everything here is either
 * already-resolved text (the root entry, past thread entries) or ephemeral
 * scratch ink that's transcribed and discarded, never added to a page.
 */
import { el } from './ui/dom';
import { icon } from './ui/icon';
import { blockGestures } from './ui/dom';
import { openModal } from './ui/dialog';
import { renderAiReply } from './ai-render';
import { renderStrokesImage } from './export/raster';
import type { Drawable } from './canvas/freehand';
import { drawStroke } from './canvas/freehand';
import { AI_COLOR, DEFAULT_PAPER, DPR } from './const';
import { getThreadEntries, putAiEntry } from './db';
import { callGemini } from './gemini-client';
import type { AiConversationEntry } from './types';
import { uid } from './util';

/** A thread's own entry, plus a transient in-memory "still waiting on Gemini" flag — same convention as ConversationEntry in ai-mode.ts. */
interface ThreadEntry extends AiConversationEntry {
  pending: boolean;
}

export function openAiThread(opts: { notebookId: string; rootEntry: AiConversationEntry; onChanged: () => void }): void {
  const { notebookId, rootEntry, onChanged } = opts;

  let entries: ThreadEntry[] = [];
  let sending = false;
  let changed = false;

  // ---------------------------------------------------------------- header
  const backBtn = el('button', { class: 'iconbtn', title: 'Close', 'aria-label': 'Close thread' });
  backBtn.append(icon('close'));
  const header = el('div', { class: 'ai-thread__header' }, backBtn, el('span', { class: 'ai-thread__title', text: 'Thread' }));

  // read-only reproduction of the reply this thread branched from, for context
  const rootBox = el('div', { class: 'ai-thread__root' });
  if (rootEntry.thumbnail) rootBox.append(el('img', { class: 'ai-panel__thumb', src: rootEntry.thumbnail, alt: 'Captured handwriting' }));
  const rootReply = el('div', { class: 'ai-panel__reply' + (rootEntry.isError ? ' ai-panel__reply--error' : '') });
  if (rootEntry.isError) rootReply.textContent = rootEntry.text;
  else renderAiReply(rootReply, rootEntry.text);
  rootBox.append(rootReply);

  // ------------------------------------------------------------------ body
  const body = el('div', { class: 'ai-thread__body' });

  function renderBody(): void {
    body.replaceChildren();
    for (const e of entries) {
      const row = el('div', { class: 'ai-thread__entry' });
      row.append(el('div', { class: 'ai-thread__bubble ai-thread__bubble--user', text: e.questionText ?? '' }));
      const cls = 'ai-thread__bubble ai-thread__bubble--ai' + (e.isError ? ' ai-panel__reply--error' : '');
      const replyEl = el('div', { class: cls });
      if (e.pending) replyEl.textContent = 'DubNotes AI is thinking…';
      else if (e.isError) replyEl.textContent = e.text;
      else renderAiReply(replyEl, e.text);
      row.append(replyEl);
      body.append(row);
    }
    body.scrollTop = body.scrollHeight;
  }

  // ---------------------------------------------------------------- footer
  const footer = el('div', { class: 'ai-thread__footer' });

  const typeTab = el('button', { class: 'iconbtn ai-thread__tab', title: 'Type' });
  typeTab.append(icon('text'));
  const writeTab = el('button', { class: 'iconbtn ai-thread__tab', title: 'Handwrite' });
  writeTab.append(icon('pen'));
  const tabs = el('div', { class: 'ai-thread__tabs' }, typeTab, writeTab);

  const typedArea = el('div', { class: 'ai-thread__input-mode' });
  const textarea = el('textarea', {
    class: 'ai-thread__textarea',
    placeholder: 'Ask a follow-up…',
    rows: '2',
  }) as HTMLTextAreaElement;
  const typedSend = el('button', { class: 'iconbtn primary', title: 'Send', 'aria-label': 'Send' });
  typedSend.append(icon('send'));
  typedArea.append(textarea, typedSend);

  const writeArea = el('div', { class: 'ai-thread__input-mode' });

  footer.append(tabs, typedArea, writeArea);

  function setMode(mode: 'type' | 'write'): void {
    typeTab.classList.toggle('active', mode === 'type');
    writeTab.classList.toggle('active', mode === 'write');
    typedArea.hidden = mode !== 'type';
    writeArea.hidden = mode !== 'write';
  }
  typeTab.addEventListener('click', () => setMode('type'));
  writeTab.addEventListener('click', () => setMode('write'));
  setMode('type');

  function updateFooterDisabled(): void {
    typedSend.disabled = sending;
    textarea.disabled = sending;
    transcribeBtn.disabled = sending || !strokes.length;
    transcriptSend.disabled = sending;
  }

  /** Asks the thread's own Gemini conversation and appends the resolved turn — the only way an entry is ever added here, typed or transcribed alike, so both paths persist and render identically. */
  async function send(questionText: string): Promise<void> {
    if (sending || !questionText.trim()) return;
    sending = true;
    updateFooterDisabled();

    const entry: ThreadEntry = {
      id: uid(),
      notebookId,
      pageId: rootEntry.pageId,
      thumbnail: '',
      text: '',
      isError: false,
      createdAt: Date.now(),
      branchedFromEntryId: rootEntry.id,
      questionText,
      pending: true,
    };
    entries.push(entry);
    renderBody();

    // seeded with the root reply as the first turn, then every resolved
    // thread entry so far, then the new question — plain multi-turn text,
    // no images (see the module doc comment).
    const history: { role: 'user' | 'model'; text: string }[] = [{ role: 'model', text: rootEntry.text }];
    for (const e of entries) {
      if (e.pending) continue;
      history.push({ role: 'user', text: e.questionText ?? '' });
      history.push({ role: 'model', text: e.text });
    }
    history.push({ role: 'user', text: questionText });

    const { text, isError } = await callGemini({ kind: 'thread', history });

    entry.pending = false;
    entry.text = text;
    entry.isError = isError;
    renderBody();

    sending = false;
    updateFooterDisabled();
    changed = true;
    onChanged();

    // written once, resolved — never while pending, same convention as the main panel.
    const { pending: _pending, ...persisted } = entry;
    void putAiEntry(persisted);
  }

  typedSend.addEventListener('click', () => {
    const v = textarea.value.trim();
    if (!v) return;
    textarea.value = '';
    void send(v);
  });
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      typedSend.click();
    }
  });

  // ----------------------------------------------------- handwriting pad
  // A small, purpose-built drawing surface — not PageCanvas (store-backed,
  // tool-aware, far more than one scratch transcription needs). Strokes live
  // only in `strokes` below; nothing here ever reaches `store`.
  let strokes: Drawable[] = [];
  let live: number[][] = [];
  let pointerId: number | null = null;

  const canvas = el('canvas', { class: 'ai-thread__pad' }) as HTMLCanvasElement;
  blockGestures(canvas);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not create a canvas.');

  function repaint(): void {
    ctx!.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx!.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    for (const s of strokes) drawStroke(ctx!, s, DEFAULT_PAPER);
    if (live.length > 1) drawStroke(ctx!, { tool: 'pen', color: AI_COLOR, size: 3, points: live }, DEFAULT_PAPER);
  }
  function resizeCanvas(): void {
    const r = canvas.getBoundingClientRect();
    canvas.width = Math.round(r.width * DPR);
    canvas.height = Math.round(r.height * DPR);
    repaint();
  }

  canvas.addEventListener('pointerdown', (e) => {
    pointerId = e.pointerId;
    canvas.setPointerCapture(e.pointerId);
    const r = canvas.getBoundingClientRect();
    live = [[e.clientX - r.left, e.clientY - r.top, e.pressure || 0.5]];
    e.preventDefault();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerId !== pointerId) return;
    const r = canvas.getBoundingClientRect();
    live.push([e.clientX - r.left, e.clientY - r.top, e.pressure || 0.5]);
    repaint();
    e.preventDefault();
  });
  const endStroke = (e: PointerEvent): void => {
    if (e.pointerId !== pointerId) return;
    pointerId = null;
    if (live.length > 1) strokes.push({ tool: 'pen', color: AI_COLOR, size: 3, points: live });
    live = [];
    repaint();
    updateFooterDisabled();
  };
  canvas.addEventListener('pointerup', endStroke);
  canvas.addEventListener('pointercancel', endStroke);

  const undoBtn = el('button', { class: 'iconbtn', title: 'Undo stroke', 'aria-label': 'Undo stroke' });
  undoBtn.append(icon('undo'));
  undoBtn.addEventListener('click', () => {
    strokes.pop();
    repaint();
    updateFooterDisabled();
  });
  const clearBtn = el('button', { class: 'iconbtn', title: 'Clear', 'aria-label': 'Clear' });
  clearBtn.append(icon('delete'));
  clearBtn.addEventListener('click', () => {
    strokes = [];
    repaint();
    updateFooterDisabled();
  });
  const transcribeBtn = el('button', { class: 'iconbtn primary', title: 'Transcribe', 'aria-label': 'Transcribe' });
  transcribeBtn.append(icon('check'));
  transcribeBtn.disabled = true; // nothing drawn yet

  // shown once a transcription comes back — editable, with its own Send, per
  // the whole point of this feature: see what was understood before it's asked.
  const transcriptRow = el('div', { class: 'ai-thread__transcript', hidden: true });
  const transcriptInput = el('textarea', { class: 'ai-thread__textarea', rows: '2' }) as HTMLTextAreaElement;
  const transcriptSend = el('button', { class: 'iconbtn primary', title: 'Send', 'aria-label': 'Send' });
  transcriptSend.append(icon('send'));
  transcriptRow.append(transcriptInput, transcriptSend);

  async function transcribe(): Promise<void> {
    if (!strokes.length || sending) return;
    sending = true;
    updateFooterDisabled();
    const capturedStrokes = strokes;
    const image = await renderStrokesImage(capturedStrokes);
    const { text, isError } = await callGemini({
      kind: 'transcribe',
      image: { image: image.base64, mimeType: image.mimeType },
    });
    sending = false;
    if (isError) {
      // surface the failure inline rather than silently dropping the ink —
      // the strokes are left in place so the user can just retry
      transcriptInput.value = '';
      transcriptInput.placeholder = text;
      transcriptRow.hidden = false;
      updateFooterDisabled();
      return;
    }
    transcriptInput.value = text;
    transcriptRow.hidden = false;
    strokes = [];
    repaint();
    updateFooterDisabled();
    transcriptInput.focus();
  }
  transcribeBtn.addEventListener('click', () => void transcribe());

  transcriptSend.addEventListener('click', () => {
    const v = transcriptInput.value.trim();
    if (!v) return;
    transcriptInput.value = '';
    transcriptRow.hidden = true;
    void send(v);
  });

  writeArea.append(canvas, el('div', { class: 'ai-thread__pad-actions' }, undoBtn, clearBtn, transcribeBtn), transcriptRow);

  // ------------------------------------------------------------------ modal
  const wrap = el('div', { class: 'ai-thread' }, header, rootBox, body, footer);

  const modal = openModal(wrap, {
    cardClass: 'modal-card--thread',
    onClose: () => {
      window.removeEventListener('resize', resizeCanvas);
      if (changed) onChanged();
    },
  });
  backBtn.addEventListener('click', () => modal.close());

  window.addEventListener('resize', resizeCanvas);
  requestAnimationFrame(resizeCanvas);

  void (async () => {
    const rows = await getThreadEntries(rootEntry.id);
    entries = rows.map((r) => ({ ...r, pending: false }));
    renderBody();
  })();
}
