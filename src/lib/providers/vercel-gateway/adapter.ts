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
import { decideReward, type RewardPolicyVersion } from "@/lib/protocol/reward-policy";
import {
  classifyEconomicSource,
  economicEventKey,
  selectAuthoritativeIdentity,
  verifyEconomically,
  type EconomicUsageEvidence,
  type EvidenceTrust,
  type FundingEvidence,
  type SourceAuthority,
} from "@/lib/protocol/economic-unit";
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
  /** Reward policy to decide eligibility with. Defaults to the active one. */
  rewardPolicy?: RewardPolicyVersion;
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

  // Economics, decided separately from proof. Which gateway ran the request is
  // the trusted evidence of who funded it: a `connection:*` gateway used the
  // user's own credential, anything else spent USAGE's own budget.
  const usageFunded = !(observation.gatewayId ?? "").startsWith("connection:");
  // A custom endpoint the user typed is not a source of economic evidence.
  const endpointControlledByUser = !usageFunded && observation.endpointTrusted !== true;
  // Funding is a fact about the ACCOUNT, stated by the provider and carried
  // here by the server. USAGE's own gateway key is its own budget.
  const funding: FundingEvidence | null =
    observation.funding ?? (usageFunded ? { class: "usage_credit", basis: "usage:gateway_credential" } : null);
  const economicSource = classifyEconomicSource({
    gatewayId: observation.gatewayId ?? null,
    actualCostMicros: parsedCost ? parsedCost.micros : null,
    actualCostAuthority: costBasis,
    usageFunded,
    endpointControlledByUser,
    funding,
  });

  // The economic unit's identity. This adapter is USAGE's own gateway, so
  // the authority is usage_gateway and the trust follows the environment the
  // observation was made in: hosted USAGE, somebody's laptop, or a fixture.
  const providerName = observation.providerSlug ?? VERCEL_GATEWAY_PROVIDER;
  const sourceAuthority: SourceAuthority = "usage_gateway";
  const evidenceTrust: EvidenceTrust =
    verification.trustEnvironment === "production"
      ? "trusted_server"
      : verification.verificationType === "reported"
        ? "unknown"
        : "device_reported";
  const identity = selectAuthoritativeIdentity({
    sourceAuthority,
    authoritativeRequestId: observation.upstreamRequestId ?? null,
    gatewayGenerationId: observation.generationId,
    gatewayId: observation.gatewayId ?? VERCEL_GATEWAY_PROVIDER,
    provider: providerName,
  });
  const unitKey = economicEventKey(providerName, identity);
  const evidence: EconomicUsageEvidence = {
    source: observation.providerSlug ? "gateway" : "vercel_ai_gateway",
    sourceAuthority,
    evidenceTrust,
    provider: providerName,
    model: observation.model,
    authoritativeRequestId: observation.upstreamRequestId ?? null,
    gatewayGenerationId: observation.generationId,
    inputTokens: observation.usage.inputTokens ?? null,
    outputTokens: observation.usage.outputTokens ?? null,
    cacheReadTokens: observation.usage.inputTokenDetails?.cacheReadTokens ?? null,
    cacheWriteTokens: observation.usage.inputTokenDetails?.cacheWriteTokens ?? null,
    reasoningTokens,
    actualCostMicros: parsedCost ? parsedCost.micros : null,
    actualCostAuthority: costBasis,
    fundingClass: funding?.class ?? null,
    endpointControlledByUser,
    occurredAt,
  };
  // Provisional: ingestion looks the key up against what is already stored
  // and may downgrade this to duplicate, which also holds the reward.
  const economicVerification = verifyEconomically({
    evidence,
    economicEventKey: unitKey,
    dedupeStatus: unitKey ? "unique" : "unkeyed",
    sourceClass: economicSource,
  });
  const reward = decideReward({
    proofStatus,
    verificationType: verification.verificationType,
    economicSource,
    protocolComputeMicros: protocol?.micros ?? null,
    policy: options.rewardPolicy,
  });

  const metadata: Record<string, string | number | boolean | null> = {
    evidence_class: verification.evidenceClass,
    trust_environment: verification.trustEnvironment,
    proof_status: proofStatus,
    economic_status: economicStatus,
    protocol_compute_micros: protocol?.micros ?? null,
    protocol_pricing_version: protocol ? pricingVersion : null,
    client_type: observation.clientType ?? "unknown",
    // Which gateway executed it. With more than one, this is evidence.
    gateway_id: observation.gatewayId ?? null,
    endpoint_trusted: observation.endpointTrusted ?? null,
    // The credential ID, never the credential. Signed into the receipt, so it
    // has to be stored for the receipt to be re-derivable and re-verifiable.
    miner_credential_id: options.minerCredentialId ?? null,
    generation_id_source: observation.generationIdSource ?? "gateway_generation_id",
    // The provider's own request identity, as the upstream response named it.
    // Local telemetry from a tool that saw the same response carries the same
    // id, and exact equality here is the only correlation USAGE will accept.
    upstream_request_id: observation.upstreamRequestId ?? null,
    // The economic unit, for auditors: which identity anchors it, who the
    // evidence came from, what funded it, and what the verification policy
    // concluded and why. All server-derived; none of it settable by a client.
    economic_event_key: unitKey,
    economic_identity_kind: identity?.kind ?? null,
    economic_identity_authority: identity?.authority ?? null,
    dedupe_status: unitKey ? "unique" : "unkeyed",
    source_authority: sourceAuthority,
    evidence_trust: evidenceTrust,
    funding_class: funding?.class ?? null,
    funding_basis: funding?.basis ?? null,
    economic_verification_status: economicVerification.status,
    economic_verification_reason: economicVerification.reason,
    economic_verification_policy_version: economicVerification.policyVersion,
    adapter_version: VERCEL_GATEWAY_ADAPTER_VERSION,
    gateway_generation_id: observation.generationId,
    gateway_model: observation.model,
    served_by_provider: observation.servedByProvider ?? null,
    cost_basis: costBasis,
    economic_source_class: economicSource,
    reward_status: reward.status,
    reward_reason: reward.reason,
    reward_policy_version: reward.policyVersion,
    cost_rounded: parsedCost?.rounded ?? false,
    // Reasoning tokens are a breakdown of output tokens (already counted, and
    // billed as output), kept for explainability rather than for scoring.
    reasoning_tokens: reasoningTokens,
    cache_write_tokens: cacheWriteTokens,
    finish_reason: observation.finishReason ?? null,
    latency_ms: observation.latencyMs ?? null,
  };

  const record: NormalizedUsageRecord = {
    // A request relayed through a user's own connection was carried by that
    // provider, not by USAGE's gateway. Saying otherwise puts a false fact in
    // a signed proof.
    provider: observation.providerSlug ?? VERCEL_GATEWAY_PROVIDER,
    source: observation.providerSlug ? "gateway" : "vercel_ai_gateway",
    externalReference,
    model: observation.model,
    occurredAt,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    requests: 1,
    actualCostMicros: parsedCost ? parsedCost.micros : null,
    normalizedCostMicros: parsedCost ? parsedCost.micros : 0,
    verificationType: verification.verificationType,
    verificationStatus,
    economicStatus,
    // Undefined, not zero. No approved price is a different fact from a price
    // of nothing, and only one of them is allowed to look like free compute.
    protocolComputeMicros: protocol?.micros,
    protocolPricingVersion: protocol ? pricingVersion : null,
    gatewayId: observation.gatewayId ?? null,
    actualCostBasis: costBasis,
    economicSourceClass: economicSource,
    eligibleComputeMicros: reward.eligibleComputeMicros,
    rewardStatus: reward.status,
    rewardReason: reward.reason,
    rewardPolicyVersion: reward.policyVersion,
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
    gatewayId: observation.gatewayId ?? null,
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
