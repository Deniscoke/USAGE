import Link from "next/link";
import { redirect } from "next/navigation";
import { AppNav, PrivacyNote } from "@/components/product";
import { Panel } from "@/components/ui";
import { LOCAL_DAY_LAYERS, LocalTokensByDayChart } from "@/components/charts";
import {
  LocalByModelTable,
  LocalByToolTable,
  LocalCategoryBars,
  LocalCostEstimate,
  LocalOnlyChip,
  LocalTotalsGrid,
  LocalUsageEmpty,
  LocalUsageNote,
  VerifiedLaneSummary,
} from "@/components/local-ai-usage";
import { LiveLocalTracking, LiveTrackingBoundary } from "@/components/live-local-tracking";
import { createServerSupabase } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import {
  LOCAL_AI_USAGE_COPY,
  RANGE_LABEL,
  USAGE_RANGES,
  loadLocalAiUsage,
  loadVerifiedLane,
  parseRange,
  rangeSinceDay,
  summarizeLocalAiUsage,
  summarizeVerifiedLane,
} from "@/lib/miner/local-ai-usage";
import { LOCAL_TOOLS } from "@/lib/miner/tools";
import { formatNumber } from "@/lib/domain/money";

export const dynamic = "force-dynamic";

/**
 * AI usage analytics (M17B).
 *
 * Two lanes, side by side and never summed:
 *
 *   LOCAL AI USAGE   what the person's own apps reported through USAGE Miner
 *                    on a subscription login. Analytics. Reward 0.
 *   VERIFIED COMPUTE records USAGE wrote itself (routed or provider-verified),
 *                    the only lane with economic weight.
 *
 * Both are read as the signed-in user, so RLS decides what comes back. A
 * request both lanes saw is counted once, in the verified lane.
 */
export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (!isSupabaseConfigured()) redirect("/dashboard");
  const supabase = await createServerSupabase();
  if (!supabase) redirect("/dashboard");

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/analytics");

  const range = parseRange((await searchParams).range, "7d");
  const now = new Date();
  const since = rangeSinceDay(range, now);

  // A failed read shows a message instead of taking the page down.
  const loaded = await Promise.all([
    loadLocalAiUsage(supabase, user.id, since, now),
    loadVerifiedLane(supabase, user.id, since, now),
  ]).catch(() => null);
  if (!loaded) {
    return (
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 sm:py-8">
        <AppNav email={user.email} />
        <p className="text-xs text-[var(--muted)]">Analytics could not be loaded just now. Reload to try again.</p>
      </main>
    );
  }
  const [local, verified] = loaded;
  const report = summarizeLocalAiUsage({ observations: local.observations, range, now, truncated: local.truncated });
  const verifiedTotals = summarizeVerifiedLane({ events: verified.events, range, now, truncated: verified.truncated });
  const toolNames = Object.fromEntries(Object.values(LOCAL_TOOLS).map((t) => [t.id, t.displayName]));
  const rangeLabel = RANGE_LABEL[range].toLowerCase();
  const hasLocal = report.totals.requests > 0;

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 sm:py-8">
      <AppNav email={user.email} />

      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[10px] uppercase tracking-[0.16em] text-[var(--faint)]">Analytics</p>
          <h1 className="mt-1 text-2xl font-medium tracking-tight">AI usage</h1>
          <p className="mt-1 text-[11px] text-[var(--faint)]">UTC days · {report.days[0]} to {report.days.at(-1)}</p>
        </div>
        <nav aria-label="Range" className="flex rounded-md border border-[var(--border)] p-0.5 text-[11px]">
          {USAGE_RANGES.map((r) => (
            <Link
              key={r}
              href={`/analytics?range=${r}`}
              aria-current={r === range ? "page" : undefined}
              className={`rounded px-2.5 py-1 ${r === range ? "bg-[var(--border)] text-[var(--foreground)]" : "text-[var(--muted)] hover:text-[var(--foreground)]"}`}
            >
              {RANGE_LABEL[r]}
            </Link>
          ))}
        </nav>
      </div>

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5" style={{ borderTop: "2px solid var(--reported)" }}>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--muted)]">{LOCAL_AI_USAGE_COPY.title}</h2>
            <LocalOnlyChip withReward />
          </div>
          <p className="mt-1 text-[11px] text-[var(--faint)]">Subscription usage your apps reported through USAGE Miner</p>
          <div className="mt-3">
            <LiveTrackingBoundary>
              <LiveLocalTracking userId={user.id} />
            </LiveTrackingBoundary>
          </div>
          <div className="mt-4">{hasLocal ? <LocalTotalsGrid totals={report.totals} /> : <LocalUsageEmpty rangeLabel={range === "today" ? "today" : `in the ${rangeLabel}`} />}</div>
          {hasLocal && (
            <div className="mt-3">
              <LocalCostEstimate totals={report.totals} />
            </div>
          )}
          <LocalUsageNote className="mt-4 border-t border-[var(--border)] pt-3" />
          {report.countedInVerified > 0 && (
            <p className="mt-1.5 text-[10px] text-[var(--faint)]">
              {formatNumber(report.countedInVerified)} tracked request{report.countedInVerified === 1 ? " was" : "s were"} also carried by USAGE and
              {report.countedInVerified === 1 ? " is" : " are"} counted once, under verified compute.
            </p>
          )}
          {report.truncated && <p className="mt-1.5 text-[10px] text-[var(--warn)]">Showing the most recent rows only; totals are a lower bound.</p>}
        </div>

        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5" style={{ borderTop: "2px solid var(--verified)" }}>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--muted)]">Verified compute</h2>
            <span className="text-[10px] uppercase tracking-[0.12em] text-[var(--verified)]">Trusted records</span>
          </div>
          <p className="mt-1 text-[11px] text-[var(--faint)]">Requests USAGE carried or a provider confirmed · {rangeLabel}</p>
          <div className="mt-4">
            <VerifiedLaneSummary totals={verifiedTotals} />
          </div>
          <p className="mt-3 text-[11px] leading-relaxed text-[var(--faint)]">
            Only this lane can earn Usage Points. It is never added to local usage, and local usage never feeds it.
          </p>
          {verifiedTotals.truncated && <p className="mt-1.5 text-[10px] text-[var(--warn)]">Showing the most recent rows only; totals are a lower bound.</p>}
        </div>
      </section>

      {hasLocal && (
        <>
          <section className="mt-4">
            <Panel
              title="Local AI usage by day"
              hint={`Tokens tracked on your devices, ${rangeLabel}`}
              action={
                <div className="flex flex-wrap items-center gap-3 text-[10px] uppercase tracking-[0.12em] text-[var(--muted)]">
                  {LOCAL_DAY_LAYERS.map((layer) => (
                    <span key={layer.key} className="flex items-center gap-1.5">
                      <span className="size-1.5 rounded-full" style={{ background: "var(--reported)", opacity: layer.opacity }} />
                      {layer.label}
                    </span>
                  ))}
                  <LocalOnlyChip withReward />
                </div>
              }
            >
              <LocalTokensByDayChart
                days={report.byDay.map((d) => ({
                  day: d.day,
                  inputTokens: d.totals.sums.inputTokens,
                  outputTokens: d.totals.sums.outputTokens,
                  cacheReadTokens: d.totals.sums.cacheReadTokens,
                  cacheWriteTokens: d.totals.sums.cacheWriteTokens,
                }))}
              />
            </Panel>
          </section>

          <section className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
            <Panel title="By app" hint="Which login the usage came from" action={<LocalOnlyChip withReward />}>
              <LocalByToolTable report={report} />
            </Panel>
            <Panel title="By token category" hint="Unreported categories show —, not 0" action={<LocalOnlyChip withReward />}>
              <LocalCategoryBars report={report} />
            </Panel>
          </section>

          <section className="mt-4">
            <Panel title="By model" hint="As each app named it" action={<LocalOnlyChip withReward />}>
              <LocalByModelTable report={report} toolNames={toolNames} />
            </Panel>
          </section>
        </>
      )}

      <div className="mt-6">
        <PrivacyNote />
      </div>
    </main>
  );
}
