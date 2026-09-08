import {
  verifyUsageReceipt,
  type ProofReceipt,
  type SignedProofReceipt,
} from "@/lib/domain/receipt";
import type { NormalizedUsageRecord } from "@/lib/domain/types";
import type { ProofRecordRow } from "@/lib/supabase/database.types";

/**
 * Rebuilding a receipt from what was stored, so a user can verify their own
 * proof rather than being told it is fine.
 *
 * Every signed field is persisted -- on the usage event, on the proof record,
 * or in the proof's metadata -- so the canonical form can be reconstructed
 * exactly. If reconstruction were lossy the signature would simply fail to
 * verify, which is the correct outcome: a proof that cannot be re-derived is
 * not a proof.
 */

function metadataString(
  metadata: ProofRecordRow["proof_metadata"],
  key: string,
  fallback: string,
): string {
  const value = metadata?.[key];
  return typeof value === "string" ? value : fallback;
}

function metadataNumber(
  metadata: ProofRecordRow["proof_metadata"],
  key: string,
): number | null {
  const value = metadata?.[key];
  return typeof value === "number" ? value : null;
}

export function receiptFromStoredProof(
  event: NormalizedUsageRecord,
  proof: ProofRecordRow,
): SignedProofReceipt | null {
  if (!proof.signature || !proof.receipt_id || !proof.receipt_version || !proof.proof_hash) {
    return null;
  }

  const metadata = proof.proof_metadata ?? {};
  const receipt: ProofReceipt = {
    receiptVersion: proof.receipt_version,
    receiptId: proof.receipt_id,
    issuer: proof.issuer ?? "",
    issuerKeyId: proof.issuer_key_id ?? "",
    userId: proof.user_id,
    minerCredentialId: metadataString(metadata, "miner_credential_id", "") || null,
    source: event.source,
    clientType: metadataString(metadata, "client_type", "unknown"),
    provider: metadataString(metadata, "served_by_provider", event.provider),
    model: event.model,
    generationId: metadataString(metadata, "gateway_generation_id", ""),
    generationIdSource: metadataString(metadata, "generation_id_source", "gateway_generation_id"),
    // v4 receipts sign the executing gateway. Null is a real value here: an
    // import has no gateway, and pre-v4 receipts never carried one.
    gatewayId: metadataString(metadata, "gateway_id", "") || null,
    trustEnvironment: (proof.trust_environment ?? "development") as ProofReceipt["trustEnvironment"],
    inputTokens: event.inputTokens,
    cachedReadTokens: event.cachedInputTokens,
    cachedWriteTokens: metadataNumber(metadata, "cache_write_tokens"),
    outputTokens: event.outputTokens,
    reasoningTokens: metadataNumber(metadata, "reasoning_tokens"),
    requests: event.requests,
    costMicroUsd: event.actualCostMicros,
    costBasis: metadataString(metadata, "cost_basis", "unavailable") as ProofReceipt["costBasis"],
    currency: "USD",
    occurredAt: event.occurredAt,
    observedAt: proof.observed_at ?? event.occurredAt,
    protocolComputeMicroUsd: metadataNumber(metadata, "protocol_compute_micros"),
    protocolPricingVersion: event.protocolPricingVersion ?? null,
    verificationType: event.verificationType,
    verificationStatus: event.verificationStatus,
    proofStatus: proof.proof_status,
    economicStatus: (metadataString(
      metadata,
      "economic_status",
      event.economicStatus ?? "ineligible",
    ) as ProofReceipt["economicStatus"]),
    adapterVersion: metadataString(metadata, "adapter_version", proof.adapter_version ?? ""),
  };

  return {
    receipt,
    canonicalHash: proof.proof_hash,
    signature: proof.signature,
    signedAt: proof.signed_at ?? proof.ingested_at,
  };
}

export type SignatureCheck =
  | { state: "valid"; issuer: string | null; issuerKeyId: string | null }
  | { state: "invalid"; reason: string }
  | { state: "unsigned" }
  | { state: "unverifiable"; reason: string };

/**
 * Check a stored proof's signature against the published public keys.
 *
 * "Unverifiable" is a distinct outcome from "invalid": missing a key is a
 * limitation of the checker, not evidence against the proof. Reporting the two
 * as one would either alarm users wrongly or reassure them wrongly.
 */
export function checkStoredSignature(
  signed: SignedProofReceipt | null,
  publicKeys: Record<string, string>,
  expectedIssuer: string,
): SignatureCheck {
  if (!signed) return { state: "unsigned" };
  if (Object.keys(publicKeys).length === 0) {
    return { state: "unverifiable", reason: "No published verification key is available here." };
  }

  const result = verifyUsageReceipt(signed, { publicKeys, expectedIssuer });
  if (result.valid) {
    return { state: "valid", issuer: result.issuer ?? null, issuerKeyId: result.issuerKeyId ?? null };
  }
  return { state: "invalid", reason: result.failures.join("; ") || "Signature did not verify." };
}
