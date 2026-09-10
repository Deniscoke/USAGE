import {
  dailyEpochFor,
  epochIdForDate,
  estimateReward,
  type EpochState,
  type RewardEpoch,
} from "@/lib/domain/epoch";
import { EMPTY_TOTALS, utcDay } from "@/lib/domain/normalize";
import { protocolForEpoch, protocolStatusView, scheduleFromRows, type ProtocolStatusView } from "@/lib/protocol/schedule";
import type { ProtocolVersionRowLite } from "@/lib/db/usage-repository";
import type {
  DailyAggregate,
  NormalizedUsageRecord,
  ProofStatus,
  UsageTotals,
  VerificationType,
} from "@/lib/domain/types";
import {
  type ProtocolNetwork,
} from "@/lib/protocol/emission";
import { buildActivityFeed, type ActivityItem } from "@/lib/product/activity";
import { deriveConnections, type ConnectedTool } from "@/lib/product/connections";
import { listIntegrations } from "@/lib/providers/registry";
import { VERCEL_GATEWAY_PROVIDER } from "@/lib/providers/vercel-gateway/observation";
import type { ConnectionSummary, MinerCredentialSummary } from "@/lib/db/usage-repository";
import type { StoredDailyScore } from "@/lib/db/rows";

/**
 * Dashboard view model.
 *
 * Pure: it takes what the database returned and derives what the page renders.
 * It calls no adapter and performs no IO, so the dashboard reflects *stored*
 * usage rather than regenerating usage on every render.
 */

/** How much history the dashboard loads. */
export const HISTORY_DAYS = 90;

export interface SeriesPoint {
  day: string;
  verifiedMicros: number;
  routedMicros: number;
  reportedMicros: number;
  points: number;
}

export interface DistributionSlice {
  key: string;
  totals: UsageTotals;
  shareOfCost: number;
}

export interface ConnectionView {
  provider: string;
  label: string;
  verificationType: VerificationType;
  costDataAvailable: boolean;
  dataFreshness: string;
  status: ConnectionSummary["status"];
  lastSyncedAt: string | null;
  isDemo: boolean;
}

export interface DashboardData {
  generatedAt: string;
  windowDays: number;
  isEmpty: boolean;
  /** True when any stored usage came from a demo adapter. */
  containsDemoData: boolean;
  /** Gateway evidence that was replayed from a fixture: shown, never rewarded. */
  containsFixtureEvidence: boolean;
  /** At least one real request USAGE actually routed and observed. */
  hasLiveRoutedEvidence: boolean;

  today: UsageTotals;
  monthToDate: UsageTotals;
  window: UsageTotals;

  byVerification: Record<VerificationType, UsageTotals>;
  byProvider: DistributionSlice[];
  byModel: DistributionSlice[];

  series: SeriesPoint[];
  scoring: { version: string; totalPoints: number; scoredDays: number };
  /** Protocol compute value backing the score, and the snapshot that priced it. */
  protocolComputeMicros: number;
  pricingVersion: string | null;

  epoch: {
    definition: RewardEpoch;
    userScore: number;
    /** Simulated until a real network exists. Always labelled as such in the UI. */
    networkScore: number;
    networkParticipants: number;
    networkShare: number;
    /**
     * What the current OPEN epoch would pay at this instant. A projection from
     * a live score against a fixed pool -- it moves while the epoch is open and
     * is never written to the point ledger.
     */
    estimatedPoints: number;
    excludedCostMicros: number;
    /** Real usage today whose economic weight is not yet established. */
    pendingCostMicros: number;
    state: EpochState;
  };

  /** Which protocol governs TODAY'S epoch (from the persisted schedule), and whether it is a public network. */
  protocol: {
    version: string;
    network: ProtocolNetwork;
    /** The scheduled cap for today's epoch. Under baseline-linear-v1 it is a cap, not an amount. */
    emissionPoints: number;
    /** Cutover-aware copy: DEVELOPMENT V1 / PREPARING BETA V2 / BETA V2 SCHEDULED … / BETA V2. */
    status: ProtocolStatusView;
  };

  mining: {
    /** True when a live miner credential exists AND usage has been observed. */
    active: boolean;
    hasCredential: boolean;
    lastProofAt: string | null;
  };

  connectedAi: ConnectedTool[];
  activity: ActivityItem[];

  /**
   * Usage Points actually credited by settled epochs. Permanent, and strictly
   * separate from the estimate above: an estimate never becomes a balance
   * except by settling the epoch that produced it.
   */
  settledPoints: number;

  recentEvents: NormalizedUsageRecord[];
  connections: ConnectionView[];
}

export interface DashboardInput {
  aggregates: readonly DailyAggregate[];
  scores: readonly StoredDailyScore[];
  recentEvents: readonly (NormalizedUsageRecord & { id?: string })[];
  connections: readonly ConnectionSummary[];
  /** Permanently credited Usage Points. Absent for callers with no ledger. */
  settledPoints?: number;
  epochStates?: Readonly<Record<string, EpochState>>;
  proofStatusById?: ReadonlyMap<string, ProofStatus>;
  minerCredentials?: readonly MinerCredentialSummary[];
  /** Scored points from everyone else in today's epoch. Zero, never invented. */
  otherParticipantsScore?: number;
  /** mining_protocol_versions rows, when the repository loaded them; the persisted schedule. */
  protocolRows?: ProtocolVersionRowLite[];
  networkParticipants?: number;
  now?: Date;
}

function addAggregate(totals: UsageTotals, aggregate: DailyAggregate): UsageTotals {
  return {
    requests: totals.requests + aggregate.requests,
    inputTokens: totals.inputTokens + aggregate.inputTokens,
    cachedInputTokens: totals.cachedInputTokens + aggregate.cachedInputTokens,
    outputTokens: totals.outputTokens + aggregate.outputTokens,
    costMicros: totals.costMicros + aggregate.costMicros,
  };
}

function sum(aggregates: readonly DailyAggregate[]): UsageTotals {
  return aggregates.reduce<UsageTotals>(addAggregate, EMPTY_TOTALS);
}

function groupTotals<K extends string>(
  aggregates: readonly DailyAggregate[],
  keyOf: (aggregate: DailyAggregate) => K,
): Map<K, UsageTotals> {
  const out = new Map<K, UsageTotals>();
  for (const aggregate of aggregates) {
    const key = keyOf(aggregate);
    out.set(key, addAggregate(out.get(key) ?? EMPTY_TOTALS, aggregate));
  }
  return out;
}

function toSlices(map: Map<string, UsageTotals>): DistributionSlice[] {
  const total = [...map.values()].reduce((acc, totals) => acc + totals.costMicros, 0);
  return [...map.entries()]
    .map(([key, totals]) => ({ key, totals, shareOfCost: total > 0 ? totals.costMicros / total : 0 }))
    .sort((a, b) => b.totals.costMicros - a.totals.costMicros);
}

function isDemoProvider(provider: string): boolean {
  return provider.startsWith("demo-");
}

export function buildDashboardView({
  aggregates,
  scores,
  recentEvents,
  connections,
  settledPoints = 0,
  epochStates = {},
  proofStatusById,
  minerCredentials = [],
  otherParticipantsScore = 0,
  protocolRows = [],
  networkParticipants = 0,
  now = new Date(),
}: DashboardInput): DashboardData {
  const today = utcDay(now.toISOString());
  const monthPrefix = today.slice(0, 7);

  const todayAggregates = aggregates.filter((a) => a.day === today);
  const monthAggregates = aggregates.filter((a) => a.day.startsWith(monthPrefix));

  const byVerificationMap = groupTotals(aggregates, (a) => a.verificationType);
  const byVerification: Record<VerificationType, UsageTotals> = {
    verified: byVerificationMap.get("verified") ?? EMPTY_TOTALS,
    routed: byVerificationMap.get("routed") ?? EMPTY_TOTALS,
    reported: byVerificationMap.get("reported") ?? EMPTY_TOTALS,
  };

  const scoreByDay = new Map(scores.map((score) => [score.day, score]));
  const days = [...new Set(aggregates.map((a) => a.day))].sort();
  const series: SeriesPoint[] = days.map((day) => {
    const forDay = aggregates.filter((a) => a.day === day);
    const totalsFor = (type: VerificationType) =>
      forDay.filter((a) => a.verificationType === type).reduce((acc, a) => acc + a.costMicros, 0);
    return {
      day,
      verifiedMicros: totalsFor("verified"),
      routedMicros: totalsFor("routed"),
      reportedMicros: totalsFor("reported"),
      points: scoreByDay.get(day)?.points ?? 0,
    };
  });

  // An epoch nobody has closed is open: it only leaves OPEN by an explicit act.
  const epochState: EpochState = epochStates[epochIdForDate(now)] ?? "open";
  // The protocol for TODAY'S epoch, from the persisted schedule when the
  // repository supplied it; never from a deploy-time constant.
  const schedule = protocolRows.length ? scheduleFromRows(protocolRows) : undefined;
  const todayProtocol = protocolForEpoch(epochIdForDate(now), schedule);
  const todayPool = todayProtocol.epochEmissionPoints;

  const todayScore = scoreByDay.get(today);
  const userScore = todayScore?.points ?? 0;
  // The denominator is the real network: this user plus everyone else who
  // actually scored today. A single-participant development network honestly
  // shows a 100% share; inventing other participants would invent a share.
  const networkScore = otherParticipantsScore + userScore;
  const reward = estimateReward({
    userScore,
    networkScore,
    rewardPoolPoints: todayPool,
  });

  const capabilities = new Map(listIntegrations().map((i) => [i.provider, i]));

  const hasCredential = minerCredentials.some((credential) => credential.revokedAt === null);
  const activity = buildActivityFeed({ events: recentEvents, proofStatusById });
  const activeProviders = new Set(
    activity
      .filter((item) => item.contributesToMining)
      .map((item) => item.model.split("/")[0]),
  );

  return {
    generatedAt: now.toISOString(),
    windowDays: HISTORY_DAYS,
    isEmpty: aggregates.length === 0,
    containsDemoData: aggregates.some((a) => isDemoProvider(a.provider)),
    // Gateway rows separate cleanly: fixtures are reported, live traffic is routed.
    containsFixtureEvidence: aggregates.some(
      (a) => a.provider === VERCEL_GATEWAY_PROVIDER && a.verificationType === "reported",
    ),
    hasLiveRoutedEvidence: aggregates.some(
      (a) => a.provider === VERCEL_GATEWAY_PROVIDER && a.verificationType === "routed",
    ),

    today: sum(todayAggregates),
    monthToDate: sum(monthAggregates),
    window: sum(aggregates),

    byVerification,
    byProvider: toSlices(groupTotals(monthAggregates, (a) => a.provider)),
    byModel: toSlices(groupTotals(monthAggregates, (a) => a.model)),

    series,
    protocolComputeMicros: recentEvents.reduce(
      (acc, event) => acc + (event.protocolComputeMicros ?? 0),
      0,
    ),
    pricingVersion:
      recentEvents.find((event) => event.protocolPricingVersion)?.protocolPricingVersion ?? null,
    scoring: {
      version: todayProtocol.scoringVersion,
      totalPoints: Math.round(scores.reduce((acc, score) => acc + score.points, 0) * 10_000) / 10_000,
      scoredDays: scores.filter((score) => score.points > 0).length,
    },

    epoch: {
      definition: dailyEpochFor(now, todayPool, epochState),
      userScore,
      networkScore,
      networkParticipants,
      networkShare: reward.networkShare,
      estimatedPoints: reward.points,
      excludedCostMicros: todayScore?.excludedCostMicros ?? 0,
      pendingCostMicros: todayScore?.pendingCostMicros ?? 0,
      state: epochState,
    },

    protocol: {
      version: todayProtocol.version,
      network: todayProtocol.network,
      emissionPoints: todayPool,
      status: protocolStatusView(epochIdForDate(now), schedule),
    },

    mining: {
      active: hasCredential && activity.some((item) => item.contributesToMining),
      hasCredential,
      lastProofAt: activity[0]?.occurredAt ?? null,
    },

    connectedAi: deriveConnections({
      connections: connections.map((connection) => ({
        provider: connection.provider,
        method: connection.method,
        status: connection.status,
        lastSyncedAt: connection.lastSyncedAt,
      })),
      hasActiveMiner: hasCredential,
      activeProviders,
    }),
    activity,

    settledPoints,

    recentEvents: [...recentEvents],
    connections: connections.map((connection) => {
      const capability = capabilities.get(connection.provider);
      return {
        provider: connection.provider,
        label: capability?.label ?? connection.provider,
        verificationType: capability?.verificationType ?? "reported",
        costDataAvailable: capability?.capability.costDataAvailable ?? false,
        dataFreshness: capability?.capability.dataFreshness ?? "unknown",
        status: connection.status,
        lastSyncedAt: connection.lastSyncedAt,
        isDemo: isDemoProvider(connection.provider),
      };
    }),
  };
}

/** First day the dashboard loads, inclusive. */
export function dashboardSinceDay(now: Date = new Date()): string {
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(start - HISTORY_DAYS * 86_400_000).toISOString().slice(0, 10);
}
