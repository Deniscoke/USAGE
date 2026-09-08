/**
 * The provider registry.
 *
 * USAGE is an AI compute network, not a client of one AI company or one
 * gateway. Everything the product says about a provider is read from here.
 *
 * THE DISTINCTION THAT MATTERS: a provider (a model lab) is not a gateway (the
 * infrastructure that carries a request). Anthropic is reachable through
 * Vercel and through OpenRouter; saying "Anthropic: routed" would imply a
 * direct Anthropic integration that does not exist. So routing lives in
 * `routes`, one entry per gateway, each with its own status. Import capability
 * stays on the provider, because it is the provider's own API.
 *
 * THE HONESTY RULE: a status describes what the code can actually do today.
 * `live` is only claimed for something exercised against the real provider in
 * production. Nothing here is aspirational.
 *
 * This file is the source of truth; `npm run usage:providers:publish` mirrors
 * it into `providers` and `provider_routes`.
 */

export type ProviderCategory = "model_provider" | "gateway" | "cloud_platform";

/** Overall integration maturity, independent of any single route. */
export type ProviderStatus = "beta" | "experimental" | "planned";

/**
 * What a capability can actually do right now.
 *
 *   live         exercised against the real provider, in production
 *   tested       implemented, covered by tests/fixtures, never run live
 *   configured   implemented and a credential is present, not yet exercised
 *   available    implemented and usable
 *   coming_soon  declared, not implemented
 *   unsupported  will not exist by this route
 */
export type RouteStatus =
  | "live"
  | "tested"
  | "configured"
  | "available"
  | "coming_soon"
  | "unsupported";

/** Statuses that mean a user can actually use the thing today. */
const USABLE: readonly RouteStatus[] = ["live", "tested", "configured", "available"];

export function isUsable(status: RouteStatus): boolean {
  return USABLE.includes(status);
}

export type CostAvailability = "authoritative" | "unavailable";

/** One way to route this provider's models: a (provider, gateway) pair. */
export interface GatewayRoute {
  /** ComputeGateway id. Must exist in the gateway registry. */
  gateway: string;
  /** Human name of that gateway, for the UI. */
  gatewayName: string;
  status: RouteStatus;
  /** What the *user* must supply. Usually nothing: USAGE holds the credential. */
  authRequirement: string;
  costAvailability: CostAvailability;
  note?: string;
}

/** Importing a provider's own record of usage that already happened. */
export interface ImportCapability {
  status: RouteStatus;
  /** The exact API, named. */
  source: string;
  /** What kind of account can do this. Consumer accounts usually cannot. */
  accountRequirement: string;
  /** Per-request, or aggregated into buckets. Never pretend the latter is the former. */
  granularity: "per_generation" | "provider_aggregate";
  costAvailability: CostAvailability;
  note?: string;
}

/** Methods that are neither a route nor an import. */
export type ConnectionMethod = "routed_mining" | "verified_import" | "byok" | "subscription";
export type MethodAvailability = "available" | "experimental" | "coming_soon" | "unsupported";

export interface ProviderMethod {
  availability: MethodAvailability;
  note?: string;
}

/** A tool a person recognises, mapped onto the method that connects it. */
export interface ProviderTool {
  slug: string;
  name: string;
  method: ConnectionMethod;
  availability: MethodAvailability;
}

export interface ProviderDefinition {
  slug: string;
  name: string;
  category: ProviderCategory;
  status: ProviderStatus;
  integrationVersion: string;
  /** Every gateway this provider's models can be routed through. */
  routes: readonly GatewayRoute[];
  import: ImportCapability;
  byok: ProviderMethod;
  subscription: ProviderMethod;
  usageFields: readonly string[];
  costFields: readonly string[];
  tools: readonly ProviderTool[];
}

const UNSUPPORTED: ProviderMethod = { availability: "unsupported" };
const SOON = (note: string): ProviderMethod => ({ availability: "coming_soon", note });

const NO_IMPORT = (note: string): ImportCapability => ({
  status: "coming_soon",
  source: "—",
  accountRequirement: "—",
  granularity: "provider_aggregate",
  costAvailability: "unavailable",
  note,
});

/**
 * Vercel AI Gateway. Proven in production against Anthropic models, so that
 * route is `live`; the same code carries every other model the gateway serves,
 * which is `available` rather than `live` because it has not been exercised.
 *
 * Cost is unavailable on the Anthropic-compatible surface: it returns no
 * authoritative cost, and inventing one would fabricate economic value.
 */
function viaVercel(status: RouteStatus): GatewayRoute {
  return {
    gateway: "vercel-ai-gateway",
    gatewayName: "Vercel AI Gateway",
    status,
    authRequirement: "None — USAGE routes with its own gateway credential.",
    costAvailability: "unavailable",
  };
}

/**
 * OpenRouter. Implemented and covered by fixture tests; no live proof exists
 * yet because no OpenRouter credential is configured. It *does* return an
 * authoritative per-request cost, which the Vercel surface does not.
 */
function viaOpenRouter(status: RouteStatus = "tested"): GatewayRoute {
  return {
    gateway: "openrouter",
    gatewayName: "OpenRouter",
    status,
    authRequirement: "None — USAGE routes with its own OpenRouter credential.",
    costAvailability: "authoritative",
    note: "Reports an authoritative per-request cost, recorded for audit only.",
  };
}

const ANTHROPIC_USAGE_FIELDS = [
  "input_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
  "output_tokens",
] as const;

const OPENAI_USAGE_FIELDS = ["input_tokens", "input_cached_tokens", "output_tokens"] as const;

export const PROVIDERS: readonly ProviderDefinition[] = [
  {
    slug: "anthropic",
    name: "Anthropic",
    category: "model_provider",
    status: "beta",
    integrationVersion: "anthropic@2",
    routes: [viaVercel("live"), viaOpenRouter()],
    import: NO_IMPORT(
      "Anthropic organization usage import needs organization/admin access and is not implemented yet.",
    ),
    byok: SOON("Bringing your own Anthropic key is not implemented yet."),
    subscription: SOON(
      "Forwarding a Claude subscription needs paid AI Gateway credits upstream.",
    ),
    usageFields: ANTHROPIC_USAGE_FIELDS,
    costFields: [],
    tools: [
      { slug: "claude-code", name: "Claude Code", method: "routed_mining", availability: "available" },
      { slug: "claude-app", name: "Claude apps", method: "subscription", availability: "coming_soon" },
    ],
  },
  {
    slug: "openai",
    name: "OpenAI",
    category: "model_provider",
    status: "beta",
    integrationVersion: "openai@2",
    routes: [viaVercel("available"), viaOpenRouter()],
    import: {
      status: "tested",
      source: "OpenAI Organization Usage API (/v1/organization/usage/completions)",
      accountRequirement: "Organization admin key. Consumer ChatGPT accounts cannot.",
      granularity: "provider_aggregate",
      costAvailability: "authoritative",
      note: "Usage arrives in time buckets, not per request. Costs come from /v1/organization/costs.",
    },
    byok: SOON("Bringing your own OpenAI key is not implemented yet."),
    subscription: UNSUPPORTED,
    usageFields: OPENAI_USAGE_FIELDS,
    costFields: ["amount.value"],
    tools: [
      { slug: "codex", name: "Codex", method: "routed_mining", availability: "coming_soon" },
      { slug: "openai-org", name: "OpenAI organization", method: "verified_import", availability: "available" },
    ],
  },
  {
    slug: "google",
    name: "Google",
    category: "model_provider",
    status: "beta",
    integrationVersion: "google@2",
    routes: [viaVercel("available"), viaOpenRouter()],
    import: NO_IMPORT("Google Cloud usage import is not implemented yet."),
    byok: SOON("Bringing your own Google key is not implemented yet."),
    subscription: UNSUPPORTED,
    usageFields: ["input_tokens", "output_tokens"],
    costFields: [],
    tools: [{ slug: "gemini-cli", name: "Gemini CLI", method: "routed_mining", availability: "coming_soon" }],
  },
  {
    slug: "mistral",
    name: "Mistral",
    category: "model_provider",
    status: "beta",
    integrationVersion: "mistral@2",
    routes: [viaVercel("available"), viaOpenRouter()],
    import: NO_IMPORT(
      "Mistral publishes an admin usage API, but its account and plan requirements are not verified yet.",
    ),
    byok: SOON("Bringing your own Mistral key is not implemented yet."),
    subscription: UNSUPPORTED,
    usageFields: ["input_tokens", "output_tokens"],
    costFields: [],
    tools: [],
  },
  {
    slug: "xai",
    name: "xAI",
    category: "model_provider",
    status: "beta",
    integrationVersion: "xai@2",
    routes: [viaVercel("available"), viaOpenRouter()],
    import: NO_IMPORT("xAI organization usage import is not implemented yet."),
    byok: SOON("Bringing your own xAI key is not implemented yet."),
    subscription: UNSUPPORTED,
    usageFields: ["input_tokens", "output_tokens"],
    costFields: [],
    tools: [],
  },
  {
    slug: "vercel",
    name: "Vercel AI Gateway",
    category: "gateway",
    status: "beta",
    integrationVersion: "vercel-gateway@1",
    routes: [viaVercel("live")],
    import: NO_IMPORT("Gateway usage import is not implemented yet."),
    byok: SOON("Bringing your own gateway key is not implemented yet."),
    subscription: UNSUPPORTED,
    usageFields: ANTHROPIC_USAGE_FIELDS,
    costFields: [],
    tools: [{ slug: "usage-miner", name: "USAGE Miner", method: "routed_mining", availability: "available" }],
  },
  {
    slug: "openrouter",
    name: "OpenRouter",
    category: "gateway",
    status: "beta",
    integrationVersion: "openrouter@1",
    routes: [viaOpenRouter()],
    import: NO_IMPORT("OpenRouter activity import is not implemented yet."),
    byok: SOON("Bringing your own OpenRouter key is not implemented yet."),
    subscription: UNSUPPORTED,
    usageFields: [
      "prompt_tokens",
      "completion_tokens",
      "prompt_tokens_details.cached_tokens",
      "completion_tokens_details.reasoning_tokens",
    ],
    costFields: ["cost"],
    tools: [{ slug: "usage-miner", name: "USAGE Miner", method: "routed_mining", availability: "available" }],
  },
  {
    slug: "aws_bedrock",
    name: "AWS Bedrock",
    category: "cloud_platform",
    status: "planned",
    integrationVersion: "bedrock@0",
    routes: [],
    import: NO_IMPORT("Cost and usage report import is planned."),
    byok: SOON("Bringing your own AWS credentials is planned."),
    subscription: UNSUPPORTED,
    usageFields: ["inputTokenCount", "outputTokenCount"],
    costFields: [],
    tools: [],
  },
  {
    slug: "azure_openai",
    name: "Azure OpenAI",
    category: "cloud_platform",
    status: "planned",
    integrationVersion: "azure-openai@0",
    routes: [],
    import: NO_IMPORT("Azure usage import is planned."),
    byok: SOON("Bringing your own Azure credentials is planned."),
    subscription: UNSUPPORTED,
    usageFields: OPENAI_USAGE_FIELDS,
    costFields: [],
    tools: [],
  },
];

export function listProviders(): readonly ProviderDefinition[] {
  return PROVIDERS;
}

export function findProvider(slug: string): ProviderDefinition | null {
  return PROVIDERS.find((provider) => provider.slug === slug) ?? null;
}

/** Routes a provider can actually be mined through today. */
export function usableRoutes(provider: ProviderDefinition): readonly GatewayRoute[] {
  return provider.routes.filter((route) => isUsable(route.status));
}

/** Providers that can mine right now. Derived, never a second hardcoded list. */
export function listMiningProviders(): readonly ProviderDefinition[] {
  return PROVIDERS.filter((provider) => usableRoutes(provider).length > 0);
}

/** Providers whose own usage API USAGE can import from today. */
export function listImportProviders(): readonly ProviderDefinition[] {
  return PROVIDERS.filter((provider) => isUsable(provider.import.status));
}

export function supportsMethod(provider: ProviderDefinition, method: ConnectionMethod): boolean {
  if (method === "routed_mining") return usableRoutes(provider).length > 0;
  if (method === "verified_import") return isUsable(provider.import.status);
  return provider[method].availability === "available";
}

/**
 * The gateway model slug prefix a provider's traffic arrives under, e.g.
 * `anthropic/claude-haiku-4.5`. Used to attribute an observation to a provider
 * without a second mapping table.
 */
export function providerForModel(model: string): ProviderDefinition | null {
  const family = model.includes("/") ? model.split("/")[0] : model;
  return findProvider(family);
}
