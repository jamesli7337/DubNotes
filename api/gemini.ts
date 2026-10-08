/**
 * POST /api/gemini — reads a handwritten page and returns Gemini's reply
 * text. Vercel serverless function (Node.js runtime); deployed alongside the
 * static Vite build, see README "Deploy the Gemini endpoint".
 *
 * A turn can span pages: `pages` holds 1..MAX_TURN_PAGES entries, each with
 * its `pageIndex` and two images — `question` is just the user's violet
 * AI-mode ink on that page (already cropped to it by the client — see
 * ai-mode.ts's `renderItemsImage`), `context` is that whole page. They're
 * sent to Gemini as separate labeled parts ("Page N question" / "Page N
 * context", see turnParts) rather than composited into one picture, so the
 * model is never asked to itself pick the question out of a mixed image by
 * colour — a previous version relied on a system-prompt instruction ("the
 * violet ink is the question") over one merged screenshot, which asked Gemini
 * to reliably notice a colour distinction rather than just being told which
 * image was which. The older single-page body (`question` + `context` at the
 * top level) is still accepted as a one-page turn, for a client still running
 * a cached build from before turns spanned pages.
 *
 * Multi-turn: an optional `history` of earlier turns in the same chat arrives
 * as plain text ({ role, text } — the user side is each earlier turn's
 * transcript, the model side its answer) and goes ahead of the current image
 * turn in `contents`. Images are only ever sent for the current turn. The
 * reply is requested as JSON `{ transcript, answer }` (see RESPONSE_SCHEMA):
 * the transcript is what the client stores to stand in for this turn's images
 * in later turns' history.
 *
 * This file lives outside `src/` and outside tsconfig's `include`, so
 * `npm run build`'s `tsc` step does not type-check it — Vercel's own build
 * (esbuild) transpiles it without a type-checking gate. The request/response
 * types below are a minimal, dependency-free stand-in for `@vercel/node`'s
 * `VercelRequest`/`VercelResponse` (installing that package purely for types
 * felt like more than this one file needs); they describe the actual shape
 * Vercel's Node.js runtime hands a handler.
 */

interface ApiRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

interface ApiResponse {
  status(code: number): ApiResponse;
  setHeader(name: string, value: string): ApiResponse;
  json(body: unknown): void;
  end(): void;
}

/**
 * Tried in order: the primary, then — only when the primary is overloaded
 * (503 UNAVAILABLE) or rate-limited (429 RESOURCE_EXHAUSTED) — the fallback,
 * immediately and once. Both are stable (non-preview) models that take image
 * input, JSON-schema output and multi-turn `contents`. This is the only retry
 * anywhere: the client (gemini-client.ts) makes one request and doesn't retry.
 */
const MODELS = ['gemini-3.6-flash', 'gemini-3.5-flash'] as const;
const modelUrl = (model: string): string =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
/** Upstream statuses that mean "this model can't take it right now" rather than "this request is wrong". */
const FALLBACK_STATUSES = new Set([503, 429]);

/** Server-side caps on `history`, a little above the client's own budget
 * (ai-mode.ts's HISTORY_CHAR_BUDGET) so a well-behaved client is never
 * trimmed here; oldest turn pairs are dropped first. */
const MAX_HISTORY_ITEMS = 40;
const MAX_HISTORY_CHARS = 32_000;

/** Most pages one turn may include — the same cap as ai-mode.ts's. */
const MAX_TURN_PAGES = 6;

/** Output cap per reply. The model's hard limit is 65,536, and on Gemini 3
 * thinking tokens count against this too, so the default (or a tight cap)
 * can run out mid-JSON. Half the hard limit leaves ample room for thinking
 * plus a long answer while still bounding a runaway generation. */
const MAX_OUTPUT_TOKENS = 32_768;

/**
 * `code` values on an error response for a reply Gemini itself stopped
 * short — see finishReasonCode. The client maps each to its own message
 * (gemini-client.ts's friendlyErrorText); none is worth retrying as-is.
 */
type ReplyErrorCode = 'too_long' | 'safety' | 'recitation';

/**
 * Error-response `code` for a request no model could take because the API
 * key's quota is used up (a daily quota, not a short-term rate limit — see
 * readUpstreamError). Sent with HTTP 429; mapped by gemini-client.ts.
 */
const QUOTA_CODE = 'quota';
/** Longest Gemini error message logged — enough to diagnose, never a dump. */
const MAX_LOGGED_MESSAGE = 500;

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    transcript: { type: 'STRING' },
    answer: { type: 'STRING' },
  },
  required: ['transcript', 'answer'],
  propertyOrdering: ['transcript', 'answer'],
};

/** First turn of a chat only (empty history): the schema gains a required "title". */
const FIRST_TURN_RESPONSE_SCHEMA = {
  ...RESPONSE_SCHEMA,
  properties: { ...RESPONSE_SCHEMA.properties, title: { type: 'STRING' } },
  required: [...RESPONSE_SCHEMA.required, 'title'],
  propertyOrdering: [...RESPONSE_SCHEMA.propertyOrdering, 'title'],
};

const TITLE_INSTRUCTION =
  ' Also set "title" to a topic label for this chat: 2-5 words, max 40 characters, plain words only, ' +
  'no LaTeX, math symbols, markdown, emoji, quotes, colons or trailing punctuation. ' +
  "Describe the topic, don't copy the question.";

const SYSTEM_INSTRUCTION =
  'Earlier turns of this conversation, if any, arrive as text only: each of ' +
  "the user's earlier turns is a transcript of what they wrote, and each of " +
  'your earlier turns is the answer you gave. Only the current (last) turn ' +
  'has images, and its question may be a follow-up to those earlier turns. ' +
  'The current turn comes from one or more pages of a handwritten notebook, ' +
  'and gives you two labeled images per page. "Page N question" is cropped ' +
  "to show ONLY what the page author wrote to you on page N — their actual " +
  'question or instruction. Taken together, every page\'s question crop is ' +
  'the one thing you must directly answer: a single question can be split ' +
  'across pages, and question ink on one page may point at, circle or refer ' +
  'to content on a different page (e.g. "solve the circled one" on page 4 ' +
  'about an equation circled on page 3). "Page N context" is a photo of the ' +
  'whole of page N, given purely as background — read it to find what the ' +
  "question refers to, but don't summarize it, describe it, or respond to " +
  'anything in it on its own; it repeats what is in that page\'s question ' +
  'crop, which is normal. ' +
  'Explain things simply: short sentences, plain everyday words, one idea ' +
  "at a time, as if talking to a beginner seeing this for the first time. " +
  "Avoid jargon; if a technical term is unavoidable, explain it in a " +
  'few plain words right there. Keep the reply short enough to fit on the ' +
  'same page: a few sentences, or a short worked answer, not an essay. ' +
  'Use standard LaTeX for math ($...$ for inline, $$...$$ for a displayed ' +
  'equation, \\frac, \\sqrt, ^, _, etc.) and simple markdown for formatting ' +
  "(**bold**, short bullet lists) — don't overuse either. " +
  'Respond with JSON matching the schema: "transcript" is a concise text ' +
  'rendering of the handwritten question, plus whatever content it refers ' +
  'to, written so it could stand in for every image of this turn in a later ' +
  'turn, when the images are gone. State what things actually say: write out ' +
  'the circled, underlined or pointed-at equation, problem, list or diagram ' +
  'itself, never just "the circled problem" or "this equation". When the turn ' +
  'spans pages, say which page each part comes from (e.g. "Page 3: …; Page 4: ' +
  '…"). Use LaTeX for math. "answer" is your reply, following the rules above.';

/** Every response carries this — the app is a static site on another origin. */
function setCors(res: ApiResponse, origin: string | string[] | undefined): void {
  res.setHeader('Access-Control-Allow-Origin', typeof origin === 'string' ? origin : '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-NoteApp-Secret');
  res.setHeader('Vary', 'Origin');
}

export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  setCors(res, req.headers.origin);

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed.' });
    return;
  }

  // Shared secret: not real authentication (it ships in the client bundle,
  // so anyone who reads the built JS can extract it), but it stops the
  // endpoint from being casually discovered and hit by scanners/bots that
  // never inspect the app at all — see README for the caveat in full.
  const expected = process.env.GEMINI_PROXY_SECRET;
  const provided = req.headers['x-noteapp-secret'];
  if (!expected || provided !== expected) {
    res.status(401).json({ error: 'Unauthorized.' });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'Server misconfigured: the AI API key is not set.' });
    return;
  }

  const body = req.body as { pages?: unknown; question?: unknown; context?: unknown; history?: unknown } | null;
  const pages = parsePages(body);
  if (!pages) {
    res.status(400).json({
      error:
        `Missing or invalid "pages": expected 1–${MAX_TURN_PAGES} { pageIndex, question, context } entries, ` +
        'each image needing a base64 "image" string.',
    });
    return;
  }
  const history = parseHistory(body?.history);
  if (!history) {
    res.status(400).json({ error: 'Invalid "history": expected alternating user/model { role, text } turns.' });
    return;
  }

  // a chat's first message (no history) also asks for a title
  const wantTitle = history.length === 0;

  // serialized once — the same request goes to the fallback if it's needed
  const upstreamBody = JSON.stringify({
    system_instruction: { parts: [{ text: wantTitle ? SYSTEM_INSTRUCTION + TITLE_INSTRUCTION : SYSTEM_INSTRUCTION }] },
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: wantTitle ? FIRST_TURN_RESPONSE_SCHEMA : RESPONSE_SCHEMA,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    },
    contents: [
      ...history.map((h) => ({ role: h.role, parts: [{ text: h.text }] })),
      { role: 'user', parts: turnParts(pages) },
    ],
  });

  let upstream: Response | null = null;
  let model: string = MODELS[0];
  // one per failed try: for the error message, and whether it was quota exhaustion
  const attempts: { label: string; quota: boolean }[] = [];
  for (const m of MODELS) {
    model = m;
    try {
      upstream = await fetch(`${modelUrl(m)}?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: upstreamBody,
      });
    } catch (err) {
      // the request URL carries the API key — logged as the error's name and
      // message only, with any key=… that might appear in them redacted
      const why = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      console.error(`Gemini attempt failed: model=${m} network error — ${why.replace(/key=[^&\s]+/g, 'key=…')}`);
      res.status(502).json({ error: 'Could not reach the AI service.' });
      return;
    }
    if (upstream.ok) break;
    const info = await readUpstreamError(upstream);
    console.error(
      `Gemini attempt failed: model=${m} http=${upstream.status} status=${info.status ?? '-'}` +
        (info.quotaIds.length ? ` quotaIds=${info.quotaIds.join(',')}` : '') +
        ` message=${JSON.stringify(info.message ?? '')}`
    );
    attempts.push({ label: `${m} ${upstream.status}`, quota: info.quotaExhausted });
    if (!FALLBACK_STATUSES.has(upstream.status)) break; // a real error, not capacity: no fallback
  }

  if (!upstream?.ok) {
    const label = attempts.map((a) => a.label).join(', then ');
    // Every model that was tried had its quota used up: retrying in a bit
    // won't help, so this gets its own code (and message) rather than
    // "overloaded". A quota-exhausted primary still falls back first — each
    // model has its own daily quota.
    if (attempts.length && attempts.every((a) => a.quota)) {
      res.status(429).json({ error: `Quota exhausted (${label}).`, code: QUOTA_CODE });
      return;
    }
    // Two failed attempts means the primary was overloaded and the fallback
    // failed too (with any status): reported as the overload it started as,
    // so the client shows its "overloaded, try again in a bit" message. A
    // single failed attempt passes its upstream status through as this
    // response's own (rather than a flat 502). Gemini's own error body may
    // include request details worth not echoing back verbatim to an untrusted
    // caller; a short status-coded message is enough.
    const status = attempts.length > 1 ? 503 : (upstream?.status ?? 502);
    res.status(status).json({ error: `Request failed (${label}).` });
    return;
  }

  let data: unknown;
  try {
    data = await upstream.json();
  } catch {
    res.status(502).json({ error: 'Received an unreadable response.' });
    return;
  }

  // checked before the text: a truncated reply is half a JSON object, and a
  // blocked one may have no text at all — either would otherwise surface as
  // the generic "unreadable"/"no text" error below
  const code = finishReasonCode(data);
  if (code) {
    res.status(502).json({ error: `Reply stopped early (${code}).`, code });
    return;
  }

  const text = extractText(data);
  if (text == null) {
    res.status(502).json({ error: 'Received no response text.' });
    return;
  }
  const reply = parseReply(text);
  if (!reply) {
    res.status(502).json({ error: 'Received an unreadable response.' });
    return;
  }

  // `text` keeps its old name (the answer) so the client's success check is
  // unchanged; `model` is whichever of MODELS answered
  res.status(200).json({
    text: reply.answer,
    transcript: reply.transcript,
    model,
    ...(wantTitle && reply.title ? { title: reply.title } : {}),
  });
}

interface HistoryTurn {
  role: 'user' | 'model';
  text: string;
}

/**
 * Validates `history` (absent → []): an array of { role, text } turns that
 * alternates user/model, starting with user and ending with model, so the
 * current image turn follows a model turn. Null if malformed. Over the caps,
 * oldest user/model pairs are dropped (pairs, so alternation survives).
 */
function parseHistory(v: unknown): HistoryTurn[] | null {
  if (v == null) return [];
  if (!Array.isArray(v) || v.length % 2) return null;
  const turns: HistoryTurn[] = [];
  for (let i = 0; i < v.length; i++) {
    const item = v[i] as { role?: unknown; text?: unknown } | null;
    const role = i % 2 ? 'model' : 'user';
    if (item?.role !== role || typeof item.text !== 'string' || !item.text.trim()) return null;
    turns.push({ role, text: item.text });
  }
  let chars = turns.reduce((n, t) => n + t.text.length, 0);
  while (turns.length && (turns.length > MAX_HISTORY_ITEMS || chars > MAX_HISTORY_CHARS)) {
    const [u, m] = turns.splice(0, 2);
    chars -= u.text.length + m.text.length;
  }
  return turns;
}

/** Parses the JSON reply requested via RESPONSE_SCHEMA; null if it isn't one. */
function parseReply(text: string): { transcript: string; answer: string; title: string } | null {
  let obj: { transcript?: unknown; answer?: unknown; title?: unknown };
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  const answer = typeof obj?.answer === 'string' ? obj.answer.trim() : '';
  if (!answer) return null;
  const transcript = typeof obj.transcript === 'string' ? obj.transcript.trim() : '';
  const title = typeof obj.title === 'string' ? obj.title.trim() : '';
  return { transcript, answer, title };
}

interface TurnPage {
  /** 0-based; null for the legacy single-page body, which carried none */
  pageIndex: number | null;
  question: { image: string; mimeType: string };
  context: { image: string; mimeType: string };
}

/**
 * Validates the turn's pages: `pages` (1..MAX_TURN_PAGES entries, each a
 * non-negative integer `pageIndex` plus two valid images), sorted by page;
 * or else the legacy top-level `question` + `context` as one page. Null if
 * neither is valid.
 */
function parsePages(body: { pages?: unknown; question?: unknown; context?: unknown } | null): TurnPage[] | null {
  if (body?.pages === undefined) {
    const question = parseImage(body?.question);
    const context = parseImage(body?.context);
    return question && context ? [{ pageIndex: null, question, context }] : null;
  }
  const raw = body.pages;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_TURN_PAGES) return null;
  const pages: TurnPage[] = [];
  for (const v of raw) {
    const p = v as { pageIndex?: unknown; question?: unknown; context?: unknown } | null;
    const pageIndex = p?.pageIndex;
    const question = parseImage(p?.question);
    const context = parseImage(p?.context);
    if (typeof pageIndex !== 'number' || !Number.isInteger(pageIndex) || pageIndex < 0 || !question || !context) return null;
    pages.push({ pageIndex, question, context });
  }
  return pages.sort((a, b) => a.pageIndex! - b.pageIndex!);
}

/** The current turn's parts: per page, its labeled question crop then its labeled whole-page context. */
function turnParts(pages: TurnPage[]): object[] {
  const parts: object[] = [];
  for (const p of pages) {
    const name = p.pageIndex == null ? 'Page' : `Page ${p.pageIndex + 1}`;
    parts.push(
      { text: `${name} question (answer this):` },
      { inline_data: { mime_type: p.question.mimeType, data: p.question.image } },
      { text: `${name} context (the whole page, background only):` },
      { inline_data: { mime_type: p.context.mimeType, data: p.context.image } }
    );
  }
  return parts;
}

/** Validates one `{ image, mimeType }` field of the request body. */
function parseImage(v: unknown): { image: string; mimeType: string } | null {
  const obj = v as { image?: unknown; mimeType?: unknown } | null;
  const image = obj?.image;
  if (typeof image !== 'string' || !image) return null;
  const mimeType = typeof obj?.mimeType === 'string' ? obj.mimeType : 'image/png';
  return { image, mimeType };
}

/**
 * What a failed upstream response says about itself — Google's standard error
 * envelope, `{ error: { code, message, status, details[] } }`. A 429 is
 * RESOURCE_EXHAUSTED either way; whether it's a short-term rate limit or a
 * used-up quota is only told apart by `details`' QuotaFailure violations:
 * each `quotaId` names its window (e.g.
 * "GenerateRequestsPerMinutePerProjectPerModel-FreeTier" for a rate limit,
 * "GenerateRequestsPerDayPerProjectPerModel-FreeTier" for the daily quota).
 * A per-day violation counts as quota exhausted; anything else — a per-minute
 * one, or a bare 429 with no details — as a rate limit. Never throws.
 */
async function readUpstreamError(
  r: Response
): Promise<{ status?: string; message?: string; quotaIds: string[]; quotaExhausted: boolean }> {
  let body: unknown;
  try {
    body = await r.json();
  } catch {
    return { quotaIds: [], quotaExhausted: false };
  }
  const err = (body as { error?: { status?: unknown; message?: unknown; details?: unknown } } | null)?.error;
  const status = typeof err?.status === 'string' ? err.status : undefined;
  const message = typeof err?.message === 'string' ? err.message.slice(0, MAX_LOGGED_MESSAGE) : undefined;
  const quotaIds: string[] = [];
  if (Array.isArray(err?.details)) {
    for (const d of err.details) {
      const violations = (d as { violations?: unknown } | null)?.violations;
      if (!Array.isArray(violations)) continue;
      for (const v of violations) {
        const id = (v as { quotaId?: unknown } | null)?.quotaId;
        if (typeof id === 'string') quotaIds.push(id);
      }
    }
  }
  const quotaExhausted = r.status === 429 && quotaIds.some((id) => /PerDay/i.test(id));
  return { status, message, quotaIds, quotaExhausted };
}

/** Maps the first candidate's `finishReason` to a ReplyErrorCode, or null if it finished normally (or says nothing). */
function finishReasonCode(data: unknown): ReplyErrorCode | null {
  const candidates = (data as { candidates?: unknown })?.candidates;
  if (!Array.isArray(candidates) || !candidates.length) return null;
  const reason = (candidates[0] as { finishReason?: unknown })?.finishReason;
  if (reason === 'MAX_TOKENS') return 'too_long';
  if (reason === 'SAFETY') return 'safety';
  if (reason === 'RECITATION') return 'recitation';
  return null;
}

/** Pulls the reply text out of a generateContent response, defensively. */
function extractText(data: unknown): string | null {
  const candidates = (data as { candidates?: unknown })?.candidates;
  if (!Array.isArray(candidates) || !candidates.length) return null;
  const parts = (candidates[0] as { content?: { parts?: unknown } })?.content?.parts;
  if (!Array.isArray(parts)) return null;
  const text = parts
    .map((p) => (typeof (p as { text?: unknown })?.text === 'string' ? (p as { text: string }).text : ''))
    .join('')
    .trim();
  return text || null;
}
