/**
 * The small Markdown a chat reply actually uses.
 *
 * Models answer in Markdown whether or not anybody asked, so a chat that
 * renders it as plain text shows people asterisks and pound signs instead of
 * structure. This parses the subset that matters -- headings, lists, tables,
 * code, quotes, rules, and inline bold/italic/code/links -- and nothing else.
 *
 * It produces a tree, never HTML. The renderer builds React elements from it,
 * so there is no `dangerouslySetInnerHTML` anywhere and a reply cannot inject
 * markup no matter what a provider returns. That is the whole reason this is
 * hand-written rather than a dependency: the output of a language model is
 * untrusted text, and the safest renderer is one that can only produce the
 * nodes it knows about.
 *
 * Unrecognised syntax stays as literal text. A half-finished document -- which
 * is what every streaming reply is, most of the time -- must render as itself
 * rather than disappear.
 */

export type Inline =
  | { type: "text"; value: string }
  | { type: "strong"; children: Inline[] }
  | { type: "em"; children: Inline[] }
  | { type: "code"; value: string }
  | { type: "link"; href: string; children: Inline[] };

export type Block =
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; children: Inline[] }
  | { type: "paragraph"; children: Inline[] }
  | { type: "list"; ordered: boolean; start: number; items: Inline[][] }
  | { type: "code"; language: string | null; value: string }
  | { type: "quote"; children: Inline[] }
  | { type: "table"; head: Inline[][]; rows: Inline[][][] }
  | { type: "rule" };

const HEADING = /^(#{1,6})\s+(.*)$/;
const FENCE = /^```([A-Za-z0-9_+-]*)\s*$/;
const BULLET = /^\s{0,3}[-*+]\s+(.*)$/;
const ORDERED = /^\s{0,3}(\d{1,9})[.)]\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/;

export function parseMarkdown(input: string): Block[] {
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index]!;

    if (line.trim() === "") {
      index += 1;
      continue;
    }

    const fence = FENCE.exec(line.trim());
    if (fence) {
      const language = fence[1] ? fence[1] : null;
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index]!.trim())) {
        body.push(lines[index]!);
        index += 1;
      }
      // A fence that never closes is a reply still streaming: show what it has.
      if (index < lines.length) index += 1;
      blocks.push({ type: "code", language, value: body.join("\n") });
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ type: "rule" });
      index += 1;
      continue;
    }

    const heading = HEADING.exec(line.trim());
    if (heading) {
      blocks.push({
        type: "heading",
        level: heading[1]!.length as 1 | 2 | 3 | 4 | 5 | 6,
        children: parseInline(heading[2]!.trim()),
      });
      index += 1;
      continue;
    }

    // A table needs its divider on the second line, or it is just text.
    if (line.includes("|") && index + 1 < lines.length && TABLE_DIVIDER.test(lines[index + 1]!)) {
      const head = splitRow(line);
      index += 2;
      const rows: Inline[][][] = [];
      while (index < lines.length && lines[index]!.includes("|") && lines[index]!.trim() !== "") {
        rows.push(splitRow(lines[index]!).map(parseInline));
        index += 1;
      }
      blocks.push({ type: "table", head: head.map(parseInline), rows });
      continue;
    }

    if (BULLET.test(line) || ORDERED.test(line)) {
      const ordered = !BULLET.test(line);
      const start = ordered ? Number(ORDERED.exec(line)![1]) : 1;
      const items: Inline[][] = [];
      while (index < lines.length) {
        const current = lines[index]!;
        const bullet = BULLET.exec(current);
        const numbered = ORDERED.exec(current);
        const isSameKind = ordered ? Boolean(numbered) : Boolean(bullet);
        if (!isSameKind) break;
        const text = ordered ? numbered![2]! : bullet![1]!;
        const parts = [text];
        index += 1;
        // A wrapped line belongs to the item above it.
        while (
          index < lines.length &&
          lines[index]!.trim() !== "" &&
          !BULLET.test(lines[index]!) &&
          !ORDERED.test(lines[index]!) &&
          !HEADING.test(lines[index]!.trim()) &&
          !FENCE.test(lines[index]!.trim())
        ) {
          parts.push(lines[index]!.trim());
          index += 1;
        }
        items.push(parseInline(parts.join(" ")));
      }
      blocks.push({ type: "list", ordered, start, items });
      continue;
    }

    if (QUOTE.test(line)) {
      const parts: string[] = [];
      while (index < lines.length && QUOTE.test(lines[index]!)) {
        parts.push(QUOTE.exec(lines[index]!)![1]!);
        index += 1;
      }
      blocks.push({ type: "quote", children: parseInline(parts.join(" ").trim()) });
      continue;
    }

    const paragraph: string[] = [];
    while (
      index < lines.length &&
      lines[index]!.trim() !== "" &&
      !HEADING.test(lines[index]!.trim()) &&
      !FENCE.test(lines[index]!.trim()) &&
      !BULLET.test(lines[index]!) &&
      !ORDERED.test(lines[index]!) &&
      !QUOTE.test(lines[index]!) &&
      !RULE.test(lines[index]!)
    ) {
      paragraph.push(lines[index]!.trim());
      index += 1;
    }
    blocks.push({ type: "paragraph", children: parseInline(paragraph.join(" ")) });
  }

  return blocks;
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

/** http, https and mailto only. Anything else renders as text, not a link. */
export function safeHref(href: string): string | null {
  const trimmed = href.trim();
  if (/^(https?:|mailto:)/i.test(trimmed) && !/[\s<>"]/.test(trimmed)) return trimmed;
  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) return trimmed;
  return null;
}

const INLINE_CODE = /^`([^`]+)`/;
const LINK = /^\[([^\]]*)\]\(([^)\s]+)\)/;
const STRONG = /^(\*\*|__)([\s\S]+?)\1/;
const EM = /^(\*|_)(?!\s)([\s\S]+?)(?<!\s)\1/;

export function parseInline(input: string): Inline[] {
  const out: Inline[] = [];
  let rest = input;
  let plain = "";

  const flush = () => {
    if (plain) {
      out.push({ type: "text", value: plain });
      plain = "";
    }
  };

  while (rest.length > 0) {
    // Code first: nothing inside a code span is markup.
    const code = INLINE_CODE.exec(rest);
    if (code) {
      flush();
      out.push({ type: "code", value: code[1]! });
      rest = rest.slice(code[0].length);
      continue;
    }

    const link = LINK.exec(rest);
    if (link) {
      const href = safeHref(link[2]!);
      if (href) {
        flush();
        out.push({ type: "link", href, children: parseInline(link[1]!) });
        rest = rest.slice(link[0].length);
        continue;
      }
    }

    const strong = STRONG.exec(rest);
    if (strong) {
      flush();
      out.push({ type: "strong", children: parseInline(strong[2]!) });
      rest = rest.slice(strong[0].length);
      continue;
    }

    const em = EM.exec(rest);
    if (em) {
      flush();
      out.push({ type: "em", children: parseInline(em[2]!) });
      rest = rest.slice(em[0].length);
      continue;
    }

    plain += rest[0];
    rest = rest.slice(1);
  }

  flush();
  return out;
}

/**
 * Is this reply long or structured enough to be worth opening as a document?
 *
 * The question the button answers is "do I want this on a page of its own",
 * and that is about shape, not length alone: a recipe with headings and a
 * list is a document at 400 characters, a chatty paragraph is not at 2000.
 */
export function looksLikeDocument(blocks: readonly Block[], text: string): boolean {
  const structural = blocks.filter((b) => b.type === "heading" || b.type === "table" || b.type === "list" || b.type === "code").length;
  return text.length >= 900 || (structural >= 2 && text.length >= 300);
}
