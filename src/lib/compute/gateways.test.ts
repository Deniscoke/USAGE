import { afterEach, describe, expect, it, vi } from "vitest";
import { openRouterComputeGateway } from "./openrouter-gateway";
import { vercelComputeGateway } from "./vercel-gateway";
import {
  getComputeGateway,
  listComputeGateways,
  routingPolicyFor,
  selectGateway,
} from "./registry";
import { normalizeGatewayObservation } from "@/lib/providers/vercel-gateway/adapter";
import { generateSigningKeyPair } from "@/lib/domain/signing";
import { verifyUsageReceipt } from "@/lib/domain/receipt";
import type { ComputeGateway } from "./gateway";

/**
 * Two gateways, one contract.
 *
 * The milestone's central claim is that USAGE is not tied to one gateway, so
 * the contract tests run against every registered implementation rather than
 * against a favourite one. A third gateway will be held to the same bar simply
 * by existing.
 */

const KEY = generateSigningKeyPair("gateway-test-key");
const ISSUER = "usage://issuer/production";

function request(body: unknown, headers: Record<string, string> = {}) {
  return {
    path: ["v1", "chat", "completions"],
    headers: new Headers(headers),
    body,
    rawBody: JSON.stringify(body),
    attribution: { user: "00000000-0000-4000-8000-000000000001", tags: ["usage", "miner"] },
  };
}

describe.each(listComputeGateways().map((gateway) => [gateway.id, gateway] as const))(
  "ComputeGateway contract: %s",
  (_id, gateway: ComputeGateway) => {
    it("declares an id and a provider the registry knows", () => {
      expect(gateway.id).toBeTruthy();
      expect(getComputeGateway(gateway.id)).toBe(gateway);
      expect(gateway.providerSlug).toBeTruthy();
    });

    it("never forwards a client-supplied credential upstream", () => {
      const call = gateway.buildUpstreamCall(
        request(
          { model: "m", messages: [] },
          {
            authorization: "Bearer usgm_client_token",
            "x-api-key": "sk-client-key",
            "x-usage-miner-token": "usgm_miner",
          },
        ),
        "sk-server-secret",
      );

      const serialized = JSON.stringify([...call.headers]);
      expect(serialized).not.toContain("usgm_client_token");
      expect(serialized).not.toContain("sk-client-key");
      expect(serialized).not.toContain("usgm_miner");
    });

    it("keeps the upstream credential out of the response a client sees", () => {
      const headers = gateway.sanitizeResponseHeaders(
        new Headers({
          authorization: "Bearer sk-server-secret",
          "set-cookie": "session=abc",
          "content-type": "application/json",
        }),
      );
      expect(JSON.stringify([...headers])).not.toContain("sk-server-secret");
      expect(headers.get("set-cookie")).toBeNull();
      expect(headers.get("content-type")).toBe("application/json");
    });

    it("reads streaming intent from the body", () => {
      expect(gateway.isStreaming({ stream: true })).toBe(true);
      expect(gateway.isStreaming({ stream: false })).toBe(false);
      expect(gateway.isStreaming(null)).toBe(false);
    });

    it("refuses to build an observation from a response with no evidence", () => {
      const observed = gateway.observe({ nonsense: true }, new Headers());
      expect(
        gateway.toObservation({
          observed,
          requestedModel: "anthropic/claude-haiku-4.5",
          environment: "live",
          clientType: "test",
          occurredAt: new Date(),
          latencyMs: 1,
        }),
      ).toBeNull();
    });

    it("stamps its own identity on every observation it produces", () => {
      // Which gateway executed a request is evidence, and only the gateway
      // itself can say it.
      const payload =
        gateway.id === "openrouter"
          ? {
              id: "gen_contract",
              model: "anthropic/claude-haiku-4.5",
              usage: { prompt_tokens: 10, completion_tokens: 5 },
            }
          : {
              id: "msg_contract",
              model: "anthropic/claude-haiku-4.5",
              usage: { input_tokens: 10, output_tokens: 5 },
            };

      const observation = gateway.toObservation({
        observed: gateway.observe(payload, new Headers()),
        requestedModel: null,
        environment: "live",
        clientType: "test",
        occurredAt: new Date("2026-09-08T10:00:00.000Z"),
        latencyMs: 4,
      });

      expect(observation?.gatewayId).toBe(gateway.id);
    });
  },
);

describe("OpenRouter normalization", () => {
  const completion = {
    id: "gen-01JQ",
    model: "anthropic/claude-haiku-4.5",
    provider: "Anthropic",
    choices: [{ finish_reason: "stop" }],
    usage: {
      prompt_tokens: 1_200,
      completion_tokens: 300,
      total_tokens: 1_500,
      cost: 0.00042,
      prompt_tokens_details: { cached_tokens: 200, cache_write_tokens: 40 },
      completion_tokens_details: { reasoning_tokens: 60 },
    },
  };

  it("reads identity, provider and every token class", () => {
    const observed = openRouterComputeGateway.observe(completion, new Headers());

    expect(observed.identity.generationId).toBe("gen-01JQ");
    expect(observed.identity.provider).toBe("Anthropic");
    expect(observed.usage.inputTokens).toBe(1_200);
    expect(observed.usage.outputTokens).toBe(300);
    // prompt_tokens is inclusive of cached reads, so the fresh remainder is
    // recorded explicitly rather than left for a later guess.
    expect(observed.usage.inputTokenDetails).toEqual({
      noCacheTokens: 1_000,
      cacheReadTokens: 200,
      cacheWriteTokens: 40,
    });
    expect(observed.usage.outputTokenDetails?.reasoningTokens).toBe(60);
    expect(observed.finishReason).toBe("stop");
  });

  it("keeps the reported cost exact, not float-rounded", () => {
    const observation = openRouterComputeGateway.toObservation({
      observed: openRouterComputeGateway.observe(completion, new Headers()),
      requestedModel: null,
      environment: "live",
      clientType: "test",
      occurredAt: new Date("2026-09-08T10:00:00.000Z"),
      latencyMs: 12,
    })!;

    const normalized = normalizeGatewayObservation(observation, { userId: "u1" });
    // $0.00042 is exactly 420 micro-USD. A float path would drift here.
    expect(normalized.record.actualCostMicros).toBe(420);
    expect(normalized.record.actualCostBasis).toBe("gateway_reported");
  });

  it("treats an absent cost as unknown and a zero cost as measured", () => {
    const noCost = openRouterComputeGateway.observe(
      { ...completion, usage: { prompt_tokens: 10, completion_tokens: 5 } },
      new Headers(),
    );
    expect(noCost.cost).toBeNull();

    const freeModel = openRouterComputeGateway.observe(
      { ...completion, usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0 } },
      new Headers(),
    );
    expect(freeModel.cost).not.toBeNull();
    expect(Number(freeModel.cost!.value)).toBe(0);
  });

  it("accumulates a streamed response without touching its content", () => {
    const observer = openRouterComputeGateway.observeStream(new Headers());
    observer.push(
      `data: ${JSON.stringify({ id: "gen-stream", model: "openai/gpt-5.4", choices: [{ delta: { content: "secret answer text" } }] })}\n\n`,
    );
    observer.push(
      `data: ${JSON.stringify({ id: "gen-stream", usage: { prompt_tokens: 40, completion_tokens: 9, cost: 0.000001 } })}\n\n`,
    );
    observer.push("data: [DONE]\n\n");

    const observed = observer.result();
    expect(observed.identity.generationId).toBe("gen-stream");
    expect(observed.usage.inputTokens).toBe(40);
    expect(observed.usage.outputTokens).toBe(9);
    expect(JSON.stringify(observed)).not.toContain("secret answer text");
  });

  it("survives a malformed frame rather than failing the passthrough", () => {
    const observer = openRouterComputeGateway.observeStream(new Headers());
    observer.push("data: {not json\n\n");
    observer.push(
      `data: ${JSON.stringify({ id: "gen-ok", usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`,
    );
    expect(observer.result().identity.generationId).toBe("gen-ok");
  });

  it("produces a signed, verifiable proof through the shared pipeline", () => {
    const observation = openRouterComputeGateway.toObservation({
      observed: openRouterComputeGateway.observe(completion, new Headers()),
      requestedModel: null,
      environment: "live",
      clientType: "openrouter-miner",
      occurredAt: new Date("2026-09-08T10:00:00.000Z"),
      latencyMs: 12,
    })!;

    // The same normalizer, the same receipt, the same key. No OpenRouter path.
    const normalized = normalizeGatewayObservation(observation, {
      userId: "00000000-0000-4000-8000-000000000001",
      minerCredentialId: "cred-1",
      issuance: { issuer: ISSUER, keyId: KEY.keyId, privateKeyBase64: KEY.privateKeyBase64 },
    });

    expect(normalized.record.verificationType).toBe("routed");
    expect(normalized.receipt.proofStatus).toBe("confirmed");
    expect(normalized.receipt.gatewayId).toBe("openrouter");
    expect(normalized.signed).not.toBeNull();

    const result = verifyUsageReceipt(normalized.signed!, {
      publicKeys: { [KEY.keyId]: KEY.publicKeyBase64 },
      expectedIssuer: ISSUER,
    });
    expect(result.valid).toBe(true);
  });

  it("gives the same generation the same identity, so a replay dedupes", () => {
    const build = () =>
      normalizeGatewayObservation(
        openRouterComputeGateway.toObservation({
          observed: openRouterComputeGateway.observe(completion, new Headers()),
          requestedModel: null,
          environment: "live",
          clientType: "openrouter-miner",
          occurredAt: new Date("2026-09-08T10:00:00.000Z"),
          latencyMs: 12,
        })!,
        { userId: "u1" },
      ).record.externalReference;

    expect(build()).toBe(build());
  });

  it("mines identically to the Vercel route for identical compute", () => {
    // The economic pipeline must not care which gateway ran the request.
    const usage = { inputTokens: 1_000, cachedReadTokens: 200, outputTokens: 300 };

    const viaOpenRouter = normalizeGatewayObservation(
      {
        environment: "live",
        generationId: "gen_or",
        model: "anthropic/claude-haiku-4.5",
        gatewayId: "openrouter",
        occurredAt: "2026-09-08T10:00:00.000Z",
        usage: {
          inputTokens: 1_200,
          outputTokens: usage.outputTokens,
          inputTokenDetails: { noCacheTokens: usage.inputTokens, cacheReadTokens: usage.cachedReadTokens },
        },
        // OpenRouter reports a cost; Vercel does not. It must change nothing.
        cost: { value: "0.00042", currency: "USD" },
      },
      { userId: "u1" },
    );

    const viaVercel = normalizeGatewayObservation(
      {
        environment: "live",
        generationId: "gen_vercel",
        model: "anthropic/claude-haiku-4.5",
        gatewayId: "vercel-ai-gateway",
        occurredAt: "2026-09-08T10:00:00.000Z",
        usage: {
          inputTokens: 1_200,
          outputTokens: usage.outputTokens,
          inputTokenDetails: { noCacheTokens: usage.inputTokens, cacheReadTokens: usage.cachedReadTokens },
        },
        cost: null,
      },
      { userId: "u1" },
    );

    expect(viaOpenRouter.record.protocolComputeMicros).toBe(
      viaVercel.record.protocolComputeMicros,
    );
    expect(viaOpenRouter.record.protocolPricingVersion).toBe(
      viaVercel.record.protocolPricingVersion,
    );
  });
});

describe("routing policy", () => {
  const OLD_ENV = { ...process.env };
  afterEach(() => {
    process.env = { ...OLD_ENV };
    vi.unstubAllEnvs();
  });

  it("prefers the first declared route and keeps the rest as fallback", () => {
    const policy = routingPolicyFor("anthropic")!;
    expect(policy.preferred).toBe("vercel-ai-gateway");
    expect(policy.fallback).toEqual(["openrouter"]);
  });

  it("has no policy for a provider with no routes", () => {
    expect(routingPolicyFor("aws_bedrock")).toBeNull();
    expect(routingPolicyFor("nope")).toBeNull();
  });

  it("selects the preferred gateway when it is configured", () => {
    process.env.AI_GATEWAY_API_KEY = "sk-vercel";
    process.env.OPENROUTER_API_KEY = "sk-openrouter";

    const selection = selectGateway("anthropic");
    expect(selection.ok && selection.gateway.id).toBe("vercel-ai-gateway");
    expect(selection.ok && selection.reason).toBe("preferred");
  });

  it("falls back only on a configuration fact, never mid-request", () => {
    // Missing credential is known before anything is sent. Switching gateways
    // after a failure would change which account paid and which upstream terms
    // applied, so it is deliberately not done.
    delete process.env.AI_GATEWAY_API_KEY;
    process.env.OPENROUTER_API_KEY = "sk-openrouter";

    const selection = selectGateway("anthropic");
    expect(selection.ok && selection.gateway.id).toBe("openrouter");
    expect(selection.ok && selection.reason).toBe("fallback");
  });

  it("reports rather than guesses when nothing is configured", () => {
    delete process.env.AI_GATEWAY_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    expect(selectGateway("anthropic")).toEqual({ ok: false, reason: "not_configured" });
    expect(selectGateway("unknown")).toEqual({ ok: false, reason: "unknown_provider" });
  });

  it("registers both real gateways", () => {
    expect(listComputeGateways().map((gateway) => gateway.id).sort()).toEqual([
      "openrouter",
      "vercel-ai-gateway",
    ]);
    expect(vercelComputeGateway.id).toBe("vercel-ai-gateway");
  });
});
