import { aggregateDaily, utcDay } from "@/lib/domain/normalize";
import { CURRENT_SCORING_VERSION, scoreRecords } from "@/lib/domain/scoring";
import type { DailyAggregate, NormalizedUsageRecord } from "@/lib/domain/types";
import type { UsageWindow } from "@/lib/providers/adapter";
import { listIntegrations } from "@/lib/providers/registry";
import { collectUsage } from "@/lib/pipeline/collect";
import { usageRecordToInsert, type StoredDailyScore } from "./rows";

/**
 * Trusted server-side ingestion.
 *
 *   adapters -> normalize -> dedupe -> usage_events
 *            -> re-aggregate affected days -> usage_daily_aggregates
 *            -> re-score affected days     -> score_records
 *
 * Only this path may write usage, and the verification type always comes from
 * the adapter that produced the record. Clients have no INSERT privilege on any
 * usage table (see migration 0002), so there is no way to submit self-declared
 * "verified" usage.
 *
 * Recomputation is full-day rather than incremental: a day is re-derived from
 * its stored events, so running ingestion twice converges on the same state.
 */

/** Storage port. Implemented over Supabase for the app, over SQL for tests. */
export interface IngestStore {
  ensureConnection(userId: string, provider: string, accountLabel: string): Promise<string | null>;
  /** Inserts, ignoring rows that violate the natural key. Returns inserted count. */
  insertEvents(rows: ReturnType<typeof usageRecordToInsert>[]): Promise<number>;
  loadEventsForDays(userId: string, days: readonly string[]): Promise<NormalizedUsageRecord[]>;
  upsertDailyAggregates(userId: string, aggregates: readonly DailyAggregate[]): Promise<void>;
  replaceDailyAggregates(userId: string, days: readonly string[]): Promise<void>;
  upsertScores(userId: string, scores: readonly StoredDailyScore[]): Promise<void>;
  markConnectionSynced(connectionId: string): Promise<void>;
}

export interface IngestSummary {
  fetched: number;
  inserted: number;
  duplicates: number;
  daysRecomputed: number;
  failures: { provider: string; error: string }[];
}

const INSERT_CHUNK = 400;

export async function ingestRecords(
  store: IngestStore,
  userId: string,
  records: readonly NormalizedUsageRecord[],
  connectionIds: ReadonlyMap<string, string | null> = new Map(),
): Promise<Omit<IngestSummary, "failures" | "fetched">> {
  if (records.length === 0) {
    return { inserted: 0, duplicates: 0, daysRecomputed: 0 };
  }

  const rows = records.map((record) =>
    usageRecordToInsert(userId, record, connectionIds.get(record.provider) ?? null),
  );

  let inserted = 0;
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    inserted += await store.insertEvents(rows.slice(i, i + INSERT_CHUNK));
  }

  const days = [...new Set(records.map((record) => utcDay(record.occurredAt)))].sort();
  const storedEvents = await store.loadEventsForDays(userId, days);

  // Aggregation and scoring stay separate layers over the same stored events.
  const aggregates = aggregateDaily(storedEvents);
  await store.replaceDailyAggregates(userId, days);
  await store.upsertDailyAggregates(userId, aggregates);

  const scores: StoredDailyScore[] = days.map((day) => {
    const dayEvents = storedEvents.filter((event) => utcDay(event.occurredAt) === day);
    const scored = scoreRecords(dayEvents, CURRENT_SCORING_VERSION);
    return {
      day,
      algorithmVersion: scored.algorithmVersion,
      weightedCostMicros: scored.weightedCostMicros,
      excludedCostMicros: scored.excludedCostMicros,
      points: scored.points,
    };
  });
  await store.upsertScores(userId, scores);

  return { inserted, duplicates: rows.length - inserted, daysRecomputed: days.length };
}

export interface DemoIngestOptions {
  userId: string;
  now?: Date;
  historyDays?: number;
}

/**
 * Development-only demo ingestion. Runs the real demo adapters through the real
 * pipeline; it never writes precomputed dashboard totals.
 */
export async function ingestDemoUsage(
  store: IngestStore,
  { userId, now = new Date(), historyDays = 90 }: DemoIngestOptions,
): Promise<IngestSummary> {
  const window: UsageWindow = {
    since: new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) -
        historyDays * 86_400_000,
    ),
    until: new Date(now.getTime() + 60 * 60 * 1000),
  };

  const integrations = listIntegrations();
  const connectionIds = new Map<string, string | null>();

  const connections = [];
  for (const integration of integrations) {
    const connectionId = await store.ensureConnection(userId, integration.provider, "demo");
    connectionIds.set(integration.provider, connectionId);
    connections.push({
      provider: integration.provider,
      context: { connectionId: connectionId ?? `demo-${integration.provider}`, secrets: {}, config: {} },
    });
  }

  const collected = await collectUsage(connections, window);
  const result = await ingestRecords(store, userId, collected.records, connectionIds);

  for (const connectionId of connectionIds.values()) {
    if (connectionId) await store.markConnectionSynced(connectionId);
  }

  return { fetched: collected.records.length, ...result, failures: collected.failures };
}
