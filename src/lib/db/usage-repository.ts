import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  Database,
  EpochStateRow,
  ProviderConnectionRow,
  ScoreRecordRow,
  UsageDailyAggregateRow,
  UsageEventRow,
} from "@/lib/supabase/database.types";
import type { DailyAggregate, NormalizedUsageRecord } from "@/lib/domain/types";
import { CURRENT_SCORING_VERSION } from "@/lib/domain/scoring";
import {
  rowToDailyAggregate,
  rowToScore,
  rowToUsageRecord,
  toSafeInteger,
  type StoredDailyScore,
} from "./rows";

/**
 * Dashboard reads.
 *
 * These run through the *user's* client, so Postgres RLS decides what comes
 * back. The explicit `user_id` filters are defence in depth and index hints,
 * not the access control -- deleting them must not change what a user can see.
 * The service role is never used here.
 */

export interface ConnectionSummary {
  id: string;
  provider: string;
  accountLabel: string | null;
  status: ProviderConnectionRow["status"];
  lastSyncedAt: string | null;
}

export interface DashboardSnapshot {
  aggregates: DailyAggregate[];
  scores: StoredDailyScore[];
  recentEvents: NormalizedUsageRecord[];
  connections: ConnectionSummary[];
  /**
   * Usage Points that have actually been credited by a settled epoch. This is
   * the permanent number; an estimate for an open epoch is derived, never
   * stored, and never added to it.
   */
  settledPoints: number;
  /** Lifecycle state of the epochs the user has usage in, by epoch id. */
  epochStates: Record<string, EpochStateRow>;
}

const PAGE_SIZE = 1000;
const RECENT_EVENT_LIMIT = 10;

async function fetchAllPages<T>(
  query: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
  context: string,
): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await query(offset, offset + PAGE_SIZE - 1);
    if (error) throw new Error(`${context}: ${error.message}`);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE_SIZE) return out;
  }
}

export async function loadDashboardSnapshot(
  supabase: SupabaseClient<Database>,
  userId: string,
  sinceDay: string,
): Promise<DashboardSnapshot> {
  const [aggregateRows, scoreRows, eventRows, connectionRows, ledgerRows, epochRows] =
    await Promise.all([
    fetchAllPages<UsageDailyAggregateRow>(
      (from, to) =>
        supabase
          .from("usage_daily_aggregates")
          .select("*")
          .eq("user_id", userId)
          .gte("day", sinceDay)
          .order("day", { ascending: true })
          .range(from, to),
      "loadAggregates",
    ),
    fetchAllPages<ScoreRecordRow>(
      (from, to) =>
        supabase
          .from("score_records")
          .select("*")
          .eq("user_id", userId)
          .eq("algorithm_version", CURRENT_SCORING_VERSION)
          .order("day", { ascending: true })
          .range(from, to),
      "loadScores",
    ),
    supabase
      .from("usage_events")
      .select("*")
      .eq("user_id", userId)
      .order("occurred_at", { ascending: false })
      .limit(RECENT_EVENT_LIMIT)
      .then(({ data, error }) => {
        if (error) throw new Error(`loadRecentEvents: ${error.message}`);
        return (data ?? []) as UsageEventRow[];
      }),
    supabase
      .from("provider_connections")
      .select("*")
      .eq("user_id", userId)
      .order("provider", { ascending: true })
      .then(({ data, error }) => {
        if (error) throw new Error(`loadConnections: ${error.message}`);
        return (data ?? []) as ProviderConnectionRow[];
      }),
    // RLS restricts this to the signed-in user's own ledger rows.
    supabase
      .from("usage_point_ledger")
      .select("amount")
      .eq("user_id", userId)
      .then(({ data, error }) => {
        if (error) throw new Error(`loadLedger: ${error.message}`);
        return (data ?? []) as { amount: number | string }[];
      }),
    supabase
      .from("reward_epochs")
      .select("id, state")
      .then(({ data, error }) => {
        if (error) throw new Error(`loadEpochs: ${error.message}`);
        return (data ?? []) as { id: string; state: EpochStateRow }[];
      }),
  ]);

  return {
    aggregates: aggregateRows.map(rowToDailyAggregate),
    scores: scoreRows.map(rowToScore),
    recentEvents: eventRows.map(rowToUsageRecord),
    connections: connectionRows.map((row) => ({
      id: row.id,
      provider: row.provider,
      accountLabel: row.account_label,
      status: row.status,
      lastSyncedAt: row.last_synced_at,
    })),
    settledPoints: ledgerRows.reduce(
      (acc, row) => acc + toSafeInteger(row.amount, "usage_point_ledger.amount"),
      0,
    ),
    epochStates: Object.fromEntries(epochRows.map((row) => [row.id, row.state])),
  };
}
