import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@/test/pg";
import { createSqlIngestStore } from "@/test/sql-ingest-store";
import { createSqlSettlementStore } from "@/test/sql-settlement-store";
import { ingestGatewayObservations, type IngestStore } from "./ingest";
import { settleEpoch, type SettlementStore } from "./settlement";
import { dailyEpochFor } from "@/lib/domain/epoch";
import { generateSigningKeyPair } from "@/lib/domain/signing";
import type { GatewayObservation } from "@/lib/providers/vercel-gateway/observation";

/**
 * Settlement turns daily mining scores into Usage Points.
 *
 * The properties that matter: the pool is conserved exactly, and no allocation
 * can ever credit twice.
 */

const DAY = "2026-06-01";
const POOL = 100_000;
const KEY = generateSigningKeyPair("settle-key");
const ISSUANCE = {
  issuer: "usage://issuer/production",
  keyId: KEY.keyId,
  privateKeyBase64: KEY.privateKeyBase64,
};

let db: TestDb;
let ingest: IngestStore;
let settlement: SettlementStore;

beforeAll(async () => {
  db = await createTestDb();
  ingest = createSqlIngestStore(db);
  settlement = createSqlSettlementStore(db);
}, 90_000);

afterAll(async () => {
  await db?.close();
});

function observation(generationId: string, outputTokens: number): GatewayObservation {
  return {
    environment: "live",
    generationId,
    model: "anthropic/claude-haiku-4.5",
    clientType: "claude-code",
    servedByProvider: "anthropic",
    occurredAt: `${DAY}T10:00:00.000Z`,
    usage: { inputTokens: 10_000, outputTokens },
    cost: null,
    finishReason: "end_turn",
  };
}

const epoch = () => dailyEpochFor(new Date(`${DAY}T12:00:00.000Z`), POOL);

describe("epoch settlement", () => {
  let alice: string;
  let bob: string;

  beforeAll(async () => {
    alice = await db.createUser("settle-a@example.com");
    bob = await db.createUser("settle-b@example.com");

    await ingestGatewayObservations(ingest, alice, [observation("gen_a", 40_000)], {
      issuance: ISSUANCE,
    });
    await ingestGatewayObservations(ingest, bob, [observation("gen_b", 10_000)], {
      issuance: ISSUANCE,
    });
  });

  it("distributes exactly the pool, never more or less", async () => {
    const result = await settleEpoch(settlement, epoch());

    expect(result.participants).toBe(2);
    expect(result.distributed).toBe(POOL);
    expect(result.credited).toBe(2);

    const [total] = await db.asServiceRole<{ sum: string }>(
      `select coalesce(sum(amount), 0)::text as sum from usage_point_ledger where epoch_id = $1`,
      [result.epochId],
    );
    expect(total.sum).toBe(String(POOL));
  });

  it("splits by share of network score", async () => {
    const rows = await db.asServiceRole<{ user_id: string; points: string }>(
      `select user_id, amount::text as points from usage_point_ledger order by amount desc`,
    );
    // More compute, more points -- but sub-linearly, because the score is sqrt.
    expect(rows[0].user_id).toBe(alice);
    expect(Number(rows[0].points)).toBeGreaterThan(Number(rows[1].points));
    expect(Number(rows[0].points) + Number(rows[1].points)).toBe(POOL);
  });

  it("cannot credit the same allocation twice", async () => {
    const before = await db.asServiceRole<{ n: string; sum: string }>(
      `select count(*)::text as n, coalesce(sum(amount), 0)::text as sum from usage_point_ledger`,
    );

    const again = await settleEpoch(settlement, epoch());
    expect(again.credited).toBe(0);

    const after = await db.asServiceRole<{ n: string; sum: string }>(
      `select count(*)::text as n, coalesce(sum(amount), 0)::text as sum from usage_point_ledger`,
    );
    expect(after[0]).toEqual(before[0]);
  });

  it("marks the counted usage as settled so it cannot be counted again", async () => {
    const rows = await db.asServiceRole<{ economic_status: string }>(
      `select economic_status from usage_events where user_id = any($1::uuid[])`,
      [[alice, bob]],
    );
    expect(rows.every((row) => row.economic_status === "settled")).toBe(true);
  });

  it("records how the epoch was produced", async () => {
    const [row] = await db.asServiceRole<{
      scoring_version: string;
      epoch_kind: string;
      network_score: string;
      settled_at: string;
    }>(`select scoring_version, epoch_kind, network_score::text, settled_at from reward_epochs`);

    expect(row.scoring_version).toBe("usage_score_v1");
    // Not a public network yet, and the record says so.
    expect(row.epoch_kind).toBe("development");
    expect(Number(row.network_score)).toBeGreaterThan(0);
    expect(row.settled_at).toBeTruthy();
  });

  it("gives an epoch with no scored usage nothing to distribute", async () => {
    const emptyEpoch = dailyEpochFor(new Date("2026-06-02T12:00:00.000Z"), POOL);
    const result = await settleEpoch(settlement, emptyEpoch);

    expect(result.participants).toBe(0);
    expect(result.distributed).toBe(0);
    expect(result.credited).toBe(0);
  });
});

describe("the ledger is not client writable", () => {
  it("refuses a client attempt to credit itself", async () => {
    const attacker = await db.createUser("ledger-attacker@example.com");
    await expect(
      db.asUser(
        attacker,
        `insert into usage_point_ledger (user_id, epoch_id, allocation_id, amount, reason)
         values ($1, $2, 'forged', 999999, 'self_credit')`,
        [attacker, `epoch-${DAY}`],
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it("refuses a client attempt to publish a price", async () => {
    const attacker = await db.createUser("pricing-attacker@example.com");
    await expect(
      db.asUser(
        attacker,
        `insert into protocol_pricing_versions (version, source, effective_from, captured_at)
         values ('usage-pricing-fake', 'me', current_date, now())`,
      ),
    ).rejects.toThrow(/permission denied/i);
    void attacker;
  });
});
