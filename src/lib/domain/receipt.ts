import { createHash } from "node:crypto";
import type { VerificationStatus, VerificationType } from "./types";

/**
 * USAGE Proof Receipt.
 *
 * The tamper-evident record of one unit of observed AI compute. It is what a
 * future signed or on-chain proof would carry, so it is defined independently of
 * any provider and hashed over a canonical form.
 *
 * WHAT IS HASHED (exactly, in this order — see `canonicalReceipt`):
 *
 *   receiptVersion, userId, source, clientType, provider, model,
 *   generationId, generationIdSource, trustEnvironment,
 *   inputTokens, cachedReadTokens, cachedWriteTokens, outputTokens,
 *   reasoningTokens, requests, costMicroUsd, costBasis, currency,
 *   occurredAt, verificationType, verificationStatus, adapterVersion
 *
 * WHAT IS NEVER HASHED OR STORED: API keys, miner tokens, prompt text,
 * response text, tool arguments, file contents, system prompts. A receipt
 * describes consumption, not conversation.
 *
 * `observedAt` is deliberately excluded from the hash: it records when USAGE
 * saw the event, which is operational metadata rather than part of the claim,
 * and including it would make the same generation hash differently on re-ingest.
 * Unknown numeric fields are `null`, never 0 — "we don't know" and "zero" are
 * different claims.
 */

export const RECEIPT_VERSION = "usage.receipt.v1";

export type CostBasis = "gateway_reported" | "provider_reported" | "estimated" | "unavailable";

/** Where the observation was made. Only `production` can carry economic weight. */
export type TrustEnvironment = "production" | "development" | "fixture";

export interface ProofReceipt {
  receiptVersion: string;
  userId: string;
  source: string;
  clientType: string;
  provider: string;
  model: string;

  generationId: string;
  generationIdSource: string;
  trustEnvironment: TrustEnvironment;

  inputTokens: number | null;
  cachedReadTokens: number | null;
  cachedWriteTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  requests: number;

  costMicroUsd: number | null;
  costBasis: CostBasis;
  currency: string;

  occurredAt: string;
  observedAt: string;

  verificationType: VerificationType;
  verificationStatus: VerificationStatus;
  adapterVersion: string;
}

/** Fields covered by the hash, in a fixed order. */
const HASHED_FIELDS = [
  "receiptVersion",
  "userId",
  "source",
  "clientType",
  "provider",
  "model",
  "generationId",
  "generationIdSource",
  "trustEnvironment",
  "inputTokens",
  "cachedReadTokens",
  "cachedWriteTokens",
  "outputTokens",
  "reasoningTokens",
  "requests",
  "costMicroUsd",
  "costBasis",
  "currency",
  "occurredAt",
  "verificationType",
  "verificationStatus",
  "adapterVersion",
] as const satisfies readonly (keyof ProofReceipt)[];

/**
 * Canonical serialization: newline-joined `key=value` pairs in the fixed order
 * above, with `null` for unknown values and timestamps normalized to UTC ISO.
 *
 * Chosen over JSON.stringify because JSON key order and number formatting are
 * not guaranteed stable across engines, and a proof hash that depends on the
 * runtime is not a proof of anything.
 */
export function canonicalReceipt(receipt: ProofReceipt): string {
  return HASHED_FIELDS.map((field) => {
    const value = receipt[field];
    if (value === null || value === undefined) return `${field}=null`;
    if (field === "occurredAt") return `${field}=${new Date(String(value)).toISOString()}`;
    return `${field}=${String(value)}`;
  }).join("\n");
}

export function receiptHash(receipt: ProofReceipt): string {
  return `sha256:${createHash("sha256").update(canonicalReceipt(receipt), "utf8").digest("hex")}`;
}

/** Recompute and compare — how a stored proof is checked for tampering. */
export function verifyReceiptHash(receipt: ProofReceipt, expected: string): boolean {
  return receiptHash(receipt) === expected;
}
