import { dailyEpochFor, estimateReward, type RewardEpoch } from "@/lib/domain/epoch";
import { EMPTY_TOTALS, addToTotals, totalsBy, totalsByVerification, utcDay } from "@/lib/domain/normalize";
import { CURRENT_SCORING_VERSION, scoreDaily, scoreRecords, totalPoints, type DailyScore } from "@/lib/domain/scoring";
import type { NormalizedUsageRecord, UsageTotals, VerificationType } from "@/lib/domain/types";
import { DAILY_REWARD_POOL_POINTS, simulatedNetwork } from "@/lib/demo/network";
import { listIntegrations } from "@/lib/providers/registry";
import type { ProviderIntegration } from "@/lib/providers/adapter";
import { collectUsage, type CollectResult } from "./collect";

/** How much history the demo account carries. */
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

export interface DashboardData {
  generatedAt: string;
  isDemo: boolean;
  history: { days: number; events: number; duplicatesSkipped: number };

  today: UsageTotals;
  monthToDate: UsageTotals;
  allTime: UsageTotals;

  byVerification: Record<VerificationType, UsageTotals>;
  byProvider: DistributionSlice[];
  byModel: DistributionSlice[];

  series: SeriesPoint[];
  scoring: {
    version: string;
    totalPoints: number;
    dailyScores: DailyScore[];
  };

  epoch: {
    definition: RewardEpoch;
    userScore: number;
    networkScore: number;
    networkParticipants: number;
    networkShare: number;
    estimatedPoints: number;
    excludedCostMicros: number;
  };

  recentEvents: NormalizedUsageRecord[];
  integrations: {
    provider: string;
    label: string;
    verificationType: VerificationType;
    costDataAvailable: boolean;
    dataFreshness: string;
    connected: boolean;
  }[];
  failures: CollectResult["failures"];
}

function toSlices(map: Map<string, UsageTotals>): DistributionSlice[] {
  const total = [...map.values()].reduce((acc, t) => acc + t.costMicros, 0);
  return [...map.entries()]
    .map(([key, totals]) => ({
      key,
      totals,
      shareOfCost: total > 0 ? totals.costMicros / total : 0,
    }))
    .sort((a, b) => b.totals.costMicros - a.totals.costMicros);
}

function sumTotals(records: readonly NormalizedUsageRecord[]): UsageTotals {
  return records.reduce<UsageTotals>((acc, r) => addToTotals(acc, r), EMPTY_TOTALS);
}

function demoConnections(integrations: readonly ProviderIntegration[]) {
  return integrations.map((integration) => ({
    provider: integration.provider,
    context: {
      connectionId: `demo-${integration.provider}`,
      secrets: {},
      config: {},
    },
  }));
}

/**
 * Runs the full vertical slice:
 *   adapters -> normalized usage -> aggregates -> Proof of Usage score -> epoch
 */
export async function buildDashboard(now: Date = new Date()): Promise<DashboardData> {
  const until = new Date(now.getTime() + 60 * 60 * 1000); // include the current hour
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - HISTORY_DAYS * 86_400_000);

  const integrations = listIntegrations();
  const collected = await collectUsage(demoConnections(integrations), { since, until });
  const records = collected.records;

  const today = utcDay(now.toISOString());
  const monthPrefix = today.slice(0, 7);

  const todayRecords = records.filter((r) => utcDay(r.occurredAt) === today);
  const monthRecords = records.filter((r) => utcDay(r.occurredAt).startsWith(monthPrefix));

  const dailyScores = scoreDaily(records);
  const todayScore = scoreRecords(todayRecords);

  const network = simulatedNetwork(today);
  // The user is part of the network, so they belong in the denominator too.
  const networkScore = network.score + todayScore.points;
  const reward = estimateReward({
    userScore: todayScore.points,
    networkScore,
    rewardPoolPoints: DAILY_REWARD_POOL_POINTS,
  });

  const scoreByDay = new Map(dailyScores.map((s) => [s.day, s.points]));
  const seriesDays = [...new Set(records.map((r) => utcDay(r.occurredAt)))].sort();
  const series: SeriesPoint[] = seriesDays.map((day) => {
    const dayRecords = records.filter((r) => utcDay(r.occurredAt) === day);
    const totals = totalsByVerification(dayRecords);
    return {
      day,
      verifiedMicros: totals.verified.costMicros,
      routedMicros: totals.routed.costMicros,
      reportedMicros: totals.reported.costMicros,
      points: scoreByDay.get(day) ?? 0,
    };
  });

  return {
    generatedAt: now.toISOString(),
    isDemo: true,
    history: {
      days: HISTORY_DAYS,
      events: records.length,
      duplicatesSkipped: collected.duplicates,
    },

    today: sumTotals(todayRecords),
    monthToDate: sumTotals(monthRecords),
    allTime: sumTotals(records),

    byVerification: totalsByVerification(records),
    byProvider: toSlices(totalsBy(monthRecords, (r) => r.provider)),
    byModel: toSlices(totalsBy(monthRecords, (r) => r.model)),

    series,
    scoring: {
      version: CURRENT_SCORING_VERSION,
      totalPoints: totalPoints(dailyScores),
      dailyScores,
    },

    epoch: {
      definition: dailyEpochFor(now, DAILY_REWARD_POOL_POINTS),
      userScore: todayScore.points,
      networkScore,
      networkParticipants: network.participants,
      networkShare: reward.networkShare,
      estimatedPoints: reward.points,
      excludedCostMicros: todayScore.excludedCostMicros,
    },

    recentEvents: [...records].reverse().slice(0, 10),
    integrations: integrations.map((i) => ({
      provider: i.provider,
      label: i.label,
      verificationType: i.verificationType,
      costDataAvailable: i.capability.costDataAvailable,
      dataFreshness: i.capability.dataFreshness,
      connected: true,
    })),
    failures: collected.failures,
  };
}
