import Link from "next/link";
import { redirect } from "next/navigation";
import { ScoreSparkline, StackedUsageChart } from "@/components/charts";
import { DemoIngestButton } from "@/components/demo-ingest-button";
import {
  Bar,
  DemoBanner,
  FixtureBanner,
  LiveRoutedBanner,
  Panel,
  Stat,
  VERIFICATION_META,
  VerificationBadge,
} from "@/components/ui";
import { signOut } from "@/app/auth/actions";
import { formatNumber, formatTokens, formatUsd } from "@/lib/domain/money";
import { totalTokens } from "@/lib/domain/normalize";
import type { VerificationType } from "@/lib/domain/types";
import { createServerSupabase } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { loadDashboardSnapshot } from "@/lib/db/usage-repository";
import { buildDashboardView, dashboardSinceDay } from "@/lib/pipeline/dashboard";

export const dynamic = "force-dynamic";

const CHART_DAYS = 45;

export default async function DashboardPage() {
  if (!isSupabaseConfigured()) return <SetupRequired />;

  const supabase = await createServerSupabase();
  if (!supabase) return <SetupRequired />;

  // getUser() validates the token with Supabase rather than trusting the cookie.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/dashboard");

  const now = new Date();
  const snapshot = await loadDashboardSnapshot(supabase, user.id, dashboardSinceDay(now));
  const data = buildDashboardView({ ...snapshot, now });

  const series = data.series.slice(-CHART_DAYS);
  const scoredCost = data.byVerification.verified.costMicros + data.byVerification.routed.costMicros;
  const totalCost = scoredCost + data.byVerification.reported.costMicros;

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 sm:py-8">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <Link href="/" className="tnum text-sm font-medium tracking-[0.3em]">
            USAGE
          </Link>
          <span className="text-xs text-[var(--faint)]">AI compute</span>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span className="tnum text-[11px] text-[var(--faint)]">
            {formatNumber(data.window.requests)} requests · {data.windowDays}d ·{" "}
            {data.scoring.version}
          </span>
          <span className="text-[11px] text-[var(--muted)]">{user.email}</span>
          <form action={signOut}>
            <button
              type="submit"
              className="rounded-md border border-[var(--border)] px-2.5 py-1 text-[11px] text-[var(--muted)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--foreground)]"
            >
              Sign out
            </button>
          </form>
        </div>
      </header>

      {data.isEmpty ? (
        <EmptyState />
      ) : (
        <>
          <div className="mb-6 flex flex-wrap items-center gap-3">
            <span className="inline-flex items-center gap-1.5 rounded-sm border border-[var(--border-strong)] px-2 py-1 text-[10px] uppercase tracking-[0.12em] text-[var(--muted)]">
              <span className="size-1.5 rounded-full bg-[var(--verified)]" />
              Stored data · read from Postgres under RLS
            </span>
            <DemoIngestButton label="Re-sync demo usage" />
          </div>

          <div className="mb-6 space-y-2">
            {data.hasLiveRoutedEvidence && <LiveRoutedBanner />}
            {data.containsDemoData && <DemoBanner />}
            {data.containsFixtureEvidence && <FixtureBanner />}
          </div>

          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
            <Stat
              label="Today"
              value={formatUsd(data.today.costMicros)}
              sub={`${formatNumber(data.today.requests)} requests`}
            />
            <Stat
              label="This month"
              value={formatUsd(data.monthToDate.costMicros)}
              sub={`${formatNumber(data.monthToDate.requests)} requests`}
            />
            <Stat
              label="Tokens (month)"
              value={formatTokens(totalTokens(data.monthToDate))}
              sub="input + cached + output"
            />
            <Stat
              label="Proof of Usage"
              value={formatNumber(data.scoring.totalPoints)}
              sub="points, lifetime"
              accent="var(--verified)"
            />
            <Stat
              label="Network share"
              value={`${(data.epoch.networkShare * 100).toFixed(3)}%`}
              sub={`of ${formatNumber(data.epoch.networkParticipants)} participants (simulated)`}
            />
            <Stat
              label="Current epoch"
              value={`${formatNumber(data.epoch.estimatedPoints)} pts`}
              sub="estimated, settles at 00:00 UTC"
              accent="var(--warn)"
            />
          </section>

          <section className="mt-6 grid gap-4 lg:grid-cols-3">
            <Panel
              className="lg:col-span-2"
              title="Usage over time"
              hint={`Daily spend by verification level, last ${series.length} days`}
              action={
                <div className="flex gap-3 text-[10px] uppercase tracking-[0.12em]">
                  {(Object.keys(VERIFICATION_META) as VerificationType[]).map((type) => (
                    <span
                      key={type}
                      className="flex items-center gap-1.5"
                      style={{ color: VERIFICATION_META[type].color }}
                    >
                      <span
                        className="size-1.5 rounded-full"
                        style={{ background: VERIFICATION_META[type].color }}
                      />
                      {VERIFICATION_META[type].label}
                    </span>
                  ))}
                </div>
              }
            >
              <StackedUsageChart series={series} />
            </Panel>

            <Panel title="Proof of Usage" hint={`Algorithm ${data.scoring.version}`}>
              <p className="tnum text-3xl leading-none tracking-tight text-[var(--verified)]">
                {formatNumber(data.scoring.totalPoints)}
              </p>
              <p className="mt-1.5 text-xs text-[var(--muted)]">
                points across {data.scoring.scoredDays} scored days
              </p>
              <div className="mt-4">
                <ScoreSparkline series={series} />
              </div>
              <dl className="mt-4 space-y-2 border-t border-[var(--border)] pt-4 text-xs">
                <div className="flex justify-between gap-3">
                  <dt className="text-[var(--muted)]">Today score</dt>
                  <dd className="tnum">{formatNumber(data.epoch.userScore, 1)}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-[var(--muted)]">Protocol compute</dt>
                  <dd className="tnum">
                    {formatUsd(data.protocolComputeMicros, { maximumFractionDigits: 6 })}
                  </dd>
                </div>
                {data.pricingVersion && (
                  <div className="flex justify-between gap-3">
                    <dt className="text-[var(--muted)]">Pricing</dt>
                    <dd className="tnum text-[var(--faint)]">{data.pricingVersion}</dd>
                  </div>
                )}
                <div className="flex justify-between gap-3">
                  <dt className="text-[var(--muted)]">Actual gateway cost</dt>
                  <dd className="tnum text-[var(--faint)]">{formatUsd(scoredCost)}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-[var(--muted)]">Pending today</dt>
                  <dd className="tnum text-[var(--warn)]">
                    {formatUsd(data.epoch.pendingCostMicros, { maximumFractionDigits: 4 })}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-[var(--muted)]">Excluded today</dt>
                  <dd className="tnum text-[var(--reported)]">
                    {formatUsd(data.epoch.excludedCostMicros)}
                  </dd>
                </div>
              </dl>
              <p className="mt-3 text-[11px] leading-relaxed text-[var(--faint)]">
                Mining values verified compute at protocol prices, not what anyone was billed.
                The score is concave in the daily total (√), so splitting or wasting requests
                cannot farm points. Usage Points — Beta: off-chain and non-transferable.
              </p>
            </Panel>
          </section>

          <section className="mt-4 grid gap-4 lg:grid-cols-3">
            <Panel title="Verified vs reported" hint={`Normalized cost, last ${data.windowDays} days`}>
              <div className="space-y-4">
                {(Object.keys(VERIFICATION_META) as VerificationType[]).map((type) => {
                  const totals = data.byVerification[type];
                  return (
                    <Bar
                      key={type}
                      fraction={totalCost > 0 ? totals.costMicros / totalCost : 0}
                      color={VERIFICATION_META[type].color}
                      label={
                        <span className="flex items-center gap-2">
                          {VERIFICATION_META[type].label}
                          <span className="tnum text-[10px] text-[var(--faint)]">
                            ×{VERIFICATION_META[type].weight}
                          </span>
                        </span>
                      }
                      value={formatUsd(totals.costMicros)}
                    />
                  );
                })}
              </div>
            </Panel>

            <Panel title="Providers" hint="Month to date">
              <div className="space-y-4">
                {data.byProvider.map((slice) => (
                  <Bar
                    key={slice.key}
                    fraction={slice.shareOfCost}
                    color="var(--routed)"
                    label={slice.key}
                    value={formatUsd(slice.totals.costMicros)}
                  />
                ))}
              </div>
            </Panel>

            <Panel title="Models" hint="Month to date">
              <div className="space-y-4">
                {data.byModel.map((slice) => (
                  <Bar
                    key={slice.key}
                    fraction={slice.shareOfCost}
                    color="var(--verified)"
                    label={slice.key}
                    value={formatUsd(slice.totals.costMicros)}
                  />
                ))}
              </div>
            </Panel>
          </section>

          <section className="mt-4 grid gap-4 lg:grid-cols-3">
            <Panel
              className="lg:col-span-2"
              title="Recent activity"
              hint="Usage metadata only — never prompts or responses"
            >
              <div className="-mx-4 overflow-x-auto">
                <table className="w-full min-w-[620px] text-left text-xs">
                  <thead>
                    <tr className="text-[10px] uppercase tracking-[0.12em] text-[var(--faint)]">
                      <th className="px-4 pb-2 font-medium">Time (UTC)</th>
                      <th className="px-4 pb-2 font-medium">Provider</th>
                      <th className="px-4 pb-2 font-medium">Model</th>
                      <th className="px-4 pb-2 text-right font-medium">Requests</th>
                      <th className="px-4 pb-2 text-right font-medium">Tokens</th>
                      <th className="px-4 pb-2 text-right font-medium">Cost</th>
                      <th className="px-4 pb-2 font-medium">Proof</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--border)]">
                    {data.recentEvents.map((event) => (
                      <tr key={`${event.provider}:${event.externalReference}`}>
                        <td className="tnum px-4 py-2 text-[var(--muted)]">
                          {event.occurredAt.slice(5, 16).replace("T", " ")}
                        </td>
                        <td className="px-4 py-2">
                          {event.provider}
                          {event.rawMetadata.evidence_class === "fixture" && (
                            <span className="ml-1.5 text-[10px] uppercase tracking-[0.1em] text-[var(--faint)]">
                              fixture
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2 text-[var(--muted)]">{event.model}</td>
                        <td className="tnum px-4 py-2 text-right">{formatNumber(event.requests)}</td>
                        <td className="tnum px-4 py-2 text-right text-[var(--muted)]">
                          {formatTokens(
                            event.inputTokens + event.cachedInputTokens + event.outputTokens,
                          )}
                        </td>
                        <td className="tnum px-4 py-2 text-right">
                          {formatUsd(event.normalizedCostMicros, { maximumFractionDigits: 4 })}
                          {event.reportedCostMicros === null && (
                            <span className="ml-1 text-[10px] text-[var(--faint)]">est</span>
                          )}
                        </td>
                        <td className="px-4 py-2">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <VerificationBadge type={event.verificationType} />
                            {event.rawMetadata.proof_status === "confirmed" && (
                              <span
                                className="text-[10px] uppercase tracking-[0.1em] text-[var(--verified)]"
                                title="Signed by a USAGE production issuer"
                              >
                                signed ✓
                              </span>
                            )}
                            {event.economicStatus === "eligible" && (
                              <span
                                className="text-[10px] uppercase tracking-[0.1em] text-[var(--verified)]"
                                title="Priced by an approved protocol pricing snapshot"
                              >
                                mining
                              </span>
                            )}
                            {event.economicStatus === "pending_pricing" && (
                              <span
                                className="text-[10px] uppercase tracking-[0.1em] text-[var(--warn)]"
                                title="Real proof; no approved price for this model yet"
                              >
                                pending price
                              </span>
                            )}
                            {event.economicStatus === "pending_cost" && (
                              <span
                                className="text-[10px] uppercase tracking-[0.1em] text-[var(--warn)]"
                                title="Real proof; cost has not reconciled, so it earns nothing yet"
                              >
                                pending cost
                              </span>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>

            <div className="space-y-4">
              <Panel title="Current epoch" hint={data.epoch.definition.id}>
                <dl className="space-y-2.5 text-xs">
                  <div className="flex justify-between gap-3">
                    <dt className="text-[var(--muted)]">Reward pool</dt>
                    <dd className="tnum">
                      {formatNumber(data.epoch.definition.rewardPoolPoints)} pts
                    </dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-[var(--muted)]">Your score</dt>
                    <dd className="tnum">{formatNumber(data.epoch.userScore, 1)}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-[var(--muted)]">
                      Network score <span className="text-[var(--faint)]">(simulated)</span>
                    </dt>
                    <dd className="tnum">{formatNumber(Math.round(data.epoch.networkScore))}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-[var(--muted)]">Your share</dt>
                    <dd className="tnum">{(data.epoch.networkShare * 100).toFixed(4)}%</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-[var(--muted)]">Epoch state</dt>
                    <dd className="uppercase tracking-wide">{data.epoch.state}</dd>
                  </div>
                  <div className="flex justify-between gap-3 border-t border-[var(--border)] pt-2.5">
                    <dt className="text-[var(--foreground)]">Estimated Usage Points</dt>
                    <dd className="tnum text-[var(--warn)]">
                      {formatNumber(data.epoch.estimatedPoints)} pts
                    </dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-[var(--foreground)]">Settled Usage Points</dt>
                    <dd className="tnum">{formatNumber(data.settledPoints)} pts</dd>
                  </div>
                </dl>
                <p className="mt-3 text-[11px] leading-relaxed text-[var(--faint)]">
                  {data.epoch.state === "open"
                    ? "This epoch is OPEN: the estimate moves as usage arrives and nothing has been credited yet."
                    : "This epoch no longer accepts usage; later proofs carry forward to the next open epoch."}{" "}
                  Only a settled epoch credits Usage Points, and a settled allocation never changes.
                  No USAGE network exists yet: the network denominator is simulated, so the estimate
                  is illustrative. Points are non-transferable and carry no monetary value.
                </p>
              </Panel>

              <Panel title="Connections">
                <ul className="space-y-3">
                  {data.connections.map((connection) => (
                    <li key={connection.provider} className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-xs">{connection.label}</p>
                        <p className="tnum mt-0.5 text-[10px] text-[var(--faint)]">
                          {connection.lastSyncedAt
                            ? `synced ${connection.lastSyncedAt.slice(0, 16).replace("T", " ")}`
                            : "never synced"}{" "}
                          · {connection.costDataAvailable ? "cost data" : "tokens only"}
                        </p>
                      </div>
                      <VerificationBadge type={connection.verificationType} />
                    </li>
                  ))}
                </ul>
              </Panel>
            </div>
          </section>
        </>
      )}
    </main>
  );
}

function EmptyState() {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-8">
      <h2 className="text-sm font-medium">No usage stored yet</h2>
      <p className="mt-2 max-w-lg text-xs leading-relaxed text-[var(--muted)]">
        Your account has no usage events. Real provider adapters are not implemented yet, so in
        development you can run the demo adapters through the ingestion pipeline: they are
        normalized, deduplicated and written to Postgres exactly like real provider data would be.
      </p>
      <div className="mt-5">
        <DemoIngestButton />
      </div>
    </div>
  );
}

function SetupRequired() {
  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-6 py-16">
      <Link href="/" className="tnum text-sm font-medium tracking-[0.3em]">
        USAGE
      </Link>
      <h1 className="mt-8 text-xl font-medium tracking-tight">Database not configured</h1>
      <p className="mt-3 text-sm leading-relaxed text-[var(--muted)]">
        The dashboard reads stored usage from Postgres. Start the local Supabase stack and copy the
        printed keys into <code className="tnum text-[var(--foreground)]">.env.local</code>.
      </p>
      <pre className="tnum mt-5 overflow-x-auto rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4 text-xs text-[var(--muted)]">
        {`npm run db:start   # requires Docker
npm run db:reset   # apply migrations`}
      </pre>
      <p className="mt-4 text-xs text-[var(--faint)]">
        See docs/STATE.md for the current environment status.
      </p>
    </main>
  );
}
