/**
 * Files dropped into the chat.
 *
 * A dropped file is read in the browser, turned into text, and folded into the
 * message that is sent. It is never uploaded as a file and never stored by
 * USAGE: there is no bucket, no attachments table and no server-side copy.
 * The bytes exist in the tab, go out inside the request body like any other
 * text, and are kept afterwards only in the reader's own browser history --
 * the same place the rest of the conversation lives.
 *
 * Text only, on purpose. The gateway body allows a message to be a string and
 * nothing else, which is what keeps a browser tab from posting arbitrary
 * structures to a provider. Images would need that boundary widened and a
 * per-model capability check, and neither is worth doing blind.
 */

/** Total characters all attachments on one message may contribute. */
export const MAX_ATTACHMENT_CHARS = 24_000;
/** No single file may fill the whole budget and crowd out the question. */
export const MAX_SINGLE_ATTACHMENT_CHARS = 20_000;
/** Refused before reading: a binary this size is never text we can use. */
export const MAX_ATTACHMENT_BYTES = 1_000_000;
export const MAX_ATTACHMENTS = 6;

/**
 * Extensions we will read as text. An allowlist rather than a denylist: the
 * failure mode of guessing wrong is pasting megabytes of binary into somebody's
 * paid context window, so unknown means no.
 */
const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "rst", "log", "csv", "tsv",
  "json", "jsonc", "json5", "yaml", "yml", "toml", "ini", "cfg", "conf", "env",
  "html", "htm", "xml", "svg", "css", "scss", "sass", "less",
  "js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts",
  "py", "rb", "go", "rs", "java", "kt", "kts", "swift", "c", "h", "cc", "cpp", "hpp", "cs",
  "php", "pl", "lua", "r", "jl", "scala", "clj", "ex", "exs", "erl", "hs", "elm", "dart", "zig",
  "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd",
  "sql", "graphql", "gql", "proto", "diff", "patch",
  "dockerfile", "gitignore", "gitattributes", "editorconfig", "npmrc", "prettierrc", "eslintrc",
]);

/** Files with no extension that are still plainly text. */
const TEXT_FILENAMES = new Set([
  "dockerfile", "makefile", "rakefile", "gemfile", "procfile", "license", "readme", "changelog", "codeowners",
]);

export interface DroppedFile {
  name: string;
  size: number;
  type: string;
}

export interface Attachment {
  name: string;
  text: string;
}

export function extensionOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** Would we read this as text? */
export function isTextLike(file: Pick<DroppedFile, "name" | "type">): boolean {
  const type = (file.type ?? "").toLowerCase();
  if (type.startsWith("text/")) return true;
  if (/^application\/(json|xml|x-yaml|yaml|javascript|sql|toml|x-sh)$/.test(type)) return true;
  if (type.startsWith("image/") || type.startsWith("audio/") || type.startsWith("video/")) return false;

  const base = (file.name.split(/[\\/]/).pop() ?? file.name).toLowerCase();
  if (TEXT_FILENAMES.has(base) || TEXT_FILENAMES.has(base.replace(/\..*$/, ""))) return true;
  const extension = extensionOf(file.name);
  return extension !== "" && TEXT_EXTENSIONS.has(extension);
}

export type AcceptResult = { ok: true } | { ok: false; reason: string };

/** Whether a file may be read at all, before anything is read. */
export function acceptFile(file: DroppedFile, alreadyAttached: number): AcceptResult {
  if (alreadyAttached >= MAX_ATTACHMENTS) {
    return { ok: false, reason: `At most ${MAX_ATTACHMENTS} files on one message.` };
  }
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return { ok: false, reason: `${file.name} is too large. Attach text files under 1 MB, or paste the part that matters.` };
  }
  if (!isTextLike(file)) {
    return { ok: false, reason: `${file.name} is not a text file. Text, data and code files can be attached; images and binaries cannot.` };
  }
  return { ok: true };
}

/** Does this file's text fit alongside what is already attached? */
export function acceptText(name: string, text: string, attached: readonly Attachment[]): AcceptResult {
  if (text.length > MAX_SINGLE_ATTACHMENT_CHARS) {
    return {
      ok: false,
      reason: `${name} is ${text.length.toLocaleString()} characters, over the ${MAX_SINGLE_ATTACHMENT_CHARS.toLocaleString()} allowed for one file.`,
    };
  }
  const used = attached.reduce((sum, attachment) => sum + attachment.text.length, 0);
  if (used + text.length > MAX_ATTACHMENT_CHARS) {
    return { ok: false, reason: `That would put the attachments over ${MAX_ATTACHMENT_CHARS.toLocaleString()} characters. Remove one first.` };
  }
  // A file of nothing tells the model nothing and still costs a line.
  if (text.trim().length === 0) return { ok: false, reason: `${name} is empty.` };
  return { ok: true };
}

/**
 * A fence long enough that the file cannot break out of it.
 *
 * A file containing ``` would otherwise end its own block and the rest would
 * read as instructions rather than as content.
 */
export function fenceFor(text: string): string {
  const longest = [...text.matchAll(/`+/g)].reduce((max, match) => Math.max(max, match[0].length), 0);
  return "`".repeat(Math.max(3, longest + 1));
}

/** What actually gets sent: the files, then the question. */
export function composeMessage(text: string, attachments: readonly Attachment[]): string {
  if (attachments.length === 0) return text;

  const blocks = attachments.map((attachment) => {
    const fence = fenceFor(attachment.text);
    const language = extensionOf(attachment.name);
    return `${attachment.name}\n${fence}${language}\n${attachment.text}\n${fence}`;
  });

  const preamble =
    attachments.length === 1
      ? "The user attached this file:"
      : `The user attached ${attachments.length} files:`;

  const question = text.trim();
  return [preamble, blocks.join("\n\n"), question].filter((part) => part.length > 0).join("\n\n");
}

/** Bytes, for a chip that says how big something is. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
