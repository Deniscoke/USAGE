/**
 * The provider registry.
 *
 * USAGE is an AI compute network, not a Vercel or Anthropic client. Everything
 * the product says about a provider -- what you can connect, what earns, what is
 * merely planned -- is read from here. Nothing in the UI hardcodes a provider
 * name or a capability label.
 *
 * The honesty rule: a capability is `available` only when a code path actually
 * exists and has been exercised. Anything else is `coming_soon`, and the UI says
 * so. A registry that overstates itself is worse than no registry.
 *
 * This file is the source of truth; `npm run usage:providers:publish` mirrors it
 * into the `providers` table so the same facts are auditable from the database.
 */

export type ProviderCategory = "model_provider" | "gateway" | "cloud_platform";

/** Overall integration maturity, independent of any single method. */
export type ProviderStatus = "beta" | "experimental" | "planned";

/**
 * How compute reaches USAGE.
 *
 *   routed_mining    USAGE routes the request and observes it first-hand.
 *                    The only path that can produce ROUTED + CONFIRMED.
 *   verified_import  historical usage pulled from a provider's own admin API.
 *   byok             the user's own provider key, used by USAGE to route.
 *   subscription     the user's existing consumer subscription, forwarded.
 */
export type ConnectionMethod = "routed_mining" | "verified_import" | "byok" | "subscription";

export type MethodAvailability = "available" | "experimental" | "coming_soon" | "unsupported";

export interface ProviderMethod {
  availability: MethodAvailability;
  /** Which gateway implementation carries this, when it is routed. */
  via?: string;
  /** One plain sentence. Shown to users, so no internal vocabulary. */
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
  methods: Record<ConnectionMethod, ProviderMethod>;
  /** Usage fields this provider actually reports. Absent means unknown, not zero. */
  usageFields: readonly string[];
  /** Cost fields, if any. An empty list means cost is never authoritative here. */
  costFields: readonly string[];
  tools: readonly ProviderTool[];
}

const UNSUPPORTED: ProviderMethod = { availability: "unsupported" };
const SOON = (note: string): ProviderMethod => ({ availability: "coming_soon", note });

/**
 * Routed mining works today for any model the Vercel AI Gateway serves, because
 * USAGE's gateway speaks the Anthropic-compatible protocol and forwards to it.
 * That is one integration, shared by every model provider behind it.
 */
const ROUTED_VIA_VERCEL: ProviderMethod = {
  availability: "available",
  via: "vercel-ai-gateway",
  note: "Requests routed through USAGE are observed first-hand and earn.",
};

const ANTHROPIC_USAGE_FIELDS = [
  "input_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
  "output_tokens",
] as const;

const OPENAI_USAGE_FIELDS = ["input_tokens", "cached_tokens", "output_tokens"] as const;

export const PROVIDERS: readonly ProviderDefinition[] = [
  {
    slug: "anthropic",
    name: "Anthropic",
    category: "model_provider",
    status: "beta",
    integrationVersion: "anthropic@1",
    methods: {
      routed_mining: ROUTED_VIA_VERCEL,
      verified_import: SOON("Organization usage import is not implemented yet."),
      byok: SOON("Bringing your own Anthropic key is not implemented yet."),
      subscription: {
        availability: "coming_soon",
        via: "vercel-ai-gateway",
        note: "Forwarding a Claude subscription needs paid AI Gateway credits upstream.",
      },
    },
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
    integrationVersion: "openai@1",
    methods: {
      routed_mining: ROUTED_VIA_VERCEL,
      verified_import: SOON("Organization usage import is not implemented yet."),
      byok: SOON("Bringing your own OpenAI key is not implemented yet."),
      subscription: UNSUPPORTED,
    },
    usageFields: OPENAI_USAGE_FIELDS,
    costFields: [],
    tools: [
      { slug: "codex", name: "Codex", method: "routed_mining", availability: "coming_soon" },
      { slug: "chatgpt", name: "ChatGPT", method: "verified_import", availability: "coming_soon" },
    ],
  },
  {
    slug: "google",
    name: "Google",
    category: "model_provider",
    status: "beta",
    integrationVersion: "google@1",
    methods: {
      routed_mining: ROUTED_VIA_VERCEL,
      verified_import: SOON("Cloud usage import is not implemented yet."),
      byok: SOON("Bringing your own Google key is not implemented yet."),
      subscription: UNSUPPORTED,
    },
    usageFields: ["input_tokens", "output_tokens"],
    costFields: [],
    tools: [{ slug: "gemini-cli", name: "Gemini CLI", method: "routed_mining", availability: "coming_soon" }],
  },
  {
    slug: "mistral",
    name: "Mistral",
    category: "model_provider",
    status: "beta",
    integrationVersion: "mistral@1",
    methods: {
      routed_mining: ROUTED_VIA_VERCEL,
      verified_import: SOON("Organization usage import is not implemented yet."),
      byok: SOON("Bringing your own Mistral key is not implemented yet."),
      subscription: UNSUPPORTED,
    },
    usageFields: ["input_tokens", "output_tokens"],
    costFields: [],
    tools: [],
  },
  {
    slug: "xai",
    name: "xAI",
    category: "model_provider",
    status: "beta",
    integrationVersion: "xai@1",
    methods: {
      routed_mining: ROUTED_VIA_VERCEL,
      verified_import: SOON("Organization usage import is not implemented yet."),
      byok: SOON("Bringing your own xAI key is not implemented yet."),
      subscription: UNSUPPORTED,
    },
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
    methods: {
      routed_mining: {
        availability: "available",
        via: "vercel-ai-gateway",
        note: "The gateway USAGE routes through today.",
      },
      verified_import: SOON("Gateway usage import is not implemented yet."),
      byok: SOON("Bringing your own gateway key is not implemented yet."),
      subscription: UNSUPPORTED,
    },
    usageFields: ANTHROPIC_USAGE_FIELDS,
    // The Anthropic-compatible surface does not return an authoritative cost.
    costFields: [],
    tools: [{ slug: "usage-miner", name: "USAGE Miner", method: "routed_mining", availability: "available" }],
  },
  {
    slug: "openrouter",
    name: "OpenRouter",
    category: "gateway",
    status: "planned",
    integrationVersion: "openrouter@0",
    methods: {
      routed_mining: SOON("An OpenRouter gateway implementation is planned."),
      verified_import: SOON("Usage import is planned."),
      byok: SOON("Bringing your own OpenRouter key is planned."),
      subscription: UNSUPPORTED,
    },
    usageFields: ["input_tokens", "output_tokens"],
    costFields: ["total_cost"],
    tools: [],
  },
  {
    slug: "aws_bedrock",
    name: "AWS Bedrock",
    category: "cloud_platform",
    status: "planned",
    integrationVersion: "bedrock@0",
    methods: {
      routed_mining: SOON("A Bedrock gateway implementation is planned."),
      verified_import: SOON("Cost and usage report import is planned."),
      byok: SOON("Bringing your own AWS credentials is planned."),
      subscription: UNSUPPORTED,
    },
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
    methods: {
      routed_mining: SOON("An Azure gateway implementation is planned."),
      verified_import: SOON("Usage import is planned."),
      byok: SOON("Bringing your own Azure credentials is planned."),
      subscription: UNSUPPORTED,
    },
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

/** Providers that can mine right now. Derived, never a second hardcoded list. */
export function listMiningProviders(): readonly ProviderDefinition[] {
  return PROVIDERS.filter((provider) => provider.methods.routed_mining.availability === "available");
}

export function supportsMethod(provider: ProviderDefinition, method: ConnectionMethod): boolean {
  return provider.methods[method].availability === "available";
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
