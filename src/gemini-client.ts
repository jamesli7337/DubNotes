/** The one client-side entry point to api/gemini.ts, used by ai-mode.ts. */

/** Where the built-in Gemini endpoint lives. Same-origin `/api/gemini` by
 * default (set if the static site itself is ever served from the Vercel
 * project); override with an absolute URL via `VITE_GEMINI_ENDPOINT` when the
 * site is hosted elsewhere (e.g. GitHub Pages) and the function is not. */
const GEMINI_ENDPOINT = import.meta.env.VITE_GEMINI_ENDPOINT?.trim() || '/api/gemini';
const PROXY_SECRET = import.meta.env.VITE_GEMINI_PROXY_SECRET ?? '';

/** One request's outcome — see callGemini. */
export interface GeminiResult {
  text: string;
  /** the question's transcript from a successful reply ('' otherwise) — see api/gemini.ts */
  transcript: string;
  /** which model answered a successful reply ('' otherwise) — the server may have fallen back from its primary */
  model: string;
  isError: boolean;
}

/** Turns a failed response's status (or, for a reply Gemini stopped short,
 * api/gemini.ts's `code`) into a plain-language message — the raw
 * status/reason is logged to the console (see callers) for debugging, but
 * never shown in the UI. */
function friendlyErrorText(status: number, code?: unknown): string {
  if (code === 'too_long') return 'Answer was too long and got cut off. Ask for a shorter or step-by-step answer.';
  if (code === 'safety') return 'The AI declined to answer this for safety reasons. Try rewording the question.';
  if (code === 'recitation') return 'The AI stopped because its answer was too close to existing published text. Try rewording the question.';
  if (code === 'quota') return 'The free AI quota is used up for now. Try again later.';
  if (status === 503) return 'The AI is overloaded right now, try again in a bit.';
  if (status === 404) return "The AI service isn't set up correctly right now.";
  if (status === 401 || status === 403) return "The AI isn't configured correctly, this needs a fix on my end, not yours.";
  return 'Something went wrong with the AI, try again in a bit.';
}

/**
 * POSTs one request to the Gemini proxy and normalizes the result to either
 * the reply text (plus the question's transcript and the model that
 * answered) or an app-facing error string. `body` is `{pages, history}` —
 * see api/gemini.ts.
 *
 * One request, no retries here: an overloaded (503) or rate-limited (429)
 * primary model is retried once on a fallback model by the server itself,
 * and retrying on top of that would stack the two. A 503 that still reaches
 * this point means both models failed, and shows as "overloaded".
 */
export async function callGemini(body: object): Promise<GeminiResult> {
  try {
    const res = await fetch(GEMINI_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-NoteApp-Secret': PROXY_SECRET },
      body: JSON.stringify(body),
    });
    const data: { text?: unknown; transcript?: unknown; model?: unknown; error?: unknown; code?: unknown } | null = await res
      .json()
      .catch(() => null);
    if (res.ok && typeof data?.text === 'string' && data.text) {
      const transcript = typeof data.transcript === 'string' ? data.transcript : '';
      const model = typeof data.model === 'string' ? data.model : '';
      return { text: data.text, transcript, model, isError: false };
    }
    const reason = typeof data?.error === 'string' ? data.error : `request failed (${res.status})`;
    console.error(`Gemini request failed: ${reason}`);
    return {
      text: `DubNotes AI error: ${friendlyErrorText(res.status, data?.code)}`,
      transcript: '',
      model: '',
      isError: true,
    };
  } catch (err) {
    console.error('Gemini request network error:', err);
    return {
      text: "DubNotes AI error: Couldn't reach the AI, check your internet connection.",
      transcript: '',
      model: '',
      isError: true,
    };
  }
}
