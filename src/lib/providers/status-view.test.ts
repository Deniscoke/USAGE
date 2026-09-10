import { describe, expect, it } from "vitest";
import { deriveProviderStatusView, type ProviderStatusInput } from "./status-view";

/**
 * `eligible_route` is route capability, not a reward. Every case here holds
 * the UI to the CURRENT economic policy, never to routability alone.
 */

const CAPS = { authenticated: true, models: true, streaming: true, usage: true, cacheUsage: true, reasoningUsage: true, requestIdentity: true, cost: false };

function input(over: Partial<ProviderStatusInput> = {}): ProviderStatusInput {
  return {
    provider: "openai",
    authMethod: "api_key",
    connectionStatus: "active",
    miningEligibility: "eligible_route",
    capabilities: CAPS,
    modelCount: 129,
    pricedModelCount: 12,
    accountContext: null,
    validatedAt: "2026-09-10T12:59:56Z",
    endpointTrusted: true,
    revoked: false,
    ...over,
  };
}

describe("the current OpenAI API-key connection", () => {
  it("is connected, routable, priced — and HELD, not full mining", () => {
    const v = deriveProviderStatusView(input());
    expect(v.connection).toEqual({ state: "active", label: "Connected" });
    expect(v.credential).toBe("valid");
    expect(v.models.discovered).toBe(129);
    expect(v.routing).toBe("available");
    expect(v.usageEvidence).toBe("routed_proof");
    expect(v.pricing).toBe("available");
    expect(v.funding.class).toBe("unknown");
    expect(v.economicSource).toBe("unknown");
    expect(v.mining.outcome).toBe("held");
    expect(v.mining.label).not.toMatch(/full mining|earns/i);
    expect(v.mining.reason).toMatch(/cannot yet authoritatively establish/);
  });
});

describe("eligible_route never decides the reward by itself", () => {
  it("free-tier OpenRouter: funding FREE TIER, mining held under the beta policy's promotional rule", () => {
    const v = deriveProviderStatusView(input({ provider: "openrouter", authMethod: "oauth", accountContext: { is_free_tier: true, usage_usd: 0 } }));
    expect(v.funding.class).toBe("free_tier_account");
    expect(v.funding.label).toMatch(/Free tier/);
    expect(v.economicSource).toBe("promotional");
    expect(["held", "ineligible"]).toContain(v.mining.outcome);
    expect(v.mining.outcome).not.toBe("eligible");
  });

  it("paid-capable OpenRouter: funding paid-account metered, mining ELIGIBLE by the current policy", () => {
    const v = deriveProviderStatusView(input({ provider: "openrouter", authMethod: "oauth", accountContext: { is_free_tier: false, usage_usd: 1.2 } }));
    expect(v.funding.class).toBe("paid_account");
    expect(v.economicSource).toBe("metered_paid");
    expect(v.mining.outcome).toBe("eligible");
    expect(v.mining.label).toBe("Eligible");
  });

  it("a user-controlled endpoint is byok, held, even when routable and priced", () => {
    const v = deriveProviderStatusView(input({ provider: "my-llm", endpointTrusted: false }));
    expect(v.economicSource).toBe("byok");
    expect(v.mining.outcome).toBe("held");
    expect(v.mining.reason).toMatch(/endpoint you control/);
  });

  it("pending pricing is held for that reason, whatever the funding", () => {
    const v = deriveProviderStatusView(input({ miningEligibility: "pending_pricing", pricedModelCount: 0, provider: "openrouter", authMethod: "oauth", accountContext: { is_free_tier: false } }));
    expect(v.pricing).toBe("pending");
    expect(v.mining).toMatchObject({ outcome: "held", label: "Held — pending pricing" });
  });

  it("analytics-only providers are not measurable for mining", () => {
    const v = deriveProviderStatusView(input({ miningEligibility: "analytics_only", capabilities: { ...CAPS, requestIdentity: false } }));
    expect(v.usageEvidence).toBe("analytics_only");
    expect(v.mining.outcome).toBe("unavailable");
  });

  it("an invalid credential is invalid, and nothing else is claimed", () => {
    const v = deriveProviderStatusView(input({ connectionStatus: "invalid_credentials", capabilities: { ...CAPS, authenticated: false }, miningEligibility: "unsupported", modelCount: 0, pricedModelCount: 0 }));
    expect(v.connection.label).toBe("Invalid credentials");
    expect(v.credential).toBe("rejected");
    expect(v.routing).toBe("unsupported");
    expect(v.mining.outcome).toBe("unavailable");
  });

  it("a saved-but-unverified connection says so", () => {
    const v = deriveProviderStatusView(input({ connectionStatus: "validating", capabilities: { ...CAPS, authenticated: false, usage: false, requestIdentity: false }, miningEligibility: "unsupported", modelCount: 0, pricedModelCount: 0 }));
    expect(v.connection.label).toBe("Saved — validation incomplete");
    expect(v.credential).toBe("unverified");
  });

  it("a revoked connection shows disconnected and unroutable", () => {
    const v = deriveProviderStatusView(input({ revoked: true }));
    expect(v.connection.state).toBe("revoked");
    expect(v.routing).toBe("unsupported");
  });
});
