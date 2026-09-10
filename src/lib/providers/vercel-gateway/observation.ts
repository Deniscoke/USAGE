import type { TrustEnvironment } from "@/lib/domain/receipt";
import type { FundingEvidence } from "@/lib/protocol/economic-unit";

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
 * Where an observation was made:
 *
 * `live`        — a real request through trusted, hosted USAGE infrastructure.
 * `development` — a real request, but observed by a gateway running on someone's
 *                 own machine. Technically identical, economically not: a local
 *                 process is not a trust anchor and must not mint rewards.
 * `fixture`     — a captured/synthetic payload used in tests.
 *
 * See `deriveVerification` for how each maps onto the public vocabulary.
 */
export type ObservationEnvironment = "live" | "development" | "fixture";

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
  /**
   * Which compute gateway carried this request. Set by the server from the
   * gateway that actually ran it -- never from anything a client sent.
   */
  gatewayId?: string;
  /**
   * True when the endpoint is one USAGE recognises rather than an arbitrary URL
   * the user supplied. A well-known provider billing a user's own key is
   * evidence; a user's own server saying it charged them is a claim.
   *
   * Set by the server from the connection's definition, never by a client.
   */
  endpointTrusted?: boolean;
  /** What produced the traffic: "probe", "claude-code", ... Non-PII. */
  clientType?: string;
  /** How the identity was obtained, for provenance. */
  generationIdSource?: string;
  /**
   * Which provider account carried this request, when it is not USAGE's own
   * gateway -- the slug of the connection that executed it, e.g. "openrouter".
   *
   * Distinct from `servedByProvider`, which is whoever ultimately ran the model
   * (an OpenRouter request can be served by Liquid). Both matter: one says
   * whose credential and whose bill, the other says whose hardware.
   *
   * Absent means USAGE's own gateway, which the adapter names itself.
   */
  providerSlug?: string;
  /** Upstream provider that actually served the request, when the gateway says. */
  servedByProvider?: string;
  /**
   * The provider's own request id from the upstream response headers
   * (Anthropic `request-id`, OpenAI `x-request-id`), when present. Distinct
   * from the generation id: this is the value a tool's telemetry also sees.
   */
  upstreamRequestId?: string | null;
  /**
   * What funded the request, as the PROVIDER's account surface stated it.
   * Set by the server from the connection that carried the request; never
   * read from a request, a response body, or telemetry. Absent means
   * unknown, and unknown is held.
   */
  funding?: FundingEvidence | null;
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
  verificationStatus: "confirmed" | "pending" | "unverifiable";
  evidenceClass: ObservationEnvironment;
  trustEnvironment: TrustEnvironment;
}

/**
 * The single place verification level is decided for gateway evidence.
 *
 *   live        -> ROUTED / confirmed      (weight 1.0, economically eligible)
 *   development -> ROUTED / pending        (real, shown, earns nothing)
 *   fixture     -> REPORTED / unverifiable (weight 0.0)
 *
 * The vocabulary does not change: a locally observed request genuinely was
 * routed, so calling it REPORTED would be a lie in the other direction. What
 * makes it non-economic is the *status*, which the scorer requires to be
 * `confirmed` (see isEconomicallyEligible).
 */
export function deriveVerification(environment: ObservationEnvironment): DerivedVerification {
  switch (environment) {
    case "live":
      return {
        verificationType: "routed",
        verificationStatus: "confirmed",
        evidenceClass: "live",
        trustEnvironment: "production",
      };
    case "development":
      return {
        verificationType: "routed",
        verificationStatus: "pending",
        evidenceClass: "development",
        trustEnvironment: "development",
      };
    case "fixture":
      return {
        verificationType: "reported",
        verificationStatus: "unverifiable",
        evidenceClass: "fixture",
        trustEnvironment: "fixture",
      };
  }
}

/**
 * Stable external identity. The gateway generation id is authoritative, and the
 * environment prefix means a fixture can never collide with -- or impersonate --
 * a real generation.
 */
export function observationReference(observation: GatewayObservation): string {
  return `${observation.environment}:${observation.generationId}`;
}

/** Trusted hosted infrastructure, or a laptop? Resolved from server config only. */
export function resolveTrustEnvironment(): ObservationEnvironment {
  return process.env.USAGE_TRUST_ENVIRONMENT === "production" ? "live" : "development";
}
