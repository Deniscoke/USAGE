import { describe, expect, it } from "vitest";
import { applyOpenRouterPrivacy, hasOpenRouterPrivacy, OPENROUTER_PRIVACY_BASELINE } from "./openrouter-privacy";
import { openRouterComputeGateway } from "@/lib/compute/openrouter-gateway";
import { vercelComputeGateway } from "@/lib/compute/vercel-gateway";
import { protocolGateway } from "@/lib/compute/protocol-gateway";
import { openAiCompatibleProtocol } from "@/lib/protocols/openai-compatible";
import { anthropicCompatibleProtocol } from "@/lib/protocols/anthropic-compatible";
import type { GatewayRequest } from "@/lib/compute/gateway";

/**
 * Every inference USAGE routes to OpenRouter carries provider.zdr = true and
 * provider.data_collection = "deny", whatever the client sent, through
 * whichever path it took. Nothing here contacts OpenRouter.
 */

const CREDENTIAL = "sk-or-v1-SERVER-SIDE-ONLY";

function request(body: unknown, headers: Record<string, string> = {}): GatewayRequest {
  return {
    path: ["v1", "chat", "completions"],
    headers: new Headers(headers),
    body,
    rawBody: JSON.stringify(body),
    attribution: { user: "user-1", tags: [] },
  };
}

describe("the baseline itself", () => {
  it("adds zdr and data_collection to a plain request", () => {
    const { body, overridden } = applyOpenRouterPrivacy({ model: "openai/gpt-5.4-mini", messages: [] });
    expect(body.provider).toEqual({ zdr: true, data_collection: "deny" });
    expect(overridden).toEqual([]);
    expect(hasOpenRouterPrivacy(body)).toBe(true);
  });

  it("overwrites a client's weaker preference and says so", () => {
    const { body, overridden } = applyOpenRouterPrivacy({ provider: { zdr: false, data_collection: "allow" } });
    expect(body.provider).toEqual(OPENROUTER_PRIVACY_BASELINE);
    expect(overridden.sort()).toEqual(["data_collection", "zdr"]);
  });

  it("keeps a client's stronger restrictions and drops unknown provider keys", () => {
    const { body } = applyOpenRouterPrivacy({
      provider: { only: ["anthropic"], ignore: ["x"], order: ["anthropic"], require_parameters: true, allow_fallbacks: false, smuggled: "value" },
    });
    expect(body.provider).toEqual({ only: ["anthropic"], ignore: ["x"], order: ["anthropic"], require_parameters: true, allow_fallbacks: false, zdr: true, data_collection: "deny" });
  });

  it("a fallback cannot bypass the rule: fallbacks are allowed only within the ZDR/deny set", () => {
    const { body } = applyOpenRouterPrivacy({ provider: { allow_fallbacks: true } });
    expect(hasOpenRouterPrivacy(body)).toBe(true);
    expect((body.provider as { allow_fallbacks: boolean }).allow_fallbacks).toBe(true);
  });

  it("replaces a non-object provider field rather than forwarding it", () => {
    const { body, overridden } = applyOpenRouterPrivacy({ provider: "anthropic" });
    expect(body.provider).toEqual(OPENROUTER_PRIVACY_BASELINE);
    expect(overridden).toEqual(["provider"]);
  });
});

describe("USAGE's own OpenRouter gateway", () => {
  it("sends the baseline on every inference, and keeps the key in the header only", () => {
    const call = openRouterComputeGateway.buildUpstreamCall(request({ model: "m", messages: [], provider: { zdr: false } }), CREDENTIAL);
    const body = JSON.parse(call.body) as Record<string, unknown>;
    expect(body.provider).toEqual({ zdr: true, data_collection: "deny" });
    expect(body.user).toBe("user-1");
    expect(call.body).not.toContain(CREDENTIAL);
    expect(call.headers.get("authorization")).toBe(`Bearer ${CREDENTIAL}`);
  });

  it("does not let a non-JSON body slip through without the baseline", () => {
    const raw: GatewayRequest = { ...request(null), rawBody: '{"model":"m","messages":[]}' };
    const call = openRouterComputeGateway.buildUpstreamCall(raw, CREDENTIAL);
    expect(hasOpenRouterPrivacy(JSON.parse(call.body))).toBe(true);
  });
});

describe("a user's OpenRouter connection", () => {
  const gateway = protocolGateway({
    protocol: openAiCompatibleProtocol,
    connectionId: "11111111-1111-4111-8111-111111111111",
    baseUrl: "https://openrouter.ai/api",
    providerSlug: "openrouter",
    providerFamily: "openrouter",
    endpointTrusted: true,
  });

  it("carries the baseline through the OpenAI-compatible protocol", () => {
    const call = gateway.buildUpstreamCall(request({ model: "m", messages: [], provider: { data_collection: "allow", only: ["openai"] } }), CREDENTIAL);
    const body = JSON.parse(call.body) as Record<string, unknown>;
    expect(body.provider).toEqual({ only: ["openai"], zdr: true, data_collection: "deny" });
    expect(call.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(call.body).not.toContain(CREDENTIAL);
  });
});

describe("non-OpenRouter providers are untouched", () => {
  it("Vercel AI Gateway gets no provider preferences from USAGE", () => {
    const call = vercelComputeGateway.buildUpstreamCall(request({ model: "m", messages: [] }), CREDENTIAL);
    expect((JSON.parse(call.body) as Record<string, unknown>).provider).toBeUndefined();
  });

  it("an OpenAI connection and an Anthropic connection send the body as-is plus attribution", () => {
    const openai = protocolGateway({ protocol: openAiCompatibleProtocol, connectionId: "2", baseUrl: "https://api.openai.com", providerSlug: "openai", providerFamily: "openai" });
    expect((JSON.parse(openai.buildUpstreamCall(request({ model: "m" }), CREDENTIAL).body) as Record<string, unknown>).provider).toBeUndefined();
    const anthropic = protocolGateway({ protocol: anthropicCompatibleProtocol, connectionId: "3", baseUrl: "https://api.anthropic.com", providerSlug: "anthropic", providerFamily: "anthropic" });
    expect((JSON.parse(anthropic.buildUpstreamCall(request({ model: "m" }), CREDENTIAL).body) as Record<string, unknown>).provider).toBeUndefined();
  });
});
