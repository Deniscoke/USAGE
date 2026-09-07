import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildUpstreamHeaders,
  isStreamingRequest,
  sanitizeResponseHeaders,
  withAttribution,
} from "./anthropic";
import {
  AnthropicStreamUsageCollector,
  buildGatewayObservation,
  extractFromMessage,
  readGatewayHeaders,
} from "./usage-extract";
import { checkRateLimit, resetRateLimits } from "./observability";
import { hashMinerToken, mintMinerToken, readPresentedToken } from "@/lib/miner/token";
import { authenticateMiner, type MinerCredentialStore } from "@/lib/miner/credentials";
import { normalizeGatewayObservation } from "@/lib/providers/vercel-gateway/adapter";
import type { MinerCredentialRow } from "@/lib/supabase/database.types";

const UPSTREAM_KEY = "sk-upstream-secret-value";

describe("upstream credential handling", () => {
  it("replaces any client-supplied credential with ours", () => {
    const incoming = new Headers({
      authorization: "Bearer usgm_client_token",
      "x-api-key": "sk-client-anthropic-key",
      "x-ai-gateway-api-key": "sk-someone-elses-gateway-key",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "tools-2024-05-16",
    });

    const headers = buildUpstreamHeaders(incoming, UPSTREAM_KEY);

    expect(headers.get("authorization")).toBe(`Bearer ${UPSTREAM_KEY}`);
    expect(headers.get("x-api-key")).toBeNull();
    expect(headers.get("x-ai-gateway-api-key")).toBeNull();
    // Protocol headers Claude Code depends on survive.
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
    expect(headers.get("anthropic-beta")).toBe("tools-2024-05-16");
  });

  it("never returns the upstream key to the caller", () => {
    const upstream = new Headers({
      "x-ai-gateway-api-key": UPSTREAM_KEY,
      authorization: `Bearer ${UPSTREAM_KEY}`,
      "set-cookie": "session=abc",
      "content-type": "application/json",
    });

    const headers = sanitizeResponseHeaders(upstream);

    expect([...headers.keys()]).toEqual(["content-type"]);
    expect(JSON.stringify([...headers])).not.toContain(UPSTREAM_KEY);
  });
});

describe("attribution", () => {
  it("attaches a stable internal id and tags, never PII", () => {
    const body = withAttribution(
      { model: "anthropic/claude-haiku-4.5", messages: [] },
      { user: "f5ceb784-33bb-41f0-a423-1bcf43088279", tags: ["usage", "miner", "claude-code"] },
    ) as Record<string, { gateway: { user: string; tags: string[] } }>;

    expect(body.providerOptions.gateway.user).toBe("f5ceb784-33bb-41f0-a423-1bcf43088279");
    expect(body.providerOptions.gateway.tags).toEqual(["usage", "miner", "claude-code"]);
    expect(JSON.stringify(body)).not.toMatch(/@/);
  });

  it("overrides attribution a client tried to set for itself", () => {
    const body = withAttribution(
      { providerOptions: { gateway: { user: "someone-else", only: ["bedrock"] } } },
      { user: "real-user", tags: ["usage"] },
    ) as Record<string, { gateway: { user: string; only: string[] } }>;

    expect(body.providerOptions.gateway.user).toBe("real-user");
    // Unrelated routing options the caller set are preserved.
    expect(body.providerOptions.gateway.only).toEqual(["bedrock"]);
  });

  it("leaves a non-object body untouched", () => {
    expect(withAttribution("not json", { user: "u", tags: [] })).toBe("not json");
  });

  it("detects streaming requests", () => {
    expect(isStreamingRequest({ stream: true })).toBe(true);
    expect(isStreamingRequest({ stream: false })).toBe(false);
    expect(isStreamingRequest(null)).toBe(false);
  });
});

describe("miner authentication", () => {
  const minted = mintMinerToken();

  function storeWith(row: Partial<MinerCredentialRow> | null): MinerCredentialStore {
    return {
      findByTokenHash: async () =>
        row
          ? ({
              id: "cred-1",
              user_id: "user-1",
              name: "default",
              token_hash: minted.tokenHash,
              token_prefix: minted.tokenPrefix,
              created_at: new Date().toISOString(),
              last_used_at: null,
              revoked_at: null,
              ...row,
            } as MinerCredentialRow)
          : null,
      touch: async () => {},
      create: async () => ({ credentialId: "x", token: "y" }),
      revoke: async () => {},
    };
  }

  it("accepts a known credential", async () => {
    const result = await authenticateMiner(minted.token, storeWith({}));
    expect(result).toEqual({
      ok: true,
      identity: { credentialId: "cred-1", userId: "user-1", name: "default" },
    });
  });

  it("rejects a missing, malformed, unknown or revoked credential", async () => {
    expect(await authenticateMiner(null, storeWith({}))).toEqual({ ok: false, reason: "missing" });
    expect(await authenticateMiner("bearer-nonsense", storeWith({}))).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(await authenticateMiner(minted.token, storeWith(null))).toEqual({
      ok: false,
      reason: "unknown",
    });
    expect(
      await authenticateMiner(minted.token, storeWith({ revoked_at: new Date().toISOString() })),
    ).toEqual({ ok: false, reason: "revoked" });
  });

  it("stores a hash from which the token cannot be recovered", () => {
    expect(minted.tokenHash).not.toContain(minted.token);
    expect(minted.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(minted.token.length).toBeGreaterThan(40);
    // The only way from hash back to token is guessing 256 bits.
    expect(hashMinerToken(minted.token)).toBe(minted.tokenHash);
    expect(hashMinerToken(`${minted.token}x`)).not.toBe(minted.tokenHash);
  });

  it("reads the credential from every supported client style", () => {
    expect(readPresentedToken(new Headers({ authorization: `Bearer ${minted.token}` }))).toBe(
      minted.token,
    );
    expect(readPresentedToken(new Headers({ "x-api-key": minted.token }))).toBe(minted.token);
    expect(readPresentedToken(new Headers({ "x-usage-miner-token": minted.token }))).toBe(
      minted.token,
    );
    expect(readPresentedToken(new Headers())).toBeNull();
  });

  it("never treats another provider credential as a miner token", async () => {
    // A Claude Code signed in to a subscription sends its own Authorization.
    const headers = new Headers({ authorization: "Bearer sk-ant-oat01-not-ours" });
    const presented = readPresentedToken(headers);
    expect(presented).not.toContain("sk-ant");
    expect(await authenticateMiner(presented, storeWith({}))).toEqual({
      ok: false,
      reason: "malformed",
    });
  });
});

describe("rate limiting", () => {
  beforeEach(() => resetRateLimits());

  it("bounds requests per credential", () => {
    for (let i = 0; i < 3; i++) expect(checkRateLimit("cred", 3).allowed).toBe(true);
    const blocked = checkRateLimit("cred", 3);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    // A different miner is unaffected.
    expect(checkRateLimit("other", 3).allowed).toBe(true);
  });
});

describe("usage extraction", () => {
  it("reads usage from a non-streaming message", () => {
    const extracted = extractFromMessage({
      id: "msg_01ABC",
      model: "anthropic/claude-haiku-4.5",
      stop_reason: "end_turn",
      content: [{ type: "text", text: "secret answer text" }],
      usage: {
        input_tokens: 100,
        output_tokens: 40,
        cache_read_input_tokens: 900,
        cache_creation_input_tokens: 50,
      },
    });

    expect(extracted.generationId).toBe("msg_01ABC");
    expect(extracted.hasUsage).toBe(true);
    // Anthropic reports fresh input separately from cache reads.
    expect(extracted.usage.inputTokens).toBe(1_000);
    expect(extracted.usage.inputTokenDetails).toEqual({
      noCacheTokens: 100,
      cacheReadTokens: 900,
      cacheWriteTokens: 50,
    });
    expect(JSON.stringify(extracted)).not.toContain("secret answer text");
  });

  it("reports no usage rather than guessing when the body has none", () => {
    expect(extractFromMessage({ id: "msg_1" }).hasUsage).toBe(false);
    expect(extractFromMessage("nonsense").hasUsage).toBe(false);
  });

  it("accumulates usage across an SSE stream", () => {
    const collector = new AnthropicStreamUsageCollector();
    const frames = [
      `event: message_start\ndata: ${JSON.stringify({
        type: "message_start",
        message: {
          id: "msg_stream_1",
          model: "anthropic/claude-haiku-4.5",
          usage: { input_tokens: 12, cache_read_input_tokens: 8, output_tokens: 0 },
        },
      })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: "content_block_delta",
        delta: { type: "text_delta", text: "private model output" },
      })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 33 },
      })}\n\n`,
    ];

    // Split mid-frame to prove the buffer handles partial chunks.
    const whole = frames.join("");
    collector.push(whole.slice(0, 61));
    collector.push(whole.slice(61));

    const result = collector.result();
    expect(result.generationId).toBe("msg_stream_1");
    expect(result.usage.inputTokens).toBe(20);
    expect(result.usage.outputTokens).toBe(33);
    expect(result.finishReason).toBe("end_turn");
    expect(JSON.stringify(result)).not.toContain("private model output");
  });

  it("survives a malformed frame without inventing usage", () => {
    const collector = new AnthropicStreamUsageCollector();
    collector.push("data: {not json}\n\n");
    expect(collector.result().hasUsage).toBe(false);
  });

  it("prefers a gateway generation id header when present", () => {
    const headers = readGatewayHeaders(
      new Headers({ "x-vercel-ai-gateway-generation-id": "gen_123", "x-random": "ignored" }),
    );
    expect(headers.generationId).toBe("gen_123");
    expect(headers.generationIdSource).toBe("x-vercel-ai-gateway-generation-id");
    expect(headers.cost).toBeNull();
  });
});

describe("observation assembly", () => {
  const base = {
    headerMetadata: { generationId: null, generationIdSource: null, cost: null },
    requestedModel: "anthropic/claude-haiku-4.5",
    environment: "development" as const,
    clientType: "claude-code",
    occurredAt: new Date("2026-04-20T10:00:00.000Z"),
    latencyMs: 250,
  };

  it("produces nothing when there is no identity or no usage", () => {
    expect(
      buildGatewayObservation({
        ...base,
        extracted: { generationId: null, model: null, usage: {}, hasUsage: false },
      }),
    ).toBeNull();

    expect(
      buildGatewayObservation({
        ...base,
        extracted: { generationId: "msg_1", model: null, usage: {}, hasUsage: false },
      }),
    ).toBeNull();
  });

  it("marks locally observed traffic as economically pending", () => {
    const observation = buildGatewayObservation({
      ...base,
      extracted: {
        generationId: "msg_dev_1",
        model: "anthropic/claude-haiku-4.5",
        usage: { inputTokens: 10, outputTokens: 5 },
        hasUsage: true,
      },
    })!;

    const { record, receipt } = normalizeGatewayObservation(observation, { userId: "user-1" });
    expect(record.verificationType).toBe("routed");
    expect(record.verificationStatus).toBe("pending");
    expect(receipt.trustEnvironment).toBe("development");
    expect(record.externalReference).toBe("development:msg_dev_1");
  });
});

describe("gateway route", () => {
  const OLD_ENV = { ...process.env };
  const logFile = path.join(process.cwd(), ".usage", "test-observations.jsonl");

  beforeEach(async () => {
    resetRateLimits();
    process.env.AI_GATEWAY_API_KEY = UPSTREAM_KEY;
    process.env.USAGE_DEV_OBSERVATION_LOG = logFile;
    process.env.USAGE_DEV_MINER_TOKEN_HASH = hashMinerToken("usgm_test_token");
    process.env.USAGE_DEV_MINER_USER_ID = "00000000-0000-4000-8000-000000000001";
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    delete process.env.USAGE_TRUST_ENVIRONMENT;
    await rm(logFile, { force: true });
  });

  afterEach(() => {
    process.env = { ...OLD_ENV };
    vi.unstubAllGlobals();
  });

  async function callRoute(
    body: unknown,
    init: { token?: string; upstream: () => Response },
  ): Promise<{ response: Response; upstreamRequest: Request | null }> {
    let upstreamRequest: Request | null = null;
    vi.stubGlobal("fetch", async (url: string, options: RequestInit) => {
      upstreamRequest = new Request(url, options);
      return init.upstream();
    });

    const { POST } = await import("@/app/api/gateway/anthropic/[...path]/route");
    const request = new Request("http://localhost/api/gateway/anthropic/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      },
      body: JSON.stringify(body),
    });

    const response = await POST(request as never, {
      params: Promise.resolve({ path: ["v1", "messages"] }),
    });
    return { response, upstreamRequest };
  }

  it("rejects an unauthenticated miner without ever calling upstream", async () => {
    const { response, upstreamRequest } = await callRoute(
      { model: "m", messages: [] },
      { upstream: () => new Response("{}") },
    );

    expect(response.status).toBe(401);
    expect(upstreamRequest).toBeNull();
    const body = await response.json();
    expect(body.error.type).toBe("authentication_error");
    expect(JSON.stringify(body)).not.toContain(UPSTREAM_KEY);
  });

  it("forwards an authenticated request with our credential and our attribution", async () => {
    const { response, upstreamRequest } = await callRoute(
      { model: "anthropic/claude-haiku-4.5", max_tokens: 16, messages: [], stream: false },
      {
        token: "usgm_test_token",
        upstream: () =>
          new Response(
            JSON.stringify({
              id: "msg_route_1",
              model: "anthropic/claude-haiku-4.5",
              stop_reason: "end_turn",
              usage: { input_tokens: 20, output_tokens: 7 },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      },
    );

    expect(response.status).toBe(200);
    const forwarded = upstreamRequest as unknown as Request;
    expect(forwarded.headers.get("authorization")).toBe(`Bearer ${UPSTREAM_KEY}`);

    const sent = JSON.parse(await forwarded.text());
    expect(sent.providerOptions.gateway.user).toBe("00000000-0000-4000-8000-000000000001");
    expect(sent.providerOptions.gateway.tags).toContain("claude-code");
    // The request body is otherwise untouched.
    expect(sent.max_tokens).toBe(16);

    const returned = await response.text();
    expect(returned).toContain("msg_route_1");
    expect(returned).not.toContain(UPSTREAM_KEY);

    // The observation is recorded out of band; give it a tick.
    await new Promise((resolve) => setTimeout(resolve, 250));
    const log = await readFile(logFile, "utf8");
    const observation = JSON.parse(log.trim().split("\n").pop()!);
    expect(observation.generationId).toBe("msg_route_1");
    expect(observation.environment).toBe("development");
    expect(observation.usage.outputTokens).toBe(7);
  });

  it("passes an upstream error through and records no usage", async () => {
    const { response } = await callRoute(
      { model: "m", messages: [] },
      {
        token: "usgm_test_token",
        upstream: () =>
          new Response(
            JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }),
            { status: 429 },
          ),
      },
    );

    expect(response.status).toBe(429);
    expect(await response.text()).toContain("rate_limit_error");
    await new Promise((resolve) => setTimeout(resolve, 250));
    await expect(readFile(logFile, "utf8")).rejects.toThrow();
  });

  it("streams bytes through unchanged while collecting usage", async () => {
    const sse =
      `event: message_start\ndata: ${JSON.stringify({
        type: "message_start",
        message: { id: "msg_sse_1", model: "anthropic/claude-haiku-4.5", usage: { input_tokens: 5 } },
      })}\n\n` +
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: "content_block_delta",
        delta: { type: "text_delta", text: "USAGE_PROOF_OK" },
      })}\n\n` +
      `event: message_delta\ndata: ${JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 9 },
      })}\n\n`;

    const { response } = await callRoute(
      { model: "anthropic/claude-haiku-4.5", messages: [], stream: true },
      {
        token: "usgm_test_token",
        upstream: () =>
          new Response(
            new ReadableStream({
              start(controller) {
                const encoder = new TextEncoder();
                // Two chunks, split mid-frame.
                controller.enqueue(encoder.encode(sse.slice(0, 90)));
                controller.enqueue(encoder.encode(sse.slice(90)));
                controller.close();
              },
            }),
            { status: 200, headers: { "content-type": "text/event-stream" } },
          ),
      },
    );

    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const received = await response.text();
    // Byte-for-byte identical: an agentic client depends on the exact protocol.
    expect(received).toBe(sse);

    await new Promise((resolve) => setTimeout(resolve, 250));
    const observation = JSON.parse((await readFile(logFile, "utf8")).trim().split("\n").pop()!);
    expect(observation.generationId).toBe("msg_sse_1");
    expect(observation.usage.outputTokens).toBe(9);
    // Model output text never reaches the observation.
    expect(JSON.stringify(observation)).not.toContain("USAGE_PROOF_OK");
  });
});
