/**
 * What trusted USAGE infrastructure observed while an AI request went through
 * the Vercel AI Gateway.
 *
 * SECURITY: there is deliberately no verification field on this type. A caller
 * cannot assert "this is ROUTED" -- the adapter derives the verification level
 * from `environment`, which is set by the server-side code that actually made
 * the request. Anything a client could influence lands in fields that carry no
 * economic weight.
 */

export const VERCEL_GATEWAY_PROVIDER = "vercel-ai-gateway";

/** Bump when normalization semantics change; recorded on every proof. */
export const VERCEL_GATEWAY_ADAPTER_VERSION = "vercel-gateway@1";

/**
 * `live`    — the request really happened through the gateway, observed by us.
 * `fixture` — a captured/synthetic payload used in development and tests.
 *
 * Fixtures are never routed evidence: USAGE did not observe them, so they are
 * classified REPORTED and carry zero economic weight. See `deriveVerification`.
 */
export type ObservationEnvironment = "live" | "fixture";

/** Mirrors the AI SDK v6 usage shape. Every field may legitimately be absent. */
export interface GatewayTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  inputTokenDetails?: {
    noCacheTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  outputTokenDetails?: {
    textTokens?: number;
    reasoningTokens?: number;
  };
}

export interface GatewayCost {
  /** Decimal USD as reported by the gateway. May exceed micro-USD precision. */
  value: string | number;
  currency: string;
}

export interface GatewayObservation {
  environment: ObservationEnvironment;
  /** `providerMetadata.gateway.generationId`. The authoritative request identity. */
  generationId: string;
  /** Gateway model slug, e.g. "openai/gpt-5.4". */
  model: string;
  /** Upstream provider that actually served the request, when the gateway says. */
  servedByProvider?: string;
  occurredAt: string;
  usage: GatewayTokenUsage;
  /** Authoritative cost from the gateway. Absent means unknown, never zero. */
  cost?: GatewayCost | null;
  finishReason?: string;
  latencyMs?: number;
}

export type GatewayObservationErrorCode =
  | "missing_generation_id"
  | "missing_model"
  | "missing_usage"
  | "invalid_usage"
  | "invalid_timestamp"
  | "invalid_cost";

/** Malformed evidence is an operational error, never a usage event. */
export class GatewayObservationError extends Error {
  constructor(
    readonly code: GatewayObservationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GatewayObservationError";
  }
}

function nonNegativeInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (!Number.isInteger(value) || value < 0) return null;
  return value;
}

/**
 * Validates an observation before it can become usage.
 *
 * Missing token counts are rejected rather than defaulted: inventing a zero
 * would quietly turn a broken integration into free, permanently stored
 * "evidence".
 */
export function assertObservation(observation: GatewayObservation): GatewayObservation {
  if (!observation.generationId?.trim()) {
    throw new GatewayObservationError(
      "missing_generation_id",
      "Gateway response carried no generation id; cannot establish request identity.",
    );
  }
  if (!observation.model?.trim()) {
    throw new GatewayObservationError("missing_model", "Gateway response carried no model.");
  }
  if (Number.isNaN(new Date(observation.occurredAt).getTime())) {
    throw new GatewayObservationError("invalid_timestamp", "Observation timestamp is not a date.");
  }

  const usage = observation.usage;
  if (!usage || (usage.inputTokens === undefined && usage.outputTokens === undefined)) {
    throw new GatewayObservationError(
      "missing_usage",
      "Gateway response carried no token usage; refusing to invent token counts.",
    );
  }

  const input = nonNegativeInteger(usage.inputTokens ?? 0);
  const output = nonNegativeInteger(usage.outputTokens ?? 0);
  if (input === null || output === null) {
    throw new GatewayObservationError("invalid_usage", "Token counts must be non-negative integers.");
  }

  const cacheRead = nonNegativeInteger(usage.inputTokenDetails?.cacheReadTokens ?? 0);
  const cacheWrite = nonNegativeInteger(usage.inputTokenDetails?.cacheWriteTokens ?? 0);
  const noCache = usage.inputTokenDetails?.noCacheTokens;
  if (
    cacheRead === null ||
    cacheWrite === null ||
    (noCache !== undefined && nonNegativeInteger(noCache) === null)
  ) {
    throw new GatewayObservationError("invalid_usage", "Token detail counts must be non-negative integers.");
  }

  if (observation.cost && observation.cost.currency !== "USD") {
    throw new GatewayObservationError(
      "invalid_cost",
      `Unsupported cost currency: ${observation.cost.currency}`,
    );
  }

  return observation;
}

export interface DerivedVerification {
  verificationType: "routed" | "reported";
  verificationStatus: "confirmed" | "unverifiable";
  evidenceClass: ObservationEnvironment;
}

/**
 * The single place verification level is decided for gateway evidence.
 *
 * live    -> ROUTED / confirmed  (weight 1.0)
 * fixture -> REPORTED / unverifiable (weight 0.0)
 *
 * A fixture is not routed evidence by definition: nothing observed it happen.
 * Classifying it REPORTED is what makes it structurally impossible for fixture
 * data to earn rewards, without needing a separate guard in the scorer.
 */
export function deriveVerification(environment: ObservationEnvironment): DerivedVerification {
  return environment === "live"
    ? { verificationType: "routed", verificationStatus: "confirmed", evidenceClass: "live" }
    : { verificationType: "reported", verificationStatus: "unverifiable", evidenceClass: "fixture" };
}

/**
 * Stable external identity. The gateway generation id is authoritative, and the
 * environment prefix means a fixture can never collide with -- or impersonate --
 * a real generation.
 */
export function observationReference(observation: GatewayObservation): string {
  return `${observation.environment}:${observation.generationId}`;
}
