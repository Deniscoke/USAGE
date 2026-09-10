import type { ProtocolCapabilities, ProviderProtocolId } from "@/lib/protocols/protocol";

/**
 * Provider connection profiles.
 *
 * PROVIDER != PROTOCOL. A provider is a company; a protocol is a wire format.
 * Two providers can speak the same inference format and still differ in
 * where their API lives, how a key is presented, whether a model list
 * exists, and what a key-only probe can prove. Treating "OpenAI-compatible"
 * as "api.openai.com semantics" is exactly how a real OpenAI key entered
 * against `https://openai.com` was reported as invalid: the marketing site
 * answered 403 and the probe called that a rejected credential.
 *
 * A profile is SERVER-CONTROLLED. It names, for a provider USAGE knows:
 *
 *   base URL          fixed; the user does not type it for a known provider
 *   auth strategy     bearer | anthropic_x_api_key -- the documented header
 *   api path prefix   "v1" for most; "" when the base already carries the
 *                     version segment (Gemini's OpenAI surface)
 *   validation        which zero-cost, non-generative request proves the key
 *   documented        generation-time capabilities the provider documents;
 *                     a model list never proves these, so they come from
 *                     here or from an observed generation, never from /models
 *   economicAuthority official | community_supported -- whether a cost this
 *                     endpoint states is evidence (the user does not control
 *                     the endpoint)
 *
 * Every profile cites the documentation it was checked against, with the
 * date. A profile is added only when that check has been made.
 */

export type AuthStrategy = "bearer" | "anthropic_x_api_key";

export type ValidationStrategy =
  /** GET the model list with the credential; 200 with a list proves the key. */
  | { kind: "models" }
  /**
   * GET a key/account endpoint with the credential. Used where the model
   * list is public (so it proves nothing about the key).
   */
  | { kind: "key_info"; path: string; modelsPublic: boolean };

export interface ProviderConnectionProfile {
  family: string;
  displayName: string;
  protocol: Extract<ProviderProtocolId, "openai_compatible" | "anthropic_compatible">;
  baseUrl: string;
  /** Hosts that identify this provider when a user types a URL. */
  hosts: readonly string[];
  authStrategy: AuthStrategy;
  apiPathPrefix: "v1" | "";
  /** Absolute path, from the base URL, of the model list. */
  modelsPath: string;
  validation: ValidationStrategy;
  /** Fixed headers every request needs beyond auth. */
  requiredHeaders: Readonly<Record<string, string>>;
  /** What the provider documents for generations on this surface. */
  documented: Pick<ProtocolCapabilities, "streaming" | "usage" | "requestIdentity" | "cost" | "cacheUsage" | "reasoningUsage">;
  economicAuthority: "official" | "community_supported";
  docs: string;
  verifiedOn: string;
}

const ANTHROPIC_VERSION = "2023-06-01";

export const PROVIDER_PROFILES: readonly ProviderConnectionProfile[] = [
  {
    family: "openai",
    displayName: "OpenAI",
    protocol: "openai_compatible",
    baseUrl: "https://api.openai.com",
    hosts: ["api.openai.com", "openai.com", "www.openai.com", "platform.openai.com"],
    authStrategy: "bearer",
    apiPathPrefix: "v1",
    modelsPath: "/v1/models",
    validation: { kind: "models" },
    requiredHeaders: {},
    // Chat Completions return `usage` and the `x-request-id` header.
    documented: { streaming: true, usage: true, requestIdentity: true, cost: false, cacheUsage: true, reasoningUsage: true },
    economicAuthority: "official",
    docs: "https://developers.openai.com/api/reference/resources/models/methods/list (GET https://api.openai.com/v1/models, Authorization: Bearer)",
    verifiedOn: "2026-09-10",
  },
  {
    family: "anthropic",
    displayName: "Anthropic",
    protocol: "anthropic_compatible",
    baseUrl: "https://api.anthropic.com",
    hosts: ["api.anthropic.com", "anthropic.com", "www.anthropic.com", "console.anthropic.com", "platform.claude.com"],
    authStrategy: "anthropic_x_api_key",
    apiPathPrefix: "v1",
    modelsPath: "/v1/models",
    validation: { kind: "models" },
    requiredHeaders: { "anthropic-version": ANTHROPIC_VERSION },
    // Messages return `usage` (incl. cache read/creation) and `request-id`.
    documented: { streaming: true, usage: true, requestIdentity: true, cost: false, cacheUsage: true, reasoningUsage: false },
    economicAuthority: "official",
    docs: "https://platform.claude.com/docs/en/api/models/list (GET /v1/models, x-api-key + anthropic-version)",
    verifiedOn: "2026-09-10",
  },
  {
    family: "openrouter",
    displayName: "OpenRouter",
    protocol: "openai_compatible",
    baseUrl: "https://openrouter.ai/api",
    hosts: ["openrouter.ai"],
    authStrategy: "bearer",
    apiPathPrefix: "v1",
    modelsPath: "/v1/models",
    // The model list is public and proves nothing about a key; the key
    // endpoint is the documented credential probe (limits, is_free_tier).
    validation: { kind: "key_info", path: "/v1/key", modelsPublic: true },
    requiredHeaders: {},
    documented: { streaming: true, usage: true, requestIdentity: true, cost: true, cacheUsage: true, reasoningUsage: true },
    economicAuthority: "community_supported",
    docs: "https://openrouter.ai/docs/api-reference/limits (GET /api/v1/key); GET /api/v1/models is unauthenticated (checked live 2026-09-10)",
    verifiedOn: "2026-09-10",
  },
  {
    family: "mistral",
    displayName: "Mistral",
    protocol: "openai_compatible",
    baseUrl: "https://api.mistral.ai",
    hosts: ["api.mistral.ai", "mistral.ai", "console.mistral.ai"],
    authStrategy: "bearer",
    apiPathPrefix: "v1",
    modelsPath: "/v1/models",
    validation: { kind: "models" },
    requiredHeaders: {},
    documented: { streaming: true, usage: true, requestIdentity: false, cost: false, cacheUsage: false, reasoningUsage: false },
    economicAuthority: "official",
    docs: "https://docs.mistral.ai/api/ (GET https://api.mistral.ai/v1/models, Authorization: Bearer)",
    verifiedOn: "2026-09-10",
  },
  {
    family: "xai",
    displayName: "xAI",
    protocol: "openai_compatible",
    baseUrl: "https://api.x.ai",
    hosts: ["api.x.ai", "x.ai", "console.x.ai"],
    authStrategy: "bearer",
    apiPathPrefix: "v1",
    modelsPath: "/v1/models",
    validation: { kind: "models" },
    requiredHeaders: {},
    documented: { streaming: true, usage: true, requestIdentity: false, cost: false, cacheUsage: false, reasoningUsage: true },
    economicAuthority: "official",
    docs: "https://docs.x.ai/docs/api-reference (base https://api.x.ai/v1, Authorization: Bearer); GET /v1/models answers 401 unauthenticated (checked live 2026-09-10)",
    verifiedOn: "2026-09-10",
  },
  {
    family: "google",
    displayName: "Google Gemini",
    protocol: "openai_compatible",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    hosts: ["generativelanguage.googleapis.com"],
    authStrategy: "bearer",
    // The base already carries `/v1beta/openai`; requests are `/chat/completions`.
    apiPathPrefix: "",
    modelsPath: "/models",
    validation: { kind: "models" },
    requiredHeaders: {},
    documented: { streaming: true, usage: true, requestIdentity: false, cost: false, cacheUsage: false, reasoningUsage: false },
    economicAuthority: "official",
    docs: "https://ai.google.dev/gemini-api/docs/openai (base https://generativelanguage.googleapis.com/v1beta/openai/, Authorization: Bearer, GET .../openai/models)",
    verifiedOn: "2026-09-10",
  },
];

export function profileForFamily(family: string | null | undefined): ProviderConnectionProfile | null {
  if (!family) return null;
  return PROVIDER_PROFILES.find((p) => p.family === family.toLowerCase()) ?? null;
}

/** The profile a typed URL belongs to, if its host is a provider USAGE knows. */
export function profileForUrl(url: string): ProviderConnectionProfile | null {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return PROVIDER_PROFILES.find((p) => p.hosts.includes(host)) ?? null;
  } catch {
    return null;
  }
}

/**
 * What a custom endpoint gets: the protocol's generic shape, documented for
 * what it is. OpenAI-compatible means Bearer auth and GET /v1/models;
 * Anthropic-compatible means x-api-key and GET /v1/models. Nothing about
 * generation-time capabilities is assumed; they are learnt from the first
 * observed request.
 */
export function customProfile(protocol: ProviderConnectionProfile["protocol"], baseUrl: string): ProviderConnectionProfile {
  const anthropic = protocol === "anthropic_compatible";
  return {
    family: "custom",
    displayName: "Custom",
    protocol,
    baseUrl: normalizeCustomBaseUrl(baseUrl),
    hosts: [],
    authStrategy: anthropic ? "anthropic_x_api_key" : "bearer",
    apiPathPrefix: "v1",
    modelsPath: "/v1/models",
    validation: { kind: "models" },
    requiredHeaders: anthropic ? { "anthropic-version": ANTHROPIC_VERSION } : {},
    documented: { streaming: false, usage: false, requestIdentity: false, cost: false, cacheUsage: false, reasoningUsage: false },
    // A user-controlled endpoint is not an economic authority.
    economicAuthority: "community_supported",
    docs: "generic protocol shape; nothing provider-specific is assumed",
    verifiedOn: "2026-09-10",
  } as ProviderConnectionProfile & { economicAuthority: "community_supported" };
}

/**
 * Base URL as the user typed it, made canonical without inventing anything:
 * trailing slashes go, one trailing `/v1` goes (the protocol adds its own),
 * and every other path segment stays -- a provider whose surface lives at
 * `/some/path/openai` keeps that path.
 */
export function normalizeCustomBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
}

/** The base URL a connection should use: a known provider's fixed one, else the typed one. */
export function resolveBaseUrl(profile: ProviderConnectionProfile, typed: string): string {
  return profile.family === "custom" ? normalizeCustomBaseUrl(typed) : profile.baseUrl;
}

/** Whether this endpoint is one USAGE recognises rather than a URL the user typed. */
export function isRecognisedEndpoint(family: string | null | undefined, baseUrl: string | null | undefined): boolean {
  const byFamily = profileForFamily(family);
  if (byFamily && baseUrl) {
    try {
      return byFamily.hosts.includes(new URL(baseUrl).hostname.toLowerCase());
    } catch {
      return false;
    }
  }
  return false;
}

export function authHeaders(profile: ProviderConnectionProfile, credential: string): Record<string, string> {
  const headers: Record<string, string> = { ...profile.requiredHeaders, accept: "application/json" };
  if (profile.authStrategy === "anthropic_x_api_key") headers["x-api-key"] = credential;
  else headers.authorization = `Bearer ${credential}`;
  return headers;
}
