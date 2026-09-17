/**
 * The one client-side entry point to api/gemini.ts — used by both the main
 * AI-mode flow (ai-mode.ts) and a branched thread's own turns (ai-thread.ts).
 * Kept as its own tiny module, rather than living on either of those two,
 * so neither has to import the other just to reach this — see ai-mode.ts's
 * module doc comment on avoiding that cycle.
 */

/** Where the built-in Gemini endpoint lives. Same-origin `/api/gemini` by
 * default (set if the static site itself is ever served from the Vercel
 * project); override with an absolute URL via `VITE_GEMINI_ENDPOINT` when the
 * site is hosted elsewhere (e.g. GitHub Pages) and the function is not. */
const GEMINI_ENDPOINT = import.meta.env.VITE_GEMINI_ENDPOINT?.trim() || '/api/gemini';
const PROXY_SECRET = import.meta.env.VITE_GEMINI_PROXY_SECRET ?? '';

/**
 * POSTs one request to the Gemini proxy and normalizes the result to either
 * the reply text or an app-facing error string. `body` is whatever shape
 * api/gemini.ts's `kind` discriminator expects for that request
 * (`{kind:'ask',...}`, `{kind:'transcribe',...}`, `{kind:'thread',...}`).
 */
export async function callGemini(body: object): Promise<{ text: string; isError: boolean }> {
  try {
    const res = await fetch(GEMINI_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-NoteApp-Secret': PROXY_SECRET },
      body: JSON.stringify(body),
    });
    const data: { text?: unknown; error?: unknown } | null = await res.json().catch(() => null);
    if (res.ok && typeof data?.text === 'string' && data.text) {
      return { text: data.text, isError: false };
    }
    const reason = typeof data?.error === 'string' ? data.error : `request failed (${res.status})`;
    return { text: `DubNotes AI error: ${reason}`, isError: true };
  } catch (err) {
    return {
      text: `DubNotes AI error: could not reach the endpoint (${err instanceof Error ? err.message : 'network error'}).`,
      isError: true,
    };
  }
}
