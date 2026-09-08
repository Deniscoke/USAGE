import { describe, expect, it } from "vitest";
import { buildActivityFeed } from "./activity";
import { deriveConnections, type StoredConnection } from "./connections";
import { checkStoredSignature, receiptFromStoredProof } from "./proof";
import { normalizeGatewayObservation } from "@/lib/providers/vercel-gateway/adapter";
import { generateSigningKeyPair } from "@/lib/domain/signing";
import { CURRENT_MINING_PROTOCOL, epochEmissionPoints, listMiningProtocols } from "@/lib/protocol/emission";
import { CURRENT_SCORING_VERSION } from "@/lib/domain/scoring";
import { CURRENT_PRICING_VERSION } from "@/lib/pricing/compute";
import { COMPUTE_CREDITS_IMPLEMENTED } from "@/lib/protocol/ledgers";
import type { NormalizedUsageRecord } from "@/lib/domain/types";
import type { GatewayObservation } from "@/lib/providers/vercel-gateway/observation";
import type { ProofRecordRow } from "@/lib/supabase/database.types";

const NO_CONNECTIONS: StoredConnection[] = [];
const NOTHING_ACTIVE = new Set<string>();

describe("connection state", () => {
  it("shows a capability that does not exist as coming soon, whatever is stored", () => {
    const rows = deriveConnections({
      // A stale row claiming an import connection cannot promote a capability
      // the registry says is not implemented.
      connections: [
        { provider: "openai", method: "verified_import", status: "active", lastSyncedAt: null },
      ],
      hasActiveMiner: true,
      activeProviders: new Set(["openai"]),
    });

    const openaiImport = rows.find((row) => row.key === "openai:verified_import")!;
    expect(openaiImport.state).toBe("coming_soon");
    expect(openaiImport.earns).toBe(false);
  });

  it("asks for setup when mining is available but no credential exists", () => {
    const rows = deriveConnections({
      connections: NO_CONNECTIONS,
      hasActiveMiner: false,
      activeProviders: NOTHING_ACTIVE,
    });
    expect(rows.find((row) => row.key === "anthropic:routed_mining")?.state).toBe("setup_required");
  });

  it("separates 'set up' from 'actually mining'", () => {
    const ready = deriveConnections({
      connections: NO_CONNECTIONS,
      hasActiveMiner: true,
      activeProviders: NOTHING_ACTIVE,
    });
    expect(ready.find((row) => row.key === "anthropic:routed_mining")?.state).toBe("available");

    const mining = deriveConnections({
      connections: NO_CONNECTIONS,
      hasActiveMiner: true,
      activeProviders: new Set(["anthropic"]),
    });
    const row = mining.find((entry) => entry.key === "anthropic:routed_mining")!;
    expect(row.state).toBe("active");
    expect(row.earns).toBe(true);
  });

  it("surfaces a broken or revoked connection", () => {
    const broken = deriveConnections({
      connections: [
        { provider: "anthropic", method: "routed_mining", status: "error", lastSyncedAt: null },
      ],
      hasActiveMiner: true,
      activeProviders: new Set(["anthropic"]),
    });
    expect(broken.find((row) => row.key === "anthropic:routed_mining")?.state).toBe("error");

    const revoked = deriveConnections({
      connections: [
        { provider: "anthropic", method: "routed_mining", status: "revoked", lastSyncedAt: null },
      ],
      hasActiveMiner: false,
      activeProviders: NOTHING_ACTIVE,
    });
    expect(revoked.find((row) => row.key === "anthropic:routed_mining")?.state).toBe("revoked");
  });

  it("omits methods a provider does not support at all", () => {
    const rows = deriveConnections({
      connections: NO_CONNECTIONS,
      hasActiveMiner: false,
      activeProviders: NOTHING_ACTIVE,
    });
    expect(rows.some((row) => row.key === "openai:subscription")).toBe(false);
  });
});

function record(overrides: Partial<NormalizedUsageRecord> = {}): NormalizedUsageRecord {
  return {
    provider: "vercel-ai-gateway",
    source: "vercel_ai_gateway",
    externalReference: "live:gen_1",
    model: "anthropic/claude-haiku-4.5",
    occurredAt: "2026-09-08T10:00:00.000Z",
    inputTokens: 1_000,
    cachedInputTokens: 200,
    outputTokens: 300,
    requests: 1,
    reportedCostMicros: null,
    normalizedCostMicros: 0,
    verificationType: "routed",
    verificationStatus: "confirmed",
    economicStatus: "eligible",
    protocolComputeMicros: 2_720,
    protocolPricingVersion: "usage-pricing-v2",
    rawMetadata: { client_type: "claude-code" },
    ...overrides,
  };
}

describe("activity feed", () => {
  it("speaks product language and links to the proof", () => {
    const [item] = buildActivityFeed({
      events: [{ ...record(), id: "event-1" }],
      proofStatusById: new Map([["event-1", "confirmed"]]),
    });

    expect(item.id).toBe("event-1");
    expect(item.provider).toBe("Anthropic");
    expect(item.modelLabel).toBe("claude-haiku-4.5");
    expect(item.tool).toBe("Claude Code");
    expect(item.tokens).toBe(1_500);
    expect(item.proofStatus).toBe("confirmed");
    expect(item.contributesToMining).toBe(true);
  });

  it("counts settled usage as having contributed, without counting it again", () => {
    const [settled] = buildActivityFeed({
      events: [{ ...record({ economicStatus: "settled" }), id: "e" }],
    });
    expect(settled.contributesToMining).toBe(true);
  });

  it("shows reported usage but never as a contribution", () => {
    const [item] = buildActivityFeed({
      events: [
        { ...record({ verificationType: "reported", economicStatus: "ineligible" }), id: "e" },
      ],
    });
    expect(item.verificationType).toBe("reported");
    expect(item.contributesToMining).toBe(false);
  });

  it("leaves protocol compute unknown rather than zero when nothing priced it", () => {
    const [item] = buildActivityFeed({
      events: [
        {
          ...record({ protocolPricingVersion: null, protocolComputeMicros: 0 }),
          id: "e",
        },
      ],
    });
    expect(item.protocolComputeMicros).toBeNull();
  });

  it("carries no conversation content of any kind", () => {
    const feed = buildActivityFeed({ events: [{ ...record(), id: "e" }] });
    const serialized = JSON.stringify(feed);
    for (const forbidden of ["prompt", "message", "content", "completion", "text"]) {
      expect(serialized.toLowerCase()).not.toContain(forbidden);
    }
  });
});

describe("proof re-verification", () => {
  const KEY = generateSigningKeyPair("product-key");
  const ISSUER = "usage://issuer/production";

  function observation(): GatewayObservation {
    return {
      environment: "live",
      generationId: "gen_product_1",
      model: "anthropic/claude-haiku-4.5",
      clientType: "claude-code",
      servedByProvider: "anthropic",
      occurredAt: "2026-09-08T10:00:00.000Z",
      usage: {
        inputTokens: 1_200,
        outputTokens: 300,
        inputTokenDetails: { noCacheTokens: 1_000, cacheReadTokens: 200, cacheWriteTokens: 40 },
      },
      cost: null,
      finishReason: "end_turn",
    };
  }

  function issue() {
    return normalizeGatewayObservation(observation(), {
      userId: "00000000-0000-4000-8000-000000000001",
      minerCredentialId: "cred-1",
      issuance: { issuer: ISSUER, keyId: KEY.keyId, privateKeyBase64: KEY.privateKeyBase64 },
    });
  }

  /** The row shape ingestion writes, so the test exercises the real round trip. */
  function storedProof(normalized: ReturnType<typeof issue>): ProofRecordRow {
    const proof = normalized.proof;
    return {
      id: "proof-1",
      user_id: "00000000-0000-4000-8000-000000000001",
      usage_event_id: "event-1",
      verification_type: normalized.record.verificationType,
      proof_kind: proof.proofKind,
      proof_source: proof.proofSource,
      external_reference: proof.externalReference,
      observed_at: proof.observedAt,
      ingested_at: "2026-09-08T10:00:01.000Z",
      adapter_version: proof.adapterVersion,
      proof_hash: proof.proofHash,
      trust_environment: proof.trustEnvironment,
      proof_status: proof.proofStatus,
      receipt_id: proof.receiptId,
      receipt_version: proof.receiptVersion,
      issuer: proof.issuer,
      issuer_key_id: proof.issuerKeyId,
      signature: proof.signature,
      signed_at: proof.signedAt,
      proof_metadata: proof.metadata,
    } as ProofRecordRow;
  }

  it("rebuilds a stored proof exactly, so its signature still verifies", () => {
    const normalized = issue();
    const rebuilt = receiptFromStoredProof(normalized.record, storedProof(normalized));

    const check = checkStoredSignature(rebuilt, { [KEY.keyId]: KEY.publicKeyBase64 }, ISSUER);
    expect(check.state).toBe("valid");
  });

  it("rejects a proof whose stored numbers were altered", () => {
    const normalized = issue();
    // Someone edits the token counts in the database. The signature covers
    // them, so the proof stops verifying -- which is the entire point.
    const tampered = { ...normalized.record, outputTokens: 999_999 };
    const rebuilt = receiptFromStoredProof(tampered, storedProof(normalized));

    const check = checkStoredSignature(rebuilt, { [KEY.keyId]: KEY.publicKeyBase64 }, ISSUER);
    expect(check.state).toBe("invalid");
  });

  it("distinguishes unsigned and unverifiable from invalid", () => {
    const normalized = issue();
    expect(checkStoredSignature(null, { k: "v" }, ISSUER).state).toBe("unsigned");
    // No key available is a limitation of the checker, not evidence of forgery.
    const rebuilt = receiptFromStoredProof(normalized.record, storedProof(normalized));
    expect(checkStoredSignature(rebuilt, {}, ISSUER).state).toBe("unverifiable");
  });

  it("refuses a receipt signed by an unexpected issuer", () => {
    const normalized = issue();
    const rebuilt = receiptFromStoredProof(normalized.record, storedProof(normalized));
    const check = checkStoredSignature(
      rebuilt,
      { [KEY.keyId]: KEY.publicKeyBase64 },
      "usage://issuer/somebody-else",
    );
    expect(check.state).toBe("invalid");
  });
});

describe("mining protocol configuration", () => {
  it("keeps emission fixed and versioned rather than scattered", () => {
    expect(epochEmissionPoints()).toBe(CURRENT_MINING_PROTOCOL.epochEmissionPoints);
    expect(epochEmissionPoints()).toBeGreaterThan(0);
  });

  it("pins the scoring and pricing it was defined against", () => {
    expect(CURRENT_MINING_PROTOCOL.scoringVersion).toBe(CURRENT_SCORING_VERSION);
    expect(CURRENT_MINING_PROTOCOL.pricingVersion).toBe(CURRENT_PRICING_VERSION);
  });

  it("says plainly that this is not a public network", () => {
    expect(CURRENT_MINING_PROTOCOL.network).toBe("development");
  });

  it("names every protocol version exactly once", () => {
    const versions = listMiningProtocols().map((protocol) => protocol.version);
    expect(new Set(versions).size).toBe(versions.length);
  });

  it("has no rate converting compute into points", () => {
    // A fixed points-per-token or points-per-dollar rate would make wasteful
    // farming rational. There must not be a field that could become one.
    const serialized = JSON.stringify(CURRENT_MINING_PROTOCOL).toLowerCase();
    expect(serialized).not.toContain("pertoken");
    expect(serialized).not.toContain("rate");
  });

  it("keeps Compute Credits unimplemented and separate from Usage Points", () => {
    expect(COMPUTE_CREDITS_IMPLEMENTED).toBe(false);
  });
});
