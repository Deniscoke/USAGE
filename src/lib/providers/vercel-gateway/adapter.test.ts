import { describe, expect, it } from "vitest";
import { normalizeGatewayObservation } from "./adapter";
import { gatewayFixtures, malformedGatewayFixtures } from "./fixtures";
import { GatewayObservationError, type GatewayObservation } from "./observation";
import { classifyGatewayFailure, observationFromAiSdkResult } from "./probe";
import { usdCostToMicros } from "@/lib/domain/money";

const NOW = new Date("2026-04-10T12:00:00.000Z");

function liveObservation(overrides: Partial<GatewayObservation> = {}): GatewayObservation {
  return {
    environment: "live",
    generationId: "gen_live_abc123",
    model: "openai/gpt-5.4",
    servedByProvider: "openai",
    occurredAt: "2026-04-10T11:59:00.000Z",
    usage: {
      inputTokens: 1_000,
      outputTokens: 200,
      totalTokens: 1_200,
      inputTokenDetails: { noCacheTokens: 700, cacheReadTokens: 300, cacheWriteTokens: 50 },
      outputTokenDetails: { textTokens: 150, reasoningTokens: 50 },
    },
    cost: { value: "0.0123", currency: "USD" },
    finishReason: "stop",
    latencyMs: 900,
    ...overrides,
  };
}

describe("verification assignment", () => {
  it("classifies a live gateway observation as ROUTED evidence", () => {
    const { record } = normalizeGatewayObservation(liveObservation());
    expect(record.verificationType).toBe("routed");
    expect(record.verificationStatus).toBe("confirmed");
    expect(record.provider).toBe("vercel-ai-gateway");
    expect(record.source).toBe("vercel_ai_gateway");
  });

  it("never claims provider-VERIFIED for gateway traffic", () => {
    const { record } = normalizeGatewayObservation(liveObservation());
    expect(record.verificationType).not.toBe("verified");
  });

  it("classifies fixtures as REPORTED so they carry no economic weight", () => {
    for (const fixture of gatewayFixtures(NOW)) {
      const { record } = normalizeGatewayObservation(fixture);
      expect(record.verificationType).toBe("reported");
      expect(record.verificationStatus).toBe("unverifiable");
      expect(record.rawMetadata.evidence_class).toBe("fixture");
    }
  });

  it("ignores any verification a caller tries to attach to the observation", () => {
    const forged = {
      ...liveObservation({ environment: "fixture" }),
      // A client-shaped attempt to assert its own evidence level and cost.
      verificationType: "verified",
      verification_type: "verified",
      normalizedCostMicros: 999_000_000,
      cost: { value: "0.0123", currency: "USD" },
    } as unknown as GatewayObservation;

    const { record } = normalizeGatewayObservation(forged);
    expect(record.verificationType).toBe("reported");
    expect(record.normalizedCostMicros).toBe(12_300);
    expect(record.rawMetadata.verificationType).toBeUndefined();
  });
});

describe("token normalization", () => {
  it("separates cached input from fresh input", () => {
    const { record } = normalizeGatewayObservation(liveObservation());
    expect(record.inputTokens).toBe(700);
    expect(record.cachedInputTokens).toBe(300);
    expect(record.outputTokens).toBe(200);
    expect(record.requests).toBe(1);
  });

  it("derives uncached input when the gateway omits the breakdown", () => {
    const { record } = normalizeGatewayObservation(
      liveObservation({
        usage: { inputTokens: 1_000, outputTokens: 100, inputTokenDetails: { cacheReadTokens: 400 } },
      }),
    );
    expect(record.inputTokens).toBe(600);
    expect(record.cachedInputTokens).toBe(400);
  });

  it("keeps reasoning tokens as explainability, not as extra billable tokens", () => {
    const { record } = normalizeGatewayObservation(liveObservation());
    // Reasoning tokens are a breakdown of output tokens and are already counted.
    expect(record.rawMetadata.reasoning_tokens).toBe(50);
    expect(record.outputTokens).toBe(200);
  });

  it("refuses malformed evidence instead of inventing counts", () => {
    const [noId, noUsage, negative] = malformedGatewayFixtures(NOW);

    expect(() => normalizeGatewayObservation(noId)).toThrow(GatewayObservationError);
    expect(() => normalizeGatewayObservation(noUsage)).toThrow(/token usage/i);
    expect(() => normalizeGatewayObservation(negative)).toThrow(/non-negative/i);
  });
});

describe("cost handling", () => {
  it("uses the gateway's authoritative cost", () => {
    const { record } = normalizeGatewayObservation(liveObservation());
    expect(record.reportedCostMicros).toBe(12_300);
    expect(record.normalizedCostMicros).toBe(12_300);
    expect(record.rawMetadata.cost_basis).toBe("gateway_reported");
  });

  it("rounds sub-micro precision deterministically and says that it did", () => {
    const { record } = normalizeGatewayObservation(
      liveObservation({ cost: { value: "0.0512347891", currency: "USD" } }),
    );
    // 0.0512347891 -> 51234.7891 micros -> half-up -> 51235
    expect(record.normalizedCostMicros).toBe(51_235);
    expect(record.rawMetadata.cost_rounded).toBe(true);
  });

  it("records an absent cost as unknown rather than zero or estimated", () => {
    const { record } = normalizeGatewayObservation(liveObservation({ cost: null }));
    expect(record.reportedCostMicros).toBeNull();
    expect(record.normalizedCostMicros).toBe(0);
    expect(record.rawMetadata.cost_basis).toBe("unavailable");
  });

  it("rejects a non-USD cost rather than mis-converting it", () => {
    expect(() =>
      normalizeGatewayObservation(liveObservation({ cost: { value: "1.00", currency: "EUR" } })),
    ).toThrow(/currency/i);
  });
});

describe("usdCostToMicros", () => {
  it("rounds half-up at the micro boundary", () => {
    expect(usdCostToMicros("0.0000004").micros).toBe(0);
    expect(usdCostToMicros("0.0000005").micros).toBe(1);
    expect(usdCostToMicros("0.0000015").micros).toBe(2);
    expect(usdCostToMicros("1.9999999").micros).toBe(2_000_000);
  });

  it("reports whether precision was lost", () => {
    expect(usdCostToMicros("0.012300").rounded).toBe(false);
    expect(usdCostToMicros("0.0123001").rounded).toBe(true);
  });

  it("accepts a JSON number without floating-point drift", () => {
    expect(usdCostToMicros(0.1).micros).toBe(100_000);
    expect(usdCostToMicros(0.0000005).micros).toBe(1);
  });

  it("rejects nonsense rather than coercing it to zero", () => {
    expect(() => usdCostToMicros("free")).toThrow();
    expect(() => usdCostToMicros(Number.NaN)).toThrow();
  });
});

describe("identity and provenance", () => {
  it("derives the external reference from the gateway generation id", () => {
    const { record } = normalizeGatewayObservation(liveObservation());
    expect(record.externalReference).toBe("live:gen_live_abc123");
  });

  it("is stable: normalizing the same observation twice yields the same identity", () => {
    const observation = liveObservation();
    expect(normalizeGatewayObservation(observation).record.externalReference).toBe(
      normalizeGatewayObservation(observation).record.externalReference,
    );
  });

  it("keeps fixture identities in a namespace that cannot impersonate live ones", () => {
    const fixture = normalizeGatewayObservation(
      liveObservation({ environment: "fixture" }),
    ).record;
    const live = normalizeGatewayObservation(liveObservation()).record;
    expect(fixture.externalReference).not.toBe(live.externalReference);
    expect(fixture.externalReference.startsWith("fixture:")).toBe(true);
  });

  it("emits provenance explaining why the event is trusted", () => {
    const { proof } = normalizeGatewayObservation(liveObservation());
    expect(proof).toMatchObject({
      proofKind: "gateway_observation",
      proofSource: "vercel-ai-gateway",
      externalReference: "live:gen_live_abc123",
      adapterVersion: "vercel-gateway@1",
    });
    expect(proof.metadata.gateway_generation_id).toBe("gen_live_abc123");
    expect(proof.metadata.served_by_provider).toBe("openai");
  });
});

describe("privacy", () => {
  it("carries no prompt or completion content into the record", () => {
    const { record, proof } = normalizeGatewayObservation(liveObservation());
    const serialized = JSON.stringify({ record, proof }).toLowerCase();

    for (const forbidden of ["prompt", "completion", "message", "content", "text\":\""]) {
      expect(serialized.includes(forbidden)).toBe(false);
    }
  });

  it("does not copy unknown provider fields into stored metadata", () => {
    const noisy = {
      ...liveObservation(),
      promptText: "secret business plan",
      apiKey: "sk-should-never-be-here",
    } as unknown as GatewayObservation;

    const { record } = normalizeGatewayObservation(noisy);
    expect(JSON.stringify(record)).not.toContain("secret business plan");
    expect(JSON.stringify(record)).not.toContain("sk-should-never-be-here");
  });
});

describe("probe result mapping", () => {
  it("reads generation id, cost and usage from an AI SDK result", () => {
    const observation = observationFromAiSdkResult(
      {
        usage: {
          inputTokens: 12,
          outputTokens: 5,
          inputTokenDetails: { noCacheTokens: 12, cacheReadTokens: 0 },
        },
        providerMetadata: { gateway: { generationId: "gen_real_1", cost: "0.000042" } },
        response: { id: "resp_1", modelId: "openai/gpt-5.4", timestamp: NOW },
        finishReason: "stop",
      },
      { model: "openai/gpt-5.4", startedAt: new Date(NOW.getTime() - 500), finishedAt: NOW },
    );

    expect(observation.environment).toBe("live");
    expect(observation.generationId).toBe("gen_real_1");
    expect(observation.cost).toEqual({ value: "0.000042", currency: "USD" });
    expect(observation.latencyMs).toBe(500);

    const { record } = normalizeGatewayObservation(observation);
    expect(record.verificationType).toBe("routed");
    expect(record.normalizedCostMicros).toBe(42);
  });

  it("falls back to the response id when the gateway omits a generation id", () => {
    const observation = observationFromAiSdkResult(
      {
        usage: { inputTokens: 1, outputTokens: 1 },
        response: { id: "resp_only", modelId: "openai/gpt-5.4", timestamp: NOW },
      },
      { model: "openai/gpt-5.4", startedAt: NOW, finishedAt: NOW },
    );
    expect(observation.generationId).toBe("resp_only");
  });

  it("produces an unusable observation when there is no identity at all", () => {
    const observation = observationFromAiSdkResult(
      { usage: { inputTokens: 1, outputTokens: 1 } },
      { model: "openai/gpt-5.4", startedAt: NOW, finishedAt: NOW },
    );
    expect(() => normalizeGatewayObservation(observation)).toThrow(/generation id/i);
  });
});

describe("failure classification", () => {
  const cases: [unknown, string][] = [
    [Object.assign(new Error("unauthorized"), { statusCode: 401 }), "authentication"],
    [Object.assign(new Error("forbidden"), { statusCode: 403 }), "authentication"],
    [Object.assign(new Error("payment required"), { statusCode: 402 }), "budget_exceeded"],
    [Object.assign(new Error("slow down"), { statusCode: 429 }), "rate_limited"],
    [Object.assign(new Error("bad gateway"), { statusCode: 502 }), "provider_unavailable"],
    [Object.assign(new Error("aborted"), { name: "AbortError" }), "timeout"],
    [new Error("fetch failed"), "network"],
    [new Error("something else"), "unknown"],
  ];

  it.each(cases)("maps %# to an operational failure kind", (error, kind) => {
    expect(classifyGatewayFailure(error).kind).toBe(kind);
  });

  it("never turns a failure into usage", () => {
    const failure = classifyGatewayFailure(
      Object.assign(new Error("rate limited"), { statusCode: 429 }),
    );
    expect(failure).not.toHaveProperty("observation");
    expect(failure.statusCode).toBe(429);
  });
});
