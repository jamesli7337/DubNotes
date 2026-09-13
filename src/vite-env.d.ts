/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * AI mode's shared secret, sent as the `X-NoteApp-Secret` header on every
   * request to the Gemini endpoint — must match the serverless function's
   * `GEMINI_PROXY_SECRET`. See README "The Gemini endpoint" for the caveat:
   * this ships in the built JS, so it only deters opportunistic abuse.
   */
  readonly VITE_GEMINI_PROXY_SECRET?: string;
  /**
   * Absolute URL of the Gemini endpoint, when the static site is not served
   * from the same origin as the function (e.g. GitHub Pages + Vercel).
   * Defaults to the relative `/api/gemini` if unset.
   */
  readonly VITE_GEMINI_ENDPOINT?: string;
}
