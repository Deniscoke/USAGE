import type {
  GatewayCost,
  GatewayObservation,
  GatewayTokenUsage,
  ObservationEnvironment,
} from "@/lib/providers/vercel-gateway/observation";

/**
 * The compute gateway boundary.
 *
 * A gateway is the half of USAGE that *executes* a request and observes it
 * first-hand. That first-hand observation is the entire basis of ROUTED
 * evidence, so this interface exists to make adding a second gateway an
 * implementation exercise rather than a rewrite.
 *
 * The security shape matters more than the method list: a gateway decides where
 * a request goes and how it is authenticated upstream, and it reports what it
 * observed. It does NOT decide verification type, proof status, economic
 * status, protocol compute value or points -- those are derived downstream from
 * the trust environment and the signing key. A malicious gateway implementation
 * could lie about tokens; it still could not mint a confirmed proof, because it
 * does not hold the key.
 *
 * Import adapters (the pull half) are a separate boundary: see
 * src/lib/imports/adapter.ts.
 */

export interface UpstreamCall {
  url: string;
  headers: Headers;
  /** Serialized request body, after any server-side attribution. */
  body: string;
}

export interface GatewayAttribution {
  /** Stable internal user id. Never an email or a name. */
  user: string;
  tags: readonly string[];
}

export interface GatewayRequest {
  /** Path segments after the gateway mount point, e.g. ["v1", "messages"]. */
  path: readonly string[];
  /** Headers exactly as the client sent them. Treated as untrusted. */
  headers: Headers;
  /** Parsed body, or null when the body was absent or not JSON. */
  body: unknown;
  rawBody: string;
  attribution: GatewayAttribution;
}

/** What a gateway could tell about the generation it just carried. */
export interface GenerationIdentity {
  generationId: string | null;
  /** How the id was obtained, recorded on the proof for provenance. */
  source: string | null;
  model: string | null;
  /** Upstream provider that actually served it, when the gateway says. */
  provider: string | null;
  /**
   * The provider's own request id from the response headers (Anthropic
   * `request-id`, OpenAI/OpenRouter `x-request-id`). Null when absent. This is
   * the value a tool's local telemetry can also see, so it is the ONLY key on
   * which a local observation may be correlated with this record.
   */
  upstreamRequestId?: string | null;
}

/** Read the provider request id from upstream response headers, if any. */
export function upstreamRequestIdFrom(headers: Headers | null | undefined): string | null {
  if (!headers) return null;
  const value = headers.get("request-id") ?? headers.get("x-request-id");
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 200 ? trimmed : null;
}

export interface ObservedGeneration {
  identity: GenerationIdentity;
  usage: GatewayTokenUsage;
  /** Authoritative cost, or null. Null means unknown -- never zero. */
  cost: GatewayCost | null;
  finishReason?: string;
  /** True when the response carried usage at all. */
  hasUsage: boolean;
}

/** Accumulates a streamed response without buffering or inspecting content. */
export interface StreamObserver {
  push(chunk: string): void;
  result(): ObservedGeneration;
}

export interface ComputeGateway {
  /** Stable identifier, recorded on proofs and referenced by the registry. */
  readonly id: string;
  /** Registry slug of the provider this gateway routes through. */
  readonly providerSlug: string;

  /** Where the request goes and how USAGE authenticates to it. */
  buildUpstreamCall(request: GatewayRequest, credential: string): UpstreamCall;

  /** Whether the client asked for a streamed response. */
  isStreaming(body: unknown): boolean;

  /** Read a complete, non-streamed response. Usage metadata only. */
  observe(payload: unknown, responseHeaders: Headers): ObservedGeneration;

  /** Read a streamed response incrementally. Bytes still pass through untouched. */
  observeStream(responseHeaders: Headers): StreamObserver;

  /** Response headers safe to return to the miner. */
  sanitizeResponseHeaders(headers: Headers): Headers;

  /**
   * Turn an observation into the canonical record ingestion accepts. Returns
   * null when the evidence is too incomplete to be a proof -- a broken response
   * must never mint economic value.
   */
  toObservation(input: {
    observed: ObservedGeneration;
    requestedModel: string | null;
    environment: ObservationEnvironment;
    clientType: string;
    occurredAt: Date;
    latencyMs: number;
  }): GatewayObservation | null;
}
