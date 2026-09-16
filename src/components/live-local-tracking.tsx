"use client";

import { Component, useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { createBrowserSupabase } from "@/lib/supabase/client";
import { LOCAL_TRACKING_EVENT_NAME, parseLocalTrackingEvent, type LocalTrackingEvent } from "@/lib/live/local-tracking";
import { acquireUserChannel, type RealtimeClientLike } from "@/lib/live/user-channel";
import type { RealtimeStatus } from "@/lib/live/controller";
import { reportClientError } from "@/lib/live/diagnostics";
import { LOCAL_AI_USAGE_COPY, toolDisplayName } from "@/lib/miner/local-ai-usage";
import { formatTokens } from "@/lib/domain/money";

/**
 * TRACKING LIVE -- the local lane's live strip (M17B).
 *
 * Listens for `tracking.local.observed` on the user's private channel and
 * shows what was just tracked. The deltas are a hint, not a figure: the
 * numbers on the page are the server render, and a debounced
 * `router.refresh()` brings them up to date a few seconds after activity.
 * Nothing here is mining, nothing is verified, nothing earns.
 */

const REFRESH_DEBOUNCE_MS = 4_000;

const STATUS_LABEL: Record<RealtimeStatus, string> = {
  connected: LOCAL_AI_USAGE_COPY.live,
  unknown: "CONNECTING",
  disconnected: "LIVE TRACKING RECONNECTING",
};

function delta(label: string, value: number | null): string | null {
  return value === null ? null : `+${formatTokens(value)} ${label}`;
}

export function LiveLocalTracking({ userId }: { userId: string }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [status, setStatus] = useState<RealtimeStatus>("unknown");
  const [last, setLast] = useState<LocalTrackingEvent | null>(null);
  const refreshTimer = useRef<number | null>(null);

  useEffect(() => {
    const release = acquireUserChannel(createBrowserSupabase() as RealtimeClientLike | null, userId, {
      events: {
        [LOCAL_TRACKING_EVENT_NAME]: (payload: unknown) => {
          const event = parseLocalTrackingEvent(payload);
          if (!event) return;
          setLast(event);
          if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
          refreshTimer.current = window.setTimeout(() => {
            refreshTimer.current = null;
            startTransition(() => router.refresh());
          }, REFRESH_DEBOUNCE_MS);
        },
      },
      onStatus: setStatus,
    });
    return () => {
      release();
      if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
      refreshTimer.current = null;
    };
  }, [userId, router]);

  const deltas = last
    ? [
        delta("input", last.inputTokens),
        delta("output", last.outputTokens),
        delta("cache read", last.cacheReadTokens),
        delta("cache write", last.cacheWriteTokens),
      ].filter((d): d is string => d !== null)
    : [];

  return (
    <div className="rounded-md border border-[var(--border)] px-3 py-2" data-tracking-state={status}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span
          className="text-[10px] font-medium uppercase tracking-[0.14em]"
          style={{ color: status === "connected" ? "var(--reported)" : "var(--faint)" }}
        >
          {status === "connected" ? "● " : ""}
          {STATUS_LABEL[status]}
        </span>
        <span className="text-[10px] uppercase tracking-[0.12em] text-[var(--reported)]">{LOCAL_AI_USAGE_COPY.badge}</span>
      </div>
      <p className="tnum mt-1 text-[11px] text-[var(--muted)]" aria-live="polite">
        {last ? (
          <>
            {toolDisplayName(last.tool)}
            {last.model ? ` · ${last.model}` : ""}
            {deltas.length > 0 ? ` · ${deltas.join(" · ")}` : ""}
            {last.requests > 1 ? ` · ${last.requests} requests` : ""}
            {` · ${last.occurredAt.slice(11, 16)} UTC`}
          </>
        ) : status === "disconnected" ? (
          "Live updates are reconnecting. The figures below are current as of this page load."
        ) : (
          "Waiting for activity from USAGE Miner."
        )}
      </p>
    </div>
  );
}

interface BoundaryState {
  failed: boolean;
}

/** Same contract as LiveMiningBoundary: a live-strip bug never takes the page down. */
export class LiveTrackingBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  state: BoundaryState = { failed: false };

  static getDerivedStateFromError(): Partial<BoundaryState> {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    reportClientError("live-local-tracking", error);
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="rounded-md border border-[var(--border)] px-3 py-2" data-tracking-state="UNAVAILABLE">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-[var(--warn)]">LIVE TRACKING UNAVAILABLE</span>
          <button
            type="button"
            onClick={() => this.setState({ failed: false })}
            className="rounded-md border border-[var(--border)] px-2 py-0.5 text-[10px] uppercase tracking-[0.1em] text-[var(--muted)] hover:border-[var(--border-strong)] hover:text-[var(--foreground)]"
          >
            Retry
          </button>
        </div>
        <p className="mt-1 text-[11px] text-[var(--muted)]">The figures below come from the server and are unaffected.</p>
      </div>
    );
  }
}
