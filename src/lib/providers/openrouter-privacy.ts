/**
 * OpenRouter privacy baseline, enforced per request by the server.
 *
 * Every inference USAGE routes to OpenRouter -- through USAGE's own key or a
 * user's connection -- carries OpenRouter's documented provider preferences
 * (https://openrouter.ai/docs/features/provider-routing):
 *
 *   provider.zdr = true               only Zero-Data-Retention endpoints
 *   provider.data_collection = "deny" only providers that do not store or
 *                                      train on request data
 *
 * Account-wide OpenRouter settings are not relied on: a normal USAGE user
 * has not configured them, and a setting outside USAGE's control is not a
 * guarantee. The fields are written into the request body itself.
 *
 * FAIL CLOSED. When no provider endpoint satisfies the preferences,
 * OpenRouter answers 404 ("no endpoints found") and the gateway returns
 * that error; nothing retries without the baseline, and nothing downgrades
 * to a provider that retains or trains on data. OpenRouter's own fallbacks
 * are chosen from the filtered set, so a fallback cannot bypass the rule.
 *
 * A client's OWN provider preferences are kept when they only narrow the
 * choice further (`only`, `ignore`, `order`, `require_parameters`,
 * `allow_fallbacks`, quantizations, sorting). A client value that would
 * WEAKEN the baseline (`zdr: false`, `data_collection: "allow"`) is
 * overwritten: the baseline is USAGE's promise, not the client's option.
 *
 * What this does and does not claim: it enforces OpenRouter's retention and
 * training restrictions on the endpoints that serve the request. OpenRouter
 * itself still receives the request in order to route it.
 */

export const OPENROUTER_PRIVACY_BASELINE = Object.freeze({
  zdr: true,
  data_collection: "deny",
} as const);

/** Client-settable preference keys that can only narrow routing further. */
const PRESERVED_PREFERENCE_KEYS: ReadonlySet<string> = new Set([
  "allow_fallbacks",
  "require_parameters",
  "order",
  "only",
  "ignore",
  "quantizations",
  "sort",
  "max_price",
]);

export interface OpenRouterPrivacyOutcome {
  body: Record<string, unknown>;
  /** Keys the client sent that were overwritten to hold the baseline. */
  overridden: string[];
}

export function applyOpenRouterPrivacy(body: Record<string, unknown>): OpenRouterPrivacyOutcome {
  const incoming = body.provider;
  const preferences: Record<string, unknown> = {};
  const overridden: string[] = [];

  if (typeof incoming === "object" && incoming !== null && !Array.isArray(incoming)) {
    for (const [key, value] of Object.entries(incoming as Record<string, unknown>)) {
      if (PRESERVED_PREFERENCE_KEYS.has(key)) preferences[key] = value;
      else if (key === "zdr" || key === "data_collection") {
        const holds = key === "zdr" ? value === true : value === "deny";
        if (!holds) overridden.push(key);
      }
      // Anything else a client put under `provider` is dropped rather than
      // forwarded: the request must not be a way to smuggle routing
      // preferences USAGE has not reviewed.
    }
  } else if (incoming !== undefined) {
    overridden.push("provider");
  }

  return {
    body: { ...body, provider: { ...preferences, ...OPENROUTER_PRIVACY_BASELINE } },
    overridden,
  };
}

/** True when a request body already carries the full baseline. */
export function hasOpenRouterPrivacy(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const provider = (body as { provider?: unknown }).provider;
  if (typeof provider !== "object" || provider === null) return false;
  const p = provider as { zdr?: unknown; data_collection?: unknown };
  return p.zdr === true && p.data_collection === "deny";
}

/** What the provider UI says. Retention and training restrictions only. */
export const OPENROUTER_PRIVACY_COPY = {
  title: "Privacy",
  lines: ["Zero Data Retention REQUIRED", "Training / data collection DENIED"],
  detail:
    "Every request USAGE routes to OpenRouter carries provider.zdr = true and provider.data_collection = \"deny\". Requests that no such endpoint can serve fail rather than fall back. OpenRouter still receives the request in order to route it.",
} as const;
