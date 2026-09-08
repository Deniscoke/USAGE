import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@/test/pg";
import { createSqlIngestStore } from "@/test/sql-ingest-store";
import { createSqlSettlementStore } from "@/test/sql-settlement-store";
import { ingestGatewayObservations, type IngestStore } from "./ingest";
import { finalizeEpoch, settleEpoch, type SettlementStore } from "./settlement";
import { allocationId } from "./settlement";
import { dailyEpochFor, EpochLifecycleError } from "@/lib/domain/epoch";
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
    // A user's own provider account, billed at a real rate: the one thing that
    // earns under usage-reward-policy-v1.
    gatewayId: "connection:11111111-1111-4111-8111-111111111111",
    endpointTrusted: true,
    occurredAt: `${DAY}T10:00:00.000Z`,
    usage: { inputTokens: 10_000, outputTokens },
    cost: { value: "0.05", currency: "USD" },
    finishReason: "end_turn",
  };
}

const epoch = () => dailyEpochFor(new Date(`${DAY}T12:00:00.000Z`), POOL);

/** The real two-phase flow: stop collecting, then credit. */
async function finalizeAndSettle(target = epoch()) {
  await finalizeEpoch(settlement, target);
  return settleEpoch(settlement, target);
}

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
    const result = await finalizeAndSettle();

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

  it("refuses to settle an epoch that is already settled", async () => {
    // Allocations are immutable, so this is refused rather than recomputed.
    await expect(settleEpoch(settlement, epoch())).rejects.toBeInstanceOf(EpochLifecycleError);
    await expect(finalizeEpoch(settlement, epoch())).rejects.toBeInstanceOf(EpochLifecycleError);
  });

  it("cannot credit the same allocation twice even if settlement is forced", async () => {
    const before = await db.asServiceRole<{ n: string; sum: string }>(
      `select count(*)::text as n, coalesce(sum(amount), 0)::text as sum from usage_point_ledger`,
    );

    // Second line of defence, below the lifecycle check: the unique allocation
    // id means a replayed credit writes nothing.
    const credited = await settlement.creditAllocations(`epoch-${DAY}`, [
      {
        allocationId: allocationId(`epoch-${DAY}`, alice),
        userId: alice,
        score: 999,
        networkShare: 1,
        points: 50_000,
      },
    ]);
    expect(credited).toBe(0);

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
    const result = await finalizeAndSettle(emptyEpoch);

    expect(result.participants).toBe(0);
    expect(result.distributed).toBe(0);
    expect(result.credited).toBe(0);
  });
});

describe("epoch lifecycle", () => {
  const LIFE_DAY = "2026-07-01";
  const lifeEpoch = () => dailyEpochFor(new Date(`${LIFE_DAY}T12:00:00.000Z`), POOL);

  function lifeObservation(generationId: string, occurredAt: string): GatewayObservation {
    return {
      environment: "live",
      generationId,
      model: "anthropic/claude-haiku-4.5",
      clientType: "claude-code",
      servedByProvider: "anthropic",
      gatewayId: "connection:11111111-1111-4111-8111-111111111111",
    endpointTrusted: true,
      occurredAt,
      usage: { inputTokens: 5_000, outputTokens: 5_000 },
      cost: { value: "0.05", currency: "USD" },
      finishReason: "end_turn",
    };
  }

  let carol: string;

  beforeAll(async () => {
    carol = await db.createUser("lifecycle@example.com");
  });

  it("refuses to settle an epoch that is still open", async () => {
    // An open epoch is still collecting, so any allocation would be provisional
    // -- and a credited allocation is permanent.
    await expect(settleEpoch(settlement, lifeEpoch())).rejects.toMatchObject({
      code: "not_finalizing",
    });

    const [ledger] = await db.asServiceRole<{ n: string }>(
      `select count(*)::text as n from usage_point_ledger where epoch_id = $1`,
      [lifeEpoch().id],
    );
    expect(ledger.n).toBe("0");
  });

  it("assigns usage to the epoch containing occurred_at while it is open", async () => {
    await ingestGatewayObservations(
      ingest,
      carol,
      [lifeObservation("gen_open", `${LIFE_DAY}T09:00:00.000Z`)],
      { issuance: ISSUANCE },
    );

    const [row] = await db.asServiceRole<{ epoch_id: string; carried_forward: boolean }>(
      `select epoch_id, carried_forward from usage_events
       where user_id = $1 and external_reference like '%gen_open%'`,
      [carol],
    );
    expect(row.epoch_id).toBe(`epoch-${LIFE_DAY}`);
    expect(row.carried_forward).toBe(false);
  });

  it("carries a late proof forward instead of assigning it to a finalizing epoch", async () => {
    await finalizeEpoch(settlement, lifeEpoch());

    // Same occurrence day, but the epoch has stopped accepting usage.
    await ingestGatewayObservations(
      ingest,
      carol,
      [lifeObservation("gen_late", `${LIFE_DAY}T23:00:00.000Z`)],
      { issuance: ISSUANCE },
    );

    const [row] = await db.asServiceRole<{ epoch_id: string; carried_forward: boolean }>(
      `select epoch_id, carried_forward from usage_events
       where user_id = $1 and external_reference like '%gen_late%'`,
      [carol],
    );
    // Deterministic rule: first open epoch at or after ingestion. Never dropped,
    // and never added to an epoch whose allocation is already being computed.
    expect(row.carried_forward).toBe(true);
    expect(row.epoch_id).not.toBe(`epoch-${LIFE_DAY}`);
    expect(row.epoch_id).toBe(`epoch-${new Date().toISOString().slice(0, 10)}`);
  });

  it("credits the ledger exactly once, and only on settlement", async () => {
    const before = await db.asServiceRole<{ n: string }>(
      `select count(*)::text as n from usage_point_ledger where epoch_id = $1`,
      [lifeEpoch().id],
    );
    expect(before[0].n).toBe("0");

    const settled = await settleEpoch(settlement, lifeEpoch());
    expect(settled.credited).toBe(1);

    const [after] = await db.asServiceRole<{ n: string; sum: string }>(
      `select count(*)::text as n, coalesce(sum(amount), 0)::text as sum
       from usage_point_ledger where epoch_id = $1`,
      [lifeEpoch().id],
    );
    expect(after.n).toBe("1");
    expect(after.sum).toBe(String(POOL));

    const [epochRow] = await db.asServiceRole<{ state: string }>(
      `select state from reward_epochs where id = $1`,
      [lifeEpoch().id],
    );
    expect(epochRow.state).toBe("settled");
  });

  it("settles only the events assigned to that epoch", async () => {
    const rows = await db.asServiceRole<{ external_reference: string; economic_status: string }>(
      `select external_reference, economic_status from usage_events where user_id = $1`,
      [carol],
    );
    const settled = rows.find((row) => row.external_reference.includes("gen_open"));
    const carried = rows.find((row) => row.external_reference.includes("gen_late"));

    expect(settled?.economic_status).toBe("settled");
    // Still eligible, waiting for its own epoch. Valid compute is never discarded.
    expect(carried?.economic_status).toBe("eligible");
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
