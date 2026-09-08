import { describe, expect, it } from "vitest";
import {
  CURRENT_REWARD_POLICY,
  decideReward,
  deriveEconomicSource,
  getRewardPolicy,
  listRewardPolicies,
  REWARD_POLICY_V0,
  REWARD_POLICY_V1,
  type EconomicSourceClass,
} from "./reward-policy";
import { normalizeGatewayObservation } from "@/lib/providers/vercel-gateway/adapter";
import { generateSigningKeyPair } from "@/lib/domain/signing";
import { scoreRecords } from "@/lib/domain/scoring";
import type { GatewayObservation } from "@/lib/providers/vercel-gateway/observation";

/**
 * The separation this milestone exists for.
 *
 * A CONFIRMED proof answers "did this compute happen". A reward decision
 * answers "should it earn". They are different questions, and the whole point
 * of these tests is that a yes to the first is never a yes to the second.
 */

const KEY = generateSigningKeyPair("policy-key");
const ISSUER = "usage://issuer/production";
const CONNECTION = "connection:11111111-1111-4111-8111-111111111111";

describe("economic source is derived, never declared", () => {
  it("calls USAGE-funded gateway traffic promotional, whatever it cost", () => {
    // USAGE's own credential and budget paid. Real compute, really observed --
    // but rewarding it would be USAGE paying twice for the same dollar.
    expect(
      deriveEconomicSource({
        gatewayId: "vercel-ai-gateway",
        actualCostMicros: 4_000_000,
        actualCostBasis: "gateway_reported",
        usageFunded: true,
      }),
    ).toBe("promotional");
  });

  it("will not take a user-controlled endpoint's word that compute was paid", () => {
    // The same person can control the endpoint and the USAGE account, so a
    // positive cost it reports is a claim, not evidence. Held, not paid.
    expect(
      deriveEconomicSource({
        gatewayId: CONNECTION,
        actualCostMicros: 420,
        actualCostBasis: "gateway_reported",
        usageFunded: false,
      }),
    ).toBe("byok");
  });

  it("accepts metered_paid only from a source the user does not control", () => {
    // An authenticated provider admin API reporting a real charge is
    // independent evidence in a way a user's own endpoint never is.
    expect(
      deriveEconomicSource({
        gatewayId: null,
        actualCostMicros: 420,
        actualCostBasis: "provider_reported",
        usageFunded: false,
        endpointControlledByUser: false,
      }),
    ).toBe("metered_paid");
  });

  it("accepts a stated zero from anywhere", () => {
    // The OpenRouter free-model case. A zero can only ever reduce a reward, so
    // nobody has a motive to lie in this direction -- and refusing it would
    // mean free compute quietly earned.
    expect(
      deriveEconomicSource({
        gatewayId: CONNECTION,
        actualCostMicros: 0,
        actualCostBasis: "gateway_reported",
        usageFunded: false,
      }),
    ).toBe("free");
  });

  it("does not treat a non-authoritative cost as evidence of payment", () => {
    // An estimated share of a bucket total is arithmetic, not a bill.
    expect(
      deriveEconomicSource({
        gatewayId: CONNECTION,
        actualCostMicros: 999_999,
        actualCostBasis: "estimated",
        usageFunded: false,
      }),
    ).toBe("byok");
  });

  it("never infers paid from silence", () => {
    expect(
      deriveEconomicSource({
        gatewayId: CONNECTION,
        actualCostMicros: null,
        usageFunded: false,
      }),
    ).toBe("byok");
    expect(
      deriveEconomicSource({ gatewayId: null, actualCostMicros: null, usageFunded: false }),
    ).toBe("unknown");
  });
});

describe("reward policy v1", () => {
  const base = {
    proofStatus: "confirmed",
    verificationType: "routed",
    protocolComputeMicros: 5_000,
  };

  it("pays metered paid compute", () => {
    const decision = decideReward({ ...base, economicSource: "metered_paid" });
    expect(decision.status).toBe("eligible");
    expect(decision.eligibleComputeMicros).toBe(5_000);
    expect(decision.policyVersion).toBe("usage-reward-policy-v1");
  });

  it("never pays free compute, and says why", () => {
    // The attack this closes: if free inference earned, farming it in a loop
    // would be the cheapest way to mine.
    const decision = decideReward({ ...base, economicSource: "free" });
    expect(decision.status).toBe("ineligible");
    expect(decision.reason).toBe("free_inference");
    expect(decision.eligibleComputeMicros).toBe(0);
  });

  it("holds rather than refusing when the answer is not known", () => {
    for (const source of ["byok", "subscription", "promotional", "unknown"] as const) {
      const decision = decideReward({ ...base, economicSource: source });
      expect(decision.status, source).toBe("held");
      expect(decision.eligibleComputeMicros, source).toBe(0);
    }
  });

  it("holds unpriced compute rather than discarding the proof", () => {
    const decision = decideReward({
      ...base,
      economicSource: "metered_paid",
      protocolComputeMicros: null,
    });
    expect(decision.status).toBe("held");
    expect(decision.reason).toBe("not_priced");
  });

  it("refuses anything that is not a confirmed proof", () => {
    const decision = decideReward({
      ...base,
      proofStatus: "observed",
      economicSource: "metered_paid",
    });
    expect(decision.status).toBe("ineligible");
    expect(decision.reason).toBe("proof_not_confirmed");
  });

  it("never pays self-reported usage, however it was funded", () => {
    const decision = decideReward({
      ...base,
      verificationType: "reported",
      economicSource: "metered_paid",
    });
    expect(decision.status).toBe("ineligible");
    expect(decision.reason).toBe("no_economic_weight");
  });

  it("records the policy that made every decision", () => {
    const sources: EconomicSourceClass[] = [
      "metered_paid",
      "byok",
      "subscription",
      "free",
      "promotional",
      "unknown",
    ];
    for (const source of sources) {
      const decision = decideReward({ ...base, economicSource: source });
      expect(decision.policyVersion, source).toBe(CURRENT_REWARD_POLICY.version);
      expect(decision.reason, source).toBeTruthy();
    }
  });
});

describe("policy versions are immutable history", () => {
  it("keeps the pre-policy version resolvable", () => {
    // Settled epochs were decided under v0. Losing it would make them
    // unexplainable, and re-judging them would move a settled allocation.
    expect(getRewardPolicy("usage-reward-policy-v0")).not.toBeNull();
    expect(REWARD_POLICY_V0.status).toBe("superseded");
    expect(REWARD_POLICY_V1.status).toBe("active");
  });

  it("names every version exactly once", () => {
    const versions = listRewardPolicies().map((policy) => policy.version);
    expect(new Set(versions).size).toBe(versions.length);
  });

  it("does not resolve a version that was never published", () => {
    expect(getRewardPolicy("usage-reward-policy-v99")).toBeNull();
  });

  it("decides the same way when replayed under the same version", () => {
    const input = {
      proofStatus: "confirmed",
      verificationType: "routed",
      economicSource: "free" as const,
      protocolComputeMicros: 1_234,
    };
    expect(decideReward({ ...input, policy: REWARD_POLICY_V1 })).toEqual(
      decideReward({ ...input, policy: REWARD_POLICY_V1 }),
    );
    // ...and differently under the version that actually judged history.
    expect(decideReward({ ...input, policy: REWARD_POLICY_V0 }).status).toBe("eligible");
  });
});

describe("a free confirmed proof, end to end", () => {
  function freeObservation(): GatewayObservation {
    return {
      environment: "live",
      generationId: "gen_free_1",
      model: "anthropic/claude-haiku-4.5",
      gatewayId: CONNECTION,
      clientType: "usage-miner",
      servedByProvider: "anthropic",
      occurredAt: "2026-09-09T10:00:00.000Z",
      usage: { inputTokens: 1_000, outputTokens: 500 },
      // The provider states this cost nothing.
      cost: { value: "0", currency: "USD" },
    };
  }

  const normalized = normalizeGatewayObservation(freeObservation(), {
    userId: "00000000-0000-4000-8000-000000000001",
    issuance: { issuer: ISSUER, keyId: KEY.keyId, privateKeyBase64: KEY.privateKeyBase64 },
  });

  it("is a real, signed, confirmed proof", () => {
    // USAGE can verify free compute. That is worth doing.
    expect(normalized.record.verificationType).toBe("routed");
    expect(normalized.receipt.proofStatus).toBe("confirmed");
    expect(normalized.signed).not.toBeNull();
  });

  it("is measured, and priced", () => {
    expect(normalized.record.protocolComputeMicros).toBeGreaterThan(0);
    expect(normalized.record.protocolPricingVersion).toBeTruthy();
  });

  it("earns nothing", () => {
    // ...without making free farming profitable. Both halves matter.
    expect(normalized.record.economicSourceClass).toBe("free");
    expect(normalized.record.rewardStatus).toBe("ineligible");
    expect(normalized.record.rewardReason).toBe("free_inference");
    expect(normalized.record.eligibleComputeMicros).toBe(0);
  });

  it("contributes zero to the mining score", () => {
    const scored = scoreRecords([normalized.record]);
    expect(scored.weightedCostMicros).toBe(0);
    expect(scored.points).toBe(0);
    // Reported, not discarded: the user can see the compute they proved.
    expect(scored.pendingCostMicros).toBe(normalized.record.protocolComputeMicros);
  });

  it("cannot be made eligible by a provider claiming a cost it did not charge", () => {
    // A malicious user controls both their endpoint and their USAGE account.
    // Claiming an enormous cost must not turn free compute into paid compute.
    const lying = normalizeGatewayObservation(
      { ...freeObservation(), generationId: "gen_lie_1", cost: { value: "500", currency: "USD" } },
      {
        userId: "u1",
        issuance: { issuer: ISSUER, keyId: KEY.keyId, privateKeyBase64: KEY.privateKeyBase64 },
      },
    );

    // The claim lands in actual cost, where it is audit data and nothing else.
    expect(lying.record.actualCostMicros).toBe(500_000_000);
    // It buys no eligibility: a user-controlled endpoint is not evidence.
    expect(lying.record.economicSourceClass).toBe("byok");
    expect(lying.record.rewardStatus).toBe("held");
    expect(lying.record.eligibleComputeMicros).toBe(0);
    expect(scoreRecords([lying.record]).weightedCostMicros).toBe(0);
    // And the proof itself is untouched: the compute really did happen.
    expect(lying.record.protocolComputeMicros).toBe(normalized.record.protocolComputeMicros);
  });
});
