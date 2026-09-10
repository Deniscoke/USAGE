"use client";

import { Component, type ReactNode } from "react";
import { reportClientError } from "@/lib/live/diagnostics";

/**
 * A narrow boundary around the live widget (M16B.1). A programmer error in
 * LiveMining must never take the dashboard down: the authoritative numbers
 * are server-rendered and stay on screen; only the live card is replaced by
 * a recovery notice with a retry.
 */
interface State {
  failed: boolean;
  attempt: number;
}

export class LiveMiningBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { failed: false, attempt: 0 };

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    reportClientError("live-mining", error);
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5" data-mining-state="UNAVAILABLE">
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-[var(--faint)]">Mining path</p>
          <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--warn)]">LIVE MINING UPDATES UNAVAILABLE</span>
        </div>
        <p className="mt-3 text-[11px] leading-relaxed text-[var(--muted)]">
          Authoritative mining data is safe: every number on this page comes from persisted, signed proofs. Only the live view failed.
        </p>
        <button
          type="button"
          onClick={() => this.setState((s) => ({ failed: false, attempt: s.attempt + 1 }))}
          className="mt-3 rounded-md border border-[var(--border)] px-2.5 py-1 text-[10px] uppercase tracking-[0.1em] text-[var(--muted)] hover:border-[var(--border-strong)] hover:text-[var(--foreground)]"
        >
          Retry live updates
        </button>
      </div>
    );
  }
}
