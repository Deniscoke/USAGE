import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  Database,
  EpochStateRow,
  ProviderConnectionRow,
  ScoreRecordRow,
  UsageDailyAggregateRow,
  UsageEventRow,
} from "@/lib/supabase/database.types";
import type { DailyAggregate, NormalizedUsageRecord, ProofStatus } from "@/lib/domain/types";
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
  method: ProviderConnectionRow["method"];
  lastSyncedAt: string | null;
}

/** A usage event plus its row id, so the feed can link to its proof. */
export type RecentEvent = NormalizedUsageRecord & { id: string };

export interface MinerCredentialSummary {
  id: string;
  name: string;
  tokenPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface DashboardSnapshot {
  aggregates: DailyAggregate[];
  scores: StoredDailyScore[];
  recentEvents: RecentEvent[];
  connections: ConnectionSummary[];
  /** proof_status by usage event id, for the events above. */
  proofStatusById: Map<string, ProofStatus>;
  minerCredentials: MinerCredentialSummary[];
  /**
   * Total scored points contributed by OTHER participants in today's epoch.
   * Read from an aggregate-only view: no user can see another user's score.
   */
  otherParticipantsScore: number;
  networkParticipants: number;
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
  const today = new Date().toISOString().slice(0, 10);

  const [
    aggregateRows,
    scoreRows,
    eventRows,
    connectionRows,
    ledgerRows,
    epochRows,
    credentialRows,
    networkRows,
  ] = await Promise.all([
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
    // Column-level grants mean a user can never select token_hash here.
    supabase
      .from("usage_miner_credentials")
      .select("id, name, token_prefix, created_at, last_used_at, revoked_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .then(({ data, error }) => {
        if (error) throw new Error(`loadMinerCredentials: ${error.message}`);
        return (data ?? []) as {
          id: string;
          name: string;
          token_prefix: string;
          created_at: string;
          last_used_at: string | null;
          revoked_at: string | null;
        }[];
      }),
    supabase
      .from("epoch_network_totals")
      .select("network_score, participants")
      .eq("day", today)
      .eq("algorithm_version", CURRENT_SCORING_VERSION)
      .maybeSingle()
      .then(({ data, error }) => {
        if (error) throw new Error(`loadNetworkTotals: ${error.message}`);
        return data as { network_score: string | number; participants: number } | null;
      }),
  ]);

  const recentEvents: RecentEvent[] = eventRows.map((row) => ({
    ...rowToUsageRecord(row),
    id: row.id,
  }));

  // Proof status for exactly the events shown. Loaded separately rather than
  // embedded, because a join through PostgREST would widen what the query can
  // return and this stays trivially auditable.
  const proofStatusById = new Map<string, ProofStatus>();
  if (recentEvents.length > 0) {
    const { data, error } = await supabase
      .from("proof_records")
      .select("usage_event_id, proof_status")
      .in(
        "usage_event_id",
        recentEvents.map((event) => event.id),
      );
    if (error) throw new Error(`loadProofStatus: ${error.message}`);
    for (const row of (data ?? []) as { usage_event_id: string; proof_status: ProofStatus }[]) {
      proofStatusById.set(row.usage_event_id, row.proof_status);
    }
  }

  const userScoreToday = scoreRows.find((row) => String(row.day).slice(0, 10) === today);
  const networkScore = Number(networkRows?.network_score ?? 0);

  return {
    aggregates: aggregateRows.map(rowToDailyAggregate),
    scores: scoreRows.map(rowToScore),
    recentEvents,
    connections: connectionRows.map((row) => ({
      id: row.id,
      provider: row.provider,
      accountLabel: row.account_label,
      status: row.status,
      method: row.method,
      lastSyncedAt: row.last_synced_at,
    })),
    proofStatusById,
    minerCredentials: credentialRows.map((row) => ({
      id: row.id,
      name: row.name,
      tokenPrefix: row.token_prefix,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
      revokedAt: row.revoked_at,
    })),
    // The view totals everyone; this user's own contribution is subtracted so
    // the caller can add a freshly computed score without double counting.
    otherParticipantsScore: Math.max(0, networkScore - Number(userScoreToday?.points ?? 0)),
    networkParticipants: Number(networkRows?.participants ?? 0),
    settledPoints: ledgerRows.reduce(
      (acc, row) => acc + toSafeInteger(row.amount, "usage_point_ledger.amount"),
      0,
    ),
    epochStates: Object.fromEntries(epochRows.map((row) => [row.id, row.state])),
  };
}
