"use client";

import { useState } from "react";

/**
 * A terminal command a person is meant to paste, with a button that copies it.
 *
 * Commands are the one piece of text on the site that has to be exactly right:
 * a missing hyphen or a curly quote turns "run this" into a confusing error.
 * So it is shown in a monospace box, selectable as a whole, and copyable in one
 * click instead of being dragged out of a sentence.
 */
export function CopyCommand({ command, label }: { command: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <code
        className="tnum select-all rounded-md border border-[var(--border-strong)] bg-[var(--background)] px-2.5 py-1 text-[12px]"
        aria-label={label ?? "Command"}
      >
        {command}
      </code>
      <button
        type="button"
        className="rounded-md border border-[var(--border)] px-2 py-1 text-[10px] uppercase tracking-[0.12em] text-[var(--muted)] hover:border-[var(--border-strong)] hover:text-[var(--foreground)]"
        onClick={() => {
          void navigator.clipboard?.writeText(command);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1600);
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
