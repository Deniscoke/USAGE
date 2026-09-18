import Link from "next/link";
import type { ReactNode } from "react";
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
import { buildDashboardView, dashboardSinceDay } from "@/lib/pipeline/dashboard";
import type { ActivityItem } from "@/lib/product/activity";
import { loadDeviceViews } from "@/lib/miner/device-view";
import { groupDeviceViews } from "@/lib/miner/device-groups";
import { EarlierPairings } from "@/components/miner-device";
import { LocalOnlyChip, LocalTodayByTool, LocalUsageNote } from "@/components/local-ai-usage";
import { LiveLocalTracking, LiveTrackingBoundary } from "@/components/live-local-tracking";
import { LOCAL_AI_USAGE_COPY, loadLocalAiUsage, summarizeLocalAiUsage, utcDay } from "@/lib/miner/local-ai-usage";
import { MinerStatus } from "@/components/miner-status";
import { loadDistribution } from "@/lib/miner/distribution-source";
import { minerPresence } from "@/lib/miner/presence";
import { MINIMUM_MINER_VERSION } from "@/lib/miner/release";
import { ProviderBillingMonth, PROVIDER_BILLING_TONE, RewardNotEnabledChip } from "@/components/provider-billing";
import { loadProviderBilling, PROVIDER_BILLING_COPY, summarizeBillingMonth } from "@/lib/provider-billing/view";

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
  const [snapshot, devices, distribution, localToday, billing] = await Promise.all([
    loadDashboardSnapshot(supabase, user.id, dashboardSinceDay(now)),
    loadDeviceViews(supabase, user.id),
    // Cached upstream; a slow or rate-limited GitHub degrades to the pinned
    // build rather than delaying the dashboard.
    loadDistribution(),
    // The local subscription lane, today. Analytics only: it is read here and
    // rendered in its own area, and nothing economic below receives it. A
    // failed read hides that area's figures rather than the dashboard.
    loadLocalAiUsage(supabase, user.id, utcDay(now), now).catch(() => null),
    // The provider-billing lane (M17C), read as the user. Its own area below;
    // never added to verified compute or local usage.
    loadProviderBilling(supabase, user.id, now).catch(() => null),
  ]);
  const data = buildDashboardView({ ...snapshot, now });
  const localReport = localToday
    ? summarizeLocalAiUsage({ observations: localToday.observations, range: "today", now, truncated: localToday.truncated })
    : null;
  const deviceGroups = groupDeviceViews(devices);
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

      <LaneHeading
        id="verified-compute"
        title="Verified compute"
        sub="Economic records USAGE wrote on its own servers, labelled by evidence level. Only this area counts toward mining and Usage Points."
        tone="var(--verified)"
      />
      <section aria-labelledby="verified-compute" className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
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
              value={formatUsd(data.today.costMicros, { maximumFractionDigits: 6 })}
              sub="cost today"
            />
            <Metric label="AI usage" value={formatTokens(totalTokens(data.today))} sub="tokens today" />
            <Metric label="Mining score" value={formatNumber(data.epoch.userScore, 2)} sub="today" />
            <Metric
              label="Network share"
              value={`${(data.epoch.networkShare * 100).toFixed(2)}%`}
              sub={data.epoch.networkParticipants > 0 ? `${formatNumber(data.epoch.networkParticipants)} miner(s) today` : "no miners yet today"}
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

            <Panel title="Connected AI" hint="What USAGE can route, and how">
              <ul className="space-y-2.5">
                {data.connectedAi
                  .filter((tool) => tool.state !== "coming_soon")
                  .map((tool) => (
                    <li key={tool.key} className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-xs">{tool.label}</p>
                        <p className="truncate text-[10px] text-[var(--faint)]">
                          {tool.gatewayName
                            ? `Routed via ${tool.gatewayName}`
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
                sub={data.scoring.since ? `${data.scoring.version}, since ${data.scoring.since}` : `${data.scoring.version}, lifetime`}
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
                  {data.protocol.status.current.emissionAlgorithm === "baseline-linear-v1"
                    ? "The score is your verified compute at the protocol price. The day's pool grows with the whole network's verified compute up to 100,000 points at $1,000, and points nobody earned are never minted. Only paid compute USAGE verifies counts, so farming costs what it earns."
                    : "The score is concave in the daily total (√) and the epoch pool is fixed, so splitting or wasting requests cannot farm USAGE."}
                </p>
              </Panel>
            </div>

            <div className="mt-4">
              <DemoIngestButton label="Re-sync demo usage" />
            </div>
          </details>
        </>
      )}

      <LaneHeading
        id="local-ai-usage"
        title={LOCAL_AI_USAGE_COPY.title}
        sub="Subscription usage your apps reported through USAGE Miner, today (UTC)."
        tone="var(--reported)"
        chip={<LocalOnlyChip withReward />}
      />
      <section aria-labelledby="local-ai-usage" className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5">
        {mountLive && (
          <div className="mb-4">
            <LiveTrackingBoundary>
              <LiveLocalTracking userId={user.id} />
            </LiveTrackingBoundary>
          </div>
        )}
        {localReport ? (
          <LocalTodayByTool report={localReport} />
        ) : (
          <p className="text-xs text-[var(--muted)]">Local AI usage could not be loaded just now. Reload to try again.</p>
        )}
        <div className="mt-4 flex flex-wrap items-baseline justify-between gap-3 border-t border-[var(--border)] pt-3">
          <LocalUsageNote />
          <Link href="/analytics" className="text-[11px] text-[var(--muted)] hover:text-[var(--foreground)] hover:underline">
            Usage analytics →
          </Link>
        </div>
      </section>

      <LaneHeading
        id="provider-confirmed-usage"
        title={PROVIDER_BILLING_COPY.title}
        sub="Aggregates a provider's own billing reports about your account, this month (UTC)."
        tone={PROVIDER_BILLING_TONE}
        chip={<RewardNotEnabledChip />}
      />
      <section aria-labelledby="provider-confirmed-usage" className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5">
        {billing ? (
          <ProviderBillingMonth summaries={summarizeBillingMonth(billing.rows, billing.month)} accounts={billing.accounts} month={billing.month} />
        ) : (
          <p className="text-xs text-[var(--muted)]">Provider-confirmed usage could not be loaded just now. Reload to try again.</p>
        )}
      </section>

      <section className="mt-4">
        <Panel title="USAGE Miner" hint="Computers metering the AI apps you chose">
          <MinerStatus presence={presence} distribution={distribution} />

          {deviceGroups.current.length > 0 && (
            <ul className="mt-4 divide-y divide-[var(--border)] border-t border-[var(--border)] pt-3">
              {deviceGroups.current.map((view) => (
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
                  {/* Per-device figures live on the device page; today's local
                      totals are in "Local AI usage" above, so they are not
                      repeated here in a second, differently-deduped form. */}
                  <Link href={`/miners/${view.device.id}`} className="mt-2 inline-block text-[10px] text-[var(--muted)] hover:underline">
                    Per-device breakdown →
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <EarlierPairings views={deviceGroups.earlier} className="mt-4 border-t border-[var(--border)] pt-3" />
          <p className="mt-3 text-[10px] leading-relaxed text-[var(--faint)]">
            Tracked ≠ verified ≠ reward-eligible. Only compute USAGE can confirm with a record of its
            own enters mining, and free compute stays at zero.
          </p>
        </Panel>
      </section>

      <div className="mt-6">
        <PrivacyNote />
      </div>
    </main>
  );
}

/**
 * The dashboard has three areas that must never read as one: verified compute
 * (economic), local AI usage (analytics) and provider-confirmed usage
 * (provider billing evidence, reward 0). Each opens with this heading, in
 * its lane's colour.
 */
function LaneHeading({ id, title, sub, tone, chip }: { id: string; title: string; sub: string; tone: string; chip?: ReactNode }) {
  return (
    <div className="mb-3 mt-8 flex flex-wrap items-end justify-between gap-2 border-b pb-2" style={{ borderColor: `color-mix(in srgb, ${tone} 40%, transparent)` }}>
      <div>
        <h2 id={id} className="text-[11px] font-medium uppercase tracking-[0.16em]" style={{ color: tone }}>
          {title}
        </h2>
        <p className="mt-0.5 text-[11px] text-[var(--faint)]">{sub}</p>
      </div>
      {chip}
    </div>
  );
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
