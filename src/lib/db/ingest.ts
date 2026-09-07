import { aggregateDaily, utcDay } from "@/lib/domain/normalize";
import { CURRENT_SCORING_VERSION, scoreRecords } from "@/lib/domain/scoring";
import type { DailyAggregate, NormalizedUsageRecord } from "@/lib/domain/types";
import type { UsageWindow } from "@/lib/providers/adapter";
import { listPullIntegrations } from "@/lib/providers/registry";
import { collectUsage } from "@/lib/pipeline/collect";
import {
  normalizeGatewayObservation,
  type NormalizedObservation,
} from "@/lib/providers/vercel-gateway/adapter";
import {
  GatewayObservationError,
  VERCEL_GATEWAY_PROVIDER,
  type GatewayObservation,
} from "@/lib/providers/vercel-gateway/observation";
import { usageRecordToInsert, type StoredDailyScore } from "./rows";

/**
 * Trusted server-side ingestion.
 *
 *   adapters -> normalize -> dedupe -> usage_events
 *            -> proof_records (provenance)
 *            -> re-aggregate affected days -> usage_daily_aggregates
 *            -> re-score affected days     -> score_records
 *
 * Only this path may write usage, and the verification type always comes from
 * the adapter that produced the record. Clients have no INSERT privilege on any
 * usage table (see migration 0002), so there is no way to submit self-declared
 * "verified" or "routed" usage.
 *
 * Recomputation is full-day rather than incremental: a day is re-derived from
 * its stored events, so running ingestion twice converges on the same state.
 */

/** Identity of an event that was actually inserted (not a duplicate). */
export interface InsertedEventRef {
  id: string;
  provider: string;
  source: string;
  externalReference: string;
}

export interface ProofDraft {
  usageEventId: string;
  verificationType: NormalizedUsageRecord["verificationType"];
  proofKind: string;
  proofSource: string;
  externalReference: string;
  observedAt: string;
  adapterVersion: string | null;
  metadata: Record<string, string | number | boolean | null>;
}

/** Storage port. Implemented over Supabase for the app, over SQL for tests. */
export interface IngestStore {
  ensureConnection(
    userId: string,
    provider: string,
    accountLabel: string,
    secretRef?: string | null,
  ): Promise<string | null>;
  /** Inserts, ignoring rows that violate the natural key. Returns what was inserted. */
  insertEvents(rows: ReturnType<typeof usageRecordToInsert>[]): Promise<InsertedEventRef[]>;
  insertProofs(userId: string, proofs: readonly ProofDraft[]): Promise<void>;
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

function naturalKey(provider: string, source: string, externalReference: string): string {
  return `${provider}|${source}|${externalReference}`;
}

/**
 * Provenance for an event, derived from the record the adapter produced.
 *
 * Only whitelisted, non-secret metadata reaches the database: adapters already
 * choose what goes into `rawMetadata`, and nothing else is copied. Raw provider
 * payloads are never stored.
 */
function proofFromRecord(
  record: NormalizedUsageRecord,
  usageEventId: string,
  override?: NormalizedObservation["proof"],
): ProofDraft {
  const adapterVersion = record.rawMetadata.adapter_version;
  return {
    usageEventId,
    verificationType: record.verificationType,
    proofKind: override?.proofKind ?? record.source,
    proofSource: override?.proofSource ?? record.provider,
    externalReference: override?.externalReference ?? record.externalReference,
    observedAt: override?.observedAt ?? record.occurredAt,
    adapterVersion:
      override?.adapterVersion ?? (typeof adapterVersion === "string" ? adapterVersion : null),
    metadata: override?.metadata ?? record.rawMetadata,
  };
}

export async function ingestRecords(
  store: IngestStore,
  userId: string,
  records: readonly NormalizedUsageRecord[],
  connectionIds: ReadonlyMap<string, string | null> = new Map(),
  proofOverrides: ReadonlyMap<string, NormalizedObservation["proof"]> = new Map(),
): Promise<Omit<IngestSummary, "failures" | "fetched">> {
  if (records.length === 0) {
    return { inserted: 0, duplicates: 0, daysRecomputed: 0 };
  }

  const rows = records.map((record) =>
    usageRecordToInsert(userId, record, connectionIds.get(record.provider) ?? null),
  );

  const insertedRefs: InsertedEventRef[] = [];
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    insertedRefs.push(...(await store.insertEvents(rows.slice(i, i + INSERT_CHUNK))));
  }

  // Provenance is written only for events that were actually created; a
  // duplicate already has its proof.
  const byKey = new Map(
    records.map((record) => [
      naturalKey(record.provider, record.source, record.externalReference),
      record,
    ]),
  );
  const proofs = insertedRefs
    .map((ref) => {
      const record = byKey.get(naturalKey(ref.provider, ref.source, ref.externalReference));
      if (!record) return null;
      return proofFromRecord(record, ref.id, proofOverrides.get(record.externalReference));
    })
    .filter((proof): proof is ProofDraft => proof !== null);
  await store.insertProofs(userId, proofs);

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

  return {
    inserted: insertedRefs.length,
    duplicates: rows.length - insertedRefs.length,
    daysRecomputed: days.length,
  };
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

  const integrations = listPullIntegrations();
  const connectionIds = new Map<string, string | null>();

  const connections = [];
  for (const integration of integrations) {
    const connectionId = await store.ensureConnection(userId, integration.provider, "demo");
    connectionIds.set(integration.provider, connectionId);
    connections.push({
      provider: integration.provider,
      context: {
        connectionId: connectionId ?? `demo-${integration.provider}`,
        secrets: {},
        config: {},
      },
    });
  }

  const collected = await collectUsage(connections, window);
  const result = await ingestRecords(store, userId, collected.records, connectionIds);

  for (const connectionId of connectionIds.values()) {
    if (connectionId) await store.markConnectionSynced(connectionId);
  }

  return { fetched: collected.records.length, ...result, failures: collected.failures };
}

export interface GatewayIngestSummary extends IngestSummary {
  rejected: { generationId: string; code: string; error: string }[];
}

/**
 * Ingest observations captured while USAGE routed AI requests through the
 * Vercel AI Gateway.
 *
 * Malformed evidence is rejected as an operational error and never becomes a
 * usage event -- a broken response must not mint economic value. The gateway
 * credential is referenced, never stored: `provider_connections.secret_ref`
 * names the server environment variable holding it.
 */
export async function ingestGatewayObservations(
  store: IngestStore,
  userId: string,
  observations: readonly GatewayObservation[],
): Promise<GatewayIngestSummary> {
  const records: NormalizedUsageRecord[] = [];
  const proofOverrides = new Map<string, NormalizedObservation["proof"]>();
  const rejected: GatewayIngestSummary["rejected"] = [];

  for (const observation of observations) {
    try {
      const normalized = normalizeGatewayObservation(observation);
      records.push(normalized.record);
      proofOverrides.set(normalized.record.externalReference, normalized.proof);
    } catch (error) {
      rejected.push({
        generationId: observation.generationId ?? "(none)",
        code: error instanceof GatewayObservationError ? error.code : "unknown",
        error: error instanceof Error ? error.message : "unknown error",
      });
    }
  }

  if (records.length === 0) {
    return {
      fetched: observations.length,
      inserted: 0,
      duplicates: 0,
      daysRecomputed: 0,
      failures: [],
      rejected,
    };
  }

  const connectionId = await store.ensureConnection(
    userId,
    VERCEL_GATEWAY_PROVIDER,
    "server",
    "env:AI_GATEWAY_API_KEY",
  );
  const connectionIds = new Map([[VERCEL_GATEWAY_PROVIDER, connectionId]]);

  const result = await ingestRecords(store, userId, records, connectionIds, proofOverrides);
  if (connectionId) await store.markConnectionSynced(connectionId);

  return { fetched: observations.length, ...result, failures: [], rejected };
}
