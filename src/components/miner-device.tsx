import Link from "next/link";
import { RevokeDeviceButton } from "@/components/pair-device";
import type { DeviceToolView, DeviceView } from "@/lib/miner/device-view";
import { formatTokens, formatUsd } from "@/lib/domain/money";
import type { UsageBreakdown } from "@/lib/miner/usage-summary";

/**
 * Device cards and the per-tool table.
 *
 * The three figures -- tracked, verified, eligible -- are deliberately laid
 * out as three, with the words a person uses, and the tool table is rendered
 * from the server's tool registry rather than from anything the device sent.
 * A device can say it detected a tool; it cannot say what that tool's usage is
 * worth.
 */

const MINING_WORDS: Record<DeviceToolView["mining"], string> = {
  eligible_when_routed: "Eligible when routed through USAGE",
  held: "Held",
  not_eligible: "Not eligible",
};

export function DeviceStatus({ view }: { view: DeviceView }) {
  const color = view.revoked ? "var(--reported)" : view.online ? "var(--verified)" : "var(--faint)";
  return (
    <span className="text-[10px] uppercase tracking-[0.1em]" style={{ color }}>
      {view.revoked
        ? "Revoked"
        : view.online
          ? "● Online · current"
          : view.previousPairing
            ? "Offline · previous pairing"
            : "Offline"}
    </span>
  );
}

/** Input / output / cache read / cache write, each its own number. */
export function UsageBreakdownRows({ breakdown, compact = false }: { breakdown: UsageBreakdown; compact?: boolean }) {
  const rows = [
    ["Input", breakdown.inputTokens],
    ["Output", breakdown.outputTokens],
    ["Cache read", breakdown.cacheReadTokens],
    ["Cache write", breakdown.cacheWriteTokens],
    ...(breakdown.reasoningTokens > 0 ? [["Reasoning (of output)", breakdown.reasoningTokens] as const] : []),
  ] as const;
  return (
    <dl className={`grid gap-x-4 gap-y-1 ${compact ? "grid-cols-2" : "grid-cols-2 sm:grid-cols-4"}`}>
      {rows.map(([label, value]) => (
        <div key={label} className="flex items-baseline justify-between gap-2 sm:block">
          <dt className="text-[10px] uppercase tracking-[0.14em] text-[var(--faint)]">{label}</dt>
          <dd className="tnum text-sm leading-tight">{formatTokens(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

export function TodayFigures({ view, compact = false }: { view: DeviceView; compact?: boolean }) {
  const t = view.today;
  return (
    <div className="space-y-3">
      <div>
        <p className="mb-1 text-[10px] uppercase tracking-[0.14em] text-[var(--muted)]">
          AI usage tracked · {t.tracked.requestCount} request{t.tracked.requestCount === 1 ? "" : "s"} · reported by your device
        </p>
        <UsageBreakdownRows breakdown={t.tracked} compact={compact} />
      </div>
      <dl className={`grid gap-3 ${compact ? "grid-cols-2" : "sm:grid-cols-2"}`}>
        <div>
          <dt className="text-[10px] uppercase tracking-[0.14em] text-[var(--faint)]">Verified by USAGE</dt>
          <dd className="tnum mt-1 text-base leading-none">
            {t.verified.requestCount} request{t.verified.requestCount === 1 ? "" : "s"} · {formatTokens(t.verifiedTokens)} fresh tokens
          </dd>
          <dd className="mt-1 text-[10px] text-[var(--muted)]">
            {formatTokens(t.verified.cacheReadTokens + t.verified.cacheWriteTokens)} cache tokens · from trusted records only
          </dd>
        </div>
        <div>
          <dt className="text-[10px] uppercase tracking-[0.14em] text-[var(--faint)]">Reward-eligible compute</dt>
          <dd className="tnum mt-1 text-base leading-none">{formatUsd(t.eligibleComputeMicros, { maximumFractionDigits: 4 })}</dd>
          <dd className="mt-1 text-[10px] text-[var(--muted)]">protocol equivalent · from versioned pricing, never from token counts</dd>
        </div>
      </dl>
    </div>
  );
}

export function DeviceCard({ view }: { view: DeviceView }) {
  const d = view.device;
  const mapped = view.tools.filter((t) => t.mapped);
  return (
    <li className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link href={`/miners/${d.id}`} className="truncate text-sm hover:underline">
            {d.name}
          </Link>
          <p className="tnum mt-0.5 text-[11px] text-[var(--faint)]">
            {d.os ?? d.platform} · USAGE Miner {d.app_version}
            {d.last_seen_at ? ` · last seen ${d.last_seen_at.slice(0, 16).replace("T", " ")}` : " · never connected"}
            {view.attested ? " · device key registered" : ""}
          </p>
          <p className="mt-1.5 text-[11px] text-[var(--muted)]">
            {mapped.length > 0
              ? `Mapping: ${mapped.map((t) => t.tool.displayName).join(", ")}`
              : "No AI apps mapped yet"}
            {view.lastUsageEventAt ? ` · last usage ${view.lastUsageEventAt.slice(0, 16).replace("T", " ")}` : ""}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <DeviceStatus view={view} />
          {!view.revoked && <RevokeDeviceButton deviceId={d.id} />}
        </div>
      </div>
      <div className="mt-4 border-t border-[var(--border)] pt-3">
        <TodayFigures view={view} compact />
      </div>
    </li>
  );
}

export function ToolTable({ tools }: { tools: DeviceToolView[] }) {
  return (
    <ul className="divide-y divide-[var(--border)]">
      {tools.map((t) => (
        <li key={t.tool.id} className="py-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="text-xs">
                {t.tool.displayName}
                {t.tool.experimental && <span className="ml-2 text-[10px] text-[var(--muted)]">experimental</span>}
              </p>
              <p className="mt-0.5 text-[10px] text-[var(--faint)]">
                {t.detected ? `Detected${t.version ? ` · ${t.version}` : ""}` : "Not detected on this device"}
              </p>
            </div>
            <span
              className="text-[10px] uppercase tracking-[0.1em]"
              style={{ color: t.mapped ? "var(--verified)" : "var(--faint)" }}
            >
              {t.mapped ? "● Mapping active" : t.mappingStatus === "disabled" ? "Mapping off" : t.tool.meteringMethods.includes("unsupported") ? "Not available" : "Not mapped"}
            </span>
          </div>

          <dl className="mt-2 grid gap-x-4 gap-y-1 text-[10px] sm:grid-cols-4">
            <div>
              <dt className="uppercase tracking-[0.12em] text-[var(--faint)]">Metering</dt>
              <dd className="mt-0.5 text-[var(--muted)]">
                {t.tool.meteringMethods.includes("unsupported")
                  ? "Unavailable"
                  : t.tool.meteringMethods.includes("native_otel")
                    ? "Native telemetry"
                    : t.tool.meteringMethods[0]}
              </dd>
            </div>
            <div>
              <dt className="uppercase tracking-[0.12em] text-[var(--faint)]">Reads</dt>
              <dd className="mt-0.5 text-[var(--muted)]">{t.tool.reads.length ? t.tool.reads.map((r) => `✓ ${r}`).join(" · ") : "—"}</dd>
            </div>
            <div>
              <dt className="uppercase tracking-[0.12em] text-[var(--faint)]">Verification</dt>
              <dd className="mt-0.5 text-[var(--muted)]">{t.verificationLabel} at most</dd>
            </div>
            <div>
              <dt className="uppercase tracking-[0.12em] text-[var(--faint)]">Mining</dt>
              <dd className="mt-0.5 text-[var(--muted)]">{MINING_WORDS[t.mining]}</dd>
            </div>
          </dl>
          <p className="mt-1.5 text-[10px] text-[var(--faint)]">
            Never reads: {t.tool.neverReads.map((r) => `✗ ${r}`).join(" · ")}
          </p>
          {t.tool.availabilityNote && (
            <p className="mt-1 text-[10px] text-[var(--muted)]">{t.tool.availabilityNote}</p>
          )}
        </li>
      ))}
    </ul>
  );
}

export function ActivityFeed({ view }: { view: DeviceView }) {
  if (view.today.recent.length === 0) {
    return <p className="text-xs text-[var(--muted)]">Nothing tracked today.</p>;
  }
  const badge = (status: "tracked" | "verified" | "routed") =>
    status === "tracked"
      ? { text: "TRACKED", color: "var(--reported)" }
      : status === "routed"
        ? { text: "ROUTED ✓", color: "var(--routed)" }
        : { text: "VERIFIED ✓", color: "var(--verified)" };
  return (
    <ul className="divide-y divide-[var(--border)]">
      {view.today.recent.map((item, index) => {
        const b = badge(item.status);
        return (
          <li key={`${item.at}-${index}`} className="flex items-center justify-between gap-3 py-2">
            <div className="min-w-0">
              <p className="truncate text-xs">
                {item.tool === "usage-gateway" ? "USAGE gateway" : item.tool}
                {item.model ? <span className="text-[var(--muted)]"> · {item.model}</span> : null}
              </p>
              <p className="tnum text-[10px] text-[var(--faint)]">
                {formatTokens(item.breakdown.inputTokens)} in · {formatTokens(item.breakdown.outputTokens)} out
                {item.breakdown.cacheReadTokens > 0 ? ` · ${formatTokens(item.breakdown.cacheReadTokens)} cache read` : ""}
                {item.breakdown.cacheWriteTokens > 0 ? ` · ${formatTokens(item.breakdown.cacheWriteTokens)} cache write` : ""}
                {item.breakdown.reasoningTokens > 0 ? ` · ${formatTokens(item.breakdown.reasoningTokens)} reasoning` : ""}
                {" · "}{item.at.slice(11, 16)} UTC
              </p>
            </div>
            <span className="shrink-0 text-[10px] uppercase tracking-[0.1em]" style={{ color: b.color }}>
              {b.text}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
