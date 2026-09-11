import Link from "next/link";
import { redirect } from "next/navigation";
import { ScoreSparkline, StackedUsageChart } from "@/components/charts";
import { DemoIngestButton } from "@/components/demo-ingest-button";
import { AppNav, BalanceHeadline, PrivacyNote, StateBadge } from "@/components/product";
import { Panel, Stat, VERIFICATION_META, VerificationBadge } from "@/components/ui";
import { signOut } from "@/app/auth/actions";
import { formatNumber, formatTokens, formatUsd } from "@/lib/domain/money";
import { totalTokens } from "@/lib/domain/normalize";
import type { VerificationType } from "@/lib/domain/types";
import { createServerSupabase } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { loadDashboardSnapshot } from "@/lib/db/usage-repository";
import { buildDashboardView, dashboardSinceDay, type DashboardData } from "@/lib/pipeline/dashboard";
import type { ActivityItem } from "@/lib/product/activity";
import { loadDeviceViews } from "@/lib/miner/device-view";
import { TodayFigures } from "@/components/miner-device";
import { MinerStatus } from "@/components/miner-status";
import { loadDistribution } from "@/lib/miner/distribution-source";
import { minerPresence } from "@/lib/miner/presence";
import { MINIMUM_MINER_VERSION } from "@/lib/miner/release";

export const dynamic = "force-dynamic";

import { LiveMining } from "@/components/live-mining";
import { LiveMiningBoundary } from "@/components/live-mining-boundary";
import { buildMiningSummary } from "@/lib/live/summary";

const CHART_DAYS = 45;

/**
 * The mining dashboard.
 *
 * Product first: balance, mining status, what ran today, what is connected.
 * Protocol detail is real and reachable, but folded away -- a person should be
 * able to read this page without knowing what an epoch is.
 */
export default async function DashboardPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (!isSupabaseConfigured()) return <SetupRequired />;
  // Test-only A/B switch (M16B.1): `?live=0` renders the dashboard without the
  // live widget so navigation stability can be compared with and without it.
  // It changes nothing about data or economics.
  const { live } = await searchParams;
  const mountLive = live !== "0";

  const supabase = await createServerSupabase();
  if (!supabase) return <SetupRequired />;

  // getUser() validates the token with Supabase rather than trusting the cookie.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/dashboard");

  const now = new Date();
  const [snapshot, devices, distribution] = await Promise.all([
    loadDashboardSnapshot(supabase, user.id, dashboardSinceDay(now)),
    loadDeviceViews(supabase, user.id),
    // Cached upstream; a slow or rate-limited GitHub degrades to the pinned
    // build rather than delaying the dashboard.
    loadDistribution(),
  ]);
  const data = buildDashboardView({ ...snapshot, now });
  const presence = minerPresence({
    devices,
    latestVersion: distribution.version,
    minimumVersion: MINIMUM_MINER_VERSION,
    now: now.getTime(),
  });

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 sm:py-8">
      <AppNav
        email={user.email}
        right={
          <form action={signOut}>
            <button
              type="submit"
              className="rounded-md border border-[var(--border)] px-2.5 py-1 text-[11px] text-[var(--muted)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--foreground)]"
            >
              Sign out
            </button>
          </form>
        }
      />

      <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <BalanceHeadline
          settled={formatNumber(data.settledPoints)}
          estimated={formatNumber(data.epoch.estimatedPoints)}
          epochState={data.epoch.state}
          epochLabel={data.epoch.label}
          settledEpochPoints={data.epoch.settledPoints === null ? null : formatNumber(data.epoch.settledPoints)}
        />

        {mountLive && (
          <LiveMiningBoundary>
            <LiveMining userId={user.id} initial={buildMiningSummary(data, devices, now)} outputMicrosPerMillion={null} />
          </LiveMiningBoundary>
        )}

        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5">
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-[var(--faint)]">
              Mining
            </p>
            <span
              className="text-[11px] font-medium uppercase tracking-[0.14em]"
              style={{ color: data.mining.active ? "var(--verified)" : "var(--muted)" }}
            >
              {data.mining.active
                ? "Mining active"
                : data.mining.hasCredential
                  ? "Ready — no usage yet"
                  : "Not connected"}
            </span>
          </div>

          <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Metric
              label="AI compute"
              value={formatUsd(todayCompute(data), { maximumFractionDigits: 6 })}
              sub="protocol equivalent"
            />
            <Metric label="AI usage" value={formatTokens(totalTokens(data.today))} sub="tokens today" />
            <Metric label="Mining score" value={formatNumber(data.epoch.userScore, 2)} sub="today" />
            <Metric
              label="Network share"
              value={`${(data.epoch.networkShare * 100).toFixed(2)}%`}
              sub={`${formatNumber(Math.max(data.epoch.networkParticipants, 1))} miner(s)`}
            />
          </dl>

          {!data.mining.hasCredential && (
            <Link
              href="/onboarding"
              className="mt-5 inline-block rounded-md bg-[var(--foreground)] px-4 py-2 text-xs font-medium text-[var(--background)] transition-opacity hover:opacity-90"
            >
              Connect your AI →
            </Link>
          )}

          <p className="mt-4 text-[11px] leading-relaxed text-[var(--faint)]">
            {data.protocol.network === "development"
              ? "Development network. Usage Points are beta: off-chain, non-transferable, no monetary value."
              : "Usage Points are off-chain and non-transferable."}{" "}
            {data.protocol.status.current.emissionAlgorithm === "baseline-linear-v1"
              ? `Daily emission is up to ${formatNumber(data.protocol.emissionPoints)} Usage Points, unlocked as the network's eligible compute approaches the baseline; what is not unlocked is never minted.`
              : `Emission is a fixed ${formatNumber(data.protocol.emissionPoints)} per epoch, so extra usage cannot mint extra USAGE.`}{" "}
            Mining protocol: {data.protocol.status.headline}. Scoring: {data.protocol.status.scoringLabel}.
            No guaranteed conversion into any future token.
          </p>
        </div>
      </section>

      {data.isEmpty ? (
        <div className="mt-4">
          <EmptyState />
        </div>
      ) : (
        <>
          <section className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
            <Panel title="Recent activity" hint="Your AI compute, newest first">
              {data.activity.length === 0 ? (
                <p className="text-xs text-[var(--muted)]">Nothing recorded yet.</p>
              ) : (
                <ul className="divide-y divide-[var(--border)]">
                  {data.activity.map((item) => (
                    <ActivityRow key={item.id} item={item} />
                  ))}
                </ul>
              )}
            </Panel>

            <Panel title="Connected AI" hint="What can mine, and how">
              <ul className="space-y-2.5">
                {data.connectedAi
                  .filter((tool) => tool.state !== "coming_soon")
                  .map((tool) => (
                    <li key={tool.key} className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-xs">{tool.label}</p>
                        <p className="truncate text-[10px] text-[var(--faint)]">
                          {tool.gatewayName
                            ? `Mining via ${tool.gatewayName}`
                            : tool.method === "verified_import"
                              ? "Verified organization import"
                              : tool.providerName}
                          {tool.lastSyncedAt
                            ? ` · synced ${tool.lastSyncedAt.slice(0, 10)}`
                            : ""}
                        </p>
                      </div>
                      <StateBadge state={tool.state} />
                    </li>
                  ))}
              </ul>
              <Link
                href="/onboarding"
                className="mt-4 inline-block text-[11px] text-[var(--routed)] hover:underline"
              >
                Connect more AI →
              </Link>
            </Panel>
          </section>

          <section className="mt-4">
            <Panel title="USAGE Miner" hint="Computers metering the AI apps you chose">
              <MinerStatus presence={presence} distribution={distribution} />

              {devices.length > 0 && (
                <ul className="mt-4 divide-y divide-[var(--border)] border-t border-[var(--border)] pt-3">
                  {devices.map((view) => (
                    <li key={view.device.id} className="py-3 first:pt-0 last:pb-0">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <Link href={`/miners/${view.device.id}`} className="text-xs hover:underline">
                          {view.device.name}
                        </Link>
                        <span
                          className="text-[10px] uppercase tracking-[0.1em]"
                          style={{ color: view.revoked ? "var(--reported)" : view.online ? "var(--verified)" : "var(--faint)" }}
                        >
                          {view.revoked ? "Revoked" : view.online ? "● Online" : "Offline"}
                        </span>
                      </div>
                      <ul className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
                        {view.tools
                          .filter((t) => t.detected || t.mapped)
                          .map((t) => (
                            <li key={t.tool.id} className="text-[10px]">
                              <span
                                style={{
                                  color: t.mapped
                                    ? t.verificationCapability === "provider_correlated"
                                      ? "var(--verified)"
                                      : "var(--routed)"
                                    : "var(--faint)",
                                }}
                              >
                                ●
                              </span>{" "}
                              {t.tool.displayName}{" "}
                              <span className="text-[var(--muted)]">
                                {t.mapped
                                  ? t.verificationCapability === "provider_correlated"
                                    ? "mapping active"
                                    : "observed only"
                                  : "not mapped"}
                              </span>
                            </li>
                          ))}
                      </ul>
                      <div className="mt-3">
                        <TodayFigures view={view} compact />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-3 text-[10px] leading-relaxed text-[var(--faint)]">
                Tracked ≠ verified ≠ reward-eligible. Only compute USAGE can confirm with a record of its
                own enters mining, and free compute stays at zero.
              </p>
            </Panel>
          </section>

          <details className="mt-4 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
            <summary className="cursor-pointer text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--muted)]">
              Protocol detail
            </summary>

            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
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
                label="Mining score"
                value={formatNumber(data.scoring.totalPoints)}
                sub={`${data.scoring.version}, lifetime`}
                accent="var(--verified)"
              />
              <Stat
                label="Epoch"
                value={data.epoch.state.toUpperCase()}
                sub={data.epoch.definition.id}
                accent="var(--warn)"
              />
            </div>

            <div className="mt-4 grid gap-4 lg:grid-cols-3">
              <Panel
                className="lg:col-span-2"
                title="Usage over time"
                hint={`Daily compute by evidence level, last ${Math.min(data.series.length, CHART_DAYS)} days`}
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
                <StackedUsageChart series={data.series.slice(-CHART_DAYS)} />
              </Panel>

              <Panel title="Mining score" hint={data.scoring.version}>
                <ScoreSparkline series={data.series.slice(-CHART_DAYS)} />
                <dl className="mt-4 space-y-2 border-t border-[var(--border)] pt-4 text-xs">
                  <DetailRow
                    label="Protocol compute"
                    value={formatUsd(data.protocolComputeMicros, { maximumFractionDigits: 6 })}
                  />
                  <DetailRow label="Pricing" value={data.pricingVersion ?? "—"} faint />
                  <DetailRow label="Protocol" value={data.protocol.version} faint />
                  <DetailRow
                    label="Pending today"
                    value={formatUsd(data.epoch.pendingCostMicros, { maximumFractionDigits: 4 })}
                    tone="var(--warn)"
                  />
                  <DetailRow
                    label="Excluded today"
                    value={formatUsd(data.epoch.excludedCostMicros)}
                    tone="var(--reported)"
                  />
                </dl>
                <p className="mt-3 text-[11px] leading-relaxed text-[var(--faint)]">
                  The score is concave in the daily total (√) and the epoch pool is fixed, so
                  splitting or wasting requests cannot farm USAGE.
                </p>
              </Panel>
            </div>

            <div className="mt-4">
              <DemoIngestButton label="Re-sync demo usage" />
            </div>
          </details>
        </>
      )}

      <div className="mt-6">
        <PrivacyNote />
      </div>
    </main>
  );
}

/** Protocol compute observed today, from the events the feed already loaded. */
function todayCompute(data: DashboardData): number {
  const today = data.epoch.definition.startsAt.slice(0, 10);
  return data.activity
    .filter((item) => item.occurredAt.slice(0, 10) === today)
    .reduce((acc, item) => acc + (item.protocolComputeMicros ?? 0), 0);
}

function Metric({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-[0.14em] text-[var(--faint)]">{label}</dt>
      <dd className="tnum mt-1.5 text-lg leading-none tracking-tight">{value}</dd>
      <dd className="mt-1 text-[10px] text-[var(--muted)]">{sub}</dd>
    </div>
  );
}

function DetailRow({
  label,
  value,
  tone,
  faint,
}: {
  label: string;
  value: string;
  tone?: string;
  faint?: boolean;
}) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-[var(--muted)]">{label}</dt>
      <dd className="tnum" style={{ color: tone ?? (faint ? "var(--faint)" : undefined) }}>
        {value}
      </dd>
    </div>
  );
}

function ActivityRow({ item }: { item: ActivityItem }) {
  return (
    <li className="flex items-start justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <Link href={`/proofs/${item.id}`} className="truncate text-xs hover:underline">
          {item.tool ?? item.provider} · {item.modelLabel}
        </Link>
        <p className="tnum mt-0.5 text-[10px] text-[var(--faint)]">
          {item.origin} · {formatTokens(item.tokens)} tokens ·{" "}
          {item.occurredAt.slice(0, 16).replace("T", " ")}
          {item.contributesToMining && item.protocolComputeMicros !== null
            ? ` · +${formatUsd(item.protocolComputeMicros, { maximumFractionDigits: 6 })} compute`
            : ""}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {item.proofStatus === "confirmed" && (
          <span className="text-[10px] uppercase tracking-[0.1em] text-[var(--verified)]">
            Confirmed
          </span>
        )}
        <VerificationBadge type={item.verificationType} />
      </div>
    </li>
  );
}

function EmptyState() {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-8">
      <h2 className="text-sm font-medium">Nothing mined yet</h2>
      <p className="mt-2 max-w-lg text-xs leading-relaxed text-[var(--muted)]">
        Connect an AI tool and use it normally. Every request USAGE routes is verified and starts
        counting toward the current epoch.
      </p>
      {/* Two people from outside this account reached exactly here and
          stopped. "Connect your AI" sent them to a page of choices, and the
          choice that works was several clicks further in. The button that
          unblocks somebody is the one that does the thing. */}
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <a
          href="/api/providers/oauth/openrouter/start"
          className="rounded-md bg-[var(--foreground)] px-4 py-2 text-xs font-medium text-[var(--background)] transition-opacity hover:opacity-90"
        >
          Connect OpenRouter
        </a>
        <Link href="/onboarding" className="text-xs text-[var(--routed)] hover:underline">
          Other ways to connect
        </Link>
        <DemoIngestButton />
      </div>
      <p className="mt-3 text-[11px] leading-relaxed text-[var(--faint)]">
        OpenRouter is the one connection that can earn today: it states per request what the
        compute cost and whether the account has purchased credit, which is what USAGE needs before
        it can reward anything. Sign in with an account that has credit on it.
      </p>
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
