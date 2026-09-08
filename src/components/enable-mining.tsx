"use client";

import { useActionState } from "react";
import { enableMining, type MinerActionState } from "@/app/actions/miner";

/**
 * The "Enable Mining" product action.
 *
 * The token is rendered exactly once, right here, because that is the only
 * moment it exists in plaintext anywhere. Nothing stores it, and a reload will
 * not bring it back -- which is the point.
 */

const EMPTY: MinerActionState = {};

export function EnableMiningButton({
  provider,
  providerName,
  gateway,
  gatewayName,
  disabled,
}: {
  provider: string;
  providerName: string;
  /** Which gateway will carry this provider's traffic. */
  gateway: string;
  gatewayName: string;
  disabled?: boolean;
}) {
  const [state, action, pending] = useActionState(enableMining, EMPTY);

  if (state.token) {
    return (
      <MinerToken
        token={state.token}
        name={state.credentialName ?? "miner"}
        endpoint={state.endpoint ?? "/api/gateway/anthropic"}
      />
    );
  }

  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="provider" value={provider} />
      <input type="hidden" name="gateway" value={gateway} />
      <button
        type="submit"
        disabled={disabled || pending}
        className="w-full rounded-md bg-[var(--foreground)] px-3 py-2 text-xs font-medium text-[var(--background)] transition-opacity hover:opacity-90 disabled:opacity-40"
      >
        {pending ? "Enabling…" : "Enable Mining"}
      </button>
      <p className="text-[11px] text-[var(--faint)]">
        Routes {providerName} requests through USAGE via {gatewayName} so they can be verified.
      </p>
      {state.error && <p className="text-[11px] text-[var(--warn)]">{state.error}</p>}
    </form>
  );
}

function MinerToken({ token, name, endpoint }: { token: string; name: string; endpoint: string }) {
  return (
    <div className="space-y-3 rounded-md border border-[color-mix(in_srgb,var(--verified)_35%,transparent)] bg-[color-mix(in_srgb,var(--verified)_7%,transparent)] p-3">
      <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--verified)]">
        Mining enabled · {name}
      </p>
      <p className="text-[11px] leading-relaxed text-[var(--muted)]">
        Copy this key now. USAGE stores only a hash of it, so this is the one and only time it can
        be shown.
      </p>
      <code className="block w-full overflow-x-auto rounded-sm border border-[var(--border-strong)] bg-[var(--surface-2)] px-2.5 py-2 text-[11px] break-all">
        {token}
      </code>
      <details className="text-[11px] text-[var(--muted)]">
        <summary className="cursor-pointer text-[var(--foreground)]">Set up your tool</summary>
        <ol className="mt-2 list-decimal space-y-1 pl-4 leading-relaxed">
          <li>Install the USAGE Miner for your tool.</li>
          <li>
            Point it at <code className="tnum">{endpoint}</code>.
          </li>
          <li>Paste this key when it asks for your USAGE mining key.</li>
          <li>Use your AI tool exactly as before. Verified compute starts counting.</li>
        </ol>
      </details>
    </div>
  );
}
