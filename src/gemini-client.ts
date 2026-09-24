/** The one client-side entry point to api/gemini.ts, used by ai-mode.ts. */

/** Where the built-in Gemini endpoint lives. Same-origin `/api/gemini` by
 * default (set if the static site itself is ever served from the Vercel
 * project); override with an absolute URL via `VITE_GEMINI_ENDPOINT` when the
 * site is hosted elsewhere (e.g. GitHub Pages) and the function is not. */
const GEMINI_ENDPOINT = import.meta.env.VITE_GEMINI_ENDPOINT?.trim() || '/api/gemini';
const PROXY_SECRET = import.meta.env.VITE_GEMINI_PROXY_SECRET ?? '';

/** One request's outcome, plus (only on failure) whether it's worth a silent retry — see callGemini. */
interface Attempt {
  text: string;
  isError: boolean;
  retryable: boolean;
}

/** 503 specifically means the model is temporarily overloaded — worth quietly
 * trying again. Delays increase each time (short, then longer, then longer
 * again) rather than hammering an already-overloaded endpoint. */
const RETRY_DELAYS_MS = [1000, 3000, 8000];

/** Turns a failed response's status into a plain-language message — the raw
 * status/reason is logged to the console (see callers) for debugging, but
 * never shown in the UI. */
function friendlyErrorText(status: number): string {
  if (status === 503) return 'The AI is overloaded right now, try again in a bit.';
  if (status === 404) return "The AI service isn't set up correctly right now.";
  if (status === 401 || status === 403) return "The AI isn't configured correctly, this needs a fix on my end, not yours.";
  return 'Something went wrong with the AI, try again in a bit.';
}

async function callGeminiOnce(body: object): Promise<Attempt> {
  try {
    const res = await fetch(GEMINI_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-NoteApp-Secret': PROXY_SECRET },
      body: JSON.stringify(body),
    });
    const data: { text?: unknown; error?: unknown } | null = await res.json().catch(() => null);
    if (res.ok && typeof data?.text === 'string' && data.text) {
      return { text: data.text, isError: false, retryable: false };
    }
    const reason = typeof data?.error === 'string' ? data.error : `request failed (${res.status})`;
    console.error(`Gemini request failed: ${reason}`);
    return { text: `DubNotes AI error: ${friendlyErrorText(res.status)}`, isError: true, retryable: res.status === 503 };
  } catch (err) {
    console.error('Gemini request network error:', err);
    return {
      text: "DubNotes AI error: Couldn't reach the AI, check your internet connection.",
      isError: true,
      retryable: false,
    };
  }
}

/**
 * POSTs one request to the Gemini proxy and normalizes the result to either
 * the reply text or an app-facing error string. `body` is `{question, context}`
 * — see api/gemini.ts.
 *
 * A 503 (the model temporarily overloaded) is retried automatically, with an
 * increasing delay between attempts, entirely behind this promise — nothing
 * is shown to the caller until every attempt has failed, and a retry that
 * eventually succeeds resolves exactly as if the first attempt had. Every
 * other failure (network error, 4xx, 500, etc.) still returns immediately.
 */
export async function callGemini(body: object): Promise<{ text: string; isError: boolean }> {
  let attempt = await callGeminiOnce(body);
  for (let i = 0; attempt.retryable && i < RETRY_DELAYS_MS.length; i++) {
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[i]));
    attempt = await callGeminiOnce(body);
  }
  return { text: attempt.text, isError: attempt.isError };
}
