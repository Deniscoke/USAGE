import { usdCostToMicros } from "@/lib/domain/money";
import {
  deriveEconomicStatus,
  newReceiptId,
  receiptHash,
  RECEIPT_VERSION,
  signReceipt,
  type CostBasis,
  type ProofReceipt,
  type SignedProofReceipt,
} from "@/lib/domain/receipt";
import type { EconomicStatus, ProofStatus } from "@/lib/domain/types";
import { CURRENT_PRICING_VERSION, protocolComputeValue } from "@/lib/pricing/compute";
import type { NormalizedUsageRecord } from "@/lib/domain/types";
import type {
  ConnectionContext,
  RawUsagePayload,
  UsageProviderAdapter,
  UsageWindow,
} from "../adapter";
import {
  assertObservation,
  deriveVerification,
  observationReference,
  VERCEL_GATEWAY_ADAPTER_VERSION,
  VERCEL_GATEWAY_PROVIDER,
  type GatewayObservation,
} from "./observation";

/**
 * Vercel AI Gateway adapter.
 *
 * Unlike the pull adapters, this one has no historical fetch: usage is captured
 * at request time from the response the gateway just returned. That is a
 * deliberate constraint -- historical reconciliation would depend on Custom
 * Reporting, which is plan-gated, so the first routed proof path must not need
 * it.
 *
 * Everything Vercel-shaped stops here. Downstream only sees
 * NormalizedUsageRecord.
 */

/** Token accounting differences that matter for normalization. */
function splitInputTokens(observation: GatewayObservation): {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
} {
  const usage = observation.usage;
  const total = usage.inputTokens ?? 0;
  const cacheRead = usage.inputTokenDetails?.cacheReadTokens ?? 0;
  const cacheWrite = usage.inputTokenDetails?.cacheWriteTokens ?? 0;

  // The AI SDK reports `inputTokens` inclusive of cache reads, with the
  // breakdown in inputTokenDetails. USAGE stores cached input separately, so
  // subtract it out -- preferring the explicit noCacheTokens when present.
  const uncached = usage.inputTokenDetails?.noCacheTokens ?? Math.max(0, total - cacheRead);

  return { inputTokens: uncached, cachedInputTokens: cacheRead, cacheWriteTokens: cacheWrite };
}

/**
 * Credentials for production issuance. Present only where the signing key is,
 * i.e. trusted hosted infrastructure -- see src/lib/trust/production.ts.
 */
export interface ProofIssuance {
  issuer: string;
  keyId: string;
  privateKeyBase64: string;
}

export interface NormalizeOptions {
  userId?: string;
  observedAt?: string;
  /** Supply to re-derive an existing receipt exactly (verification, tests). */
  receiptId?: string;
  /** Protocol pricing snapshot to value this compute with. */
  pricingVersion?: string;
  minerCredentialId?: string | null;
  /**
   * Supplying this is what CONFIRMS a proof. It cannot be faked by a caller:
   * the private key only exists where USAGE put it.
   */
  issuance?: ProofIssuance | null;
}

export interface NormalizedObservation {
  record: NormalizedUsageRecord;
  /** The tamper-evident receipt this record was derived from. */
  receipt: ProofReceipt;
  /** Present only when a production issuer signed it. */
  signed: SignedProofReceipt | null;
  /** Provenance for proof_records. Non-secret fields only. */
  proof: {
    proofKind: string;
    proofSource: string;
    externalReference: string;
    observedAt: string;
    adapterVersion: string;
    proofHash: string;
    trustEnvironment: string;
    proofStatus: ProofStatus;
    economicStatus: EconomicStatus;
    receiptId: string;
    receiptVersion: string;
    issuer: string | null;
    issuerKeyId: string | null;
    signature: string | null;
    signedAt: string | null;
    metadata: Record<string, string | number | boolean | null>;
  };
}

/**
 * Turn one trusted gateway observation into a normalized usage record.
 * Throws GatewayObservationError on malformed evidence.
 */
export function normalizeGatewayObservation(
  input: GatewayObservation,
  options: NormalizeOptions = {},
): NormalizedObservation {
  const observation = assertObservation(input);
  const verification = deriveVerification(observation.environment);
  const { inputTokens, cachedInputTokens, cacheWriteTokens } = splitInputTokens(observation);
  const outputTokens = observation.usage.outputTokens ?? 0;
  const reasoningTokens = observation.usage.outputTokenDetails?.reasoningTokens ?? null;

  // Cost provenance stays explicit. An absent gateway cost is *unknown*, not
  // zero and not estimated: we have no authoritative price for arbitrary
  // upstream models, and inventing one would fabricate economic value.
  const parsedCost = observation.cost ? usdCostToMicros(observation.cost.value) : null;
  const costBasis: CostBasis = parsedCost ? "gateway_reported" : "unavailable";

  // Usage with no authoritative cost is real, but there is nothing to weigh. It
  // stays visible and stays out of the reward pool until a cost is known --
  // scoring it as $0 would quietly say "this compute was worthless".
  const verificationStatus =
    verification.verificationType !== "reported" && parsedCost === null
      ? "pending"
      : verification.verificationStatus;

  // Protocol compute value: what this compute is worth to the protocol, from a
  // frozen pricing snapshot. Deliberately independent of the bill -- identical
  // compute mines identically whoever paid what for it.
  const pricingVersion = options.pricingVersion ?? CURRENT_PRICING_VERSION;
  const protocol = protocolComputeValue(pricingVersion, observation.model, {
    inputTokens,
    cachedReadTokens: cachedInputTokens,
    cachedWriteTokens: cacheWriteTokens,
    outputTokens,
    reasoningTokens,
  });

  const externalReference = observationReference(observation);
  const occurredAt = new Date(observation.occurredAt).toISOString();

  // CONFIRMED is not a claim a caller can make: it follows from holding the
  // production signing key, which only trusted hosted infrastructure does.
  const issuance = options.issuance ?? null;
  const proofStatus: ProofStatus =
    issuance && verification.trustEnvironment === "production" ? "confirmed" : "observed";
  const economicStatus: EconomicStatus = deriveEconomicStatus({
    proofStatus,
    verificationType: verification.verificationType,
    protocolComputeMicros: protocol?.micros ?? null,
    pricingVersion: protocol ? pricingVersion : null,
  });

  const metadata: Record<string, string | number | boolean | null> = {
    evidence_class: verification.evidenceClass,
    trust_environment: verification.trustEnvironment,
    proof_status: proofStatus,
    economic_status: economicStatus,
    protocol_compute_micros: protocol?.micros ?? null,
    protocol_pricing_version: protocol ? pricingVersion : null,
    client_type: observation.clientType ?? "unknown",
    generation_id_source: observation.generationIdSource ?? "gateway_generation_id",
    adapter_version: VERCEL_GATEWAY_ADAPTER_VERSION,
    gateway_generation_id: observation.generationId,
    gateway_model: observation.model,
    served_by_provider: observation.servedByProvider ?? null,
    cost_basis: costBasis,
    cost_rounded: parsedCost?.rounded ?? false,
    // Reasoning tokens are a breakdown of output tokens (already counted, and
    // billed as output), kept for explainability rather than for scoring.
    reasoning_tokens: reasoningTokens,
    cache_write_tokens: cacheWriteTokens,
    finish_reason: observation.finishReason ?? null,
    latency_ms: observation.latencyMs ?? null,
  };

  const record: NormalizedUsageRecord = {
    provider: VERCEL_GATEWAY_PROVIDER,
    source: "vercel_ai_gateway",
    externalReference,
    model: observation.model,
    occurredAt,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    requests: 1,
    reportedCostMicros: parsedCost ? parsedCost.micros : null,
    normalizedCostMicros: parsedCost ? parsedCost.micros : 0,
    verificationType: verification.verificationType,
    verificationStatus,
    economicStatus,
    protocolComputeMicros: protocol?.micros ?? 0,
    protocolPricingVersion: protocol ? pricingVersion : null,
    rawMetadata: metadata,
  };

  const observedAt = options.observedAt ?? new Date().toISOString();
  const receipt: ProofReceipt = {
    receiptVersion: RECEIPT_VERSION,
    receiptId: options.receiptId ?? newReceiptId(),
    issuer: issuance?.issuer ?? "usage://issuer/unsigned",
    issuerKeyId: issuance?.keyId ?? "unsigned",
    // A receipt is always about someone; an unattributed one is only useful for
    // inspecting the pipeline, so it is explicitly marked rather than blank.
    userId: options.userId ?? "unattributed",
    minerCredentialId: options.minerCredentialId ?? null,
    source: record.source,
    clientType: observation.clientType ?? "unknown",
    provider: observation.servedByProvider ?? VERCEL_GATEWAY_PROVIDER,
    model: observation.model,
    generationId: observation.generationId,
    generationIdSource: observation.generationIdSource ?? "gateway_generation_id",
    trustEnvironment: verification.trustEnvironment,
    inputTokens,
    cachedReadTokens: cachedInputTokens,
    cachedWriteTokens: cacheWriteTokens,
    outputTokens,
    reasoningTokens,
    requests: 1,
    costMicroUsd: parsedCost ? parsedCost.micros : null,
    costBasis,
    currency: "USD",
    protocolComputeMicroUsd: protocol?.micros ?? null,
    protocolPricingVersion: protocol ? pricingVersion : null,
    occurredAt,
    observedAt,
    verificationType: record.verificationType,
    verificationStatus,
    proofStatus,
    economicStatus,
    adapterVersion: VERCEL_GATEWAY_ADAPTER_VERSION,
  };

  // Only confirmed proofs are signed. A signature is an attestation that USAGE
  // stands behind this as trusted evidence; there is nothing to stand behind
  // when the observation was not made by trusted infrastructure.
  const signed =
    issuance && proofStatus === "confirmed" ? signReceipt(receipt, issuance.privateKeyBase64) : null;

  return {
    record,
    receipt,
    signed,
    proof: {
      proofKind: "gateway_observation",
      proofSource: VERCEL_GATEWAY_PROVIDER,
      externalReference,
      observedAt,
      adapterVersion: VERCEL_GATEWAY_ADAPTER_VERSION,
      proofHash: signed?.canonicalHash ?? receiptHash(receipt),
      trustEnvironment: verification.trustEnvironment,
      proofStatus,
      economicStatus,
      receiptId: receipt.receiptId,
      receiptVersion: receipt.receiptVersion,
      issuer: issuance?.issuer ?? null,
      issuerKeyId: issuance?.keyId ?? null,
      signature: signed?.signature ?? null,
      signedAt: signed?.signedAt ?? null,
      metadata,
    },
  };
}

export const vercelGatewayAdapter: UsageProviderAdapter<GatewayObservation> = {
  provider: VERCEL_GATEWAY_PROVIDER,
  label: "Vercel AI Gateway",
  ingestionMode: "observation",
  capability: {
    requiredAccountType: "Vercel team with AI Gateway enabled",
    authMethod: "AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN, server-side only",
    costDataAvailable: true,
    perUserDataAvailable: true,
    dataFreshness: "at request time",
    verification: "routed",
    limitations: [
      "Only covers requests actually routed through the gateway by USAGE.",
      "No historical backfill: reconciliation would need Custom Reporting, which is plan-gated.",
      "Cost is present only when the gateway reports it; it is never estimated.",
    ],
  },

  async validateConnection(context: ConnectionContext) {
    // The gateway credential lives in server environment configuration, not in
    // the database, so a connection is valid when the server holds a key.
    return context.secrets.apiKey
      ? { ok: true as const, accountLabel: "vercel-ai-gateway" }
      : { ok: false as const, reason: "AI_GATEWAY_API_KEY is not configured on the server." };
  },

  async fetchUsage(_context: ConnectionContext, window: UsageWindow) {
    // Observation-mode adapter: nothing to pull. Evidence arrives from
    // ingestGatewayObservations at request time.
    return { provider: VERCEL_GATEWAY_PROVIDER, window, rows: [] };
  },

  normalize(payload: RawUsagePayload<GatewayObservation>): NormalizedUsageRecord[] {
    return payload.rows.map((row) => normalizeGatewayObservation(row).record);
  },

  getVerificationType() {
    return "routed" as const;
  },
};
