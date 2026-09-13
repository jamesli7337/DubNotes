/**
 * Strips common Markdown syntax from AI-generated text for plain display in
 * the chat panel — not a full parser, just enough to turn what an LLM
 * typically produces (bold/italic, headers, rules, code, links, lists) into
 * readable plain text. LaTeX-style math delimiters are a separate, not-yet-
 * decided piece — see the AI-mode report — and are untouched here.
 */
export function stripMarkdown(text: string): string {
  let t = text;

  // fenced code blocks: keep the content, drop the ``` fences and language tag
  t = t.replace(/```[^\n]*\n([\s\S]*?)```/g, (_, code: string) => code.trim());
  // inline code
  t = t.replace(/`([^`]+)`/g, '$1');
  // headers: "## Heading" -> "Heading"
  t = t.replace(/^#{1,6}\s+/gm, '');
  // horizontal rules: a line of only -, *, or _ (3 or more, optionally spaced)
  t = t.replace(/^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, '');
  // bold/italic, most-specific first so e.g. ***x*** doesn't half-match as *x*
  t = t.replace(/\*\*\*([^*]+)\*\*\*/g, '$1');
  t = t.replace(/___([^_]+)___/g, '$1');
  t = t.replace(/\*\*([^*]+)\*\*/g, '$1');
  t = t.replace(/__([^_]+)__/g, '$1');
  t = t.replace(/\*([^*\n]+)\*/g, '$1');
  t = t.replace(/(?<![A-Za-z0-9])_([^_\n]+)_(?![A-Za-z0-9])/g, '$1');
  // links: [text](url) -> text
  t = t.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  // blockquotes: "> text" -> "text"
  t = t.replace(/^>\s?/gm, '');
  // bullet lists: "- item" / "* item" / "+ item" -> "• item"
  t = t.replace(/^[ \t]*[-*+]\s+/gm, '• ');
  // the rules/header strips above can leave stray blank-line runs
  t = t.replace(/\n{3,}/g, '\n\n');
  return t.trim();
}
