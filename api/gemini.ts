/**
 * POST /api/gemini — reads a handwritten page image and returns Gemini's
 * reply text. Vercel serverless function (Node.js runtime); deployed
 * alongside the static Vite build, see README "Deploy the Gemini endpoint".
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
  "You're reading a photo of a handwritten notebook page. Some of the ink " +
  'is a distinct violet/purple colour — that violet handwriting is always ' +
  "the page author's actual question or instruction to you, and it's the " +
  'one thing you must directly answer. Everything else on the page (any ' +
  'other ink colour) is pre-existing notes, there only as background — read ' +
  "it if it helps you answer the violet part, but don't summarize it, " +
  'describe it, or respond to it on its own. If there is no violet ink at ' +
  'all, treat whatever is most clearly a question or instruction as the one ' +
  'to answer. ' +
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
    res.status(500).json({ error: 'Server misconfigured: GEMINI_API_KEY is not set.' });
    return;
  }

  const body = req.body as { image?: unknown; mimeType?: unknown } | null;
  const image = body?.image;
  const mimeType = typeof body?.mimeType === 'string' ? body.mimeType : 'image/png';
  if (typeof image !== 'string' || !image) {
    res.status(400).json({ error: 'Missing or invalid "image" (base64 string) in request body.' });
    return;
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
        contents: [{ role: 'user', parts: [{ inline_data: { mime_type: mimeType, data: image } }] }],
      }),
    });
  } catch {
    res.status(502).json({ error: 'Could not reach Gemini.' });
    return;
  }

  if (!upstream.ok) {
    // Gemini's own error body may include request details worth not echoing
    // back verbatim to an untrusted caller; a short status-coded message is enough.
    res.status(502).json({ error: `Gemini request failed (${upstream.status}).` });
    return;
  }

  let data: unknown;
  try {
    data = await upstream.json();
  } catch {
    res.status(502).json({ error: 'Gemini returned an unreadable response.' });
    return;
  }

  const text = extractText(data);
  if (text == null) {
    res.status(502).json({ error: 'Gemini returned no text.' });
    return;
  }

  res.status(200).json({ text });
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
