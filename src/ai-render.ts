/**
 * Renders an AI reply into `container`: inline ($...$) and block ($$...$$ or
 * \[...\]) LaTeX spans through KaTeX, everything else through a small
 * markdown-lite pass (bold/italic/code, headers, bullet lists, blockquotes,
 * horizontal rules) — replacing the old plain-text-only rendering (which
 * needed `stripMarkdown` as a workaround) and the earlier "no LaTeX, plain
 * words instead" system-prompt workaround this pairs with (see api/gemini.ts).
 *
 * Two-pass, not a single combined parser: math spans are found first (a flat
 * scan for the three delimiter forms), since they can contain characters
 * (`_`, `*`) that would otherwise look like markdown; everything between them
 * is plain markdown source. The results are then regrouped into lines/blocks
 * so inline math still flows inside a paragraph instead of splitting it.
 */
import katex from 'katex';
import 'katex/dist/katex.min.css';

type MathToken = { kind: 'math'; display: boolean; src: string; raw: string };
type TextToken = { kind: 'text'; value: string };

/** Block math ($$...$$ or \[...\]) checked first so its own $ signs aren't read as inline math; incomplete/unclosed math (no matching closer) simply doesn't match and falls through as plain text — see the module doc comment. */
const MATH_RE = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\$([^\n$]+?)\$/g;

function tokenize(text: string): (MathToken | TextToken)[] {
  const out: (MathToken | TextToken)[] = [];
  let last = 0;
  for (const m of text.matchAll(MATH_RE)) {
    if (m.index! > last) out.push({ kind: 'text', value: text.slice(last, m.index) });
    const display = m[1] !== undefined || m[2] !== undefined;
    const src = m[1] ?? m[2] ?? m[3] ?? '';
    out.push({ kind: 'math', display, src, raw: m[0] });
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push({ kind: 'text', value: text.slice(last) });
  return out;
}

/** A KaTeX span, or the raw source (delimiters included) if it doesn't parse — never a KaTeX error box. */
function renderMath(t: MathToken): HTMLElement {
  try {
    const html = katex.renderToString(t.src, { throwOnError: true, displayMode: t.display, output: 'htmlAndMathml' });
    const el = document.createElement(t.display ? 'div' : 'span');
    el.className = t.display ? 'ai-math ai-math--block' : 'ai-math ai-math--inline';
    el.innerHTML = html;
    return el;
  } catch {
    const el = document.createElement('span');
    el.textContent = t.raw;
    return el;
  }
}

/** One line of the original text: either a display-math block, or a run of plain-text/inline-math pieces. */
type Piece = string | MathToken;
type Line = { display: MathToken } | { pieces: Piece[] };

function toLines(tokens: (MathToken | TextToken)[]): Line[] {
  const lines: Line[] = [];
  let cur: Piece[] = [];
  const flush = (): void => {
    if (cur.length) lines.push({ pieces: cur });
    cur = [];
  };
  for (const t of tokens) {
    if (t.kind === 'math' && t.display) {
      flush();
      lines.push({ display: t });
    } else if (t.kind === 'math') {
      cur.push(t);
    } else {
      const parts = t.value.split('\n');
      parts.forEach((part, i) => {
        if (i > 0) flush();
        if (part) cur.push(part);
      });
    }
  }
  flush();
  return lines;
}

/** First piece as plain text, if the line starts with one (block-level markdown only looks at this). */
function leadingText(line: Line): string | null {
  if ('display' in line) return null;
  const first = line.pieces[0];
  return typeof first === 'string' ? first : null;
}

const HEADER_RE = /^#{1,6}\s+/;
const HR_RE = /^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const BULLET_RE = /^[ \t]*[-*+]\s+/;
const QUOTE_RE = /^>\s?/;

/** Inline formatting within one plain-text piece (math is already split out by this point): code, bold, italic; a markdown link keeps just its label, matching the old stripMarkdown behaviour. */
const INLINE_RE = /`([^`]+)`|\[([^\]]+)\]\([^)]+\)|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\n]+)\*|(?<![A-Za-z0-9])_([^_\n]+)_(?![A-Za-z0-9])/g;

function appendInline(host: HTMLElement, text: string): void {
  let last = 0;
  for (const m of text.matchAll(INLINE_RE)) {
    if (m.index! > last) host.append(text.slice(last, m.index));
    if (m[1] !== undefined) host.append(Object.assign(document.createElement('code'), { textContent: m[1] }));
    else if (m[2] !== undefined) host.append(m[2]); // link: label only
    else if (m[3] !== undefined) host.append(Object.assign(document.createElement('strong'), { textContent: m[3] }));
    else if (m[4] !== undefined) host.append(Object.assign(document.createElement('strong'), { textContent: m[4] }));
    else if (m[5] !== undefined) host.append(Object.assign(document.createElement('em'), { textContent: m[5] }));
    else if (m[6] !== undefined) host.append(Object.assign(document.createElement('em'), { textContent: m[6] }));
    last = m.index! + m[0].length;
  }
  if (last < text.length) host.append(text.slice(last));
}

/** Appends a line's pieces (plain-text runs with inline formatting, inline math as KaTeX) into `host` in order. */
function appendPieces(host: HTMLElement, pieces: Piece[]): void {
  for (const p of pieces) {
    if (typeof p === 'string') appendInline(host, p);
    else host.append(renderMath(p));
  }
}

/**
 * Merges a paragraph's buffered lines into one flat Piece[], joining adjacent
 * plain-text runs across the line breaks (with a space, matching how they'd
 * otherwise be visually joined) instead of keeping each line a separate
 * string. Inline formatting (appendInline, via appendPieces) is matched
 * per-string-piece, so a `**bold**`/`*italic*`/code span that happens to wrap
 * onto the next line — ordinary word-wrap in a model's reply, not a
 * paragraph break — would otherwise never see both of its markers in the
 * same piece and would show up as literal, un-rendered asterisks. Math
 * tokens are left as their own pieces (never merged into a string) so inline
 * math is untouched.
 */
function flattenParaLines(para: Piece[][]): Piece[] {
  const out: Piece[] = [];
  const appendStr = (s: string): void => {
    if (out.length && typeof out[out.length - 1] === 'string') out[out.length - 1] = (out[out.length - 1] as string) + s;
    else out.push(s);
  };
  para.forEach((pieces, i) => {
    if (i > 0) appendStr(' ');
    for (const p of pieces) {
      if (typeof p === 'string') appendStr(p);
      else out.push(p);
    }
  });
  return out;
}

/** Strips a line's leading marker (header/bullet/quote) from its first plain-text piece. */
function withoutLead(line: { pieces: Piece[] }, re: RegExp): Piece[] {
  const [first, ...rest] = line.pieces;
  return [typeof first === 'string' ? first.replace(re, '') : first, ...rest];
}

/**
 * Renders `text` into `container` as markdown-lite + KaTeX math, replacing
 * its current children. Falls back to raw text for any math span KaTeX can't
 * parse (see renderMath) — never throws, never shows a KaTeX error box.
 */
export function renderAiReply(container: HTMLElement, text: string): void {
  container.replaceChildren();
  const lines = toLines(tokenize(text));

  let para: Piece[][] | null = null; // buffered plain lines, merged into one <p>
  let list: HTMLUListElement | null = null;
  let quote: HTMLQuoteElement | null = null;

  const flushPara = (): void => {
    if (!para) return;
    const p = document.createElement('p');
    appendPieces(p, flattenParaLines(para));
    container.append(p);
    para = null;
  };
  const closeList = (): void => {
    list = null;
  };
  const closeQuote = (): void => {
    quote = null;
  };

  for (const line of lines) {
    if ('display' in line) {
      flushPara();
      closeList();
      closeQuote();
      container.append(renderMath(line.display));
      continue;
    }
    const lead = leadingText(line);
    if (lead != null && !lead.trim() && line.pieces.length === 1) {
      // blank line: paragraph/list/quote boundary, renders nothing itself
      flushPara();
      closeList();
      closeQuote();
      continue;
    }
    if (lead != null && HR_RE.test(lead) && line.pieces.length === 1) {
      flushPara();
      closeList();
      closeQuote();
      container.append(document.createElement('hr'));
      continue;
    }
    if (lead != null && HEADER_RE.test(lead)) {
      flushPara();
      closeList();
      closeQuote();
      const h = document.createElement('div');
      h.className = 'ai-md-heading';
      appendPieces(h, withoutLead(line, HEADER_RE));
      container.append(h);
      continue;
    }
    if (lead != null && BULLET_RE.test(lead)) {
      flushPara();
      closeQuote();
      if (!list) {
        list = document.createElement('ul');
        container.append(list);
      }
      const li = document.createElement('li');
      appendPieces(li, withoutLead(line, BULLET_RE));
      list.append(li);
      continue;
    }
    if (lead != null && QUOTE_RE.test(lead)) {
      flushPara();
      closeList();
      if (!quote) {
        quote = document.createElement('blockquote');
        container.append(quote);
      }
      const p = document.createElement('p');
      appendPieces(p, withoutLead(line, QUOTE_RE));
      quote.append(p);
      continue;
    }
    // plain line: buffer into the current paragraph
    closeList();
    closeQuote();
    para ??= [];
    para.push(line.pieces);
  }
  flushPara();
}
