import {
  classifyEconomicSource,
  economicEventKey,
  selectAuthoritativeIdentity,
  verifyEconomically,
} from "@/lib/protocol/economic-unit";
import {
  newReceiptId,
  receiptHash,
  signReceipt,
  RECEIPT_VERSION,
  type ProofReceipt,
} from "@/lib/domain/receipt";
import type { NormalizedUsageRecord } from "@/lib/domain/types";
import type { ProofIssuance } from "@/lib/providers/vercel-gateway/adapter";
import type { ProofDraft } from "@/lib/db/ingest";
import { decideReward } from "@/lib/protocol/reward-policy";

/**
 * Issuing a proof for imported usage.
 *
 * Deliberately the same machinery as a routed proof: same canonical receipt,
 * same Ed25519 signature, same hash, same rule that only trusted hosted
 * infrastructure holding the signing key can produce CONFIRMED. A second
 * issuance path would be a second security model.
 *
 * What differs is provenance, and the receipt says so plainly:
 *
 *   routed proof   gatewayId set, per-generation, USAGE watched it happen
 *   import proof   gatewayId null, provider aggregate, the provider says so
 *
 * Both are Proof of Usage. Neither is dressed up as the other.
 */

export interface ImportIssuanceOptions {
  userId: string;
  issuance: ProofIssuance | null;
  /** Which import connection produced it, for provenance. Not a secret. */
  connectionId?: string | null;
  observedAt?: string;
  receiptId?: string;
}

/**
 * The proof shape ingestion accepts as an override.
 *
 * `verificationType` is deliberately absent: ingestion takes it from the
 * record the adapter produced, so a proof can never claim to be stronger
 * evidence than the record it belongs to.
 */
export type ImportProofDraft = Omit<ProofDraft, "usageEventId" | "verificationType">;

function metadataString(
  metadata: NormalizedUsageRecord["rawMetadata"],
  key: string,
): string | null {
  const value = metadata[key];
  return typeof value === "string" ? value : null;
}

/**
 * Turn one normalized imported record into a signed proof draft.
 *
 * CONFIRMED is not something an import adapter can assert: it follows from a
 * signature, and the signature follows from holding a key that exists only on
 * trusted hosted infrastructure. Without issuance the record is OBSERVED and
 * economically ineligible, exactly like a locally-observed gateway request.
 */
export function issueImportProof(
  record: NormalizedUsageRecord,
  options: ImportIssuanceOptions,
): { record: NormalizedUsageRecord; receipt: ProofReceipt; proof: ImportProofDraft } {
  const issuance = options.issuance;
  const proofStatus = issuance ? "confirmed" : "observed";
  const observedAt = options.observedAt ?? new Date().toISOString();

  // An unsigned import is real usage but not trusted evidence, so it must not
  // carry economic weight either.
  const economicStatus =
    proofStatus === "confirmed" ? (record.economicStatus ?? "pending_pricing") : "ineligible";

  // An import is the provider's own record of the user's own account, so the
  // user funded it. Whether it was PAID depends on what the provider stated,
  // and a share of a bucket total is not an authoritative per-request cost.
  // An import carries no funding evidence of its own: the provider's billing
  // export says what was charged, not what account tier paid it. Under
  // economic-verification-v1 that is `unknown`, and unknown is held.
  const economicSource = classifyEconomicSource({
    gatewayId: null,
    actualCostMicros: record.actualCostMicros,
    actualCostAuthority: record.actualCostBasis ?? null,
    usageFunded: false,
    endpointControlledByUser: false,
    subscription: record.rawMetadata.subscription === true,
    funding: null,
  });
  // The bucket identity anchors the unit. It is unique per import bucket,
  // never per request, so a routed proof of one request inside the bucket
  // does not share it; that overlap is what reconciliation holds.
  const identity = selectAuthoritativeIdentity({
    sourceAuthority: "provider_admin_import",
    authoritativeRequestId: metadataString(record.rawMetadata, "upstream_request_id"),
    gatewayGenerationId: null,
    importIdentity: record.externalReference,
    provider: record.provider,
  });
  const unitKey = economicEventKey(record.provider, identity);
  const economicVerification = verifyEconomically({
    evidence: {
      source: record.source,
      sourceAuthority: "provider_admin_import",
      evidenceTrust: issuance ? "provider_authoritative" : "unknown",
      provider: record.provider,
      model: record.model,
      authoritativeRequestId: metadataString(record.rawMetadata, "upstream_request_id"),
      gatewayGenerationId: null,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      cacheReadTokens: record.cachedInputTokens,
      cacheWriteTokens: null,
      reasoningTokens: null,
      actualCostMicros: record.actualCostMicros,
      actualCostAuthority: record.actualCostBasis ?? null,
      fundingClass: null,
      occurredAt: record.occurredAt,
    },
    economicEventKey: unitKey,
    dedupeStatus: unitKey ? "unique" : "unkeyed",
    sourceClass: economicSource,
  });
  const reward = decideReward({
    proofStatus,
    verificationType: record.verificationType,
    economicSource,
    protocolComputeMicros: record.protocolPricingVersion
      ? (record.protocolComputeMicros ?? 0)
      : null,
  });

  const receipt: ProofReceipt = {
    receiptVersion: RECEIPT_VERSION,
    receiptId: options.receiptId ?? newReceiptId(),
    issuer: issuance?.issuer ?? "usage://issuer/unsigned",
    issuerKeyId: issuance?.keyId ?? "unsigned",
    userId: options.userId,
    minerCredentialId: null,
    source: record.source,
    clientType: "import",
    provider: record.provider,
    model: record.model,
    // The deterministic import identity stands in for a generation id: it is
    // what makes this bucket exactly one thing, forever.
    generationId: record.externalReference,
    generationIdSource: "import_identity",
    // Nobody executed this on the user's behalf.
    gatewayId: null,
    trustEnvironment: issuance ? "production" : "development",
    inputTokens: record.inputTokens,
    cachedReadTokens: record.cachedInputTokens,
    cachedWriteTokens: null,
    outputTokens: record.outputTokens,
    reasoningTokens: null,
    requests: record.requests,
    costMicroUsd: record.actualCostMicros,
    costBasis: record.actualCostBasis ?? "unavailable",
    currency: "USD",
    occurredAt: record.occurredAt,
    observedAt,
    protocolComputeMicroUsd: record.protocolPricingVersion
      ? (record.protocolComputeMicros ?? 0)
      : null,
    protocolPricingVersion: record.protocolPricingVersion ?? null,
    verificationType: record.verificationType,
    verificationStatus: record.verificationStatus,
    proofStatus,
    economicStatus,
    adapterVersion: metadataString(record.rawMetadata, "adapter_version") ?? "import@1",
  };

  const signed = issuance ? signReceipt(receipt, issuance.privateKeyBase64) : null;

  return {
    record: {
      ...record,
      rawMetadata: {
        ...record.rawMetadata,
        economic_event_key: unitKey,
        economic_identity_kind: identity?.kind ?? null,
        economic_identity_authority: identity?.authority ?? null,
        dedupe_status: unitKey ? "unique" : "unkeyed",
        source_authority: "provider_admin_import",
        evidence_trust: issuance ? "provider_authoritative" : "unknown",
        economic_verification_status: economicVerification.status,
        economic_verification_reason: economicVerification.reason,
        economic_verification_policy_version: economicVerification.policyVersion,
      },
      economicStatus,
      economicSourceClass: economicSource,
      eligibleComputeMicros: reward.eligibleComputeMicros,
      rewardStatus: reward.status,
      rewardReason: reward.reason,
      rewardPolicyVersion: reward.policyVersion,
    },
    receipt,
    proof: {
      proofKind: "provider_usage_import",
      proofSource: record.provider,
      externalReference: record.externalReference,
      observedAt,
      adapterVersion: receipt.adapterVersion,
      proofHash: signed?.canonicalHash ?? receiptHash(receipt),
      trustEnvironment: receipt.trustEnvironment,
      proofStatus,
      receiptId: receipt.receiptId,
      receiptVersion: receipt.receiptVersion,
      issuer: issuance?.issuer ?? null,
      issuerKeyId: issuance?.keyId ?? null,
      signature: signed?.signature ?? null,
      signedAt: signed?.signedAt ?? null,
      metadata: {
        ...record.rawMetadata,
        proof_status: proofStatus,
        economic_status: economicStatus,
        economic_source_class: economicSource,
        reward_status: reward.status,
        reward_reason: reward.reason,
        reward_policy_version: reward.policyVersion,
        gateway_id: null,
        client_type: "import",
        generation_id_source: "import_identity",
        connection_id: options.connectionId ?? null,
        economic_event_key: unitKey,
        economic_identity_kind: identity?.kind ?? null,
        economic_identity_authority: identity?.authority ?? null,
        dedupe_status: unitKey ? "unique" : "unkeyed",
        source_authority: "provider_admin_import",
        evidence_trust: issuance ? "provider_authoritative" : "unknown",
        funding_class: null,
        economic_verification_status: economicVerification.status,
        economic_verification_reason: economicVerification.reason,
        economic_verification_policy_version: economicVerification.policyVersion,
      },
    },
  };
}
