"use client";

import { useState } from "react";

/**
 * The wallet identifier, with a button that copies it.
 *
 * Shown openly rather than masked, because it is an identifier and not a
 * secret: it authenticates nothing, authorises nothing, and appears in no
 * row-level policy. It exists so a person can say which wallet is theirs
 * without handing over their email address.
 */
export function WalletId({ walletId }: { walletId: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <code className="tnum rounded-md border border-[var(--border)] px-2.5 py-1 text-[13px] tracking-[0.08em]">
        {walletId}
      </code>
      <button
        type="button"
        className="chat-link text-[11px]"
        onClick={() => {
          void navigator.clipboard?.writeText(walletId);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1600);
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
