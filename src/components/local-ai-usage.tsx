import Link from "next/link";
import { formatNumber, formatTokens, formatUsd } from "@/lib/domain/money";
import {
  LOCAL_AI_USAGE_COPY,
  TOKEN_CATEGORIES,
  TOKEN_CATEGORY_LABEL,
  cacheTotal,
  estimatedCost,
  freshTotal,
  tokenValue,
  type LocalAiUsageReport,
  type LocalTokenTotals,
  type TokenCategory,
  type VerifiedLaneTotals,
} from "@/lib/miner/local-ai-usage";

/**
 * The local subscription lane, rendered (M17B).
 *
 * Grey throughout: colour encodes verification level, and this lane is
 * reported by a device. Unknown categories print "—", never 0. A cost appears
 * only as the tool's own estimate, under its exact label, and only when some
 * row carried one.
 */

export function tokensOrDash(value: number | null): string {
  return value === null ? "—" : formatTokens(value);
}

export function LocalOnlyChip({ withReward = false }: { withReward?: boolean }) {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1.5 rounded-sm border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.1em]"
      style={{ color: "var(--reported)", borderColor: "color-mix(in srgb, var(--reported) 45%, transparent)" }}
    >
      <span className="size-1.5 rounded-full" style={{ border: "1px solid var(--reported)" }} />
      {withReward ? LOCAL_AI_USAGE_COPY.badge : LOCAL_AI_USAGE_COPY.chip}
    </span>
  );
}

export function LocalUsageNote({ className = "" }: { className?: string }) {
  return <p className={`text-[11px] leading-relaxed text-[var(--muted)] ${className}`}>{LOCAL_AI_USAGE_COPY.note}</p>;
}

/** Nothing tracked yet: say how tracking is turned on, and that it never earns. */
export function LocalUsageEmpty({ rangeLabel = "today" }: { rangeLabel?: string }) {
  return (
    <div className="text-xs leading-relaxed text-[var(--muted)]">
      <p>Nothing tracked {rangeLabel}.</p>
      <p className="mt-1.5 text-[11px] text-[var(--faint)]">
        In USAGE Miner, turn mapping on for Claude Code, Codex or Gemini CLI and start the app with{" "}
        <span className="text-[var(--muted)]">&ldquo;Track only&rdquo;</span>. The app keeps its own sign-in; USAGE Miner
        reads its token counts from the app&rsquo;s official telemetry, and they appear here.{" "}
        <Link href="/download" className="text-[var(--muted)] underline hover:text-[var(--foreground)]">
          Get USAGE Miner
        </Link>
      </p>
    </div>
  );
}

/** Dashboard: today, one row per tool. */
export function LocalTodayByTool({ report }: { report: LocalAiUsageReport }) {
  if (report.byTool.length === 0) return <LocalUsageEmpty />;
  return (
    <ul className="divide-y divide-[var(--border)]">
      {report.byTool.map((t) => {
        const fresh = freshTotal(t.totals);
        const cache = cacheTotal(t.totals);
        const anyCache = t.totals.reported.cacheReadTokens + t.totals.reported.cacheWriteTokens > 0;
        return (
          <li key={t.tool} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
            <div className="min-w-0">
              <p className="truncate text-xs">{t.toolName}</p>
              <p className="mt-0.5 text-[10px] text-[var(--faint)]">
                {t.product ?? "Local app"} · {formatNumber(t.totals.requests)} request{t.totals.requests === 1 ? "" : "s"}
              </p>
            </div>
            <div className="flex items-center gap-4">
              <dl className="tnum grid grid-cols-2 gap-x-4 text-right">
                <div>
                  <dt className="text-[10px] uppercase tracking-[0.14em] text-[var(--faint)]">Fresh</dt>
                  <dd className="text-sm leading-tight">{formatTokens(fresh)}</dd>
                </div>
                <div>
                  <dt className="text-[10px] uppercase tracking-[0.14em] text-[var(--faint)]">Cache</dt>
                  <dd className="text-sm leading-tight">{anyCache ? formatTokens(cache) : "—"}</dd>
                </div>
              </dl>
              <LocalOnlyChip />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

const ROW_CATEGORIES: readonly TokenCategory[] = TOKEN_CATEGORIES;

/** Requests + every category, "—" where no row reported it. */
export function LocalTotalsGrid({ totals }: { totals: LocalTokenTotals }) {
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
      <div>
        <dt className="text-[10px] uppercase tracking-[0.14em] text-[var(--faint)]">Requests</dt>
        <dd className="tnum mt-1 text-lg leading-none">{formatNumber(totals.requests)}</dd>
      </div>
      {ROW_CATEGORIES.map((category) => (
        <div key={category}>
          <dt className="text-[10px] uppercase tracking-[0.14em] text-[var(--faint)]">{TOKEN_CATEGORY_LABEL[category]}</dt>
          <dd className="tnum mt-1 text-lg leading-none">{tokensOrDash(tokenValue(totals, category))}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Only when at least one row carried the tool's own estimate. */
export function LocalCostEstimate({ totals }: { totals: LocalTokenTotals }) {
  const micros = estimatedCost(totals);
  if (micros === null) return null;
  return (
    <p className="tnum text-[11px] text-[var(--muted)]">
      {LOCAL_AI_USAGE_COPY.costLabel}: {formatUsd(micros, { maximumFractionDigits: 4 })}
      <span className="text-[var(--faint)]">
        {" "}
        · from {formatNumber(totals.costReported)} of {formatNumber(totals.requests)} request{totals.requests === 1 ? "" : "s"}
      </span>
    </p>
  );
}

function CategoryCells({ totals }: { totals: LocalTokenTotals }) {
  return (
    <>
      <td className="tnum px-2 py-2 text-right">{formatNumber(totals.requests)}</td>
      {ROW_CATEGORIES.map((category) => (
        <td key={category} className="tnum px-2 py-2 text-right">
          {tokensOrDash(tokenValue(totals, category))}
        </td>
      ))}
    </>
  );
}

function CategoryHeader({ first }: { first: string }) {
  return (
    <thead>
      <tr className="text-[10px] uppercase tracking-[0.12em] text-[var(--faint)]">
        <th className="px-2 py-2 text-left font-normal">{first}</th>
        <th className="px-2 py-2 text-right font-normal">Requests</th>
        {ROW_CATEGORIES.map((category) => (
          <th key={category} className="px-2 py-2 text-right font-normal">
            {TOKEN_CATEGORY_LABEL[category]}
          </th>
        ))}
      </tr>
    </thead>
  );
}

export function LocalByToolTable({ report }: { report: LocalAiUsageReport }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] text-xs">
        <CategoryHeader first="App" />
        <tbody className="divide-y divide-[var(--border)]">
          {report.byTool.map((t) => (
            <tr key={t.tool}>
              <td className="px-2 py-2">
                {t.toolName}
                <span className="block text-[10px] text-[var(--faint)]">{t.product ?? "Local app"}</span>
              </td>
              <CategoryCells totals={t.totals} />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function LocalByModelTable({ report, toolNames }: { report: LocalAiUsageReport; toolNames: Record<string, string> }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] text-xs">
        <CategoryHeader first="Model" />
        <tbody className="divide-y divide-[var(--border)]">
          {report.byModel.map((m) => (
            <tr key={m.label}>
              <td className="px-2 py-2">
                <span className={m.model ? "" : "text-[var(--muted)]"}>{m.label}</span>
                <span className="block text-[10px] text-[var(--faint)]">{m.tools.map((t) => toolNames[t] ?? t).join(", ")}</span>
              </td>
              <CategoryCells totals={m.totals} />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Horizontal bars per category; an unreported category is a dash, not an empty bar. */
export function LocalCategoryBars({ report }: { report: LocalAiUsageReport }) {
  const max = Math.max(...report.byCategory.map((c) => c.value ?? 0), 1);
  return (
    <ul className="space-y-2.5">
      {report.byCategory.map((c) => (
        <li key={c.category}>
          <div className="flex items-baseline justify-between gap-3 text-[11px]">
            <span className="text-[var(--muted)]">{c.label}</span>
            <span className="tnum">
              {tokensOrDash(c.value)}
              <span className="ml-2 text-[10px] text-[var(--faint)]">
                {c.reported === 0 ? "not reported" : `${formatNumber(c.reported)} of ${formatNumber(report.totals.requests)}`}
              </span>
            </span>
          </div>
          <svg viewBox="0 0 100 4" preserveAspectRatio="none" className="mt-1 h-1.5 w-full" aria-hidden>
            <rect x={0} y={0} width={100} height={4} fill="var(--border)" />
            {c.value !== null && c.value > 0 && <rect x={0} y={0} width={(c.value / max) * 100} height={4} fill="var(--reported)" />}
          </svg>
        </li>
      ))}
    </ul>
  );
}

/** The verified lane for the same range. Trusted records only; green. */
export function VerifiedLaneSummary({ totals }: { totals: VerifiedLaneTotals }) {
  const rows: Array<[string, string]> = [
    ["Requests", formatNumber(totals.requests)],
    ["Input", formatTokens(totals.inputTokens)],
    ["Output", formatTokens(totals.outputTokens)],
    ["Cache read", formatTokens(totals.cacheReadTokens)],
    ["Cache write", formatTokens(totals.cacheWriteTokens)],
    ["Reasoning", formatTokens(totals.reasoningTokens)],
  ];
  return (
    <div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt className="text-[10px] uppercase tracking-[0.14em] text-[var(--faint)]">{label}</dt>
            <dd className="tnum mt-1 text-lg leading-none">{value}</dd>
          </div>
        ))}
      </dl>
      <dl className="mt-4 space-y-1.5 border-t border-[var(--border)] pt-3 text-[11px]">
        <div className="flex justify-between gap-3">
          <dt className="text-[var(--muted)]">Reward-eligible compute</dt>
          <dd className="tnum" style={{ color: "var(--verified)" }}>
            {formatUsd(totals.eligibleComputeMicros, { maximumFractionDigits: 4 })}
          </dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-[var(--muted)]">Also tracked on your device</dt>
          <dd className="tnum text-[var(--muted)]">
            {formatNumber(totals.alsoObservedLocally)} request{totals.alsoObservedLocally === 1 ? "" : "s"} · counted here once
          </dd>
        </div>
      </dl>
    </div>
  );
}
