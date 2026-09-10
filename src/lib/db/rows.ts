import type { DailyAggregate, NormalizedUsageRecord } from "@/lib/domain/types";
import { createHash } from "node:crypto";
import { economicKeyOf } from "@/lib/protocol/economic-unit";
import type {
  CorrelationStatusRow,
  PricingStatusRow,
  VerificationLevelRow,
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
    actualCostMicros:
      row.actual_cost_micros === null
        ? null
        : toSafeInteger(row.actual_cost_micros, "actual_cost_micros"),
    actualCostBasis: (row.actual_cost_basis as NormalizedUsageRecord["actualCostBasis"]) ?? undefined,
    normalizedCostMicros: toSafeInteger(row.normalized_cost_micros, "normalized_cost_micros"),
    verificationType: row.verification_type,
    verificationStatus: row.verification_status,
    economicStatus: row.economic_status ?? undefined,
    // Only meaningful when a pricing version produced it. Left undefined
    // otherwise so pre-mining records keep falling back to their stored cost
    // rather than silently becoming worth zero.
    // The column now says this itself. A null is an absent price; a number --
    // including 0 -- is a real one. `protocol_pricing_version` is still
    // required, so a value with no snapshot behind it cannot be believed.
    protocolComputeMicros:
      row.protocol_pricing_version && row.protocol_compute_micros !== null
        ? toSafeInteger(row.protocol_compute_micros, "protocol_compute_micros")
        : undefined,
    protocolPricingVersion: row.protocol_pricing_version ?? null,
    protocolComputePico: row.protocol_compute_pico ?? null,
    eligibleComputePico: row.eligible_compute_pico ?? null,
    pricingComponentsPending: row.pricing_components_pending ?? [],
    epochId: row.epoch_id ?? null,
    carriedForward: row.carried_forward ?? false,
    gatewayId: row.gateway_id ?? null,
    economicSourceClass: row.economic_source_class ?? undefined,
    eligibleComputeMicros:
      row.reward_policy_version === null || row.reward_policy_version === undefined
        ? undefined
        : toSafeInteger(row.eligible_compute_micros ?? 0, "eligible_compute_micros"),
    rewardStatus: row.reward_status ?? undefined,
    rewardReason: row.reward_reason ?? null,
    rewardPolicyVersion: row.reward_policy_version ?? null,
    reconciliationStatus: row.reconciliation_status ?? "clear",
    rewardHold: row.reward_hold ?? false,
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
  actual_cost_micros: number | null;
  actual_cost_basis: string | null;
  normalized_cost_micros: number;
  verification_type: NormalizedUsageRecord["verificationType"];
  verification_status: NormalizedUsageRecord["verificationStatus"];
  economic_status: NonNullable<NormalizedUsageRecord["economicStatus"]>;
  /** Null means no approved price exists. A real 0 means priced at zero. */
  protocol_compute_micros: number | null;
  /** 0019: exact pico as decimal strings; null unless priced under a pico_exact version. */
  protocol_compute_pico: string | null;
  eligible_compute_pico: string | null;
  pricing_components_pending: string[];
  pricing_status: PricingStatusRow;
  protocol_pricing_version: string | null;
  protocol_pricing_basis: string | null;
  epoch_id: string | null;
  carried_forward: boolean;
  gateway_id: string | null;
  economic_source_class: NonNullable<NormalizedUsageRecord["economicSourceClass"]>;
  eligible_compute_micros: number;
  reward_status: NonNullable<NormalizedUsageRecord["rewardStatus"]>;
  reward_reason: string | null;
  reward_policy_version: string | null;
  reconciliation_status: NonNullable<NormalizedUsageRecord["reconciliationStatus"]>;
  reward_hold: boolean;
  raw_metadata: NormalizedUsageRecord["rawMetadata"];
  provenance_sources: string[];
  verification_level: VerificationLevelRow;
  correlation_status: CorrelationStatusRow;
  identity_trust_level: string;
  provider_identity_hash: string | null;
  economic_event_key: string | null;
  dedupe_status: "unique" | "duplicate" | "conflict" | "unkeyed";
  economic_verification_status: string | null;
  economic_verification_policy_version: string | null;
}

export function usageRecordToInsert(
  userId: string,
  record: NormalizedUsageRecord,
  connectionId: string | null,
): UsageEventInsert {
  const protocolCompute = record.protocolComputeMicros ?? null;

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
    actual_cost_micros: record.actualCostMicros,
    actual_cost_basis: record.actualCostBasis ?? null,
    normalized_cost_micros: record.normalizedCostMicros,
    // Assigned by trusted ingestion from the adapter, never accepted from input.
    verification_type: record.verificationType,
    verification_status: record.verificationStatus,
    economic_status: record.economicStatus ?? legacyEconomicStatus(record),
    // Unknown stays unknown. `0` here would be indistinguishable from a model
    // that really is priced at nothing, which is the ambiguity migration 0015
    // exists to remove.
    // One expression for both, so the column and its status cannot disagree.
    // `?? null` on its own would let an explicit null through as "priced",
    // which the database check constraint correctly refuses.
    protocol_compute_micros: protocolCompute,
    // Exact economics, server-derived (M16A). A client cannot write this table.
    protocol_compute_pico: record.protocolComputePico ?? null,
    eligible_compute_pico: record.eligibleComputePico ?? null,
    pricing_components_pending: record.pricingComponentsPending ?? [],
    pricing_status: protocolCompute === null ? "pending_pricing" : "priced",
    protocol_pricing_version: record.protocolPricingVersion ?? null,
    protocol_pricing_basis: record.protocolPricingVersion ? "protocol_pricing" : null,
    // Assigned by ingestion, from the epoch lifecycle -- never from input.
    epoch_id: record.epochId ?? null,
    carried_forward: record.carriedForward ?? false,
    // Which gateway executed it. Null for imports: nobody executed those.
    gateway_id: record.gatewayId ?? null,
    // The reward policy decides these, server-side. A client cannot write this
    // table at all, so there is no path by which it could choose them.
    economic_source_class: record.economicSourceClass ?? "unknown",
    // A record produced by an adapter that predates reward policy keeps the
    // decision it would have had. Defaulting it to "held" would silently strand
    // every demo and pull-adapter record.
    eligible_compute_micros:
      record.eligibleComputeMicros ?? legacyEligibleCompute(record),
    reward_status: record.rewardStatus ?? legacyRewardStatus(record),
    reward_reason: record.rewardReason ?? (record.rewardStatus ? null : "legacy_pre_policy"),
    reward_policy_version: record.rewardPolicyVersion ?? null,
    // Reconciliation is decided by trusted ingestion, never by input.
    reconciliation_status: record.reconciliationStatus ?? "clear",
    reward_hold: record.rewardHold ?? false,
    raw_metadata: record.rawMetadata,
    // Provenance names where the evidence came from. Set from the verification
    // type the trusted adapter assigned; correlation may later ADD a source,
    // never replace one, and never touches the reward columns above.
    provenance_sources:
      record.verificationType === "verified"
        ? ["provider_import"]
        : record.verificationType === "routed"
          ? ["usage_gateway"]
          : ["reported"],
    verification_level:
      record.verificationType === "verified"
        ? "provider_verified_import"
        : record.verificationType === "routed"
          ? "routed_confirmed"
          : "local_observed",
    correlation_status: "none",
    identity_trust_level: "account",
    provider_identity_hash: providerIdentityHashFor(record),
    // 0018: the same facts the adapter put in raw_metadata, as columns, so
    // the database's global unique index and the settled-row trigger see
    // them. Written from the metadata, never from anything a client sent.
    economic_event_key: economicKeyOf(record.rawMetadata),
    dedupe_status: dedupeStatusFor(record),
    economic_verification_status: stringOrNull(record.rawMetadata.economic_verification_status),
    economic_verification_policy_version: stringOrNull(record.rawMetadata.economic_verification_policy_version),
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function dedupeStatusFor(record: NormalizedUsageRecord): UsageEventInsert["dedupe_status"] {
  const key = economicKeyOf(record.rawMetadata);
  const stated = record.rawMetadata.dedupe_status;
  if (stated === "duplicate" || stated === "conflict") return stated;
  return key ? "unique" : "unkeyed";
}

function providerIdentityHashFor(record: NormalizedUsageRecord): string | null {
  const id = record.rawMetadata?.upstream_request_id;
  if (typeof id !== "string" || !id) return null;
  return `sha256:${createHash("sha256").update(`${record.provider}
${id}`).digest("hex")}`;
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

/**
 * Pre-policy grandfather, matching migration 0011's backfill exactly.
 *
 * Historical decisions must stay reproducible, so a record with no policy
 * attached is judged the way it was judged before policy existed -- and says so
 * via `legacy_pre_policy`, so nobody mistakes it for a v1 judgement.
 */
function legacyRewardStatus(record: NormalizedUsageRecord): "eligible" | "held" | "ineligible" {
  const economic = record.economicStatus ?? legacyEconomicStatus(record);
  if (economic === "eligible" || economic === "settled") return "eligible";
  if (economic === "ineligible") return "ineligible";
  return "held";
}

function legacyEligibleCompute(record: NormalizedUsageRecord): number {
  if (legacyRewardStatus(record) !== "eligible") return 0;
  return record.protocolComputeMicros ?? record.normalizedCostMicros;
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
  /** usage_score_v2: the exact score, Σ eligible pico as a decimal string. Absent for v1. */
  weightedComputePico?: string | null;
}

export function rowToScore(row: ScoreRecordRow): StoredDailyScore {
  return {
    day: String(row.day).slice(0, 10),
    algorithmVersion: row.algorithm_version,
    weightedCostMicros: toSafeInteger(row.weighted_cost_micros, "weighted_cost_micros"),
    excludedCostMicros: toSafeInteger(row.excluded_cost_micros, "excluded_cost_micros"),
    pendingCostMicros: toSafeInteger(row.pending_cost_micros ?? 0, "pending_cost_micros"),
    points: toDecimal(row.points),
    weightedComputePico: row.weighted_compute_pico ?? null,
  };
}
