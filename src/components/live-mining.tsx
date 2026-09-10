"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createBrowserSupabase } from "@/lib/supabase/client";
import { EMPTY_LIVE, MINING_EVENT_NAMES, applyLiveEvent, deriveMiningState, formatAge, formatElapsed, liveEstimate, miningTopic, type LiveModel, type MiningEvent, type MiningState } from "@/lib/live/events";
import { LiveController, type RealtimeStatus } from "@/lib/live/controller";
import type { MiningSummary } from "@/lib/live/summary";
import { formatNumber, formatUsd } from "@/lib/domain/money";

/**
 * MINING PATH — the live card (M16B).
 *
 * Subscribes to the user's PRIVATE Realtime channel (RLS on
 * realtime.messages, migration 0021) for ephemeral events, repaints once a
 * second locally while a request is live, and reconciles every number to the
 * authenticated summary endpoint after any authoritative event. Live values
 * are labelled ESTIMATED; only persisted units are shown as VERIFIED. When
 * Realtime drops it polls the summary every 5 s while visible, and stops
 * when Realtime is back. Hidden tabs neither tick nor poll.
 */

const STATE_LABEL: Record<MiningState, string> = {
  DISCONNECTED: "NO ELIGIBLE ROUTE",
  READY: "READY TO MINE",
  MINING_LIVE: "● MINING LIVE",
  VERIFYING: "VERIFYING",
  VERIFIED: "✓ COMPUTE VERIFIED",
  HELD: "COMPUTE HELD",
  INELIGIBLE: "COMPUTE NOT ELIGIBLE",
  ERROR: "REQUEST FAILED",
};

const STATE_COLOR: Record<MiningState, string> = {
  DISCONNECTED: "var(--faint)",
  READY: "var(--muted)",
  MINING_LIVE: "var(--verified)",
  VERIFYING: "var(--warn)",
  VERIFIED: "var(--verified)",
  HELD: "var(--warn)",
  INELIGIBLE: "var(--faint)",
  ERROR: "var(--warn)",
};

export function LiveMining({ userId, initial, outputMicrosPerMillion }: { userId: string; initial: MiningSummary; outputMicrosPerMillion: number | null }) {
  const [summary, setSummary] = useState<MiningSummary>(initial);
  const [model, setModel] = useState<LiveModel>({ ...EMPTY_LIVE, routeEligible: initial.route.eligible });
  const [now, setNow] = useState<number>(() => Date.now());
  const [realtime, setRealtime] = useState<RealtimeStatus>("unknown");
  const [visible, setVisible] = useState(true);
  const controller = useMemo(() => new LiveController({ fallbackIntervalMs: 5000 }), []);
  const state = deriveMiningState(model, now);

  const refetch = useCallback(async () => {
    try {
      const response = await fetch("/api/mining/summary", { cache: "no-store", credentials: "same-origin" });
      if (!response.ok) return;
      const next = (await response.json()) as MiningSummary;
      setSummary(next);
      setModel((m) => ({ ...m, routeEligible: next.route.eligible }));
    } catch {
      // The next event or poll retries; nothing here is authoritative.
    }
  }, []);

  // Realtime subscription: private, own topic only.
  useEffect(() => {
    const supabase = createBrowserSupabase();
    const channel = supabase.channel(miningTopic(userId), { config: { private: true } });
    for (const name of MINING_EVENT_NAMES) {
      channel.on("broadcast", { event: name }, (message: { payload: MiningEvent }) => {
        const event = message.payload;
        setModel((m) => applyLiveEvent(m, event));
        setNow(Date.now());
        if (controller.shouldRefetchAfter(event.name)) void refetch();
      });
    }
    channel.subscribe((status) => {
      const next: RealtimeStatus = status === "SUBSCRIBED" ? "connected" : status === "CLOSED" || status === "CHANNEL_ERROR" || status === "TIMED_OUT" ? "disconnected" : "unknown";
      controller.setRealtime(next);
      setRealtime(next);
      if (next === "connected") void refetch(); // reconcile anything missed while away
    });
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [userId, controller, refetch]);

  // Tab visibility: no cosmetic work in the background; one refetch on return.
  useEffect(() => {
    const onVisibility = () => {
      const isVisible = document.visibilityState === "visible";
      controller.setVisible(isVisible);
      setVisible(isVisible);
      if (isVisible && controller.onVisibilityRestored()) void refetch();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [controller, refetch]);

  // Local one-second repaint while live; nothing on the network.
  useEffect(() => {
    const interval = controller.tickIntervalMs(state);
    if (!interval || !visible) return;
    const id = window.setInterval(() => setNow(Date.now()), interval);
    return () => window.clearInterval(id);
  }, [state, visible, controller]);

  // Fallback polling only while Realtime is down and the tab is visible.
  useEffect(() => {
    const interval = controller.pollIntervalMs();
    if (!interval || realtime !== "disconnected" || !visible) return;
    const id = window.setInterval(() => void refetch(), interval);
    return () => window.clearInterval(id);
  }, [realtime, visible, controller, refetch]);

  const banner = controller.banner();
  const current = model.current;
  const last = model.last;
  const estimate = useMemo(() => (current ? liveEstimate(current, outputMicrosPerMillion) : null), [current, outputMicrosPerMillion]);

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5" data-mining-state={state}>
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-[var(--faint)]">Mining path</p>
        <span className="text-[11px] font-medium uppercase tracking-[0.14em]" style={{ color: STATE_COLOR[state] }}>
          {STATE_LABEL[state]}
        </span>
      </div>

      {banner && (
        <p className="mt-2 rounded-sm border border-[var(--warn)] px-2 py-1 text-[10px] uppercase tracking-[0.12em] text-[var(--warn)]">{banner}</p>
      )}

      <dl className="tnum mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[11px]">
        <dt className="text-[var(--faint)]">USAGE Miner</dt>
        <dd style={{ color: summary.miner.online ? "var(--verified)" : "var(--faint)" }}>
          {summary.miner.online ? "ONLINE" : "OFFLINE"}
          {summary.miner.lastSeenAt ? ` · seen ${formatAge(new Date(summary.miner.lastSeenAt).getTime(), now)} ago` : ""}
        </dd>
        <dt className="text-[var(--faint)]">Reward route</dt>
        <dd style={{ color: summary.route.eligible ? "var(--verified)" : "var(--faint)" }}>
          {summary.route.label ?? "none"} · {summary.route.eligible ? "CONNECTED · ELIGIBLE" : summary.route.connected > 0 ? "CONNECTED · NOT ELIGIBLE" : "NOT CONNECTED"}
        </dd>
        <dt className="text-[var(--faint)]">Live request</dt>
        <dd>{current ? "ACTIVE" : "IDLE"}</dd>
        <dt className="text-[var(--faint)]">Last proof</dt>
        <dd>{summary.lastProofAt ? `${formatAge(new Date(summary.lastProofAt).getTime(), now)} ago` : "none yet"}</dd>
        <dt className="text-[var(--faint)]">Live updates</dt>
        <dd>{realtime === "connected" ? "REALTIME" : realtime === "disconnected" ? "RECONNECTING · 5 s FALLBACK" : "CONNECTING"}</dd>
      </dl>

      {current && (
        <div className="mt-3 border-t border-[var(--border)] pt-3">
          <dl className="tnum grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[11px]">
            <dt className="text-[var(--faint)]">Route</dt>
            <dd>{current.route}</dd>
            <dt className="text-[var(--faint)]">Model</dt>
            <dd>{current.model ?? "—"}</dd>
            <dt className="text-[var(--faint)]">Elapsed</dt>
            <dd className="text-[var(--verified)]">{formatElapsed(current.startedAt, now)}</dd>
            <dt className="text-[var(--faint)]">Last signal</dt>
            <dd>{formatAge(current.lastEventAt, now)}</dd>
            <dt className="text-[var(--faint)]">Activity</dt>
            <dd>{current.firstChunkAt ? `streaming · ${current.chunks} chunk${current.chunks === 1 ? "" : "s"}` : "waiting for the model"}</dd>
            {estimate && estimate.computeMicrosEstimate !== null && (
              <>
                <dt className="text-[var(--faint)]">Live estimate</dt>
                <dd className="text-[var(--warn)]">
                  ~ {formatUsd(estimate.computeMicrosEstimate, { maximumFractionDigits: 6 })} compute · ~{estimate.tokensEstimate} tokens · ESTIMATED, not verified
                </dd>
              </>
            )}
            {current.verifying && (
              <>
                <dt className="text-[var(--faint)]">Provider usage</dt>
                <dd>
                  {current.verifying.inputTokens ?? "?"} in · {current.verifying.outputTokens ?? "?"} out
                  {current.verifying.providerCostMicros !== null ? ` · ${formatUsd(current.verifying.providerCostMicros, { maximumFractionDigits: 6 })} reported` : ""} · VERIFYING
                </dd>
              </>
            )}
          </dl>
        </div>
      )}

      {!current && last && (
        <div className="mt-3 border-t border-[var(--border)] pt-3 text-[11px]">
          <p style={{ color: STATE_COLOR[last.state] }}>
            {STATE_LABEL[last.state]}
            {last.outcome ? ` · ${last.outcome.model ?? ""}` : ""}
            {last.persistedAt ? ` · ${formatAge(last.persistedAt, now)} ago` : ""}
          </p>
          {last.outcome && (
            <p className="tnum mt-1 text-[var(--muted)]">
              {last.outcome.protocolComputeMicros !== null ? `+${formatUsd(last.outcome.protocolComputeMicros, { maximumFractionDigits: 6 })} protocol compute` : "compute pending pricing"}
              {` · ${last.outcome.inputTokens} in / ${last.outcome.outputTokens} out`}
              {last.outcome.rewardStatus === "eligible" ? " · reward-eligible" : ` · reward ${last.outcome.rewardStatus}${last.outcome.rewardReason ? ` (${last.outcome.rewardReason})` : ""}`}
            </p>
          )}
          {last.failure && <p className="mt-1 text-[var(--warn)]">{last.failure.reason} (HTTP {last.failure.status})</p>}
        </div>
      )}

      <div className="mt-3 grid grid-cols-2 gap-3 border-t border-[var(--border)] pt-3 text-[11px] sm:grid-cols-4">
        <div>
          <p className="text-[var(--faint)]">AI compute (recent)</p>
          <p className="tnum">{formatUsd(summary.today.computeMicros, { maximumFractionDigits: 6 })}</p>
        </div>
        <div>
          <p className="text-[var(--faint)]">Mining score</p>
          <p className="tnum">{formatNumber(summary.scoring.totalPoints)}</p>
        </div>
        <div>
          <p className="text-[var(--faint)]">Network share</p>
          <p className="tnum">{(summary.epoch.networkShare * 100).toFixed(2)}%</p>
        </div>
        <div>
          <p className="text-[var(--faint)]">This epoch</p>
          <p className="tnum" style={{ color: summary.epoch.state === "open" ? "var(--warn)" : "var(--muted)" }}>
            {summary.epoch.state === "open" && summary.epoch.estimatedPoints !== null
              ? `~${formatNumber(summary.epoch.estimatedPoints)} estimated`
              : `${formatNumber(summary.epoch.settledPoints ?? 0)} · ${summary.epoch.state.toUpperCase()}`}
          </p>
        </div>
      </div>
      <p className="mt-2 text-[10px] text-[var(--faint)]">
        Totals come from persisted, signed proofs and reconcile automatically after each verified request. Live values marked ~ are estimates and never count.
      </p>
    </div>
  );
}
