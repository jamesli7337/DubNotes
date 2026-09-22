/**
 * POST /api/gemini — one endpoint, three request `kind`s (see `Body` below),
 * all proxying to Gemini. Vercel serverless function (Node.js runtime);
 * deployed alongside the static Vite build, see README "Deploy the Gemini
 * endpoint". One function rather than three (one per kind) deliberately —
 * this project's Vercel deploy is a manual `npx vercel --prod` step, not
 * triggered by a git push the way the static site's GitHub Pages deploy is;
 * a client/server version-skew incident already happened once from that
 * (the client shipped a new request shape before this function was
 * redeployed), so keeping everything Gemini-facing in one function halves
 * the ways client and server can drift out of sync, and `kind` defaults to
 * `'ask'` when absent (below) so an old client talking to a new function
 * still degrades to working rather than erroring.
 *
 * - `'ask'` (default when `kind` is omitted, for the reason above): the
 *   original AI-mode flow. Takes two images — `question` is just the user's
 *   violet AI-mode ink (already cropped to it by the client — see
 *   ai-mode.ts's `renderItemsImage`), `context` is the whole page. They're
 *   sent to Gemini as two separate labeled parts (see `contents` in
 *   `buildAsk`) rather than composited into one picture, so the model is
 *   never asked to itself pick the question out of a mixed image by colour.
 * - `'transcribe'`: one image (handwriting from a branched thread's own
 *   input pad — see ai-thread.ts), returns plain transcribed text (LaTeX for
 *   math), nothing else — so the app can show what it understood *before*
 *   sending it on as a question, per that feature's whole point.
 * - `'thread'`: a branched thread's own follow-up turn. No images — plain
 *   multi-turn text (`history`), seeded by the caller with the original
 *   reply being branched from as the first turn.
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

const GEMINI_MODEL = 'gemini-3.6-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

/** Shared by 'ask' and 'thread' — 'transcribe' doesn't answer/explain anything, so it skips this. */
const EXPLAIN_SIMPLY =
  'Explain things simply: short sentences, plain everyday words, one idea ' +
  "at a time, as if talking to a beginner seeing this for the first time. " +
  "Avoid jargon; if a technical term is unavoidable, explain it in a " +
  'few plain words right there. Keep the reply short enough to fit on the ' +
  'same page: a few sentences, or a short worked answer, not an essay. ' +
  'Use standard LaTeX for math ($...$ for inline, $$...$$ for a displayed ' +
  'equation, \\frac, \\sqrt, ^, _, etc.) and simple markdown for formatting ' +
  "(**bold**, short bullet lists) — don't overuse either.";

const ASK_SYSTEM_INSTRUCTION =
  'You will be given two images from a handwritten notebook page. The ' +
  "first is cropped to show ONLY the page author's actual question or " +
  "instruction to you — that crop is the one thing you must directly " +
  'answer. The second is a photo of the whole page, given purely as ' +
  "background — read it if it helps you answer the question in the first " +
  "image, but don't summarize it, describe it, or respond to anything in " +
  "it on its own; it may repeat what's in the first image, which is normal. " +
  EXPLAIN_SIMPLY;

/** One image of handwriting only — no answering, no context, just OCR (LaTeX for math). Used by a branched thread's handwriting input pad so the app can show what it understood before sending it on as a question. */
const TRANSCRIBE_SYSTEM_INSTRUCTION =
  'Transcribe the handwriting in this image into plain text, exactly as ' +
  'written — do not answer it, solve it, comment on it, or add anything. ' +
  'If it contains math, use standard LaTeX ($...$ inline, $$...$$ ' +
  'displayed, \\frac, \\sqrt, ^, _, etc.) for that part. Output only the ' +
  'transcription itself, nothing else — no preamble, no quotes around it.';

/** A branched thread's own follow-up turn: plain multi-turn text, no images — see the 'thread' request kind. */
const THREAD_SYSTEM_INSTRUCTION =
  "You're continuing a conversational thread that branched off an earlier " +
  'reply to a handwritten notebook page — the first message here is that ' +
  'original reply, given for context. Answer the newest message the same way. ' +
  EXPLAIN_SIMPLY;

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

  // `kind` defaults to 'ask' when absent — see the module doc comment for why
  // (an old client, from before this discriminator existed, still works).
  const body = req.body as { kind?: unknown } | null;
  const kind = typeof body?.kind === 'string' ? body.kind : 'ask';

  let geminiBody: Record<string, unknown>;
  if (kind === 'ask') {
    const b = req.body as { question?: unknown; context?: unknown };
    const question = parseImage(b?.question);
    const context = parseImage(b?.context);
    if (!question || !context) {
      res
        .status(400)
        .json({ error: 'Missing or invalid "question"/"context" image (each needs a base64 "image" string) in request body.' });
      return;
    }
    geminiBody = {
      system_instruction: { parts: [{ text: ASK_SYSTEM_INSTRUCTION }] },
      contents: [
        {
          role: 'user',
          parts: [
            { text: 'Image 1 of 2 — the question (answer this):' },
            { inline_data: { mime_type: question.mimeType, data: question.image } },
            { text: 'Image 2 of 2 — the whole page, background only:' },
            { inline_data: { mime_type: context.mimeType, data: context.image } },
          ],
        },
      ],
    };
  } else if (kind === 'transcribe') {
    const image = parseImage((req.body as { image?: unknown })?.image);
    if (!image) {
      res.status(400).json({ error: 'Missing or invalid "image" (base64 string) in request body.' });
      return;
    }
    geminiBody = {
      system_instruction: { parts: [{ text: TRANSCRIBE_SYSTEM_INSTRUCTION }] },
      contents: [{ role: 'user', parts: [{ inline_data: { mime_type: image.mimeType, data: image.image } }] }],
      generationConfig: { temperature: 0 },
    };
  } else if (kind === 'thread') {
    const history = parseHistory((req.body as { history?: unknown })?.history);
    if (!history) {
      res.status(400).json({ error: 'Missing or invalid "history" (a non-empty array of {role, text}) in request body.' });
      return;
    }
    geminiBody = {
      system_instruction: { parts: [{ text: THREAD_SYSTEM_INSTRUCTION }] },
      contents: history.map((h) => ({ role: h.role, parts: [{ text: h.text }] })),
    };
  } else {
    res.status(400).json({ error: `Unknown request "kind": ${kind}.` });
    return;
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(geminiBody),
    });
  } catch {
    res.status(502).json({ error: 'Could not reach the AI service.' });
    return;
  }

  if (!upstream.ok) {
    // Passed through as this response's own status (rather than a flat 502)
    // so the client can tell a 503 (temporary overload — see gemini-client.ts's
    // retry) apart from anything else without parsing the message text.
    // Gemini's own error body may include request details worth not echoing
    // back verbatim to an untrusted caller; a short status-coded message is enough.
    res.status(upstream.status).json({ error: `Request failed (${upstream.status}).` });
    return;
  }

  let data: unknown;
  try {
    data = await upstream.json();
  } catch {
    res.status(502).json({ error: 'Received an unreadable response.' });
    return;
  }

  const text = extractText(data);
  if (text == null) {
    res.status(502).json({ error: 'Received no response text.' });
    return;
  }

  res.status(200).json({ text });
}

/** Validates one `{ image, mimeType }` field of the request body. */
function parseImage(v: unknown): { image: string; mimeType: string } | null {
  const obj = v as { image?: unknown; mimeType?: unknown } | null;
  const image = obj?.image;
  if (typeof image !== 'string' || !image) return null;
  const mimeType = typeof obj?.mimeType === 'string' ? obj.mimeType : 'image/png';
  return { image, mimeType };
}

/** Validates a 'thread' request's `history`: a non-empty array of `{role: 'user'|'model', text}`. */
function parseHistory(v: unknown): { role: 'user' | 'model'; text: string }[] | null {
  if (!Array.isArray(v) || !v.length) return null;
  const out: { role: 'user' | 'model'; text: string }[] = [];
  for (const item of v) {
    const role = (item as { role?: unknown })?.role;
    const text = (item as { text?: unknown })?.text;
    if ((role !== 'user' && role !== 'model') || typeof text !== 'string' || !text) return null;
    out.push({ role, text });
  }
  return out;
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
