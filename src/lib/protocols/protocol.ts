import type { ObservedGeneration, StreamObserver } from "@/lib/compute/gateway";

/**
 * The provider protocol boundary.
 *
 * A provider is a company; a protocol is the wire format it speaks. Keeping
 * them separate is what makes "connect any AI provider" possible without a code
 * change per company: DeepSeek, Together, Groq and a provider that does not
 * exist yet are all "OpenAI-compatible", and USAGE only needs to know the
 * protocol.
 *
 * A protocol knows how to talk to an endpoint and how to read what came back.
 * It decides NOTHING about trust: verification type, proof status, economic
 * status, pricing and points are all derived downstream from the trust
 * environment and the signing key. A protocol that lied about tokens still
 * could not mint a confirmed proof, because it does not hold the key.
 *
 * There is deliberately no user-supplied-code protocol. Executing an adapter a
 * user uploaded would hand them the server.
 */

export type ProviderProtocolId =
  | "openai_compatible"
  | "anthropic_compatible"
  | "usage_import"
  | "custom_unsupported";

/** What USAGE could establish about an endpoint by asking it. */
export interface ProtocolCapabilities {
  /** The credential was accepted. */
  authenticated: boolean;
  /** A model list is available. */
  models: boolean;
  /** Streaming responses are supported. */
  streaming: boolean;
  /** Token counts come back on a response. Without this, nothing can be mined. */
  usage: boolean;
  /** Cache read/write token detail is reported. */
  cacheUsage: boolean;
  /** Reasoning token detail is reported. */
  reasoningUsage: boolean;
  /**
   * Responses carry a stable per-request id. Without one there is no way to
   * dedupe, and no way to stop the same request being rewarded twice.
   */
  requestIdentity: boolean;
  /** The provider states an authoritative cost. Analytics only, never mining. */
  cost: boolean;
}

export const UNKNOWN_CAPABILITIES: ProtocolCapabilities = {
  authenticated: false,
  models: false,
  streaming: false,
  usage: false,
  cacheUsage: false,
  reasoningUsage: false,
  requestIdentity: false,
  cost: false,
};

export interface DiscoveredModel {
  /** The id the provider uses. Not assumed to be unique across providers. */
  upstreamModelId: string;
  displayName?: string;
}

export type ProbeFailure =
  | "unreachable"
  | "invalid_credentials"
  | "forbidden"
  | "rate_limited"
  | "unsupported"
  | "malformed";

export interface ProbeResult {
  ok: boolean;
  capabilities: ProtocolCapabilities;
  models: DiscoveredModel[];
  failure?: ProbeFailure;
  /** Safe to show a user. Never an upstream body, never a credential. */
  message?: string;
}

export interface ProtocolRequestContext {
  baseUrl: string;
  credential: string;
  /** Path segments after the connection mount point. */
  path: readonly string[];
  headers: Headers;
  body: unknown;
  rawBody: string;
  /** Stable internal user id, for provider-side attribution. Never PII. */
  attributionUser: string;
}

/**
 * Build an upstream path without doubling the API version segment.
 *
 * Clients disagree about who owns the `/v1`. Codex is configured with a base
 * URL and appends `/chat/completions` to whatever it was given, so it is handed
 * a base ending in `/v1`; a plain OpenAI SDK is handed a bare base and appends
 * `/v1/chat/completions` itself. Both are correct, and USAGE sees the
 * difference as a leading `v1` segment that is either present or not.
 *
 * Prepending unconditionally produced `/v1/v1/chat/completions`, which the
 * provider answers with its own 404 page -- an error that looks like USAGE
 * being down rather than a path being wrong. Accept both shapes instead of
 * making a user work out which kind of client they have.
 */
export function upstreamPath(segments: readonly string[]): string {
  const rest = segments[0] === "v1" ? segments.slice(1) : segments;
  return `v1/${rest.join("/")}`;
}

export interface ProbeInput {
  baseUrl: string;
  credential: string;
  fetchImpl?: typeof fetch;
  /** Injectable resolver, so tests exercise the guard without real DNS. */
  resolve?: (hostname: string) => Promise<string[]>;
  allowInsecure?: boolean;
}

export interface ProviderProtocol {
  readonly id: ProviderProtocolId;
  readonly label: string;
  /** Whether requests can be routed through this protocol at all. */
  readonly routable: boolean;

  /** Normalize a user-entered base URL (trailing slashes, version suffixes). */
  normalizeBaseUrl(baseUrl: string): string;

  /**
   * The cheapest honest check that a connection works.
   *
   * Ordered by cost to the user: credential metadata first, then a models
   * listing, and only an inference request if there is genuinely no other way.
   */
  probe(input: ProbeInput): Promise<ProbeResult>;

  /** Where the request goes, and how USAGE authenticates to it. */
  buildUpstreamCall(context: ProtocolRequestContext): {
    url: string;
    headers: Headers;
    body: string;
  };

  isStreaming(body: unknown): boolean;
  observe(payload: unknown, responseHeaders: Headers): ObservedGeneration;
  observeStream(responseHeaders: Headers): StreamObserver;
  sanitizeResponseHeaders(headers: Headers): Headers;
  /** Protocol-shaped error body, so a client sees something it understands. */
  error(status: number, type: string, message: string): Response;
}

/**
 * What a connection can be trusted to produce, given what it can actually do.
 *
 * The rule that keeps "connectable" and "mining eligible" apart. Connecting a
 * provider is never itself grounds to pay anyone.
 */
export type MiningEligibility =
  | "eligible_route"
  | "pending_pricing"
  | "analytics_only"
  | "unsupported";

export function deriveMiningEligibility(input: {
  routable: boolean;
  capabilities: ProtocolCapabilities;
  /** At least one selected model has an approved protocol price. */
  hasPricedModel: boolean;
}): MiningEligibility {
  if (!input.routable || !input.capabilities.authenticated) return "unsupported";

  // No token counts means nothing to measure; no request identity means no way
  // to stop the same request being counted twice. A synthetic id would make
  // duplicates invisible rather than impossible, which is worse than refusing.
  if (!input.capabilities.usage || !input.capabilities.requestIdentity) {
    return "analytics_only";
  }

  // Real, provable compute that the protocol has no approved price for. The
  // proof is still issued; only the reward waits for a pricing snapshot.
  if (!input.hasPricedModel) return "pending_pricing";

  return "eligible_route";
}

export const MINING_ELIGIBILITY_COPY: Record<
  MiningEligibility,
  { label: string; detail: string }
> = {
  eligible_route: {
    label: "Full mining",
    detail: "Verified compute through this connection earns USAGE.",
  },
  pending_pricing: {
    label: "Routed proof, pending pricing",
    detail:
      "USAGE can prove this compute happened, but has no approved price for these models yet, so it does not earn.",
  },
  analytics_only: {
    label: "Analytics only",
    detail:
      "This provider does not report enough to measure a request reliably, so its usage is shown but never earns.",
  },
  unsupported: {
    label: "Connected, not measurable",
    detail: "USAGE cannot observe usage through this connection.",
  },
};
