import Link from "next/link";
import type { ReactNode } from "react";
import { CONNECTION_STATE_LABEL, type ConnectionState } from "@/lib/product/connections";

/**
 * Product chrome.
 *
 * Everything here speaks the user's language: mining, balance, connected AI.
 * Engineering vocabulary (receipts, issuers, pricing versions) lives behind
 * "advanced" on the proof page, not in the main flow.
 */

const STATE_COLOR: Record<ConnectionState, string> = {
  active: "var(--verified)",
  available: "var(--routed)",
  setup_required: "var(--routed)",
  coming_soon: "var(--faint)",
  experimental: "var(--warn)",
  error: "var(--warn)",
  revoked: "var(--reported)",
};

export function StateBadge({ state }: { state: ConnectionState }) {
  const color = STATE_COLOR[state];
  const filled = state === "active";
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1.5 rounded-sm border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.1em]"
      style={{ color, borderColor: `color-mix(in srgb, ${color} 35%, transparent)` }}
    >
      <span
        className="size-1.5 rounded-full"
        style={{ background: filled ? color : "transparent", border: `1px solid ${color}` }}
      />
      {CONNECTION_STATE_LABEL[state]}
    </span>
  );
}

export function AppNav({ email, right }: { email?: string; right?: ReactNode }) {
  return (
    <header className="mb-8 flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-baseline gap-4">
        <Link href="/dashboard" className="tnum text-sm font-medium tracking-[0.3em]">
          USAGE
        </Link>
        <nav className="flex items-center gap-3 text-[11px] text-[var(--muted)]">
          <Link href="/dashboard" className="hover:text-[var(--foreground)]">
            Mining
          </Link>
          <Link href="/providers" className="hover:text-[var(--foreground)]">
            Providers
          </Link>
          <Link href="/settings" className="hover:text-[var(--foreground)]">
            Settings
          </Link>
        </nav>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        {email && <span className="text-[11px] text-[var(--muted)]">{email}</span>}
        {right}
      </div>
    </header>
  );
}

/** The two numbers that must never be confused with one another. */
export function BalanceHeadline({
  settled,
  estimated,
  epochState,
  epochLabel,
  settledEpochPoints = null,
}: {
  settled: string;
  estimated: string;
  epochState: string;
  /** Full label, e.g. "OPEN" or "SETTLED · DEVELOPMENT CALIBRATION". */
  epochLabel?: string;
  /** Persisted reward of a settled epoch (formatted); null while the epoch is open. */
  settledEpochPoints?: string | null;
}) {
  const isOpen = epochState === "open";
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5 sm:p-6">
      <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-[var(--faint)]">
        USAGE Balance
      </p>
      <p className="tnum mt-2 text-4xl leading-none tracking-tight sm:text-5xl">{settled}</p>
      <div className="mt-4 flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t border-[var(--border)] pt-4">
        <span className="text-[11px] uppercase tracking-[0.14em] text-[var(--faint)]">
          This epoch
        </span>
        {isOpen ? (
          <span className="tnum text-sm text-[var(--warn)]">~{estimated} estimated</span>
        ) : (
          <span className="tnum text-sm text-[var(--muted)]">Reward: {settledEpochPoints ?? "0"}</span>
        )}
        <span className="text-[11px] text-[var(--faint)]">{epochLabel ?? `epoch ${epochState.toUpperCase()}`}</span>
      </div>
      <p className="mt-3 text-[11px] leading-relaxed text-[var(--faint)]">
        Estimated USAGE moves while the epoch is open and is not part of your balance. Only a
        settled epoch adds to it, and a settled amount never changes.
      </p>
    </div>
  );
}

export function PrivacyNote() {
  return (
    <p className="text-[11px] leading-relaxed text-[var(--faint)]">
      USAGE measures your AI compute, not your conversations. Prompts, responses, tool arguments and
      source code are never stored — only token counts, models and timestamps.
    </p>
  );
}
