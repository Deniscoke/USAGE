"use client";

import { useActionState } from "react";
import { revokeMinerCredential, type MinerActionState } from "@/app/actions/miner";

const EMPTY: MinerActionState = {};

/**
 * Revocation runs as the signed-in user, so the database rejects a credential
 * they do not own. There is no ownership check in this component to bypass.
 */
export function RevokeCredentialButton({ credentialId }: { credentialId: string }) {
  const [state, action, pending] = useActionState(revokeMinerCredential, EMPTY);

  if (state.message) {
    return <span className="text-[10px] uppercase tracking-[0.1em] text-[var(--reported)]">Revoked</span>;
  }

  return (
    <form action={action} className="shrink-0">
      <input type="hidden" name="credentialId" value={credentialId} />
      <button
        type="submit"
        disabled={pending}
        className="rounded-md border border-[var(--border)] px-2 py-1 text-[10px] uppercase tracking-[0.1em] text-[var(--muted)] transition-colors hover:border-[var(--warn)] hover:text-[var(--warn)] disabled:opacity-40"
      >
        {pending ? "Revoking…" : "Revoke"}
      </button>
      {state.error && <p className="mt-1 text-[10px] text-[var(--warn)]">{state.error}</p>}
    </form>
  );
}
