import type { GatewayObservation } from "./observation";

/**
 * Schema-realistic gateway observations for development and tests.
 *
 * These are NOT captured production payloads: they contain no credentials, no
 * prompt or completion text, and no real generation ids. They exist so the full
 * path (observation -> adapter -> normalize -> ingest -> dedupe -> aggregate ->
 * score) can be exercised without spending money.
 *
 * Every fixture is stamped `environment: "fixture"`, which the adapter turns
 * into REPORTED / unverifiable evidence with zero economic weight. A fixture
 * therefore cannot become a rewardable ROUTED record, wherever it is ingested.
 */

const HOUR = 60 * 60 * 1000;

export function gatewayFixtures(now: Date = new Date()): GatewayObservation[] {
  const base = now.getTime();

  return [
    {
      environment: "fixture",
      generationId: "gen_fixture_0001",
      model: "openai/gpt-5.4",
      servedByProvider: "openai",
      occurredAt: new Date(base - 3 * HOUR).toISOString(),
      usage: {
        inputTokens: 1_842,
        outputTokens: 640,
        totalTokens: 2_482,
        inputTokenDetails: { noCacheTokens: 1_842, cacheReadTokens: 0, cacheWriteTokens: 0 },
        outputTokenDetails: { textTokens: 640, reasoningTokens: 0 },
      },
      cost: { value: "0.014205", currency: "USD" },
      finishReason: "stop",
      latencyMs: 1_284,
    },
    {
      // Cache reads and reasoning tokens, i.e. the shape a real agentic call has.
      environment: "fixture",
      generationId: "gen_fixture_0002",
      model: "anthropic/claude-sonnet-4.6",
      servedByProvider: "anthropic",
      occurredAt: new Date(base - 2 * HOUR).toISOString(),
      usage: {
        inputTokens: 24_500,
        outputTokens: 3_120,
        totalTokens: 27_620,
        inputTokenDetails: { noCacheTokens: 4_500, cacheReadTokens: 20_000, cacheWriteTokens: 1_200 },
        outputTokenDetails: { textTokens: 1_920, reasoningTokens: 1_200 },
      },
      cost: { value: "0.0512347891", currency: "USD" },
      finishReason: "stop",
      latencyMs: 5_930,
    },
    {
      // The gateway does not always report cost. Cost is then unknown -- the
      // adapter must not estimate one.
      environment: "fixture",
      generationId: "gen_fixture_0003",
      model: "openai/gpt-5.4",
      servedByProvider: "azure-openai",
      occurredAt: new Date(base - 1 * HOUR).toISOString(),
      usage: {
        inputTokens: 512,
        outputTokens: 96,
        totalTokens: 608,
        inputTokenDetails: { noCacheTokens: 512, cacheReadTokens: 0, cacheWriteTokens: 0 },
        outputTokenDetails: { textTokens: 96, reasoningTokens: 0 },
      },
      cost: null,
      finishReason: "stop",
      latencyMs: 402,
    },
  ];
}

/** Observations that must be rejected rather than stored. */
export function malformedGatewayFixtures(now: Date = new Date()): GatewayObservation[] {
  const at = new Date(now.getTime() - HOUR).toISOString();
  return [
    {
      environment: "fixture",
      generationId: "",
      model: "openai/gpt-5.4",
      occurredAt: at,
      usage: { inputTokens: 10, outputTokens: 5 },
    },
    {
      environment: "fixture",
      generationId: "gen_fixture_no_usage",
      model: "openai/gpt-5.4",
      occurredAt: at,
      usage: {},
    },
    {
      environment: "fixture",
      generationId: "gen_fixture_bad_tokens",
      model: "openai/gpt-5.4",
      occurredAt: at,
      usage: { inputTokens: -5, outputTokens: 5 },
    },
  ];
}
