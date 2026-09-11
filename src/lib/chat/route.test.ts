import { describe, expect, it } from "vitest";
import type { MinerRouteEntry } from "@/lib/miner/routes";
import { configuredSharedGateway, pickChatRoute } from "./route";

/**
 * One rule, shared with the miner: earn if you can, be measured either way.
 */

function route(overrides: Partial<MinerRouteEntry> = {}): MinerRouteEntry {
  return {
    connectionId: "conn-1",
    label: "OpenRouter",
    protocol: "openai_compatible",
    surface: "openai_compatible",
    surfaceLabel: "OpenAI-compatible",
    url: "https://usage.example/api/gateway/provider/conn-1",
    miningEligibility: "eligible_route",
    rewardStatus: "eligible",
    miningLabel: "Mining eligible — paid account",
    providerFamily: "openrouter",
    ...overrides,
  };
}

describe("pickChatRoute", () => {
  it("takes the person's own eligible connection first, even when the shared key is free for them", () => {
    const picked = pickChatRoute({ routes: [route()], sharedGateway: "openrouter" });
    expect(picked.kind).toBe("provider");
    expect(picked.kind === "provider" && picked.rewardStatus).toBe("eligible");
  });

  it("uses the shared key when nothing of theirs can earn", () => {
    const picked = pickChatRoute({ routes: [], sharedGateway: "openrouter" });
    expect(picked).toMatchObject({ kind: "shared", gatewayId: "openrouter", rewardStatus: "held" });
    expect(picked.kind === "shared" && picked.reason).toMatch(/cannot earn/i);
  });

  it("prefers the shared key over the person's own HELD connection", () => {
    // Their key would earn nothing either; at least the shared one costs them nothing.
    const held = route({ connectionId: "openai", label: "OpenAI", providerFamily: "openai", rewardStatus: "held" });
    const picked = pickChatRoute({ routes: [held], sharedGateway: "vercel-ai-gateway" });
    expect(picked.kind).toBe("shared");
  });

  it("falls back to a HELD connection of their own when no shared key is configured", () => {
    const held = route({ rewardStatus: "held", miningLabel: "Mining held — funding unknown" });
    const picked = pickChatRoute({ routes: [held], sharedGateway: null });
    expect(picked).toMatchObject({ kind: "provider", rewardStatus: "held" });
  });

  it("ignores the Anthropic surface of the same connection", () => {
    const anthropicOnly = route({ surface: "anthropic_compatible", protocol: "anthropic_compatible" });
    expect(pickChatRoute({ routes: [anthropicOnly], sharedGateway: null }).kind).toBe("none");
  });

  it("never picks an ineligible or unavailable route", () => {
    const bad = [route({ rewardStatus: "ineligible" }), route({ connectionId: "c2", rewardStatus: "unavailable" })];
    expect(pickChatRoute({ routes: bad, sharedGateway: null }).kind).toBe("none");
  });

  it("carries the server's verdict through unchanged", () => {
    const picked = pickChatRoute({ routes: [route({ miningLabel: "verbatim reason" })], sharedGateway: null });
    expect(picked.kind === "provider" && picked.reason).toBe("verbatim reason");
  });
});

describe("configuredSharedGateway", () => {
  it("prefers OpenRouter, because it states cost per request", () => {
    expect(configuredSharedGateway({ OPENROUTER_API_KEY: "k", AI_GATEWAY_API_KEY: "k" })).toBe("openrouter");
    expect(configuredSharedGateway({ AI_GATEWAY_API_KEY: "k" })).toBe("vercel-ai-gateway");
    expect(configuredSharedGateway({ OPENROUTER_API_KEY: "  " })).toBeNull();
    expect(configuredSharedGateway({})).toBeNull();
  });
});
