import { describe, expect, it } from "vitest";
import {
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_CHARS,
  MAX_SINGLE_ATTACHMENT_CHARS,
  acceptFile,
  acceptText,
  composeMessage,
  extensionOf,
  fenceFor,
  formatSize,
  isTextLike,
  type Attachment,
} from "./attachments";

const file = (name: string, type = "", size = 100) => ({ name, type, size });

describe("isTextLike", () => {
  it("takes anything the browser calls text", () => {
    expect(isTextLike(file("notes", "text/plain"))).toBe(true);
    expect(isTextLike(file("data", "application/json"))).toBe(true);
  });

  it("takes code and data by extension when the browser says nothing", () => {
    for (const name of ["index.ts", "main.py", "schema.sql", "notes.md", "rows.csv", "deploy.sh", "app.tsx"]) {
      expect(isTextLike(file(name)), name).toBe(true);
    }
  });

  it("takes the well-known files that have no extension", () => {
    expect(isTextLike(file("Dockerfile"))).toBe(true);
    expect(isTextLike(file("Makefile"))).toBe(true);
    expect(isTextLike(file("LICENSE"))).toBe(true);
  });

  it("refuses images, audio and video even with a tempting name", () => {
    expect(isTextLike(file("diagram.png", "image/png"))).toBe(false);
    expect(isTextLike(file("song.mp3", "audio/mpeg"))).toBe(false);
    // An SVG is text, but a PNG that someone renamed is not.
    expect(isTextLike(file("photo.svg", "image/png"))).toBe(false);
  });

  it("refuses what it does not recognise, rather than guessing", () => {
    expect(isTextLike(file("archive.zip"))).toBe(false);
    expect(isTextLike(file("report.pdf"))).toBe(false);
    expect(isTextLike(file("program.exe"))).toBe(false);
    expect(isTextLike(file("nameless"))).toBe(false);
  });
});

describe("acceptFile", () => {
  it("accepts an ordinary text file", () => {
    expect(acceptFile(file("notes.md", "text/markdown", 2_000), 0).ok).toBe(true);
  });

  it("stops at the attachment count", () => {
    const result = acceptFile(file("a.txt", "text/plain", 10), MAX_ATTACHMENTS);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain(String(MAX_ATTACHMENTS));
  });

  it("refuses something too big before reading a byte of it", () => {
    const result = acceptFile(file("huge.txt", "text/plain", MAX_ATTACHMENT_BYTES + 1), 0);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("too large");
  });

  it("says why a binary was refused, naming the file", () => {
    const result = acceptFile(file("photo.png", "image/png", 500), 0);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("photo.png");
  });
});

describe("acceptText", () => {
  const attached = (chars: number): Attachment[] => [{ name: "a.txt", text: "x".repeat(chars) }];

  it("accepts text that fits", () => {
    expect(acceptText("b.txt", "hello", []).ok).toBe(true);
  });

  it("refuses one file that is too long on its own", () => {
    const result = acceptText("b.txt", "x".repeat(MAX_SINGLE_ATTACHMENT_CHARS + 1), []);
    expect(result.ok).toBe(false);
  });

  it("refuses the file that would push the total over", () => {
    const result = acceptText("b.txt", "x".repeat(MAX_SINGLE_ATTACHMENT_CHARS), attached(MAX_ATTACHMENT_CHARS - 10));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("Remove one");
  });

  it("refuses an empty file, which costs a line and says nothing", () => {
    expect(acceptText("b.txt", "   \n  ", []).ok).toBe(false);
  });
});

describe("fenceFor", () => {
  it("uses three backticks for ordinary text", () => {
    expect(fenceFor("hello")).toBe("```");
  });

  it("grows past any run of backticks inside the file", () => {
    expect(fenceFor("a ``` b")).toBe("````");
    expect(fenceFor("a ````` b")).toBe("``````");
  });

  it("stops a markdown file from breaking out of its own block", () => {
    const markdown = "# Title\n\n```js\nconst a = 1;\n```\n";
    const composed = composeMessage("what is this", [{ name: "readme.md", text: markdown }]);
    const fence = fenceFor(markdown);
    expect(fence.length).toBeGreaterThan(3);
    // The inner fence never equals the outer one, so the block cannot close early.
    expect(composed.split(fence)).toHaveLength(3);
  });
});

describe("composeMessage", () => {
  it("is the message itself when nothing is attached", () => {
    expect(composeMessage("hello", [])).toBe("hello");
  });

  it("puts the file before the question, so the question is read last", () => {
    const composed = composeMessage("explain this", [{ name: "a.ts", text: "const a = 1;" }]);
    expect(composed.indexOf("a.ts")).toBeLessThan(composed.indexOf("explain this"));
    expect(composed).toContain("```ts");
    expect(composed).toContain("const a = 1;");
  });

  it("counts the files when there is more than one", () => {
    const composed = composeMessage("compare", [
      { name: "a.ts", text: "1" },
      { name: "b.ts", text: "2" },
    ]);
    expect(composed).toContain("attached 2 files");
  });

  it("sends the files even when nothing was typed", () => {
    const composed = composeMessage("   ", [{ name: "a.txt", text: "body" }]);
    expect(composed).toContain("body");
    expect(composed.trimEnd().endsWith("```")).toBe(true);
  });
});

describe("extensionOf and formatSize", () => {
  it("reads an extension, and nothing from a dotfile", () => {
    expect(extensionOf("a/b/c.tsx")).toBe("tsx");
    expect(extensionOf("Makefile")).toBe("");
    expect(extensionOf(".gitignore")).toBe("");
  });

  it("writes a size a person can read", () => {
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(2048)).toBe("2 KB");
    expect(formatSize(1_572_864)).toBe("1.5 MB");
  });
});
