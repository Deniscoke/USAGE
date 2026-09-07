/**
 * Core domain vocabulary for USAGE.
 *
 * Everything downstream of a provider adapter consumes these types only.
 * Provider-shaped payloads must never leak past `normalize()`.
 */

/** How strongly USAGE can vouch for a usage record. */
export type VerificationType = "verified" | "routed" | "reported";

/** Lifecycle of a record's verification, independent of its type. */
export type VerificationStatus = "confirmed" | "pending" | "unverifiable";

/** Does USAGE attest that this happened? Independent of money. */
export type ProofStatus = "observed" | "confirmed" | "rejected";

/**
 * May it earn right now? Independent of whether the proof is sound.
 *
 *   eligible        priced by an approved snapshot; counts toward mining
 *   pending_pricing genuine proof, but no approved price for this model yet
 *   pending_cost    legacy: awaiting an authoritative cost (pre-mining-v1)
 *   settled         already counted into an epoch allocation
 *   ineligible      not economic evidence at all
 */
export type EconomicStatus =
  | "eligible"
  | "pending_pricing"
  | "pending_cost"
  | "settled"
  | "ineligible";

/** Where the bytes physically came from (an adapter may support several). */
export type UsageSource =
  | "provider_usage_api"
  | "provider_cost_api"
  | "org_analytics_api"
  | "gateway"
  | "vercel_ai_gateway"
  | "local_client"
  | "imported_report";

/**
 * The single normalized shape produced by every adapter.
 * Monetary values are integer micro-USD (1 USD = 1_000_000). Never floats.
 */
export interface NormalizedUsageRecord {
  provider: string;
  source: UsageSource;
  /** Stable provider-side id. Used for idempotency; must be deterministic. */
  externalReference: string;
  model: string;
  occurredAt: string; // ISO 8601, UTC

  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  requests: number;

  /** Cost as reported by the provider, if any. */
  reportedCostMicros: number | null;
  /** Cost USAGE will actually reason about (reported, or derived from pricing). */
  normalizedCostMicros: number;

  verificationType: VerificationType;
  verificationStatus: VerificationStatus;
  /**
   * Set by trusted ingestion. Absent on older records, which fall back to
   * verificationStatus for eligibility.
   */
  economicStatus?: EconomicStatus;
  /**
   * Deterministic protocol value of this compute, in micro-USD. NOT a cost:
   * see src/lib/pricing/compute.ts.
   */
  protocolComputeMicros?: number;
  protocolPricingVersion?: string | null;

  /** Small, non-sensitive provider metadata. Never prompts or completions. */
  rawMetadata: Record<string, string | number | boolean | null>;
}

/** What a provider integration can actually deliver. Documented, not inferred. */
export interface ProviderCapability {
  requiredAccountType: string;
  authMethod: string;
  costDataAvailable: boolean;
  perUserDataAvailable: boolean;
  /** Rough lag between activity and it appearing in the source. */
  dataFreshness: string;
  verification: VerificationType;
  limitations: string[];
}

export interface UsageTotals {
  requests: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costMicros: number;
}

export interface DailyAggregate extends UsageTotals {
  /** YYYY-MM-DD in UTC. */
  day: string;
  provider: string;
  model: string;
  verificationType: VerificationType;
}
