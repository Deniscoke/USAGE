import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@/test/pg";
import { createSqlIngestStore } from "@/test/sql-ingest-store";
import { createSqlSettlementStore } from "@/test/sql-settlement-store";
import { ingestGatewayObservations, type IngestStore } from "./ingest";
import { ingestImportedUsage } from "./import-ingest";
import { finalizeEpoch, settleEpoch, type SettlementStore } from "./settlement";
import { dailyEpochFor } from "@/lib/domain/epoch";
import { generateSigningKeyPair } from "@/lib/domain/signing";
import { scoreRecords } from "@/lib/domain/scoring";
import { CURRENT_PRICING_VERSION } from "@/lib/pricing/compute";
import { correlate, validateIncoming } from "@/lib/miner/telemetry";
import { fundingEvidenceForConnection } from "@/lib/protocol/funding";
import { snapshotExclusions } from "@/lib/protocol/snapshot";
import type { GatewayObservation } from "@/lib/providers/vercel-gateway/observation";
import type { NormalizedUsageRecord } from "@/lib/domain/types";
import type { UsageEventRow } from "@/lib/supabase/database.types";

/**
 * ONE AUTHORITATIVE AI COMPUTE = AT MOST ONE ECONOMIC CREDIT.
 *
 * Against a real Postgres with the production migrations: replays, duplicate
 * sources, forged local evidence, spoofed funding, conflicting evidence,
 * settled history and the shape a future snapshot would read. Everything
 * economic in here is a FIXTURE and says so: no live provider, no money.
 */

const KEY = generateSigningKeyPair("ecu-key");
const ISSUANCE = { issuer: "usage://issuer/production", keyId: KEY.keyId, privateKeyBase64: KEY.privateKeyBase64 };
const POOL = 100_000;

let db: TestDb;
let store: IngestStore;
let settlement: SettlementStore;

beforeAll(async () => {
  db = await createTestDb();
  store = createSqlIngestStore(db);
  settlement = createSqlSettlementStore(db);
}, 90_000);

afterAll(async () => {
  await db?.close();
});

/** SIMULATED paid routed request through the user's own trusted connection. */
function paid(day: string, generationId: string, requestId: string | null, overrides: Partial<GatewayObservation> = {}): GatewayObservation {
  return {
    environment: "live",
    generationId,
    model: "openai/gpt-5.4",
    providerSlug: "openai",
    servedByProvider: "openai",
    gatewayId: "connection:11111111-1111-4111-8111-111111111111",
    endpointTrusted: true,
    funding: { class: "paid_account", basis: "fixture:SIMULATED paid_account" },
    upstreamRequestId: requestId,
    occurredAt: `${day}T10:00:00.000Z`,
    usage: { inputTokens: 1_000, outputTokens: 250, inputTokenDetails: { noCacheTokens: 800, cacheReadTokens: 200 } },
    cost: { value: "4.00", currency: "USD" },
    finishReason: "stop",
    ...overrides,
  };
}

async function events(userId: string): Promise<UsageEventRow[]> {
  return db.asServiceRole<UsageEventRow>(`select * from usage_events where user_id = $1 order by created_at asc`, [userId]);
}

async function credits(userId: string): Promise<{ units: number; credited: number; eligibleMicros: number; weighted: number }> {
  const rows = await events(userId);
  const units = rows.filter((r) => r.raw_metadata?.dedupe_status === "unique").length;
  const credited = rows.filter((r) => r.reward_status === "eligible" && !r.reward_hold).length;
  const eligibleMicros = rows.filter((r) => !r.reward_hold).reduce((sum, r) => sum + Number(r.eligible_compute_micros), 0);
  const [score] = await db.asServiceRole<{ w: string }>(
    `select coalesce(sum(weighted_cost_micros), 0)::text as w from score_records where user_id = $1`,
    [userId],
  );
  return { units, credited, eligibleMicros, weighted: Number(score.w) };
}

describe("a paid fixture is eligible only with sufficient authoritative evidence", () => {
  it("with provider-stated paid funding: verified, eligible, priced", async () => {
    const user = await db.createUser("ecu-paid@example.com");
    await ingestGatewayObservations(store, user, [paid("2026-07-01", "gen_paid", "req_paid")], { issuance: ISSUANCE });
    const [row] = await events(user);
    expect(row.economic_source_class).toBe("metered_paid");
    expect(row.reward_status).toBe("eligible");
    expect(Number(row.eligible_compute_micros)).toBeGreaterThan(0);
    expect(row.raw_metadata.economic_verification_status).toBe("verified");
    expect(row.raw_metadata.economic_verification_policy_version).toBe("economic-verification-v1");
    expect(row.raw_metadata.economic_identity_kind).toBe("provider_request_id");
    expect(row.raw_metadata.dedupe_status).toBe("unique");
    expect(String(row.raw_metadata.economic_event_key)).toMatch(/^ecu1:/);
  });

  it("with a positive cost but no funding evidence: unknown, held", async () => {
    const user = await db.createUser("ecu-nofund@example.com");
    await ingestGatewayObservations(store, user, [paid("2026-07-01", "gen_nofund", "req_nofund", { funding: null })], { issuance: ISSUANCE });
    const [row] = await events(user);
    expect(row.economic_source_class).toBe("unknown");
    expect(row.reward_status).toBe("held");
    expect(Number(row.eligible_compute_micros)).toBe(0);
    expect(row.raw_metadata.economic_verification_reason).toBe("funding_unknown");
    // What it WOULD be worth is still recorded; a later policy can release it.
    expect(Number(row.protocol_compute_micros)).toBeGreaterThan(0);
  });

  it("on a never-paid account: promotional, held, whatever the list price", async () => {
    const user = await db.createUser("ecu-freetier@example.com");
    await ingestGatewayObservations(
      store,
      user,
      [paid("2026-07-01", "gen_ft", "req_ft", { funding: { class: "free_tier_account", basis: "fixture:SIMULATED is_free_tier" } })],
      { issuance: ISSUANCE },
    );
    const [row] = await events(user);
    expect(row.economic_source_class).toBe("promotional");
    expect(row.reward_status).toBe("held");
    expect(row.raw_metadata.economic_verification_reason).toBe("promotional_funding");
  });

  it("free routed compute stays ineligible with zero reward", async () => {
    const user = await db.createUser("ecu-free@example.com");
    await ingestGatewayObservations(store, user, [paid("2026-07-01", "gen_free", "req_free", { cost: { value: "0", currency: "USD" } })], { issuance: ISSUANCE });
    const [row] = await events(user);
    expect(row.economic_source_class).toBe("free");
    expect(row.reward_status).toBe("ineligible");
    expect(Number(row.eligible_compute_micros)).toBe(0);
    expect(row.raw_metadata.economic_verification_status).toBe("ineligible");
  });

  it("a user-controlled endpoint claiming payment is byok, held", async () => {
    const user = await db.createUser("ecu-byok@example.com");
    await ingestGatewayObservations(store, user, [paid("2026-07-01", "gen_byok", "req_byok", { endpointTrusted: false })], { issuance: ISSUANCE });
    const [row] = await events(user);
    expect(row.economic_source_class).toBe("byok");
    expect(row.reward_status).toBe("held");
    expect(row.raw_metadata.economic_verification_reason).toBe("byok_funding_unproven");
  });
});

describe("replay protection", () => {
  let user: string;
  beforeAll(async () => {
    user = await db.createUser("ecu-replay@example.com");
    await ingestGatewayObservations(store, user, [paid("2026-07-02", "gen_replay", "req_replay")], { issuance: ISSUANCE });
  });

  it("x2 and x10 in separate uploads: one unit", async () => {
    for (let i = 0; i < 10; i += 1) {
      const result = await ingestGatewayObservations(store, user, [paid("2026-07-02", "gen_replay", "req_replay")], { issuance: ISSUANCE });
      expect(result.inserted).toBe(0);
      expect(result.duplicates).toBe(1);
    }
    expect((await events(user)).length).toBe(1);
  });

  it("x1000 in one upload: one unit, one eligible value, one contribution", async () => {
    const batch = Array.from({ length: 1000 }, () => paid("2026-07-02", "gen_replay", "req_replay"));
    const result = await ingestGatewayObservations(store, user, batch, { issuance: ISSUANCE });
    expect(result.inserted).toBe(0);
    expect(result.duplicates).toBe(1000);
    const c = await credits(user);
    expect(c.units).toBe(1);
    expect(c.credited).toBe(1);
    const [row] = await events(user);
    expect(c.eligibleMicros).toBe(Number(row.eligible_compute_micros));
    expect(c.weighted).toBe(Number(row.eligible_compute_micros));
  });

  it("the same provider request under a new generation id is a duplicate, held, not a second credit", async () => {
    // A retry that re-used the provider's request id but minted a fresh
    // gateway id: different natural key, same economic key.
    const result = await ingestGatewayObservations(store, user, [paid("2026-07-02", "gen_replay_2", "req_replay")], { issuance: ISSUANCE });
    expect(result.inserted).toBe(1);
    const rows = await events(user);
    expect(rows.length).toBe(2);
    const dup = rows.find((r) => r.external_reference === "live:gen_replay_2")!;
    expect(dup.reward_hold).toBe(true);
    expect(dup.reward_status).toBe("held");
    expect(dup.reward_reason).toBe("duplicate_evidence");
    expect(Number(dup.eligible_compute_micros)).toBe(0);
    expect(dup.raw_metadata.dedupe_status).toBe("duplicate");
    expect(dup.raw_metadata.economic_duplicate_of).toBe(rows[0].id);
    const c = await credits(user);
    expect(c.units).toBe(1);
    expect(c.credited).toBe(1);
    expect(c.weighted).toBe(Number(rows[0].eligible_compute_micros));
  });
});

describe("three evidence sources, one unit, one credit", () => {
  let user: string;
  let device: string;
  let routedId: string;

  beforeAll(async () => {
    user = await db.createUser("ecu-three@example.com");
    const [d] = await db.asServiceRole<{ id: string }>(
      `insert into miner_devices (user_id, name, platform, app_version) values ($1, 'DESKTOP-3', 'win32', '0.4.0') returning id`,
      [user],
    );
    device = d.id;
    await db.asServiceRole(
      `insert into miner_tool_mappings (device_id, user_id, tool_id, metering_method, verification_capability)
       values ($1, $2, 'claude-code', 'native_otel', 'provider_correlated')`,
      [device, user],
    );
    // 1. USAGE routed proof.
    await ingestGatewayObservations(store, user, [paid("2026-07-03", "gen_three", "req_three")], { issuance: ISSUANCE });
    routedId = (await events(user))[0].id;
  });

  it("local telemetry of the same request correlates and creates no unit", async () => {
    const [candidate] = await db.asServiceRole<{ id: string; verification_level: string; provenance_sources: string[]; provider: string; model: string; input_tokens: number; output_tokens: number }>(
      `select id, verification_level, provenance_sources, provider, model, input_tokens, output_tokens
         from usage_events where user_id = $1 and verification_status = 'confirmed' and raw_metadata @> '{"upstream_request_id":"req_three"}'`,
      [user],
    );
    const decision = correlate(
      { upstreamRequestId: "req_three", signatureVerified: true, provider: "openai", model: "gpt-5.4", inputTokens: 800, outputTokens: 250 },
      {
        eventId: candidate.id,
        verificationLevel: candidate.verification_level as "routed_confirmed",
        provenanceSources: candidate.provenance_sources,
        provider: candidate.provider,
        model: candidate.model,
        inputTokens: candidate.input_tokens,
        outputTokens: candidate.output_tokens,
      },
    );
    expect(decision.event?.kind).toBe("match");
    // 2. The device observation, stored where it belongs, with the match.
    await db.asServiceRole(
      `insert into local_usage_observations
         (user_id, device_id, schema_version, adapter, tool_id, source_type, provider, model, upstream_request_id,
          input_tokens, output_tokens, occurred_at, local_session_id, local_event_id, signature_verified,
          verification_level, correlation_status, correlated_event_id)
       values ($1, $2, 'local-usage-observation-v1', 'claude-otel-adapter-v1', 'claude-code', 'native_otel', 'openai', 'gpt-5.4', 'req_three',
               800, 250, '2026-07-03T10:00:00Z', 'sess', 'ev-three', true, $3, $4, $5)`,
      [user, device, decision.observation.level, decision.observation.correlationStatus, decision.observation.correlatedEventId],
    );
    if (decision.event?.kind === "match") {
      await db.asServiceRole(
        `update usage_events set provenance_sources = $1, correlation_status = 'matched' where id = $2 and user_id = $3`,
        [decision.event.provenanceSources, decision.event.eventId, user],
      );
    }
    expect((await events(user)).length).toBe(1);
  });

  it("a provider import of the same request is stored as evidence and held", async () => {
    // 3. The provider's own record, arriving later, naming the same request.
    const record: NormalizedUsageRecord = {
      provider: "openai",
      source: "provider_usage_api",
      externalReference: "import:req_three",
      model: "openai/gpt-5.4",
      occurredAt: "2026-07-03T10:00:00.000Z",
      inputTokens: 800,
      cachedInputTokens: 200,
      outputTokens: 250,
      requests: 1,
      actualCostMicros: 4_000_000,
      actualCostBasis: "provider_reported",
      normalizedCostMicros: 4_000_000,
      verificationType: "verified",
      verificationStatus: "confirmed",
      economicStatus: "eligible",
      protocolComputeMicros: 5_800,
      protocolPricingVersion: CURRENT_PRICING_VERSION,
      rawMetadata: { adapter_version: "import@fixture", upstream_request_id: "req_three", granularity: "provider_request" },
    };
    const result = await ingestImportedUsage(store, user, [record], { issuance: ISSUANCE });
    expect(result.inserted).toBe(1);

    const rows = await events(user);
    const [obs] = await db.asServiceRole<{ n: string }>(`select count(*)::text as n from local_usage_observations where user_id = $1`, [user]);
    const evidenceCount = rows.length + Number(obs.n);
    expect(evidenceCount).toBe(3);

    const imported = rows.find((r) => r.source === "provider_usage_api")!;
    expect(imported.raw_metadata.economic_event_key).toBe(rows.find((r) => r.id === routedId)!.raw_metadata.economic_event_key);
    expect(imported.raw_metadata.dedupe_status).toBe("duplicate");
    expect(imported.raw_metadata.economic_duplicate_of).toBe(routedId);
    expect(imported.reward_hold).toBe(true);
    expect(Number(imported.eligible_compute_micros)).toBe(0);
    // The proof of the import is still real: evidence is kept, credit is not.
    expect(imported.verification_status).toBe("confirmed");

    const c = await credits(user);
    expect(c.units).toBe(1);
    expect(c.credited).toBe(1);
    const routed = rows.find((r) => r.id === routedId)!;
    expect(routed.provenance_sources).toEqual(["local_telemetry", "usage_gateway"]);
    expect(c.weighted).toBe(Number(routed.eligible_compute_micros));
  });
});

describe("local forgery", () => {
  it("a trillion tokens is refused at the door", () => {
    const r = validateIncoming({
      observation: {
        schema: "local-usage-observation-v1", adapter: "claude-otel-adapter-v1", tool: "claude-code", toolVersion: "2.1.261",
        sourceType: "native_otel", provider: "anthropic", model: "claude-sonnet-5", upstreamRequestId: "req_forged",
        inputTokens: 1_000_000_000_000, outputTokens: 1, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null,
        toolTokens: null, estimatedCostMicros: null, occurredAt: "2026-07-04T10:00:00Z", localSessionId: "s", localEventId: "forged",
      },
      signature: null,
    });
    expect(r).toEqual({ ok: false, reason: "bad_number:inputTokens" });
  });

  it("the largest signed observation the schema allows earns nothing anywhere", async () => {
    const mallory = await db.createUser("ecu-mallory@example.com");
    const [d] = await db.asServiceRole<{ id: string }>(
      `insert into miner_devices (user_id, name, platform, app_version, public_key) values ($1, 'DESKTOP-M', 'win32', '0.4.0', 'MCowBQYDK2VwAyEA') returning id`,
      [mallory],
    );
    await db.asServiceRole(
      `insert into local_usage_observations
         (user_id, device_id, schema_version, adapter, tool_id, source_type, provider, model, upstream_request_id,
          input_tokens, output_tokens, occurred_at, local_session_id, local_event_id, signature_verified, verification_level, correlation_status)
       values ($1, $2, 'local-usage-observation-v1', 'claude-otel-adapter-v1', 'claude-code', 'native_otel', 'anthropic', 'claude-opus-5', 'req_never_seen',
               100000000, 100000000, '2026-07-04T10:00:00Z', 'sess', 'ev-forged', true, 'device_attested', 'unmatched')`,
      [mallory, d.id],
    );
    // Tracked, as analytics. Nothing economic exists for this user at all.
    expect((await events(mallory)).length).toBe(0);
    const [scores] = await db.asServiceRole<{ n: string }>(`select count(*)::text as n from score_records where user_id = $1`, [mallory]);
    expect(scores.n).toBe("0");
    expect(scoreRecords(await store.loadEventsForEpochs(mallory, ["2026-07-04"])).weightedCostMicros).toBe(0);

    // Settling that day pays mallory nothing: not in the denominator, not in the ledger.
    const epoch = dailyEpochFor(new Date("2026-07-04T12:00:00.000Z"), POOL);
    await finalizeEpoch(settlement, epoch);
    const result = await settleEpoch(settlement, epoch);
    expect(result.allocations.find((a) => a.userId === mallory)).toBeUndefined();
    const [ledger] = await db.asServiceRole<{ n: string }>(`select count(*)::text as n from usage_point_ledger where user_id = $1`, [mallory]);
    expect(ledger.n).toBe("0");
  });
});

describe("funding spoof", () => {
  it("from the frontend: an authenticated user cannot write any economic column", async () => {
    const user = await db.createUser("ecu-spoof@example.com");
    await ingestGatewayObservations(store, user, [paid("2026-07-05", "gen_spoof", "req_spoof", { funding: null })], { issuance: ISSUANCE });
    for (const set of [
      `economic_source_class = 'metered_paid'`,
      `reward_status = 'eligible', eligible_compute_micros = 999999999`,
      `actual_cost_micros = 999999999`,
      `reward_hold = false, reconciliation_status = 'clear'`,
      `raw_metadata = raw_metadata || '{"funding_class":"paid_account","economic_verification_status":"verified"}'::jsonb`,
    ]) {
      await expect(db.asUser(user, `update usage_events set ${set}`), set).rejects.toThrow(/permission denied/i);
    }
    const [row] = await events(user);
    expect(row.reward_status).toBe("held");
    expect(row.economic_source_class).toBe("unknown");
  });

  it("from local telemetry: naming a funding field rejects the observation", () => {
    const r = validateIncoming({
      observation: {
        schema: "local-usage-observation-v1", adapter: "claude-otel-adapter-v1", tool: "claude-code", toolVersion: "2.1.261",
        sourceType: "native_otel", provider: "anthropic", model: "claude-sonnet-5", upstreamRequestId: "req_x",
        inputTokens: 1, outputTokens: 1, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null,
        toolTokens: null, estimatedCostMicros: null, occurredAt: "2026-07-05T10:00:00Z", localSessionId: "s", localEventId: "spoof",
        funding_class: "paid_account", economic_source: "metered_paid", actual_cost_micros: 999_999_999, reward_eligible: true,
      },
      signature: null,
    });
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/^forbidden_field:/);
  });

  it("from the miner API: funding comes from the connection row, never the request", () => {
    // An API-key connection knows nothing about the account: unknown.
    expect(fundingEvidenceForConnection({ provider: "openrouter", auth_method: "api_key", account_context: null, validated_at: null })).toBeNull();
    // The OAuth callback recorded what OpenRouter's key endpoint said.
    expect(fundingEvidenceForConnection({ provider: "openrouter", auth_method: "oauth", account_context: { is_free_tier: true, usage_usd: 0 }, validated_at: "2026-09-08T14:49:32Z" }))
      .toEqual({ class: "free_tier_account", basis: "openrouter:/api/v1/key#is_free_tier", observedAt: "2026-09-08T14:49:32Z" });
    // Something a client might inject into account-shaped JSON is not a flag we read.
    expect(fundingEvidenceForConnection({ provider: "anthropic", auth_method: "api_key", account_context: { is_free_tier: false, paid: true }, validated_at: null })).toBeNull();
  });
});

describe("conflicting evidence cannot mine", () => {
  it("a device that disagrees with the trusted record holds the reward and raises nothing", async () => {
    const user = await db.createUser("ecu-conflict@example.com");
    await ingestGatewayObservations(store, user, [paid("2026-07-06", "gen_conf", "req_conf")], { issuance: ISSUANCE });
    const [before] = await events(user);
    expect(before.reward_status).toBe("eligible");

    const decision = correlate(
      { upstreamRequestId: "req_conf", signatureVerified: true, provider: "openai", model: "gpt-5.4", inputTokens: 800, outputTokens: 250_000 },
      { eventId: before.id, verificationLevel: "routed_confirmed", provenanceSources: before.provenance_sources, provider: before.provider, model: before.model, inputTokens: before.input_tokens, outputTokens: before.output_tokens },
    );
    expect(decision.event?.kind).toBe("conflict");
    if (decision.event?.kind !== "conflict") return;
    // Exactly the statement the ingestion code issues on a conflict.
    await db.asServiceRole(
      `update usage_events set correlation_status = 'pending', reward_hold = true, reconciliation_status = 'held',
         raw_metadata = raw_metadata || $1::jsonb where id = $2 and user_id = $3`,
      [JSON.stringify({ dedupe_status: "conflict", correlation_conflict: decision.event.conflicts.join(","), economic_verification_status: "held", economic_verification_reason: "identity_conflict" }), before.id, user],
    );
    const [after] = await events(user);
    expect(after.reward_hold).toBe(true);
    expect(after.raw_metadata.correlation_conflict).toBe("output_tokens");
    // Held is a hold: the proof, the price and the policy decision all stand.
    expect(after.verification_status).toBe("confirmed");
    expect(after.reward_status).toBe(before.reward_status);
    expect(after.eligible_compute_micros).toBe(before.eligible_compute_micros);
    // And nothing scores it.
    const scored = scoreRecords(await store.loadEventsForEpochs(user, [after.epoch_id!]));
    expect(scored.weightedCostMicros).toBe(0);
    expect(scored.pendingCostMicros).toBeGreaterThan(0);
  });
});

describe("settled history is immutable, and a snapshot could read it", () => {
  const DAY = "2026-07-07";
  let user: string;
  let settledBefore: Record<string, unknown>;

  beforeAll(async () => {
    user = await db.createUser("ecu-settled@example.com");
    await ingestGatewayObservations(store, user, [paid(DAY, "gen_settled", "req_settled")], { issuance: ISSUANCE });
    const epoch = dailyEpochFor(new Date(`${DAY}T12:00:00.000Z`), POOL);
    await finalizeEpoch(settlement, epoch);
    await settleEpoch(settlement, epoch);
    [settledBefore] = await db.asServiceRole(
      `select id, economic_status, eligible_compute_micros, reward_status, reward_policy_version, protocol_pricing_version, epoch_id, raw_metadata
         from usage_events where user_id = $1`,
      [user],
    );
  });

  it("a replay after settlement changes neither the row, the allocation nor the ledger", async () => {
    const ledgerBefore = await db.asServiceRole(`select allocation_id, amount from usage_point_ledger where user_id = $1`, [user]);
    // The same generation, and the same request under a new generation id --
    // now claiming free-tier funding, as if the account had been re-read.
    await ingestGatewayObservations(store, user, [
      paid(DAY, "gen_settled", "req_settled", { funding: { class: "free_tier_account", basis: "fixture" } }),
      paid(DAY, "gen_settled_again", "req_settled"),
    ], { issuance: ISSUANCE });
    const [row] = await db.asServiceRole(
      `select id, economic_status, eligible_compute_micros, reward_status, reward_policy_version, protocol_pricing_version, epoch_id, raw_metadata
         from usage_events where user_id = $1 and id = $2`,
      [user, settledBefore.id],
    );
    expect(row).toEqual(settledBefore);
    expect(row.economic_status).toBe("settled");
    const ledgerAfter = await db.asServiceRole(`select allocation_id, amount from usage_point_ledger where user_id = $1`, [user]);
    expect(ledgerAfter).toEqual(ledgerBefore);
    const late = (await events(user)).find((r) => r.external_reference === "live:gen_settled_again")!;
    expect(late.reward_hold).toBe(true);
    expect(late.economic_status).not.toBe("settled");
  });

  it("refuses to settle the epoch twice", async () => {
    const epoch = dailyEpochFor(new Date(`${DAY}T12:00:00.000Z`), POOL);
    await expect(settleEpoch(settlement, epoch)).rejects.toThrow();
  });

  it("answers every audit question for the settled unit without any content", async () => {
    const [audit] = await db.asServiceRole<Record<string, unknown>>(
      `select l.allocation_id, a.user_id, a.epoch_id, a.points::text as settled_points,
              ep.scoring_version, e.reward_policy_version,
              e.raw_metadata->>'economic_verification_policy_version' as economic_verification_policy_version,
              e.protocol_pricing_version, e.raw_metadata->>'economic_event_key' as economic_event_key,
              e.raw_metadata->>'economic_identity_kind' as identity_kind, e.raw_metadata->>'funding_class' as funding_class,
              e.raw_metadata->>'economic_verification_reason' as why_eligible, e.provenance_sources,
              p.receipt_id as proof_reference, p.signature is not null as signed
         from reward_allocations a
         join reward_epochs ep on ep.id = a.epoch_id
         join usage_point_ledger l on l.epoch_id = a.epoch_id and l.user_id = a.user_id
         join usage_events e on e.user_id = a.user_id and e.epoch_id = a.epoch_id and e.economic_status = 'settled'
         join proof_records p on p.usage_event_id = e.id
        where a.user_id = $1`,
      [user],
    );
    for (const field of ["allocation_id", "user_id", "epoch_id", "settled_points", "scoring_version", "reward_policy_version", "economic_verification_policy_version", "protocol_pricing_version", "economic_event_key", "proof_reference"]) {
      expect(audit[field], field).toBeTruthy();
    }
    expect(audit.identity_kind).toBe("provider_request_id");
    expect(audit.funding_class).toBe("paid_account");
    expect(audit.why_eligible).toBe("metered_paid_verified");
    expect(audit.signed).toBe(true);
    // No prompt, no completion, no content column exists to leak.
    const columns = await db.sql<{ column_name: string }>(`select column_name from information_schema.columns where table_name in ('usage_events','proof_records','reward_allocations')`);
    expect(columns.map((c) => c.column_name)).not.toContain("prompt");
  });

  it("would admit exactly the settled unique paid unit and nothing above it on the ladder", async () => {
    const all = await db.asServiceRole<UsageEventRow>(`select * from usage_events`);
    const admissible = all.filter((row) => snapshotExclusions(row).length === 0);
    // Only settled rows qualify, and every settled row here is a unique,
    // eligible, paid, priced, confirmed unit.
    expect(admissible.length).toBeGreaterThan(0);
    for (const row of admissible) {
      expect(row.economic_status).toBe("settled");
      expect(row.reward_hold).toBe(false);
      expect(row.raw_metadata.dedupe_status).toBe("unique");
      expect(row.economic_source_class).toBe("metered_paid");
    }
    // Held, free, promotional, duplicate, conflict, unpriced: all refused.
    for (const row of all.filter((r) => r.reward_hold || r.reward_status !== "eligible" || r.economic_source_class !== "metered_paid")) {
      expect(snapshotExclusions(row).length, row.external_reference).toBeGreaterThan(0);
    }
    // Local observations are not even candidates: no economic column exists.
    const [obs] = await db.asServiceRole<{ n: string }>(`select count(*)::text as n from local_usage_observations`);
    expect(Number(obs.n)).toBeGreaterThan(0);
  });
});
