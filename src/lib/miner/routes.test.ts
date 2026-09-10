import { describe, expect, it } from "vitest";
import { buildMinerRoutes, preferredRoute } from "./routes";
import { wireSurfacesFor, surfaceRoutePath } from "@/lib/providers/surfaces";
import type { ConnectionSummaryView } from "@/lib/providers/connections";
import { UNKNOWN_CAPABILITIES } from "@/lib/protocols/protocol";

/**
 * M16C0 §17: the OpenRouter OAuth connection advertises both wire surfaces as
 * ONE connection; Claude Code receives it Anthropic-compatible, Codex
 * OpenAI-compatible; selection prefers reward over route capability.
 */

const ORIGIN = "https://usage.example";

function connection(overrides: Partial<ConnectionSummaryView> & { id: string; provider: string }): ConnectionSummaryView {
  const eligible = overrides.provider === "openrouter";
  return {
    displayName: overrides.provider === "openrouter" ? "OpenRouter" : "OpenAI",
    definitionId: "def-1",
    protocol: "openai_compatible",
    baseUrlHost: "openrouter.ai",
    status: "active",
    miningEligibility: "eligible_route",
    capabilities: { ...UNKNOWN_CAPABILITIES, authenticated: true, usage: true, requestIdentity: true },
    origin: "official",
    authMethod: overrides.provider === "openrouter" ? "oauth" : "api_key",
    modelCount: 5,
    pricedModelCount: 5,
    validatedAt: "2026-09-10T00:00:00.000Z",
    lastSuccessAt: null,
    lastErrorCode: null,
    revokedAt: null,
    providerFamily: overrides.provider,
    view: {
      mining: eligible
        ? { outcome: "eligible", label: "Eligible", reason: "Paid OpenRouter account." }
        : { outcome: "held", label: "Held", reason: "Funding unknown for an API-key connection." },
    } as ConnectionSummaryView["view"],
    ...overrides,
  };
}

describe("wire surfaces", () => {
  it("OpenRouter advertises both surfaces; an ordinary provider only the one it was validated on", () => {
    expect(wireSurfacesFor({ provider: "openrouter", providerFamily: "openrouter", protocol: "openai_compatible" })).toEqual(["openai_compatible", "anthropic_compatible"]);
    expect(wireSurfacesFor({ provider: "openai", providerFamily: "openai", protocol: "openai_compatible" })).toEqual(["openai_compatible"]);
    expect(wireSurfacesFor({ provider: "my-proxy", providerFamily: null, protocol: "anthropic_compatible" })).toEqual(["anthropic_compatible"]);
    expect(wireSurfacesFor({ provider: "openrouter", providerFamily: "openrouter", protocol: null })).toEqual([]);
  });

  it("the extra surface has its own path; the stored protocol keeps the universal route", () => {
    expect(surfaceRoutePath("c1", "openai_compatible", "openai_compatible")).toBe("/api/gateway/provider/c1");
    expect(surfaceRoutePath("c1", "anthropic_compatible", "openai_compatible")).toBe("/api/gateway/provider/c1/anthropic");
    expect(surfaceRoutePath("c2", "anthropic_compatible", "anthropic_compatible")).toBe("/api/gateway/provider/c2");
  });
});

describe("miner routes", () => {
  const openrouter = connection({ id: "or-1", provider: "openrouter" });
  const openai = connection({ id: "oa-1", provider: "openai", displayName: "OpenAI", baseUrlHost: "api.openai.com" });

  it("one OpenRouter connection becomes two routes with the same id, label, reward and no credential", () => {
    const routes = buildMinerRoutes([openrouter], ORIGIN);
    expect(routes).toHaveLength(2);
    expect(routes.map((r) => r.surface)).toEqual(["openai_compatible", "anthropic_compatible"]);
    for (const route of routes) {
      expect(route.connectionId).toBe("or-1");
      expect(route.label).toBe("OpenRouter");
      expect(route.rewardStatus).toBe("eligible");
      expect(route.providerFamily).toBe("openrouter");
      expect(JSON.stringify(route)).not.toMatch(/sk-|usgm_|secret|credential/i);
    }
    expect(routes[1].url).toBe(`${ORIGIN}/api/gateway/provider/or-1/anthropic`);
  });

  it("Claude Code receives OpenRouter Anthropic-compatible; Codex receives the same connection OpenAI-compatible", () => {
    const routes = buildMinerRoutes([openrouter, openai], ORIGIN);
    const claude = routes.filter((r) => r.protocol === "anthropic_compatible");
    const codex = routes.filter((r) => r.protocol === "openai_compatible");
    expect(claude.map((r) => r.connectionId)).toEqual(["or-1"]);
    expect(codex.map((r) => r.connectionId)).toEqual(["or-1", "oa-1"]);
  });

  it("skips revoked and unusable connections", () => {
    expect(buildMinerRoutes([connection({ id: "r", provider: "openrouter", revokedAt: "2026-09-01T00:00:00.000Z" })], ORIGIN)).toEqual([]);
    expect(buildMinerRoutes([connection({ id: "e", provider: "openrouter", status: "error" })], ORIGIN)).toEqual([]);
  });
});

describe("route selection prefers reward, never route capability alone", () => {
  it("OpenAI held + OpenRouter eligible → OpenRouter, whatever the order", () => {
    const openai = { label: "OpenAI", rewardStatus: "held" as const, miningEligibility: "eligible_route" };
    const openrouter = { label: "OpenRouter", rewardStatus: "eligible" as const, miningEligibility: "eligible_route" };
    expect(preferredRoute([openai, openrouter])?.label).toBe("OpenRouter");
    expect(preferredRoute([openrouter, openai])?.label).toBe("OpenRouter");
  });

  it("falls back to a held route only when nothing is eligible, and never to an ineligible one", () => {
    expect(preferredRoute([{ rewardStatus: "held" as const }, { rewardStatus: "ineligible" as const }])?.rewardStatus).toBe("held");
    expect(preferredRoute([{ rewardStatus: "ineligible" as const }, { rewardStatus: "unavailable" as const }])).toBeNull();
    expect(preferredRoute([])).toBeNull();
  });
});
