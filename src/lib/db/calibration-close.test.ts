import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@/test/pg";
import { createSqlIngestStore } from "@/test/sql-ingest-store";
import { createSqlSettlementStore } from "@/test/sql-settlement-store";
import { ingestGatewayObservations } from "./ingest";
import { finalizeEpoch, settleEpoch, type SettlementStore } from "./settlement";
import { CalibrationCloseRefused, closeCalibrationEpoch, snapshotCalibration, type ApprovedCalibrationClose, type CalibrationReadStore } from "./calibration-close";
import { dailyEpochFor, isClaimableEpoch, type EpochState } from "@/lib/domain/epoch";
import { generateSigningKeyPair } from "@/lib/domain/signing";
import type { GatewayObservation } from "@/lib/providers/vercel-gateway/observation";

/**
 * M15D — the guarded zero-reward close of a development calibration epoch,
 * on real Postgres (PGlite) with the full migration chain through 0019.
 *
 * The production epoch is epoch-2026-09-10 with the M14C unit. Here the same
 * shape is rebuilt through the real ingestion path, then "approved" with the
 * facts the store actually recorded, exactly as the owner approved the real
 * ones. Nothing here touches production.
 */

const DAY = "2026-03-10";
const EPOCH = `epoch-${DAY}`;
const KEY = generateSigningKeyPair("m15d-test");
const ISSUANCE = { issuer: "usage://issuer/production", keyId: KEY.keyId, privateKeyBase64: KEY.privateKeyBase64 };

let db: TestDb;
let settlement: SettlementStore;
let reads: CalibrationReadStore;
let user: string;
let approved: ApprovedCalibrationClose;

function readsOver(database: TestDb): CalibrationReadStore {
  return {
    async loadEvent(eventId) {
      const [row] = await database.asServiceRole<Record<string, unknown>>(`select id, user_id, epoch_id, economic_event_key, eligible_compute_micros, economic_status, reward_status, protocol_pricing_version from usage_events where id = $1`, [eventId]);
      return row ? { id: row.id as string, userId: row.user_id as string, epochId: row.epoch_id as string | null, economicEventKey: row.economic_event_key as string | null, eligibleComputeMicros: Number(row.eligible_compute_micros), economicStatus: row.economic_status as string, rewardStatus: row.reward_status as string | null, protocolPricingVersion: row.protocol_pricing_version as string | null } : null;
    },
    async loadProof(proofId) {
      const [row] = await database.asServiceRole<Record<string, unknown>>(`select id, usage_event_id, signature from proof_records where id = $1`, [proofId]);
      return row ? { id: row.id as string, usageEventId: row.usage_event_id as string, signed: typeof row.signature === "string" && row.signature.length > 0 } : null;
    },
    async loadScore(userId, day, algorithmVersion) {
      const [row] = await database.asServiceRole<{ points: string }>(`select points::text from score_records where user_id = $1 and day = $2 and algorithm_version = $3`, [userId, day, algorithmVersion]);
      return row ? Number(row.points) : null;
    },
    async loadEpochRow(epochId) {
      const [row] = await database.asServiceRole<Record<string, unknown>>(`select state, epoch_kind, reward_pool_points, protocol_version, claimable from reward_epochs where id = $1`, [epochId]);
      return row ? { state: row.state as EpochState, epochKind: row.epoch_kind as string, rewardPoolPoints: Number(row.reward_pool_points), protocolVersion: (row.protocol_version as string | null) ?? null, claimable: (row.claimable as boolean | null) ?? null } : null;
    },
    async ledgerStats() {
      const [row] = await database.asServiceRole<{ rows: string; total: string }>(`select count(*)::text as rows, coalesce(sum(amount), 0)::text as total from usage_point_ledger`);
      return { rows: Number(row.rows), total: Number(row.total) };
    },
    async allocationStats(epochId) {
      const [row] = await database.asServiceRole<{ rows: string; positive: string }>(`select count(*)::text as rows, count(*) filter (where points > 0)::text as positive from reward_allocations where epoch_id = $1`, [epochId]);
      return { rows: Number(row.rows), positive: Number(row.positive) };
    },
    async userBalance(userId) {
      const [row] = await database.asServiceRole<{ total: string }>(`select coalesce(sum(amount), 0)::text as total from usage_point_ledger where user_id = $1`, [userId]);
      return Number(row.total);
    },
    async protocolVersionRow(version) {
      const [row] = await database.asServiceRole<Record<string, unknown>>(`select status, role, epoch_emission_points, claimable from mining_protocol_versions where version = $1`, [version]);
      return row ? { status: row.status as string, role: row.role as string, epochEmissionPoints: Number(row.epoch_emission_points), claimable: Boolean(row.claimable) } : null;
    },
  };
}

beforeAll(async () => {
  db = await createTestDb();
  settlement = createSqlSettlementStore(db);
  reads = readsOver(db);
  user = await db.createUser("m15d-owner@example.com");

  // One real-shaped paid unit through the real ingestion path: OpenRouter
  // OAuth connection, paid account (fixture), gpt-5-nano, 10 input tokens.
  const observation: GatewayObservation = {
    environment: "live",
    generationId: "gen-1789057887-M15DCALIB",
    model: "openai/gpt-5-nano",
    clientType: "usage-miner",
    servedByProvider: "Azure",
    gatewayId: "connection:22222222-2222-4222-8222-222222222222",
    endpointTrusted: true,
    funding: { class: "paid_account", basis: "fixture:SIMULATED paid_account" },
    occurredAt: `${DAY}T16:31:31.829Z`,
    usage: { inputTokens: 10, outputTokens: 0 },
    cost: { value: "0.0000005", currency: "USD" },
    finishReason: "length",
  };
  await ingestGatewayObservations(createSqlIngestStore(db), user, [observation], { issuance: ISSUANCE });

  const [event] = await db.asServiceRole<Record<string, unknown>>(`select id, economic_event_key, eligible_compute_micros from usage_events where user_id = $1`, [user]);
  const [proof] = await db.asServiceRole<{ id: string }>(`select id from proof_records where usage_event_id = $1`, [event.id as string]);
  const [score] = await db.asServiceRole<{ points: string }>(`select points::text from score_records where user_id = $1 and day = $2`, [user, DAY]);
  approved = { epochId: EPOCH, eventId: event.id as string, economicEventKey: event.economic_event_key as string, userId: user, eligibleComputeMicros: Number(event.eligible_compute_micros), expectedScore: Number(score.points), proofId: proof.id };
}, 120_000);

afterAll(async () => {
  await db?.close();
});

describe("the conflict the close must avoid", () => {
  it("the fixture reproduces M14C: 1 micro-USD eligible, usage_score_v1 = 1.0000, keyed and unique", async () => {
    expect(approved.eligibleComputeMicros).toBe(1);
    expect(approved.expectedScore).toBe(1);
    expect(approved.economicEventKey).toMatch(/^ecu1:/);
  });

  it("0019 persisted the calibration disposition: active, role calibration, zero emission, not claimable", async () => {
    const row = await reads.protocolVersionRow("mining-dev-calibration-v1");
    expect(row).toEqual({ status: "active", role: "calibration", epochEmissionPoints: 0, claimable: false });
    const dev = await reads.protocolVersionRow("mining-dev-v1");
    expect(dev).toEqual({ status: "active", role: "network", epochEmissionPoints: 100_000, claimable: false });
  });

  it("the database refuses a claimable development epoch and a claimable development protocol", async () => {
    await expect(db.asServiceRole(`insert into reward_epochs (id, starts_at, ends_at, reward_pool_points, scoring_version, epoch_kind, state, claimable) values ('epoch-2026-01-01', '2026-01-01', '2026-01-02', 0, 'usage_score_v1', 'development', 'open', true)`)).rejects.toThrow(/development_not_claimable/);
    await expect(db.asServiceRole(`update mining_protocol_versions set claimable = true where version = 'mining-dev-v1'`)).rejects.toThrow(/development_not_claimable/);
  });
});

describe("fail closed", () => {
  it("refuses an epoch that is not owner-approved, before any read", async () => {
    await expect(closeCalibrationEpoch(settlement, reads, "epoch-2026-03-11", [approved])).rejects.toThrow(/not an owner-approved/);
    await expect(closeCalibrationEpoch(settlement, reads, EPOCH, [])).rejects.toThrow(/not an owner-approved/);
  });

  it("refuses when any approved fact differs: key, owner, eligible micros, score, proof", async () => {
    for (const [name, wrong] of [
      ["key", { economicEventKey: "ecu1:0000" }],
      ["owner", { userId: "00000000-0000-4000-8000-000000000000" }],
      ["eligible micros", { eligibleComputeMicros: 2 }],
      ["score", { expectedScore: 1.5 }],
      ["proof", { proofId: "00000000-0000-4000-8000-000000000000" }],
    ] as const) {
      await expect(closeCalibrationEpoch(settlement, reads, EPOCH, [{ ...approved, ...wrong }]), name).rejects.toThrow(CalibrationCloseRefused);
    }
    const [row] = await db.asServiceRole<{ state: string }>(`select state from reward_epochs where id = $1`, [EPOCH]);
    expect(row).toBeUndefined(); // nothing was written
  });

  it("refuses when the calibration protocol row is not active", async () => {
    await db.asServiceRole(`update mining_protocol_versions set status = 'draft' where version = 'mining-dev-calibration-v1'`);
    await expect(closeCalibrationEpoch(settlement, reads, EPOCH, [approved])).rejects.toThrow(/status is draft/);
    await db.asServiceRole(`update mining_protocol_versions set status = 'active' where version = 'mining-dev-calibration-v1'`);
  });
});

describe("the close", () => {
  it("settles the epoch with ZERO emission and changes nothing of economic value", async () => {
    const before = await snapshotCalibration(reads, approved);
    const result = await closeCalibrationEpoch(settlement, reads, EPOCH, [approved]);
    expect(result.distributed).toBe(0);
    expect(result.networkScore).toBe(1);
    expect(result.after.epoch).toEqual({ state: "settled", epochKind: "development", protocolVersion: "mining-dev-calibration-v1", claimable: false });
    expect(result.after.event.economicStatus).toBe("settled");
    expect(result.after.event.economicEventKey).toBe(approved.economicEventKey);
    expect(result.after.event.eligibleComputeMicros).toBe(1);
    expect(result.after.score).toBe(1);
    expect(result.after.proof).toEqual(before.proof);
    expect(result.after.ledger).toEqual(before.ledger);
    expect(result.after.balance).toBe(before.balance);
    expect(result.after.allocations).toEqual({ rows: 1, positive: 0 });
  });

  it("is not repeatable: a second close is refused by the epoch state", async () => {
    await expect(closeCalibrationEpoch(settlement, reads, EPOCH, [approved])).rejects.toThrow(/epoch is settled/);
  });

  it("the settled calibration epoch is immutable, including its protocol binding and claimability", async () => {
    await expect(db.asServiceRole(`update reward_epochs set protocol_version = 'mining-dev-v1' where id = $1`, [EPOCH])).rejects.toThrow(/immutable/);
    await expect(db.asServiceRole(`update reward_epochs set reward_pool_points = 100000 where id = $1`, [EPOCH])).rejects.toThrow(/immutable/);
    await expect(db.asServiceRole(`update mining_protocol_versions set epoch_emission_points = 100000 where version = 'mining-dev-calibration-v1'`)).rejects.toThrow(/immutable except for status/);
  });
});

describe("historical audit from persisted data only", () => {
  it("answers every question about the calibration epoch without source code", async () => {
    const [audit] = await db.asServiceRole<Record<string, unknown>>(`select * from audit_epoch($1)`, [EPOCH]);
    expect(audit.scoring_version).toBe("usage_score_v1");
    expect(audit.pricing_version).toBe("usage-pricing-v2");
    expect(audit.protocol_version).toBe("mining-dev-calibration-v1");
    expect(audit.emission_algorithm).toBe("zero-reward-calibration-v1");
    expect(Number(audit.scheduled_points)).toBe(0);
    expect(Number(audit.effective_points)).toBe(0);
    expect(Number(audit.network_score)).toBe(1);
    expect(Number(audit.distributed_points)).toBe(0);
    expect(Number(audit.ledger_points)).toBe(0);
    expect(audit.claimable).toBe(false);
    expect(audit.protocol_claimable).toBe(false);
    expect(audit.protocol_role).toBe("calibration");
    expect(isClaimableEpoch({ epochKind: audit.epoch_kind as string, claimable: audit.claimable as boolean })).toBe(false);
  });

  it("a normal mining-dev-v1 epoch still reproduces the fixed 100,000 emission and is told apart by its protocol binding", async () => {
    const otherDay = "2026-03-12";
    const miner = await db.createUser("m15d-miner@example.com");
    await ingestGatewayObservations(createSqlIngestStore(db), miner, [{ environment: "live", generationId: "gen-1789057887-M15DNORMAL", model: "openai/gpt-5-nano", clientType: "usage-miner", servedByProvider: "Azure", gatewayId: "connection:22222222-2222-4222-8222-222222222222", endpointTrusted: true, funding: { class: "paid_account", basis: "fixture:SIMULATED paid_account" }, occurredAt: `${otherDay}T10:00:00.000Z`, usage: { inputTokens: 100_000, outputTokens: 10_000 }, cost: { value: "0.009", currency: "USD" }, finishReason: "stop" }], { issuance: ISSUANCE });
    const epoch = dailyEpochFor(new Date(`${otherDay}T12:00:00.000Z`), 100_000);
    expect(epoch.protocolVersion).toBe("mining-dev-v1");
    await finalizeEpoch(settlement, epoch, { algorithmVersion: "usage_score_v1", epochKind: "development" });
    const result = await settleEpoch(settlement, epoch, { algorithmVersion: "usage_score_v1", epochKind: "development" });
    expect(result.distributed).toBe(100_000);

    const [audit] = await db.asServiceRole<Record<string, unknown>>(`select * from audit_epoch($1)`, [epoch.id]);
    expect(audit.protocol_version).toBe("mining-dev-v1");
    expect(audit.emission_algorithm).toBe("fixed-pool-v1");
    expect(Number(audit.scheduled_points)).toBe(100_000);
    expect(Number(audit.distributed_points)).toBe(100_000);
    expect(Number(audit.ledger_points)).toBe(100_000);
    expect(audit.claimable).toBe(false);
    expect(isClaimableEpoch({ epochKind: "development", claimable: false })).toBe(false);
  });

  it("only a production epoch explicitly flagged claimable is claimable", () => {
    expect(isClaimableEpoch({ epochKind: "production", claimable: true })).toBe(true);
    expect(isClaimableEpoch({ epochKind: "production", claimable: false })).toBe(false);
    expect(isClaimableEpoch({ epochKind: "production" })).toBe(false);
    expect(isClaimableEpoch({ epochKind: "development", claimable: true })).toBe(false);
  });
});
