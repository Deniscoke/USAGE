import { describe, expect, it } from "vitest";
import { openAiCompatibleProtocol } from "./openai-compatible";
import { anthropicCompatibleProtocol } from "./anthropic-compatible";
import { getProtocol, listRoutableProtocols } from "./registry";
import {
  deriveMiningEligibility,
  UNKNOWN_CAPABILITIES,
  type ProtocolCapabilities,
} from "./protocol";
import { protocolGateway } from "@/lib/compute/protocol-gateway";
import { normalizeGatewayObservation } from "@/lib/providers/vercel-gateway/adapter";
import { generateSigningKeyPair } from "@/lib/domain/signing";
import { verifyUsageReceipt } from "@/lib/domain/receipt";

/**
 * Protocol adapters, against fake provider servers.
 *
 * No external calls: every provider here is a local function returning the
 * shapes real providers return, including the ones that return *less* than
 * they should. Handling a half-compatible provider correctly is the point --
 * "OpenAI compatible" is a spectrum, not a guarantee.
 */

const PUBLIC_DNS = async () => ["93.184.216.34"];
const BASE = "https://api.fake-provider.com";

/** A fake provider server. Routes by path, exactly like a real one. */
function fakeProvider(routes: Record<string, () => Response>): typeof fetch {
  return (async (url: string) => {
    const path = new URL(url).pathname;
    const handler = routes[path];
    if (!handler) return new Response("{}", { status: 404 });
    return handler();
  }) as unknown as typeof fetch;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("protocol registry", () => {
  it("routes exactly the two protocols that are implemented", () => {
    expect(listRoutableProtocols().map((protocol) => protocol.id).sort()).toEqual([
      "anthropic_compatible",
      "openai_compatible",
    ]);
  });

  it("refuses to hand back a protocol it cannot route", () => {
    // Declared in the vocabulary, deliberately not routable.
    expect(getProtocol("usage_import")).toBeNull();
    expect(getProtocol("custom_unsupported")).toBeNull();
    expect(getProtocol("definitely_not_a_protocol")).toBeNull();
  });

  it("accepts a base URL with or without a version suffix", () => {
    for (const protocol of listRoutableProtocols()) {
      expect(protocol.normalizeBaseUrl("https://api.example.com/v1/")).toBe(
        "https://api.example.com",
      );
      expect(protocol.normalizeBaseUrl("https://api.example.com")).toBe("https://api.example.com");
    }
  });
});

describe("OpenAI-compatible probe", () => {
  const probe = (fetchImpl: typeof fetch, credential = "sk-test") =>
    openAiCompatibleProtocol.probe({ baseUrl: BASE, credential, fetchImpl, resolve: PUBLIC_DNS });

  it("authenticates and discovers models without generating anything", async () => {
    let inferenceCalls = 0;
    const provider = fakeProvider({
      "/v1/models": () => json({ data: [{ id: "deepseek-chat" }, { id: "deepseek-reasoner" }] }),
      "/v1/chat/completions": () => {
        inferenceCalls += 1;
        return json({});
      },
    });

    const result = await probe(provider);

    expect(result.ok).toBe(true);
    expect(result.capabilities.authenticated).toBe(true);
    expect(result.models.map((model) => model.upstreamModelId)).toEqual([
      "deepseek-chat",
      "deepseek-reasoner",
    ]);
    // Testing a connection must never cost the user provider credit.
    expect(inferenceCalls).toBe(0);
  });

  it("reports a rejected credential as exactly that", async () => {
    const result = await probe(fakeProvider({ "/v1/models": () => json({}, 401) }));
    expect(result.ok).toBe(false);
    expect(result.failure).toBe("invalid_credentials");
  });

  it("distinguishes a missing endpoint from a bad key", async () => {
    const result = await probe(fakeProvider({}));
    expect(result.failure).toBe("unsupported");
  });

  it("refuses a response that is not a model list", async () => {
    const result = await probe(
      fakeProvider({ "/v1/models": () => new Response("<html>hi</html>", { status: 200 }) }),
    );
    expect(result.ok).toBe(false);
    expect(result.failure).toBe("malformed");
  });

  it("never echoes the credential in a message", async () => {
    const result = await probe(fakeProvider({ "/v1/models": () => json({}, 401) }), "sk-super-secret");
    expect(JSON.stringify(result)).not.toContain("sk-super-secret");
  });
});

describe("OpenAI-compatible observation", () => {
  it("reads every token class a provider reports", () => {
    const observed = openAiCompatibleProtocol.observe(
      {
        id: "chatcmpl-123",
        model: "deepseek-chat",
        usage: {
          prompt_tokens: 1_000,
          completion_tokens: 200,
          prompt_tokens_details: { cached_tokens: 300 },
          completion_tokens_details: { reasoning_tokens: 50 },
        },
      },
      new Headers(),
    );

    expect(observed.identity.generationId).toBe("chatcmpl-123");
    expect(observed.usage.inputTokens).toBe(1_000);
    expect(observed.usage.inputTokenDetails?.noCacheTokens).toBe(700);
    expect(observed.usage.inputTokenDetails?.cacheReadTokens).toBe(300);
    expect(observed.usage.outputTokenDetails?.reasoningTokens).toBe(50);
  });

  it("leaves what a provider did not report unknown, not zero", () => {
    const observed = openAiCompatibleProtocol.observe(
      { id: "chatcmpl-1", model: "m", usage: { prompt_tokens: 10, completion_tokens: 2 } },
      new Headers(),
    );
    // A minimal provider reported no cache detail. It did not report zeros.
    expect(observed.usage.inputTokenDetails).toBeUndefined();
    expect(observed.cost).toBeNull();
  });

  it("handles a provider that reports no usage at all", () => {
    const observed = openAiCompatibleProtocol.observe(
      { id: "chatcmpl-1", model: "m", choices: [{ finish_reason: "stop" }] },
      new Headers(),
    );
    expect(observed.hasUsage).toBe(false);
  });

  it("reads content out of a stream without ever touching the content", () => {
    const observer = openAiCompatibleProtocol.observeStream(new Headers());
    observer.push(
      `data: ${JSON.stringify({ id: "chatcmpl-s", model: "m", choices: [{ delta: { content: "secret answer" } }] })}\n\n`,
    );
    observer.push(
      `data: ${JSON.stringify({ id: "chatcmpl-s", usage: { prompt_tokens: 5, completion_tokens: 3 } })}\n\n`,
    );
    observer.push("data: [DONE]\n\n");

    const observed = observer.result();
    expect(observed.usage.outputTokens).toBe(3);
    expect(JSON.stringify(observed)).not.toContain("secret answer");
  });
});

describe("Anthropic-compatible protocol", () => {
  it("connects even when the endpoint lists no models", async () => {
    // Many Anthropic-compatible servers do not implement /v1/models. That is a
    // connection with unproven model discovery, not a failed connection.
    const result = await anthropicCompatibleProtocol.probe({
      baseUrl: BASE,
      credential: "sk-ant-test",
      fetchImpl: fakeProvider({}),
      resolve: PUBLIC_DNS,
    });

    expect(result.ok).toBe(true);
    expect(result.capabilities.authenticated).toBe(true);
    expect(result.capabilities.models).toBe(false);
    expect(result.message).toContain("manually");
  });

  it("reports a rejected credential", async () => {
    const result = await anthropicCompatibleProtocol.probe({
      baseUrl: BASE,
      credential: "bad",
      fetchImpl: fakeProvider({ "/v1/models": () => json({}, 401) }),
      resolve: PUBLIC_DNS,
    });
    expect(result.failure).toBe("invalid_credentials");
  });

  it("authenticates with x-api-key, not a bearer token", () => {
    const call = anthropicCompatibleProtocol.buildUpstreamCall({
      baseUrl: BASE,
      credential: "sk-ant-secret",
      path: ["messages"],
      headers: new Headers({ authorization: "Bearer usgm_client" }),
      body: { model: "m" },
      rawBody: '{"model":"m"}',
      attributionUser: "user-1",
    });

    expect(call.headers.get("x-api-key")).toBe("sk-ant-secret");
    // A client-supplied credential never reaches upstream.
    expect(call.headers.get("authorization")).toBeNull();
    expect(call.headers.get("anthropic-version")).toBeTruthy();
    expect(call.url).toBe(`${BASE}/v1/messages`);
  });

  it("accepts a path that already carries the API version", () => {
    const call = anthropicCompatibleProtocol.buildUpstreamCall({
      baseUrl: BASE,
      credential: "sk-ant-secret",
      path: ["v1", "messages"],
      headers: new Headers(),
      body: { model: "m" },
      rawBody: '{"model":"m"}',
      attributionUser: "user-1",
    });
    expect(call.url).toBe(`${BASE}/v1/messages`);
  });

  it("reads Anthropic usage with the same code the production path uses", () => {
    const observed = anthropicCompatibleProtocol.observe(
      {
        id: "msg_01",
        model: "claude-haiku-4.5",
        usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 900 },
      },
      new Headers(),
    );
    expect(observed.identity.generationId).toBe("msg_01");
    expect(observed.usage.inputTokens).toBe(1_000);
  });
});

describe("mining eligibility", () => {
  const capable: ProtocolCapabilities = {
    ...UNKNOWN_CAPABILITIES,
    authenticated: true,
    usage: true,
    requestIdentity: true,
  };

  it("earns only with usage, identity and an approved price", () => {
    expect(
      deriveMiningEligibility({ routable: true, capabilities: capable, hasPricedModel: true }),
    ).toBe("eligible_route");
  });

  it("proves the compute but withholds reward when nothing prices the model", () => {
    // A custom provider must not be able to mine by declaring its own prices.
    expect(
      deriveMiningEligibility({ routable: true, capabilities: capable, hasPricedModel: false }),
    ).toBe("pending_pricing");
  });

  it("falls back to analytics when there is no usage to measure", () => {
    expect(
      deriveMiningEligibility({
        routable: true,
        capabilities: { ...capable, usage: false },
        hasPricedModel: true,
      }),
    ).toBe("analytics_only");
  });

  it("falls back to analytics when requests have no identity", () => {
    // Without a stable id there is no way to stop the same request being
    // rewarded twice, and a synthetic id would hide duplicates rather than
    // prevent them.
    expect(
      deriveMiningEligibility({
        routable: true,
        capabilities: { ...capable, requestIdentity: false },
        hasPricedModel: true,
      }),
    ).toBe("analytics_only");
  });

  it("is unsupported when the connection never authenticated or cannot be routed", () => {
    expect(
      deriveMiningEligibility({ routable: false, capabilities: capable, hasPricedModel: true }),
    ).toBe("unsupported");
    expect(
      deriveMiningEligibility({
        routable: true,
        capabilities: { ...UNKNOWN_CAPABILITIES },
        hasPricedModel: true,
      }),
    ).toBe("unsupported");
  });
});

describe("a connection behaves like any other gateway", () => {
  const KEY = generateSigningKeyPair("connection-key");
  const ISSUER = "usage://issuer/production";

  const gateway = protocolGateway({
    protocol: openAiCompatibleProtocol,
    connectionId: "11111111-1111-4111-8111-111111111111",
    baseUrl: BASE,
    providerSlug: "deepseek",
  });

  it("records which connection executed the request", () => {
    const observation = gateway.toObservation({
      observed: gateway.observe(
        {
          id: "chatcmpl-abc",
          model: "deepseek-chat",
          usage: { prompt_tokens: 900, completion_tokens: 100 },
        },
        new Headers(),
      ),
      requestedModel: null,
      environment: "live",
      clientType: "usage-miner",
      occurredAt: new Date("2026-09-08T10:00:00.000Z"),
      latencyMs: 10,
    })!;

    expect(observation.gatewayId).toBe("connection:11111111-1111-4111-8111-111111111111");
    // Upstream model ids are not globally unique, so they are namespaced.
    expect(observation.model).toBe("deepseek/deepseek-chat");
  });

  it("refuses to produce a proof when the provider gave no request identity", () => {
    // No id means no dedupe key. Rather than inventing one, there is no proof.
    const observation = gateway.toObservation({
      observed: gateway.observe(
        { model: "deepseek-chat", usage: { prompt_tokens: 900, completion_tokens: 100 } },
        new Headers(),
      ),
      requestedModel: "deepseek-chat",
      environment: "live",
      clientType: "usage-miner",
      occurredAt: new Date(),
      latencyMs: 10,
    });
    expect(observation).toBeNull();
  });

  it("produces a signed proof through the shared pipeline", () => {
    const observation = gateway.toObservation({
      observed: gateway.observe(
        {
          id: "chatcmpl-abc",
          model: "deepseek-chat",
          usage: { prompt_tokens: 900, completion_tokens: 100 },
        },
        new Headers(),
      ),
      requestedModel: null,
      environment: "live",
      clientType: "usage-miner",
      occurredAt: new Date("2026-09-08T10:00:00.000Z"),
      latencyMs: 10,
    })!;

    const normalized = normalizeGatewayObservation(observation, {
      userId: "00000000-0000-4000-8000-000000000001",
      issuance: { issuer: ISSUER, keyId: KEY.keyId, privateKeyBase64: KEY.privateKeyBase64 },
    });

    expect(normalized.record.verificationType).toBe("routed");
    expect(normalized.receipt.proofStatus).toBe("confirmed");
    expect(
      verifyUsageReceipt(normalized.signed!, {
        publicKeys: { [KEY.keyId]: KEY.publicKeyBase64 },
        expectedIssuer: ISSUER,
      }).valid,
    ).toBe(true);
  });

  it("is PENDING_PRICING for a model no approved snapshot covers", () => {
    // The anti-fraud property: an unknown model produces a real proof that
    // earns nothing, rather than a price the provider chose.
    const observation = gateway.toObservation({
      observed: gateway.observe(
        {
          id: "chatcmpl-xyz",
          model: "totally-made-up-model",
          usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 },
        },
        new Headers(),
      ),
      requestedModel: null,
      environment: "live",
      clientType: "usage-miner",
      occurredAt: new Date("2026-09-08T10:00:00.000Z"),
      latencyMs: 10,
    })!;

    const normalized = normalizeGatewayObservation(observation, {
      userId: "u1",
      issuance: { issuer: ISSUER, keyId: KEY.keyId, privateKeyBase64: KEY.privateKeyBase64 },
    });

    expect(normalized.receipt.proofStatus).toBe("confirmed");
    expect(normalized.record.economicStatus).toBe("pending_pricing");
    expect(normalized.record.protocolPricingVersion).toBeNull();
  });

  it("never lets a client credential reach the provider", () => {
    const call = gateway.buildUpstreamCall(
      {
        path: ["chat", "completions"],
        headers: new Headers({
          authorization: "Bearer usgm_miner_token",
          "x-api-key": "sk-client",
        }),
        body: { model: "deepseek-chat", user: "attacker-supplied" },
        rawBody: "{}",
        attribution: { user: "00000000-0000-4000-8000-000000000001", tags: [] },
      },
      "sk-connection-secret",
    );

    expect(call.headers.get("authorization")).toBe("Bearer sk-connection-secret");
    expect(JSON.stringify([...call.headers])).not.toContain("usgm_miner_token");
    expect(JSON.stringify([...call.headers])).not.toContain("sk-client");
    // Server-side attribution overwrites anything the caller sent.
    expect(JSON.parse(call.body).user).toBe("00000000-0000-4000-8000-000000000001");
  });

  it("does not double the API version when the client already sent one", () => {
    // The bug this covers reached production and cost a real end-to-end run:
    // Codex is configured with a base ending in /v1 and so sends /v1/... , the
    // protocol prepended another /v1, and OpenRouter answered with its own 404
    // page -- which reads like USAGE being broken rather than a path being
    // wrong. Both client conventions must resolve to the same upstream URL.
    const withVersion = gateway.buildUpstreamCall(
      {
        path: ["v1", "chat", "completions"],
        headers: new Headers(),
        body: { model: "m" },
        rawBody: "{}",
        attribution: { user: "u1", tags: [] },
      },
      "sk",
    );
    const withoutVersion = gateway.buildUpstreamCall(
      {
        path: ["chat", "completions"],
        headers: new Headers(),
        body: { model: "m" },
        rawBody: "{}",
        attribution: { user: "u1", tags: [] },
      },
      "sk",
    );

    expect(withVersion.url).toBe(`${BASE}/v1/chat/completions`);
    expect(withVersion.url).toBe(withoutVersion.url);
    expect(withVersion.url).not.toContain("/v1/v1/");
  });

  it("sends requests only to the connection's stored base URL", () => {
    const call = gateway.buildUpstreamCall(
      {
        // A caller trying to escape the connection's endpoint via the path.
        path: ["chat", "completions"],
        headers: new Headers(),
        body: { model: "m", base_url: "https://evil.example.com" },
        rawBody: "{}",
        attribution: { user: "u1", tags: [] },
      },
      "sk",
    );
    expect(call.url.startsWith(BASE)).toBe(true);
  });
});
