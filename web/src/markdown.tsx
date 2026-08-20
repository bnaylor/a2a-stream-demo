/**
 * Markdown-lite: the three inline marks agents actually emit — `**bold**`,
 * `*italic*` / `_italic_`, and `` `code` `` — turned into React elements.
 *
 * Deliberately not a markdown parser. It never touches `dangerouslySetInnerHTML`
 * and never produces an element it did not construct itself, so anything that
 * looks like markup in agent output (`<b>`, `<script>`, a stray `&`) survives
 * as inert text: React escapes every string it is handed.
 *
 * Where the syntax is ambiguous the parser stands down and leaves the literal
 * characters alone. An unclosed `**`, a `*` used as multiplication, a `_` in
 * the middle of `snake_case` — all of those read as text, because a wrong
 * emphasis is worse than a missing one in a transcript people are reading fast.
 */
import type { ReactNode } from "react";

/** Emphasis never opens or closes against whitespace: `2 * 3 * 4` is arithmetic. */
function isEmphasisBody(body: string): boolean {
  return body.length > 0 && !/^\s/.test(body) && !/\s$/.test(body);
}

/** `_` only marks emphasis at a word boundary, so identifiers stay intact. */
function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /\w/.test(ch);
}

/**
 * Where the code spans are, computed up front so an emphasis marker can never
 * close against a delimiter that is really inside backticks: in
 * ``**run `a**b` now**`` the middle `**` is code, and the run closes at the end.
 */
function codeRanges(src: string): [number, number][] {
  const ranges: [number, number][] = [];
  let i = 0;
  while (i < src.length) {
    if (src[i] === "`") {
      const close = src.indexOf("`", i + 1);
      if (close > i + 1) {
        ranges.push([i, close]);
        i = close + 1;
        continue;
      }
    }
    i++;
  }
  return ranges;
}

/** First occurrence of `needle` at or after `from` that is not inside code. */
function findClose(src: string, needle: string, from: number, ranges: [number, number][]): number {
  let at = src.indexOf(needle, from);
  while (at >= 0 && ranges.some(([a, b]) => at > a && at < b)) {
    at = src.indexOf(needle, at + 1);
  }
  return at;
}

function parse(src: string, key: string, strong: boolean, em: boolean): ReactNode[] {
  const out: ReactNode[] = [];
  const ranges = codeRanges(src);
  let buf = "";
  let i = 0;
  let n = 0;

  const flush = () => {
    if (buf.length > 0) {
      out.push(buf);
      buf = "";
    }
  };
  const push = (node: ReactNode) => {
    flush();
    out.push(node);
  };

  while (i < src.length) {
    const ch = src[i];

    // Code wins over emphasis: `**not bold**` inside backticks is literal.
    if (ch === "`") {
      const close = src.indexOf("`", i + 1);
      if (close > i + 1) {
        push(
          <code key={`${key}c${n++}`} className="md-code">
            {src.slice(i + 1, close)}
          </code>,
        );
        i = close + 1;
        continue;
      }
    } else if (strong && ch === "*" && src[i + 1] === "*") {
      const close = findClose(src, "**", i + 2, ranges);
      const body = close > i + 2 ? src.slice(i + 2, close) : "";
      if (isEmphasisBody(body)) {
        push(
          <strong key={`${key}b${n++}`}>{parse(body, `${key}b${n}`, false, em)}</strong>,
        );
        i = close + 2;
        continue;
      }
    } else if (em && (ch === "*" || ch === "_")) {
      // A lone `*` inside a `**` run is the strong marker, not emphasis.
      if (!(ch === "*" && src[i + 1] === "*") && !(ch === "_" && isWordChar(src[i - 1]))) {
        const close = findClose(src, ch, i + 1, ranges);
        const body = close > i + 1 ? src.slice(i + 1, close) : "";
        const boundary = ch === "*" || !isWordChar(src[close + 1]);
        if (isEmphasisBody(body) && boundary) {
          push(<em key={`${key}i${n++}`}>{parse(body, `${key}i${n}`, strong, false)}</em>);
          i = close + 1;
          continue;
        }
      }
    }

    buf += ch;
    i++;
  }

  flush();
  return out;
}

/** Inline nodes for one run of agent text. Pure; safe to call during render. */
export function renderMarkdown(text: string): ReactNode[] {
  return parse(text, "m", true, true);
}

/** The same thing as a component, for the common `<span><Markdown …/></span>`. */
export default function Markdown({ text }: { text: string }) {
  return <>{renderMarkdown(text)}</>;
}
