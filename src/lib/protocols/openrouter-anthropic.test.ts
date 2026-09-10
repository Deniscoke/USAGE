import { describe, expect, it } from "vitest";
import { anthropicCompatibleProtocol } from "./anthropic-compatible";
import { openAiCompatibleProtocol } from "./openai-compatible";
import { protocolGateway } from "@/lib/compute/protocol-gateway";
import { normalizeGatewayObservation } from "@/lib/providers/vercel-gateway/adapter";
import { generateSigningKeyPair } from "@/lib/domain/signing";

/**
 * OpenRouter's Anthropic-compatible surface (M16C0 §5–§7, §17).
 *
 * Fixtures follow OpenRouter's documented Anthropic Messages response
 * (docs checked 2026-09-11): `msg_…` id, Anthropic usage fields including
 * cache read/creation counts, plus a stated `usage.cost`. No provider is
 * contacted; nothing here spends anything.
 */

const CONNECTION = "f0f97095-4a68-432c-ac10-93746c370af3";
const CREDENTIAL = "sk-or-v1-server-held-secret";
const KEY = generateSigningKeyPair("m16c0-test-key");
const ISSUER = "usage://issuer/production";

const gateway = protocolGateway({
  protocol: anthropicCompatibleProtocol,
  connectionId: CONNECTION,
  baseUrl: "https://openrouter.ai/api",
  providerSlug: "openrouter",
  providerFamily: "openrouter",
  endpointTrusted: true,
  funding: { class: "paid_account", basis: "openrouter:/api/v1/key#is_free_tier", observedAt: "2026-09-10T00:00:00.000Z" },
});

function claudeCodeRequest(body: Record<string, unknown>) {
  const rawBody = JSON.stringify(body);
  return {
    baseUrl: "https://openrouter.ai/api",
    credential: CREDENTIAL,
    path: ["v1", "messages"],
    headers: new Headers({
      // What a claude.ai-signed-in Claude Code actually sends (probed 2026-09-11).
      authorization: "Bearer sk-ant-oat01-the-users-claude-max-oauth-token",
      "anthropic-beta": "oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27",
      "anthropic-version": "2023-06-01",
      "x-usage-miner-token": "usgm_device_token",
      "x-claude-code-session-id": "session-1",
      "content-type": "application/json",
    }),
    body,
    rawBody,
    attributionUser: "user-1",
    pathPrefix: "v1" as const,
    privacy: "openrouter" as const,
  };
}

describe("Claude Code → OpenRouter Anthropic surface", () => {
  it("forwards the Anthropic wire format to /api/v1/messages with the server-held credential and nothing of the client's", () => {
    const call = anthropicCompatibleProtocol.buildUpstreamCall(
      claudeCodeRequest({ model: "anthropic/claude-opus-5", max_tokens: 64, stream: true, messages: [{ role: "user", content: "x" }] }),
    );
    expect(call.url).toBe("https://openrouter.ai/api/v1/messages");
    expect(anthropicCompatibleProtocol.isStreaming(JSON.parse(call.body))).toBe(true);
  });

  it("carries the privacy baseline in the body, keeps the Anthropic shape, and adds no attribution field", () => {
    const context = claudeCodeRequest({
      model: "anthropic/claude-opus-5",
      max_tokens: 64,
      stream: true,
      thinking: { type: "adaptive" },
      tools: [{ name: "bash", input_schema: { type: "object" } }],
      messages: [{ role: "user", content: "x" }],
      provider: { zdr: false, data_collection: "allow", order: ["anthropic"] },
    });
    const call = anthropicCompatibleProtocol.buildUpstreamCall({ ...context, credential: CREDENTIAL });
    const body = JSON.parse(call.body) as Record<string, unknown>;
    expect(body.provider).toEqual({ order: ["anthropic"], zdr: true, data_collection: "deny" });
    expect(body.thinking).toEqual({ type: "adaptive" });
    expect(body.tools).toHaveLength(1);
    expect(body.stream).toBe(true);
    expect(body).not.toHaveProperty("user");
    expect(body).not.toHaveProperty("messages.0.role", "system");
  });

  it("authenticates with the connection's credential on both documented headers, and the client's OAuth never leaves", () => {
    const call = anthropicCompatibleProtocol.buildUpstreamCall({ ...claudeCodeRequest({ model: "anthropic/claude-opus-5", messages: [] }), credential: CREDENTIAL });
    expect(call.headers.get("authorization")).toBe(`Bearer ${CREDENTIAL}`);
    expect(call.headers.get("x-api-key")).toBe(CREDENTIAL);
    expect(call.headers.get("x-usage-miner-token")).toBeNull();
    expect([...call.headers.values()].join(" ")).not.toContain("sk-ant-oat01");
  });

  it("drops only the OAuth capability from anthropic-beta and forwards every other beta verbatim", () => {
    const call = anthropicCompatibleProtocol.buildUpstreamCall({ ...claudeCodeRequest({ model: "anthropic/claude-opus-5", messages: [] }), credential: CREDENTIAL });
    expect(call.headers.get("anthropic-beta")).toBe("interleaved-thinking-2025-05-14,context-management-2025-06-27");
    expect(call.headers.get("anthropic-version")).toBe("2023-06-01");
    expect(call.headers.get("x-claude-code-session-id")).toBe("session-1");
  });

  it("fails closed on a body it cannot parse rather than forwarding it unrestricted", () => {
    const call = anthropicCompatibleProtocol.buildUpstreamCall({ ...claudeCodeRequest({}), body: null, rawBody: "not json", credential: CREDENTIAL });
    expect(JSON.parse(call.body)).toEqual({ provider: { zdr: true, data_collection: "deny" } });
  });
});

const NON_STREAM_FIXTURE = {
  id: "msg_01XFDUDYJgAACzvnptvVoYEL",
  type: "message",
  role: "assistant",
  model: "anthropic/claude-opus-5",
  content: [{ type: "text", text: "OK" }],
  stop_reason: "end_turn",
  usage: {
    input_tokens: 12,
    output_tokens: 3,
    cache_creation_input_tokens: 4000,
    cache_read_input_tokens: 20000,
    cost: 0.0123456,
    cost_details: { upstream_inference_prompt_cost: 0.01, upstream_inference_completions_cost: 0.0023456 },
  },
};

function observeNonStream() {
  return gateway.toObservation({
    observed: gateway.observe(NON_STREAM_FIXTURE, new Headers()),
    requestedModel: "anthropic/claude-opus-5",
    environment: "live",
    clientType: "usage-miner",
    occurredAt: new Date("2026-09-11T10:00:00.000Z"),
    latencyMs: 1200,
  });
}

describe("economic observation on the Anthropic surface", () => {
  it("extracts identity, model, every token class, the stated cost and the funding context", () => {
    const observation = observeNonStream()!;
    expect(observation).not.toBeNull();
    expect(observation.generationId).toBe("msg_01XFDUDYJgAACzvnptvVoYEL");
    expect(observation.generationIdSource).toBe("anthropic_message_id");
    expect(observation.model).toBe("anthropic/claude-opus-5");
    expect(observation.providerSlug).toBe("openrouter");
    expect(observation.gatewayId).toBe(`connection:${CONNECTION}`);
    // Anthropic's input_tokens excludes cache; USAGE stores the inclusive total with the split alongside.
    expect(observation.usage.inputTokens).toBe(12 + 20000);
    expect(observation.usage.inputTokenDetails).toEqual({ noCacheTokens: 12, cacheReadTokens: 20000, cacheWriteTokens: 4000 });
    expect(observation.usage.outputTokens).toBe(3);
    expect(observation.cost).toEqual({ value: "0.012345600000", currency: "USD" });
    expect(observation.funding?.class).toBe("paid_account");
    expect(observation.endpointTrusted).toBe(true);
  });

  it("reads the same facts out of a stream, taking cost and output from the final message_delta", () => {
    const observer = gateway.observeStream(new Headers());
    const frames = [
      `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_stream1", model: "anthropic/claude-opus-5", usage: { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, output_tokens: 1, cost: null } } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "secret content never read" } })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 42, cost: 0.0005 } })}\n\n`,
    ];
    for (const frame of frames) observer.push(frame);
    const observed = observer.result();
    expect(observed.identity.generationId).toBe("msg_stream1");
    expect(observed.usage.outputTokens).toBe(42);
    expect(observed.usage.inputTokens).toBe(110);
    expect(observed.cost).toEqual({ value: "0.000500000000", currency: "USD" });
    expect(observed.finishReason).toBe("end_turn");
  });

  it("leaves cost unknown when the surface states none (Anthropic direct), never zero", () => {
    const observed = anthropicCompatibleProtocol.observe({ id: "msg_x", model: "claude-opus-5", usage: { input_tokens: 1, output_tokens: 1 } }, new Headers());
    expect(observed.cost).toBeNull();
  });

  it("produces at most ONE economic compute unit per upstream generation, on either surface", () => {
    const observation = observeNonStream()!;
    const first = normalizeGatewayObservation(observation, { userId: "u1", issuance: { issuer: ISSUER, keyId: KEY.keyId, privateKeyBase64: KEY.privateKeyBase64 } });
    const second = normalizeGatewayObservation(observation, { userId: "u1", issuance: { issuer: ISSUER, keyId: KEY.keyId, privateKeyBase64: KEY.privateKeyBase64 } });
    expect(first.proof.metadata.economic_event_key).toMatch(/^ecu1:/);
    expect(second.proof.metadata.economic_event_key).toBe(first.proof.metadata.economic_event_key);
    expect(first.record.verificationType).toBe("routed");
    expect(first.proof.metadata.cost_basis).toBe("gateway_reported");
    expect(first.record.actualCostMicros).toBe(12346);
    expect(first.proof.metadata.funding_class).toBe("paid_account");

    // The same generation observed on the OpenAI-compatible surface of the
    // same connection would be a different provider id space only if the
    // ids differed; a distinct generation is a distinct unit, never a merge.
    const openai = protocolGateway({ protocol: openAiCompatibleProtocol, connectionId: CONNECTION, baseUrl: "https://openrouter.ai/api", providerSlug: "openrouter", providerFamily: "openrouter", endpointTrusted: true });
    const other = openai.toObservation({
      observed: openai.observe({ id: "gen-abc", model: "openai/gpt-5-nano", usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.000001 } }, new Headers()),
      requestedModel: null,
      environment: "live",
      clientType: "usage-miner",
      occurredAt: new Date(),
      latencyMs: 1,
    })!;
    const otherKey = normalizeGatewayObservation(other, { userId: "u1" }).proof.metadata.economic_event_key;
    expect(otherKey).not.toBe(first.proof.metadata.economic_event_key);
  });

  it("issues no proof without a generation identity", () => {
    const observation = gateway.toObservation({
      observed: gateway.observe({ model: "anthropic/claude-opus-5", usage: { input_tokens: 1, output_tokens: 1 } }, new Headers()),
      requestedModel: null,
      environment: "live",
      clientType: "usage-miner",
      occurredAt: new Date(),
      latencyMs: 1,
    });
    expect(observation).toBeNull();
  });
});
