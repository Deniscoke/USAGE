import { describe, expect, it } from "vitest";
import { looksLikeDocument, parseInline, parseMarkdown, safeHref, type Block } from "./markdown";

/**
 * Model output is untrusted text that happens to be Markdown. The parser has
 * two jobs: show the structure, and never produce anything but the nodes it
 * knows about.
 */

const text = (value: string) => ({ type: "text", value }) as const;

describe("blocks", () => {
  it("reads headings, paragraphs and rules", () => {
    const blocks = parseMarkdown("## Recept\n\nNiečo dobré.\n\n---\n");
    expect(blocks).toEqual<Block[]>([
      { type: "heading", level: 2, children: [text("Recept")] },
      { type: "paragraph", children: [text("Niečo dobré.")] },
      { type: "rule" },
    ]);
  });

  it("reads both kinds of list, keeping the number it started at", () => {
    const [unordered, ordered] = parseMarkdown("- one\n- two\n\n3. three\n4. four");
    expect(unordered).toEqual({ type: "list", ordered: false, start: 1, items: [[text("one")], [text("two")]] });
    expect(ordered).toMatchObject({ type: "list", ordered: true, start: 3 });
  });

  it("joins a wrapped list item instead of starting a paragraph", () => {
    const [list] = parseMarkdown("1. Zmiešaj múku\n   s kypriacim práškom.\n2. Peč.");
    expect(list).toMatchObject({ type: "list", items: [[text("Zmiešaj múku s kypriacim práškom.")], [text("Peč.")]] });
  });

  it("reads a fenced code block and keeps its text exactly", () => {
    const [code] = parseMarkdown("```ts\nconst a = 1;\n\nconst b = 2;\n```");
    expect(code).toEqual({ type: "code", language: "ts", value: "const a = 1;\n\nconst b = 2;" });
  });

  it("renders an unclosed fence as the code it has so far", () => {
    // Every streaming reply passes through this state.
    const [code] = parseMarkdown("```\nhalf a thing");
    expect(code).toEqual({ type: "code", language: null, value: "half a thing" });
  });

  it("reads a table only when the divider is there", () => {
    const [table] = parseMarkdown("| a | b |\n| --- | --- |\n| 1 | 2 |");
    expect(table).toEqual({
      type: "table",
      head: [[text("a")], [text("b")]],
      rows: [[[text("1")], [text("2")]]],
    });
    // Without a divider it is a paragraph containing pipes, not a table.
    expect(parseMarkdown("| a | b |\njust text")[0]!.type).toBe("paragraph");
  });

  it("reads a blockquote across its lines", () => {
    expect(parseMarkdown("> first\n> second")).toEqual([{ type: "quote", children: [text("first second")] }]);
  });
});

describe("inline", () => {
  it("reads bold, italic and code", () => {
    expect(parseInline("**bold** and *soft* and `x`")).toEqual([
      { type: "strong", children: [text("bold")] },
      text(" and "),
      { type: "em", children: [text("soft")] },
      text(" and "),
      { type: "code", value: "x" },
    ]);
  });

  it("does not find markup inside a code span", () => {
    expect(parseInline("`**not bold**`")).toEqual([{ type: "code", value: "**not bold**" }]);
  });

  it("leaves a lone asterisk alone", () => {
    expect(parseInline("2 * 3 = 6")).toEqual([text("2 * 3 = 6")]);
    expect(parseInline("**unclosed")).toEqual([text("**unclosed")]);
  });

  it("reads links, and refuses any scheme but http, https and mailto", () => {
    expect(parseInline("[docs](https://example.com/a)")).toEqual([
      { type: "link", href: "https://example.com/a", children: [text("docs")] },
    ]);
    // A javascript: link renders as the literal text it is.
    expect(parseInline("[click](javascript:alert(1))")).toEqual([text("[click](javascript:alert(1))")]);
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("data:text/html,x")).toBeNull();
    expect(safeHref("/download")).toBe("/download");
  });

  it("keeps every character of text it does not understand", () => {
    const odd = "<script>alert(1)</script> & ampersands 100% ~tilde~";
    expect(parseInline(odd)).toEqual([text(odd)]);
  });
});

describe("looksLikeDocument", () => {
  const doc = "# Title\n\n- one\n- two\n\n" + "x".repeat(400);
  it("offers a document for something shaped like one", () => {
    expect(looksLikeDocument(parseMarkdown(doc), doc)).toBe(true);
  });

  it("does not offer one for a chatty answer", () => {
    const chat = "Sure, that works fine. ".repeat(10);
    expect(looksLikeDocument(parseMarkdown(chat), chat)).toBe(false);
  });

  it("offers one for anything long, structured or not", () => {
    const long = "word ".repeat(300);
    expect(looksLikeDocument(parseMarkdown(long), long)).toBe(true);
  });
});
