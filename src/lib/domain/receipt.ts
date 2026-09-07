import { createHash, randomUUID } from "node:crypto";
import { signPayload, verifyPayload } from "./signing";
import type {
  EconomicStatus,
  ProofStatus,
  VerificationStatus,
  VerificationType,
} from "./types";

export type { EconomicStatus, ProofStatus };

/**
 * USAGE Proof Receipt.
 *
 * The tamper-evident record of one unit of observed AI compute, and the thing a
 * third party can eventually check without trusting USAGE at all.
 *
 * TRUST MODEL, in one paragraph. The canonical hash proves *integrity* — that
 * these numbers have not been edited. It proves nothing about origin, because
 * anybody can invent a receipt and hash it. Origin comes from the Ed25519
 * signature, made with a private key that exists only in trusted hosted
 * infrastructure. A laptop cannot produce a production-signed receipt no matter
 * what environment variables it sets.
 *
 * WHAT IS HASHED AND SIGNED (exactly, in this order — see `canonicalReceipt`):
 *
 *   receiptVersion, receiptId, issuer, issuerKeyId,
 *   userId, minerCredentialId, source, clientType, provider, model,
 *   generationId, generationIdSource, trustEnvironment,
 *   inputTokens, cachedReadTokens, cachedWriteTokens, outputTokens,
 *   reasoningTokens, requests, costMicroUsd, costBasis, currency,
 *   occurredAt, verificationType, verificationStatus, proofStatus,
 *   economicStatus, adapterVersion
 *
 * WHAT IS NEVER HASHED, SIGNED OR STORED: API keys, miner plaintext tokens,
 * prompt text, response text, tool arguments, file contents, system prompts.
 *
 * `observedAt` is deliberately excluded: it records when USAGE saw the event,
 * which is operational metadata rather than part of the claim, and including it
 * would make the same generation hash differently on re-ingest. Unknown numeric
 * fields are `null`, never 0 — "we don't know" and "zero" are different claims.
 */

export const RECEIPT_VERSION = "usage.receipt.v2";
export const SUPPORTED_RECEIPT_VERSIONS = [RECEIPT_VERSION] as const;

export type CostBasis = "gateway_reported" | "provider_reported" | "estimated" | "unavailable";

/** Where the observation was made. Only `production` can be CONFIRMED. */
export type TrustEnvironment = "production" | "development" | "fixture";

/*
 * ProofStatus and EconomicStatus live in ./types so the normalized usage record
 * can carry them too:
 *
 *   proof_status     observed | confirmed | rejected
 *   economic_status  eligible | pending_cost | ineligible
 *
 * Separating them is the point: a real request through trusted infrastructure
 * is a real proof even when billing metadata has not reconciled, and calling it
 * "unconfirmed" for that reason would be false.
 */

export interface ProofReceipt {
  receiptVersion: string;
  receiptId: string;
  issuer: string;
  issuerKeyId: string;

  userId: string;
  minerCredentialId: string | null;
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
  proofStatus: ProofStatus;
  economicStatus: EconomicStatus;
  adapterVersion: string;
}

/** A receipt plus the proof of who issued it. */
export interface SignedProofReceipt {
  receipt: ProofReceipt;
  canonicalHash: string;
  signature: string;
  signedAt: string;
}

/** Fields covered by the hash and therefore by the signature, in a fixed order. */
const SIGNED_FIELDS = [
  "receiptVersion",
  "receiptId",
  "issuer",
  "issuerKeyId",
  "userId",
  "minerCredentialId",
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
  "proofStatus",
  "economicStatus",
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
  return SIGNED_FIELDS.map((field) => {
    const value = receipt[field];
    if (value === null || value === undefined) return `${field}=null`;
    if (field === "occurredAt") return `${field}=${new Date(String(value)).toISOString()}`;
    return `${field}=${String(value)}`;
  }).join("\n");
}

export function receiptHash(receipt: ProofReceipt): string {
  return `sha256:${createHash("sha256").update(canonicalReceipt(receipt), "utf8").digest("hex")}`;
}

/** Integrity only. Says nothing about who produced the receipt. */
export function verifyReceiptHash(receipt: ProofReceipt, expected: string): boolean {
  return receiptHash(receipt) === expected;
}

export function newReceiptId(): string {
  return randomUUID();
}

/**
 * Sign a receipt. Only ever called where the production private key exists.
 * The signature covers the canonical hash, which covers every economic field.
 */
export function signReceipt(receipt: ProofReceipt, privateKeyBase64: string): SignedProofReceipt {
  const canonicalHash = receiptHash(receipt);
  return {
    receipt,
    canonicalHash,
    signature: signPayload(canonicalHash, privateKeyBase64),
    signedAt: new Date().toISOString(),
  };
}

export interface ReceiptVerificationOptions {
  /** Known issuer public keys, by key id. Public by design. */
  publicKeys: Readonly<Record<string, string>>;
  /** Only receipts from this issuer are trusted. */
  expectedIssuer: string;
  acceptedVersions?: readonly string[];
}

export interface ReceiptVerificationResult {
  valid: boolean;
  /** Every reason it failed, so a caller can report precisely. */
  failures: string[];
  issuer?: string;
  issuerKeyId?: string;
  receiptId?: string;
  generationId?: string;
  canonicalHash?: string;
}

/**
 * Framework-independent verification. Needs only the receipt and a public key:
 * no database, no secrets, no USAGE code running on the verifier's behalf.
 */
export function verifyUsageReceipt(
  signed: SignedProofReceipt,
  options: ReceiptVerificationOptions,
): ReceiptVerificationResult {
  const failures: string[] = [];
  const { receipt } = signed;
  const accepted = options.acceptedVersions ?? SUPPORTED_RECEIPT_VERSIONS;

  if (!accepted.includes(receipt.receiptVersion)) {
    failures.push(`unsupported receipt version: ${receipt.receiptVersion}`);
  }
  if (receipt.issuer !== options.expectedIssuer) {
    failures.push(`unexpected issuer: ${receipt.issuer}`);
  }

  const computedHash = receiptHash(receipt);
  if (computedHash !== signed.canonicalHash) {
    // The receipt body no longer matches the hash it was signed with.
    failures.push("canonical hash does not match receipt contents");
  }

  const publicKey = options.publicKeys[receipt.issuerKeyId];
  if (!publicKey) {
    failures.push(`unknown signing key: ${receipt.issuerKeyId}`);
  } else if (!verifyPayload(signed.canonicalHash, signed.signature, publicKey)) {
    failures.push("signature does not verify");
  }

  return {
    valid: failures.length === 0,
    failures,
    issuer: receipt.issuer,
    issuerKeyId: receipt.issuerKeyId,
    receiptId: receipt.receiptId,
    generationId: receipt.generationId,
    canonicalHash: computedHash,
  };
}

/**
 * Economic classification, derived — never accepted from a caller.
 *
 * A confirmed proof with authoritative cost is eligible. A confirmed proof with
 * unknown cost is a genuine proof awaiting reconciliation. Anything unconfirmed
 * is not economic evidence.
 */
export function deriveEconomicStatus(input: {
  proofStatus: ProofStatus;
  verificationType: VerificationType;
  costBasis: CostBasis;
  costMicroUsd: number | null;
}): EconomicStatus {
  if (input.proofStatus !== "confirmed") return "ineligible";
  if (input.verificationType === "reported") return "ineligible";
  // Estimated cost is explicitly not an invoice: it may inform a UI, never a payout.
  if (input.costBasis === "estimated" || input.costBasis === "unavailable") return "pending_cost";
  if (input.costMicroUsd === null) return "pending_cost";
  return "eligible";
}
