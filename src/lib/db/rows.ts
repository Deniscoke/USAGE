import type { DailyAggregate, NormalizedUsageRecord } from "@/lib/domain/types";
import type {
  ScoreRecordRow,
  UsageDailyAggregateRow,
  UsageEventRow,
} from "@/lib/supabase/database.types";

/**
 * Row <-> domain mapping.
 *
 * The database stores money as BIGINT micro-USD; PostgREST hands it back as a
 * JSON number. That is exact up to 2^53-1 (~9 billion USD in micros), which is
 * far beyond any real balance -- but "far beyond" is not "checked", so every
 * value crossing this boundary is verified to be an exact integer. A silent
 * precision loss in a cost column is exactly the class of bug the micro-USD
 * design exists to prevent.
 */
export function toSafeInteger(value: number | string | null | undefined, field: string): number {
  if (value === null || value === undefined) return 0;
  const parsed = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new Error(`Expected an integer for ${field}, received ${JSON.stringify(value)}`);
  }
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Value for ${field} exceeds exact integer range: ${value}`);
  }
  return parsed;
}

/** numeric(20,4) columns. Points are a score, never money. */
export function toDecimal(value: number | string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const parsed = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(parsed)) throw new Error(`Invalid numeric value: ${String(value)}`);
  return parsed;
}

export function rowToUsageRecord(row: UsageEventRow): NormalizedUsageRecord {
  return {
    provider: row.provider,
    source: row.source,
    externalReference: row.external_reference,
    model: row.model,
    occurredAt: new Date(row.occurred_at).toISOString(),
    inputTokens: toSafeInteger(row.input_tokens, "input_tokens"),
    cachedInputTokens: toSafeInteger(row.cached_input_tokens, "cached_input_tokens"),
    outputTokens: toSafeInteger(row.output_tokens, "output_tokens"),
    requests: toSafeInteger(row.requests, "requests"),
    reportedCostMicros:
      row.reported_cost_micros === null
        ? null
        : toSafeInteger(row.reported_cost_micros, "reported_cost_micros"),
    normalizedCostMicros: toSafeInteger(row.normalized_cost_micros, "normalized_cost_micros"),
    verificationType: row.verification_type,
    verificationStatus: row.verification_status,
    economicStatus: row.economic_status ?? undefined,
    rawMetadata: row.raw_metadata ?? {},
  };
}

export interface UsageEventInsert {
  user_id: string;
  connection_id: string | null;
  provider: string;
  source: NormalizedUsageRecord["source"];
  external_reference: string;
  model: string;
  occurred_at: string;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  requests: number;
  reported_cost_micros: number | null;
  normalized_cost_micros: number;
  verification_type: NormalizedUsageRecord["verificationType"];
  verification_status: NormalizedUsageRecord["verificationStatus"];
  economic_status: NonNullable<NormalizedUsageRecord["economicStatus"]>;
  raw_metadata: NormalizedUsageRecord["rawMetadata"];
}

export function usageRecordToInsert(
  userId: string,
  record: NormalizedUsageRecord,
  connectionId: string | null,
): UsageEventInsert {
  return {
    user_id: userId,
    connection_id: connectionId,
    provider: record.provider,
    source: record.source,
    external_reference: record.externalReference,
    model: record.model,
    occurred_at: record.occurredAt,
    input_tokens: record.inputTokens,
    cached_input_tokens: record.cachedInputTokens,
    output_tokens: record.outputTokens,
    requests: record.requests,
    reported_cost_micros: record.reportedCostMicros,
    normalized_cost_micros: record.normalizedCostMicros,
    // Assigned by trusted ingestion from the adapter, never accepted from input.
    verification_type: record.verificationType,
    verification_status: record.verificationStatus,
    economic_status: record.economicStatus ?? legacyEconomicStatus(record),
    raw_metadata: record.rawMetadata,
  };
}

/**
 * Economic status for records produced before signed issuance existed (the demo
 * adapters, and anything not routed through the hosted gateway). Confirmed
 * evidence stays eligible; everything else is held rather than silently
 * promoted.
 */
function legacyEconomicStatus(
  record: NormalizedUsageRecord,
): NonNullable<NormalizedUsageRecord["economicStatus"]> {
  if (record.verificationType === "reported") return "ineligible";
  return record.verificationStatus === "confirmed" ? "eligible" : "pending_cost";
}

export function rowToDailyAggregate(row: UsageDailyAggregateRow): DailyAggregate {
  return {
    day: String(row.day).slice(0, 10),
    provider: row.provider,
    model: row.model,
    verificationType: row.verification_type,
    requests: toSafeInteger(row.requests, "requests"),
    inputTokens: toSafeInteger(row.input_tokens, "input_tokens"),
    cachedInputTokens: toSafeInteger(row.cached_input_tokens, "cached_input_tokens"),
    outputTokens: toSafeInteger(row.output_tokens, "output_tokens"),
    costMicros: toSafeInteger(row.cost_micros, "cost_micros"),
  };
}

export function dailyAggregateToRow(userId: string, aggregate: DailyAggregate) {
  return {
    user_id: userId,
    day: aggregate.day,
    provider: aggregate.provider,
    model: aggregate.model,
    verification_type: aggregate.verificationType,
    requests: aggregate.requests,
    input_tokens: aggregate.inputTokens,
    cached_input_tokens: aggregate.cachedInputTokens,
    output_tokens: aggregate.outputTokens,
    cost_micros: aggregate.costMicros,
    updated_at: new Date().toISOString(),
  };
}

export interface StoredDailyScore {
  day: string;
  algorithmVersion: string;
  weightedCostMicros: number;
  excludedCostMicros: number;
  /** Eligible usage whose economic weight is not yet established. */
  pendingCostMicros: number;
  points: number;
}

export function rowToScore(row: ScoreRecordRow): StoredDailyScore {
  return {
    day: String(row.day).slice(0, 10),
    algorithmVersion: row.algorithm_version,
    weightedCostMicros: toSafeInteger(row.weighted_cost_micros, "weighted_cost_micros"),
    excludedCostMicros: toSafeInteger(row.excluded_cost_micros, "excluded_cost_micros"),
    pendingCostMicros: toSafeInteger(row.pending_cost_micros ?? 0, "pending_cost_micros"),
    points: toDecimal(row.points),
  };
}
