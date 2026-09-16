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

/** One line of the original text: either a display-math block, or a run of plain-text/inline-math pieces. A line with a single empty-string piece is an explicit blank-line marker (a hard block boundary) — see toLines. */
type Piece = string | MathToken;
type Line = { display: MathToken } | { pieces: Piece[] };

/**
 * Splits the token stream into lines, on single '\n's, the same as before —
 * but a run of *two or more* consecutive newlines (a genuine blank line
 * between blocks) is now emitted as its own explicit line with a single
 * empty-string piece, rather than silently disappearing.
 *
 * That distinction matters once callers merge a block's own wrapped
 * continuation lines together (see renderAiReply): without it, "blank line"
 * and "ordinary single-newline wrap" were indistinguishable here — a genuine
 * paragraph break after a heading or list would have been read as more of
 * that heading/list's own text and swallowed into it. Detected per text
 * chunk (via a capturing split on the newline run itself, so a lone
 * remainder never gets read as a blank line — see the trailing-empty-string
 * case below); a blank line that happens to fall exactly on a boundary
 * between two chunks (e.g. right after an inline math span) is the one case
 * this doesn't catch, since each chunk is only ever compared against itself.
 */
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
      for (const part of t.value.split(/(\n+)/)) {
        if (part === '') continue; // an empty string only ever shows up as a split artifact (start/end), never a real gap
        if (/^\n+$/.test(part)) {
          flush();
          if (part.length > 1) lines.push({ pieces: [''] }); // 2+ newlines: a real blank-line boundary
        } else {
          cur.push(part);
        }
      }
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

/** Appends a block's pieces (plain-text runs with inline formatting, inline math as KaTeX) into `host` in order. */
function appendPieces(host: HTMLElement, pieces: Piece[]): void {
  for (const p of pieces) {
    if (typeof p === 'string') appendInline(host, p);
    else host.append(renderMath(p));
  }
}

/**
 * Merges a block's buffered lines into one flat Piece[], joining adjacent
 * plain-text runs across the line breaks (with a space, matching how they'd
 * otherwise be visually joined) instead of keeping each line a separate
 * string. Inline formatting (appendInline, via appendPieces) is matched
 * per-string-piece, so a `**bold**`/`*italic*`/code span that happens to wrap
 * onto the next line — ordinary word-wrap in a model's reply, not a block
 * boundary — would otherwise never see both of its markers in the same piece
 * and would show up as literal, un-rendered asterisks. Used for every block
 * kind (paragraph, heading, list item, quote line) so a wrapped span inside
 * any of them renders the same way. Math tokens are left as their own pieces
 * (never merged into a string) so inline math is untouched.
 */
function flattenLines(blockLines: Piece[][]): Piece[] {
  const out: Piece[] = [];
  const appendStr = (s: string): void => {
    if (out.length && typeof out[out.length - 1] === 'string') out[out.length - 1] = (out[out.length - 1] as string) + s;
    else out.push(s);
  };
  blockLines.forEach((pieces, i) => {
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

type BlockKind = 'para' | 'heading' | 'bullet' | 'quote';

/**
 * Renders `text` into `container` as markdown-lite + KaTeX math, replacing
 * its current children. Falls back to raw text for any math span KaTeX can't
 * parse (see renderMath) — never throws, never shows a KaTeX error box.
 *
 * Every block kind (paragraph, heading, list item, quote line) buffers its
 * own physical lines the same way: a marker line (`#`/`-`/`>`/etc.) starts a
 * new block, and any further plain lines — no marker of their own, just a
 * model's own word-wrap — keep extending *that* block until a blank line or
 * a new marker ends it (see `current`/`flushCurrent` below). They're then
 * flattened (flattenLines) and inline-formatted (appendPieces) together, so
 * a bold/italic/code span that happens to wrap mid-heading or mid-bullet is
 * matched the same as one that wraps mid-paragraph.
 */
export function renderAiReply(container: HTMLElement, text: string): void {
  container.replaceChildren();
  const lines = toLines(tokenize(text));

  let current: { kind: BlockKind; lines: Piece[][] } | null = null;
  let list: HTMLUListElement | null = null;
  let quote: HTMLQuoteElement | null = null;

  const flushCurrent = (): void => {
    if (!current) return;
    const pieces = flattenLines(current.lines);
    if (current.kind === 'para') {
      const p = document.createElement('p');
      appendPieces(p, pieces);
      container.append(p);
    } else if (current.kind === 'heading') {
      const h = document.createElement('div');
      h.className = 'ai-md-heading';
      appendPieces(h, pieces);
      container.append(h);
    } else if (current.kind === 'bullet') {
      if (!list) {
        list = document.createElement('ul');
        container.append(list);
      }
      const li = document.createElement('li');
      appendPieces(li, pieces);
      list.append(li);
    } else {
      if (!quote) {
        quote = document.createElement('blockquote');
        container.append(quote);
      }
      const p = document.createElement('p');
      appendPieces(p, pieces);
      quote.append(p);
    }
    current = null;
  };
  const closeList = (): void => {
    list = null;
  };
  const closeQuote = (): void => {
    quote = null;
  };
  /** Ends whatever block was open and starts a new one of `kind` from this marker line's own (lead-stripped) pieces. */
  const startBlock = (kind: BlockKind, pieces: Piece[]): void => {
    flushCurrent();
    current = { kind, lines: [pieces] };
  };

  for (const line of lines) {
    if ('display' in line) {
      flushCurrent();
      closeList();
      closeQuote();
      container.append(renderMath(line.display));
      continue;
    }
    const lead = leadingText(line);
    if (lead != null && !lead.trim() && line.pieces.length === 1) {
      // blank line: ends the current block (of any kind) and any open list/quote grouping
      flushCurrent();
      closeList();
      closeQuote();
      continue;
    }
    if (lead != null && HR_RE.test(lead) && line.pieces.length === 1) {
      flushCurrent();
      closeList();
      closeQuote();
      container.append(document.createElement('hr'));
      continue;
    }
    if (lead != null && HEADER_RE.test(lead)) {
      closeList();
      closeQuote();
      startBlock('heading', withoutLead(line, HEADER_RE));
      continue;
    }
    if (lead != null && BULLET_RE.test(lead)) {
      closeQuote(); // a fresh bullet still joins the current <ul> (not closed here) — only a blank line or a quote/heading ends the list
      startBlock('bullet', withoutLead(line, BULLET_RE));
      continue;
    }
    if (lead != null && QUOTE_RE.test(lead)) {
      closeList(); // a fresh quote line still joins the current <blockquote> — only a blank line or a list/heading ends it
      startBlock('quote', withoutLead(line, QUOTE_RE));
      continue;
    }
    // plain line, no marker of its own: continues whatever block is currently open
    // (a model's own word-wrap inside that heading/bullet/quote/paragraph),
    // or starts a fresh paragraph if nothing is open.
    current ??= { kind: 'para', lines: [] };
    current.lines.push(line.pieces);
  }
  flushCurrent();
}
