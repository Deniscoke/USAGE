import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  canonicalReceipt,
  deriveEconomicStatus,
  RECEIPT_VERSION,
  receiptHash,
  signReceipt,
  verifyUsageReceipt,
  type ProofReceipt,
  type SignedProofReceipt,
} from "./receipt";
import { generateSigningKeyPair, publicKeyFromPrivate } from "./signing";
import { assessTrust, publishedPublicKeys } from "@/lib/trust/production";
import { checkVercelDeploymentIdentity } from "@/lib/trust/vercel-oidc";
import { normalizeGatewayObservation } from "@/lib/providers/vercel-gateway/adapter";
import type { GatewayObservation } from "@/lib/providers/vercel-gateway/observation";
import { resolveCost } from "./cost";

/**
 * The root-of-trust tests.
 *
 * The claim under test: a receipt is trustworthy because of who signed it, not
 * because of what it says about itself or what environment variable was set.
 */

const PRODUCTION = generateSigningKeyPair("usage-prod-1");
const ATTACKER = generateSigningKeyPair("usage-prod-1"); // same key id, wrong key
const ISSUER = "usage://issuer/production";

function receipt(overrides: Partial<ProofReceipt> = {}): ProofReceipt {
  return {
    receiptVersion: RECEIPT_VERSION,
    receiptId: "11111111-1111-4111-8111-111111111111",
    issuer: ISSUER,
    issuerKeyId: PRODUCTION.keyId,
    userId: "user-1",
    minerCredentialId: "cred-1",
    source: "vercel_ai_gateway",
    clientType: "claude-code",
    provider: "anthropic",
    model: "anthropic/claude-haiku-4.5",
    generationId: "gen_1",
    generationIdSource: "gateway_generation_id",
    trustEnvironment: "production",
    inputTokens: 100,
    cachedReadTokens: 0,
    cachedWriteTokens: 0,
    outputTokens: 20,
    reasoningTokens: null,
    requests: 1,
    costMicroUsd: 4_000_000,
    costBasis: "gateway_reported",
    currency: "USD",
    occurredAt: "2026-05-05T10:00:00.000Z",
    observedAt: "2026-05-05T10:00:01.000Z",
    verificationType: "routed",
    verificationStatus: "confirmed",
    proofStatus: "confirmed",
    economicStatus: "eligible",
    adapterVersion: "vercel-gateway@1",
    ...overrides,
  };
}

const verifyOptions = {
  publicKeys: { [PRODUCTION.keyId]: PRODUCTION.publicKeyBase64 },
  expectedIssuer: ISSUER,
};

describe("signature is the root of trust", () => {
  it("accepts a receipt signed by the production key", () => {
    const signed = signReceipt(receipt(), PRODUCTION.privateKeyBase64);
    const result = verifyUsageReceipt(signed, verifyOptions);

    expect(result.valid).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.issuerKeyId).toBe(PRODUCTION.keyId);
  });

  it("rejects a receipt a local attacker invented and hashed themselves", () => {
    const forged = receipt();
    // Perfectly well-formed, perfectly self-consistent, and worthless.
    const selfMade: SignedProofReceipt = {
      receipt: forged,
      canonicalHash: receiptHash(forged),
      signature: "not-a-real-signature",
      signedAt: new Date().toISOString(),
    };

    const result = verifyUsageReceipt(selfMade, verifyOptions);
    expect(result.valid).toBe(false);
    expect(result.failures).toContain("signature does not verify");
  });

  it("rejects a receipt signed by a different key claiming the same key id", () => {
    const signed = signReceipt(receipt(), ATTACKER.privateKeyBase64);
    expect(verifyUsageReceipt(signed, verifyOptions).valid).toBe(false);
  });

  it("rejects an unknown signing key", () => {
    const other = generateSigningKeyPair("rotated-key-2");
    const signed = signReceipt(receipt({ issuerKeyId: other.keyId }), other.privateKeyBase64);

    const result = verifyUsageReceipt(signed, verifyOptions);
    expect(result.valid).toBe(false);
    expect(result.failures[0]).toContain("unknown signing key");
  });

  it("rejects an unexpected issuer", () => {
    const signed = signReceipt(receipt({ issuer: "usage://issuer/someone-else" }), PRODUCTION.privateKeyBase64);
    const result = verifyUsageReceipt(signed, verifyOptions);
    expect(result.valid).toBe(false);
    expect(result.failures.some((f) => f.includes("unexpected issuer"))).toBe(true);
  });

  it("rejects an unsupported receipt version", () => {
    const signed = signReceipt(receipt({ receiptVersion: "usage.receipt.v99" }), PRODUCTION.privateKeyBase64);
    expect(verifyUsageReceipt(signed, verifyOptions).valid).toBe(false);
  });
});

describe("tampering after signing", () => {
  const mutations: [string, Partial<ProofReceipt>][] = [
    ["user", { userId: "someone-else" }],
    ["generation id", { generationId: "gen_stolen" }],
    ["model", { model: "anthropic/claude-opus-5" }],
    ["input tokens", { inputTokens: 10_000_000 }],
    ["output tokens", { outputTokens: 999_999 }],
    ["cost", { costMicroUsd: 999_000_000 }],
    ["cost basis", { costBasis: "estimated" }],
    ["timestamp", { occurredAt: "2026-06-06T00:00:00.000Z" }],
    ["verification status", { verificationStatus: "pending" }],
    ["proof status", { proofStatus: "observed" }],
    ["economic status", { economicStatus: "pending_cost" }],
    ["trust environment", { trustEnvironment: "development" }],
  ];

  it.each(mutations)("invalidates the signature when %s changes", (_label, mutation) => {
    const signed = signReceipt(receipt(), PRODUCTION.privateKeyBase64);
    const tampered: SignedProofReceipt = { ...signed, receipt: { ...signed.receipt, ...mutation } };

    const result = verifyUsageReceipt(tampered, verifyOptions);
    expect(result.valid).toBe(false);
    // The body no longer matches the hash that was signed.
    expect(result.failures).toContain("canonical hash does not match receipt contents");
  });

  it("also fails when the hash is recomputed to match the tampered body", () => {
    const signed = signReceipt(receipt(), PRODUCTION.privateKeyBase64);
    const tamperedReceipt = { ...signed.receipt, costMicroUsd: 999_000_000 };
    const resealed: SignedProofReceipt = {
      ...signed,
      receipt: tamperedReceipt,
      canonicalHash: receiptHash(tamperedReceipt),
    };

    // Integrity restored, origin still missing: the signature covers the hash.
    expect(verifyUsageReceipt(resealed, verifyOptions).failures).toContain(
      "signature does not verify",
    );
  });

  it("covers every economic field in the canonical form", () => {
    const canonical = canonicalReceipt(receipt());
    for (const field of [
      "userId",
      "generationId",
      "inputTokens",
      "outputTokens",
      "costMicroUsd",
      "costBasis",
      "proofStatus",
      "economicStatus",
      "trustEnvironment",
    ]) {
      expect(canonical).toContain(`${field}=`);
    }
  });
});

describe("environment variables are not the root of trust", () => {
  const OLD_ENV = { ...process.env };

  beforeEach(() => {
    for (const key of [
      "USAGE_RECEIPT_SIGNING_PRIVATE_KEY",
      "USAGE_RECEIPT_SIGNING_KEY_ID",
      "USAGE_RECEIPT_ISSUER",
      "USAGE_TRUST_ENVIRONMENT",
      "USAGE_VERCEL_OIDC_ISSUER",
    ]) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    process.env = { ...OLD_ENV };
  });

  it("refuses to issue production proofs on a claim alone", async () => {
    process.env.USAGE_TRUST_ENVIRONMENT = "production";

    const trust = await assessTrust();
    expect(trust.canIssueProduction).toBe(false);
    expect(trust.issuer).toBeNull();
    expect(trust.signals.environmentHint).toBe("production");
    expect(trust.reasons[0]).toContain("no production signing key");
  });

  it("issues only when the signing key is present", async () => {
    process.env.USAGE_RECEIPT_SIGNING_PRIVATE_KEY = PRODUCTION.privateKeyBase64;
    process.env.USAGE_RECEIPT_SIGNING_KEY_ID = PRODUCTION.keyId;

    const trust = await assessTrust();
    expect(trust.canIssueProduction).toBe(true);
    expect(trust.issuer?.keyId).toBe(PRODUCTION.keyId);
  });

  it("refuses a signing key that is not a usable key", async () => {
    // A pasted variable name, a quoted value, a truncated key: all non-empty.
    process.env.USAGE_RECEIPT_SIGNING_PRIVATE_KEY = "USAGE_RECEIPT_SIGNING_PRIVATE_KEY=MC4CAQ";
    process.env.USAGE_RECEIPT_SIGNING_KEY_ID = "usage-prod-1";

    const trust = await assessTrust();
    expect(trust.canIssueProduction).toBe(false);
    expect(trust.reasons[0]).toContain("not a usable");
    // And it must not advertise a key it cannot sign with.
    expect(publishedPublicKeys()).toEqual({});
  });

  it("refuses when configured deployment identity cannot be verified", async () => {
    process.env.USAGE_RECEIPT_SIGNING_PRIVATE_KEY = PRODUCTION.privateKeyBase64;
    process.env.USAGE_RECEIPT_SIGNING_KEY_ID = PRODUCTION.keyId;
    process.env.USAGE_VERCEL_OIDC_ISSUER = "https://oidc.vercel.com/usage";

    // No token presented, which is what a local process would look like.
    const trust = await assessTrust(new Headers());
    expect(trust.canIssueProduction).toBe(false);
    expect(trust.signals.oidc).toBe("missing_token");
  });

  it("publishes the public half of the signing key for verifiers", () => {
    process.env.USAGE_RECEIPT_SIGNING_PRIVATE_KEY = PRODUCTION.privateKeyBase64;
    process.env.USAGE_RECEIPT_SIGNING_KEY_ID = PRODUCTION.keyId;

    const keys = publishedPublicKeys();
    expect(keys[PRODUCTION.keyId]).toBe(publicKeyFromPrivate(PRODUCTION.privateKeyBase64));
    expect(JSON.stringify(keys)).not.toContain(PRODUCTION.privateKeyBase64);
  });
});

describe("vercel deployment identity", () => {
  const expectation = {
    issuer: "https://oidc.vercel.com/usage",
    projectId: "prj_123",
    ownerId: "team_abc",
    environment: "production",
  };

  it("accepts the expected production deployment", async () => {
    const check = await checkVercelDeploymentIdentity("token", expectation, async () => ({
      iss: expectation.issuer,
      project_id: "prj_123",
      owner_id: "team_abc",
      environment: "production",
    }));
    expect(check.state).toBe("verified");
  });

  it("rejects a token pulled to a developer machine", async () => {
    // `vercel env pull` gives a real, valid token — for the development environment.
    const check = await checkVercelDeploymentIdentity("token", expectation, async () => ({
      iss: expectation.issuer,
      project_id: "prj_123",
      owner_id: "team_abc",
      environment: "development",
    }));
    expect(check).toEqual({ state: "failed", reason: "environment is development" });
  });

  it("rejects another project or another team", async () => {
    const wrongProject = await checkVercelDeploymentIdentity("t", expectation, async () => ({
      iss: expectation.issuer,
      project_id: "prj_other",
      owner_id: "team_abc",
      environment: "production",
    }));
    expect(wrongProject).toEqual({ state: "failed", reason: "project id does not match" });

    const wrongOwner = await checkVercelDeploymentIdentity("t", expectation, async () => ({
      iss: expectation.issuer,
      project_id: "prj_123",
      owner_id: "team_other",
      environment: "production",
    }));
    expect(wrongOwner).toEqual({ state: "failed", reason: "owner id does not match" });
  });

  it("rejects a token that fails signature verification", async () => {
    const check = await checkVercelDeploymentIdentity("forged", expectation, async () => {
      throw new Error("signature verification failed");
    });
    expect(check.state).toBe("failed");
  });
});

describe("a local gateway cannot mint confirmed proofs", () => {
  const observation: GatewayObservation = {
    environment: "development",
    generationId: "gen_local_1",
    model: "anthropic/claude-haiku-4.5",
    clientType: "claude-code",
    occurredAt: "2026-05-05T10:00:00.000Z",
    usage: { inputTokens: 100, outputTokens: 20 },
    cost: { value: "4.00", currency: "USD" },
  };

  it("stays OBSERVED and ineligible even if handed a signing key", () => {
    const { record, receipt: issued, signed } = normalizeGatewayObservation(observation, {
      userId: "user-1",
      issuance: {
        issuer: ISSUER,
        keyId: PRODUCTION.keyId,
        privateKeyBase64: PRODUCTION.privateKeyBase64,
      },
    });

    // The trust environment is part of the decision, not just key possession.
    expect(issued.proofStatus).toBe("observed");
    expect(issued.economicStatus).toBe("ineligible");
    expect(record.economicStatus).toBe("ineligible");
    expect(signed).toBeNull();
  });

  it("confirms the same request when it is observed in production", () => {
    const { receipt: issued, signed } = normalizeGatewayObservation(
      { ...observation, environment: "live" },
      {
        userId: "user-1",
        issuance: {
          issuer: ISSUER,
          keyId: PRODUCTION.keyId,
          privateKeyBase64: PRODUCTION.privateKeyBase64,
        },
      },
    );

    expect(issued.proofStatus).toBe("confirmed");
    expect(issued.economicStatus).toBe("eligible");
    expect(signed).not.toBeNull();
    expect(verifyUsageReceipt(signed!, verifyOptions).valid).toBe(true);
  });

  it("confirms without cost, and holds the economics", () => {
    const { receipt: issued, signed } = normalizeGatewayObservation(
      { ...observation, environment: "live", cost: null },
      {
        userId: "user-1",
        issuance: {
          issuer: ISSUER,
          keyId: PRODUCTION.keyId,
          privateKeyBase64: PRODUCTION.privateKeyBase64,
        },
      },
    );

    // A real proof whose price nobody has stated yet.
    expect(issued.proofStatus).toBe("confirmed");
    expect(issued.economicStatus).toBe("pending_cost");
    expect(issued.costMicroUsd).toBeNull();
    expect(verifyUsageReceipt(signed!, verifyOptions).valid).toBe(true);
  });
});

describe("economic classification", () => {
  it("separates proof soundness from payability", () => {
    const base = { verificationType: "routed" as const, costMicroUsd: 1_000 };

    expect(deriveEconomicStatus({ ...base, proofStatus: "confirmed", costBasis: "gateway_reported" })).toBe("eligible");
    expect(deriveEconomicStatus({ ...base, proofStatus: "confirmed", costBasis: "unavailable" })).toBe("pending_cost");
    // An estimate is not an invoice.
    expect(deriveEconomicStatus({ ...base, proofStatus: "confirmed", costBasis: "estimated" })).toBe("pending_cost");
    expect(deriveEconomicStatus({ ...base, proofStatus: "observed", costBasis: "gateway_reported" })).toBe("ineligible");
    expect(
      deriveEconomicStatus({ ...base, verificationType: "reported", proofStatus: "confirmed", costBasis: "gateway_reported" }),
    ).toBe("ineligible");
  });
});

describe("cost resolution", () => {
  const query = {
    provider: "anthropic",
    model: "anthropic/claude-haiku-4.5",
    generationId: "gen_1",
    inputTokens: 100,
    cachedReadTokens: 0,
    cachedWriteTokens: 0,
    outputTokens: 20,
    reportedCostMicros: null,
  };

  it("uses the gateway figure when there is one", async () => {
    const resolved = await resolveCost({ ...query, reportedCostMicros: 4_000_000 });
    expect(resolved).toMatchObject({ costMicroUsd: 4_000_000, costBasis: "gateway_reported" });
  });

  it("reports unknown rather than inventing a price", async () => {
    const resolved = await resolveCost(query);
    expect(resolved.costMicroUsd).toBeNull();
    expect(resolved.costBasis).toBe("unavailable");
  });
});
