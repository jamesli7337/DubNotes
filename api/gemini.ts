/**
 * POST /api/gemini — reads a handwritten page and returns Gemini's reply
 * text. Vercel serverless function (Node.js runtime); deployed alongside the
 * static Vite build, see README "Deploy the Gemini endpoint".
 *
 * Takes two images, not one: `question` is just the user's violet AI-mode
 * ink (already cropped to it by the client — see ai-mode.ts's
 * `renderItemsImage`), `context` is the whole page. They're sent to Gemini
 * as two separate labeled parts (see `contents` below) rather than composited
 * into one picture, so the model is never asked to itself pick the question
 * out of a mixed image by colour — a previous version relied on a system-
 * prompt instruction ("the violet ink is the question") over one merged
 * screenshot, which asked Gemini to reliably notice a colour distinction
 * rather than just being told which image was which.
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

const SYSTEM_INSTRUCTION =
  'You will be given two images from a handwritten notebook page. The ' +
  "first is cropped to show ONLY the page author's actual question or " +
  "instruction to you — that crop is the one thing you must directly " +
  'answer. The second is a photo of the whole page, given purely as ' +
  "background — read it if it helps you answer the question in the first " +
  "image, but don't summarize it, describe it, or respond to anything in " +
  "it on its own; it may repeat what's in the first image, which is normal. " +
  'Explain things simply: short sentences, plain everyday words, one idea ' +
  "at a time, as if talking to a beginner seeing this for the first time. " +
  "Avoid jargon; if a technical term is unavoidable, explain it in a " +
  'few plain words right there. Keep the reply short enough to fit on the ' +
  'same page: a few sentences, or a short worked answer, not an essay. ' +
  'Use standard LaTeX for math ($...$ for inline, $$...$$ for a displayed ' +
  'equation, \\frac, \\sqrt, ^, _, etc.) and simple markdown for formatting ' +
  "(**bold**, short bullet lists) — don't overuse either.";

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

  const body = req.body as { question?: unknown; context?: unknown } | null;
  const question = parseImage(body?.question);
  const context = parseImage(body?.context);
  if (!question || !context) {
    res
      .status(400)
      .json({ error: 'Missing or invalid "question"/"context" image (each needs a base64 "image" string) in request body.' });
    return;
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
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
      }),
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
