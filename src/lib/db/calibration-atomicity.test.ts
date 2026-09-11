import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@/test/pg";
import { createSqlIngestStore } from "@/test/sql-ingest-store";
import { createSqlSettlementStore } from "@/test/sql-settlement-store";
import { ingestGatewayObservations } from "./ingest";
import type { SettlementStore } from "./settlement";
import { closeCalibrationEpoch, type ApprovedCalibrationClose } from "./calibration-close";
import { generateSigningKeyPair } from "@/lib/domain/signing";
import type { GatewayObservation } from "@/lib/providers/vercel-gateway/observation";

/**
 * M15E — atomicity.
 *
 * Part 1 proves the CURRENT application path is not atomic: a failure
 * injected after any of its separate store writes leaves partial state.
 * Part 2 proves the PENDING 0020 function is: every injected failure, at
 * every stage, leaves the database exactly as it was.
 *
 * Real PostgreSQL semantics (PGlite), full chain through 0019, plus the
 * pending 0020 applied explicitly. No production access.
 */

const KEY = generateSigningKeyPair("m15e-test");
const ISSUANCE = { issuer: "usage://issuer/production", keyId: KEY.keyId, privateKeyBase64: KEY.privateKeyBase64 };

let db: TestDb;

async function seedUnit(day: string, email: string, generationId: string): Promise<ApprovedCalibrationClose> {
  const user = await db.createUser(email);
  const observation: GatewayObservation = {
    environment: "live", generationId, model: "openai/gpt-5-nano", clientType: "usage-miner", servedByProvider: "Azure",
    gatewayId: "connection:22222222-2222-4222-8222-222222222222", endpointTrusted: true,
    funding: { class: "paid_account", basis: "fixture:SIMULATED paid_account" },
    occurredAt: `${day}T16:31:31.829Z`, usage: { inputTokens: 10, outputTokens: 0 }, cost: { value: "0.0000005", currency: "USD" }, finishReason: "length",
  };
  await ingestGatewayObservations(createSqlIngestStore(db), user, [observation], { issuance: ISSUANCE });
  const [event] = await db.asServiceRole<Record<string, unknown>>(`select id, economic_event_key, eligible_compute_micros from usage_events where user_id = $1`, [user]);
  const [proof] = await db.asServiceRole<{ id: string }>(`select id from proof_records where usage_event_id = $1`, [event.id as string]);
  const [score] = await db.asServiceRole<{ points: string }>(`select points::text from score_records where user_id = $1 and day = $2`, [user, day]);
  return { epochId: `epoch-${day}`, eventId: event.id as string, economicEventKey: event.economic_event_key as string, userId: user, eligibleComputeMicros: Number(event.eligible_compute_micros), expectedScore: Number(score.points), proofId: proof.id };
}

interface State {
  epoch: { state: string; protocol: string | null } | null;
  eventStatus: string;
  allocations: number;
  ledgerRows: number;
  ledgerTotal: number;
  balance: number;
}

async function stateOf(a: ApprovedCalibrationClose): Promise<State> {
  const [epoch] = await db.asServiceRole<{ state: string; protocol_version: string | null }>(`select state, protocol_version from reward_epochs where id = $1`, [a.epochId]);
  const [event] = await db.asServiceRole<{ economic_status: string }>(`select economic_status from usage_events where id = $1`, [a.eventId]);
  const [alloc] = await db.asServiceRole<{ n: string }>(`select count(*)::text as n from reward_allocations where epoch_id = $1`, [a.epochId]);
  const [ledger] = await db.asServiceRole<{ rows: string; total: string }>(`select count(*)::text as rows, coalesce(sum(amount), 0)::text as total from usage_point_ledger`);
  const [bal] = await db.asServiceRole<{ total: string }>(`select coalesce(sum(amount), 0)::text as total from usage_point_ledger where user_id = $1`, [a.userId]);
  return { epoch: epoch ? { state: epoch.state, protocol: epoch.protocol_version } : null, eventStatus: event.economic_status, allocations: Number(alloc.n), ledgerRows: Number(ledger.rows), ledgerTotal: Number(ledger.total), balance: Number(bal.total) };
}

beforeAll(async () => {
  db = await createTestDb();
  // 0020 is part of the migration chain the test database applies.
}, 120_000);

afterAll(async () => {
  await db?.close();
});

// ---------------------------------------------------------------------------
// Part 1 — the current application path is NOT atomic
// ---------------------------------------------------------------------------

type Stage = "finalizing" | "settled" | "allocation" | "markSettled";

/** The real SQL store, failing right AFTER the named write. Each write is its own committed transaction, as in production. */
function failingAfter(base: SettlementStore, stage: Stage): SettlementStore {
  return {
    ...base,
    async upsertEpoch(epoch, networkScore, kind) {
      await base.upsertEpoch(epoch, networkScore, kind);
      if (stage === "finalizing" && epoch.state === "finalizing") throw new Error("injected: after finalizing write");
      if (stage === "settled" && epoch.state === "settled") throw new Error("injected: after settled write");
    },
    async creditAllocations(epochId, entries) {
      const n = await base.creditAllocations(epochId, entries);
      if (stage === "allocation") throw new Error("injected: after allocation write");
      return n;
    },
    async markSettled(epochId, userIds) {
      await base.markSettled(epochId, userIds);
      if (stage === "markSettled") throw new Error("injected: after event update, before postconditions");
    },
  };
}

describe("current application path: separate autocommitted writes", () => {
  const base = () => createSqlSettlementStore(db);

  it("A. failure after the FINALIZING write leaves the epoch finalizing", async () => {
    const a = await seedUnit("2026-04-01", "m15e-a@example.com", "gen-m15e-a");
    const before = await stateOf(a);
    await expect(closeCalibrationEpoch(failingAfter(base(), "finalizing"), readsOver(), a.epochId, [a])).rejects.toThrow(/after finalizing/);
    const after = await stateOf(a);
    expect(after.epoch).toEqual({ state: "finalizing", protocol: "mining-dev-calibration-v1" }); // PARTIAL STATE
    expect(after.eventStatus).toBe("eligible");
    expect(after).not.toEqual(before);
  });

  it("B. failure after the SETTLED write leaves a settled epoch with no allocation and an unsettled event", async () => {
    const a = await seedUnit("2026-04-02", "m15e-b@example.com", "gen-m15e-b");
    await expect(closeCalibrationEpoch(failingAfter(base(), "settled"), readsOver(), a.epochId, [a])).rejects.toThrow(/after settled/);
    const after = await stateOf(a);
    expect(after.epoch?.state).toBe("settled"); // PARTIAL STATE: settled and now immutable
    expect(after.allocations).toBe(0);
    expect(after.eventStatus).toBe("eligible");
  });

  it("C/E. failure after the allocation write (= before the event update) leaves a settled epoch and allocation with an eligible event", async () => {
    const a = await seedUnit("2026-04-03", "m15e-c@example.com", "gen-m15e-c");
    await expect(closeCalibrationEpoch(failingAfter(base(), "allocation"), readsOver(), a.epochId, [a])).rejects.toThrow(/after allocation/);
    const after = await stateOf(a);
    expect(after.epoch?.state).toBe("settled");
    expect(after.allocations).toBe(1);
    expect(after.eventStatus).toBe("eligible"); // PARTIAL STATE
  });

  it("D. the ledger phase is skipped for zero points, so it cannot fail; the ledger is untouched in every case", async () => {
    const a = await seedUnit("2026-04-04", "m15e-d@example.com", "gen-m15e-d");
    const before = await stateOf(a);
    await expect(closeCalibrationEpoch(failingAfter(base(), "markSettled"), readsOver(), a.epochId, [a])).rejects.toThrow(/before postconditions/);
    const after = await stateOf(a);
    expect(after.ledgerRows).toBe(before.ledgerRows);
    expect(after.ledgerTotal).toBe(before.ledgerTotal);
  });

  it("F. failure after the event update but before postconditions: everything is already committed; the application reports failure anyway", async () => {
    const a = await seedUnit("2026-04-05", "m15e-f@example.com", "gen-m15e-f");
    await expect(closeCalibrationEpoch(failingAfter(base(), "markSettled"), readsOver(), a.epochId, [a])).rejects.toThrow(/before postconditions/);
    const after = await stateOf(a);
    expect(after.epoch?.state).toBe("settled");
    expect(after.eventStatus).toBe("settled");
    expect(after.allocations).toBe(1);
    // The postcondition layer cannot undo this: the writes were separate transactions.
  });

  function readsOver() {
    return {
      async loadEvent(eventId: string) {
        const [row] = await db.asServiceRole<Record<string, unknown>>(`select id, user_id, epoch_id, economic_event_key, eligible_compute_micros, economic_status, reward_status, protocol_pricing_version from usage_events where id = $1`, [eventId]);
        return row ? { id: row.id as string, userId: row.user_id as string, epochId: row.epoch_id as string | null, economicEventKey: row.economic_event_key as string | null, eligibleComputeMicros: Number(row.eligible_compute_micros), economicStatus: row.economic_status as string, rewardStatus: row.reward_status as string | null, protocolPricingVersion: row.protocol_pricing_version as string | null } : null;
      },
      async loadProof(proofId: string) {
        const [row] = await db.asServiceRole<Record<string, unknown>>(`select id, usage_event_id, signature from proof_records where id = $1`, [proofId]);
        return row ? { id: row.id as string, usageEventId: row.usage_event_id as string, signed: typeof row.signature === "string" && row.signature.length > 0 } : null;
      },
      async loadScore(userId: string, day: string, v: string) {
        const [row] = await db.asServiceRole<{ points: string }>(`select points::text from score_records where user_id = $1 and day = $2 and algorithm_version = $3`, [userId, day, v]);
        return row ? Number(row.points) : null;
      },
      async loadEpochRow(epochId: string) {
        const [row] = await db.asServiceRole<Record<string, unknown>>(`select state, epoch_kind, reward_pool_points, protocol_version, claimable from reward_epochs where id = $1`, [epochId]);
        return row ? { state: row.state as "open" | "finalizing" | "settled", epochKind: row.epoch_kind as string, rewardPoolPoints: Number(row.reward_pool_points), protocolVersion: (row.protocol_version as string | null) ?? null, claimable: (row.claimable as boolean | null) ?? null } : null;
      },
      async ledgerStats() {
        const [row] = await db.asServiceRole<{ rows: string; total: string }>(`select count(*)::text as rows, coalesce(sum(amount), 0)::text as total from usage_point_ledger`);
        return { rows: Number(row.rows), total: Number(row.total) };
      },
      async allocationStats(epochId: string) {
        const [row] = await db.asServiceRole<{ rows: string; positive: string }>(`select count(*)::text as rows, count(*) filter (where points > 0)::text as positive from reward_allocations where epoch_id = $1`, [epochId]);
        return { rows: Number(row.rows), positive: Number(row.positive) };
      },
      async userBalance(userId: string) {
        const [row] = await db.asServiceRole<{ total: string }>(`select coalesce(sum(amount), 0)::text as total from usage_point_ledger where user_id = $1`, [userId]);
        return Number(row.total);
      },
      async protocolVersionRow(version: string) {
        const [row] = await db.asServiceRole<Record<string, unknown>>(`select status, role, epoch_emission_points, claimable from mining_protocol_versions where version = $1`, [version]);
        return row ? { status: row.status as string, role: row.role as string, epochEmissionPoints: Number(row.epoch_emission_points), claimable: Boolean(row.claimable) } : null;
      },
    };
  }
});

// ---------------------------------------------------------------------------
// Part 2 — the pending 0020 function IS atomic
// ---------------------------------------------------------------------------

/**
 * The function's approved facts are constants for the real production
 * epoch, so the test rewrites exactly those constants (and the UTC
 * boundaries) to the fixture's ids. With `withHooks`, every `-- @stage`
 * comment marker becomes a RAISE guarded by a session setting: the
 * TEST-ONLY variant. The deployed function keeps only the comments.
 * Everything else (locking, writes, postconditions, grants) is the pending
 * SQL verbatim.
 */
const PENDING_0020 = path.resolve(process.cwd(), "supabase/migrations/0020_atomic_calibration_close.sql");

function functionSqlFor(a: ApprovedCalibrationClose, withHooks: boolean): string {
  const day = a.epochId.slice("epoch-".length);
  const next = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  let sql = readFileSync(PENDING_0020, "utf8")
    .replace("'epoch-2026-09-10';", `'${a.epochId}';`)
    .replace("'2026-09-10';", `'${day}';`)
    .replace("timestamptz '2026-09-10 00:00:00+00';", `timestamptz '${day} 00:00:00+00';`)
    .replace("timestamptz '2026-09-11 00:00:00+00';", `timestamptz '${next} 00:00:00+00';`)
    .replace("'c75acc2e-7f79-4161-b18f-3d8783561394';", `'${a.eventId}';`)
    .replace("'ecu1:cf605dfe61da51020d3e406fba288c137d4b1059268e68064322a44d3a1a2107';", `'${a.economicEventKey}';`)
    .replace("'da93cec8-8f02-4fc7-b86a-d70be521a19f';", `'${a.userId}';`)
    .replace("'b60f5602-9ea5-4292-a1c8-fda3e874c025';", `'${a.proofId}';`);
  if (withHooks) {
    sql = sql.replace(/^\s*-- @stage (\w+)\s*$/gm, (_m, stage: string) =>
      `  if current_setting('usage.test_fail_after', true) = '${stage}' then raise exception 'calibration close: injected failure after ${stage}'; end if;`);
  }
  return sql;
}

async function installFunctionFor(a: ApprovedCalibrationClose, withHooks = true): Promise<void> {
  await db.exec(functionSqlFor(a, withHooks));
}

async function callWithInjectedFailure(epochId: string, stage: string): Promise<string> {
  // One explicit transaction: set the fault, call, and (on error) roll back,
  // exactly as PostgreSQL would for a failed RPC.
  try {
    await db.exec(`begin; select set_config('usage.test_fail_after', '${stage}', true); select * from public.close_development_calibration_epoch('${epochId}'); commit;`);
    return "committed";
  } catch (error) {
    await db.exec("rollback;");
    return (error as Error).message;
  }
}

describe("the production text of 0020 carries no fault hook", () => {
  it("has only comment markers, no current_setting and no injected raise", () => {
    const sql = readFileSync(PENDING_0020, "utf8");
    expect(sql).not.toMatch(/current_setting\(/);
    expect(sql).not.toMatch(/injected failure/);
    expect(sql.match(/^\s*-- @stage \w+$/gm)?.length).toBe(6);
    expect(sql).toMatch(/security invoker/);
    expect(sql).toMatch(/set search_path = ''/);
    for (const role of ["public", "anon", "authenticated"]) expect(sql).toMatch(new RegExp(`revoke execute on function public.close_development_calibration_epoch\\(text\\) from ${role};`));
    expect(sql).toMatch(/grant execute on function public.close_development_calibration_epoch\(text\) to service_role;/);
    expect(sql).toMatch(/timestamptz '2026-09-10 00:00:00\+00'/);
    expect(sql).toMatch(/timestamptz '2026-09-11 00:00:00\+00'/);
    expect(sql).not.toMatch(/c_day::timestamptz/);
  });
});

describe("pending 0020: epoch boundaries are UTC regardless of session TimeZone", () => {
  const zones: [string, string][] = [["UTC", "2026-06-01"], ["Europe/Prague", "2026-06-02"], ["America/New_York", "2026-06-03"], ["Asia/Tokyo", "2026-06-04"]];
  for (const [zone, day] of zones) {
    it(`${zone}: persisted starts_at/ends_at are exactly ${day}T00:00:00Z and the next UTC midnight`, async () => {
      const u = await seedUnit(day, `m15e-tz-${day}@example.com`, `gen-m15e-tz-${day}`);
      await installFunctionFor(u, false); // the production text, no hooks
      await db.exec(`begin; set local TimeZone = '${zone}'; select * from public.close_development_calibration_epoch('${u.epochId}'); commit;`);
      const [row] = await db.asServiceRole<{ starts: string; ends: string; tz: string }>(
        `select to_char(starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as starts,
                to_char(ends_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as ends,
                current_setting('TimeZone') as tz
           from reward_epochs where id = $1`, [u.epochId]);
      expect(row.starts).toBe(`${day}T00:00:00.000Z`);
      const next = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
      expect(row.ends).toBe(`${next}T00:00:00.000Z`);
      const [epochSeconds] = await db.asServiceRole<{ s: string; e: string }>(`select extract(epoch from starts_at)::text as s, extract(epoch from ends_at)::text as e from reward_epochs where id = $1`, [u.epochId]);
      expect(Number(epochSeconds.s)).toBe(Date.parse(`${day}T00:00:00Z`) / 1000);
      expect(Number(epochSeconds.e) - Number(epochSeconds.s)).toBe(86_400);
    });
  }
});

describe("pending 0020: close_development_calibration_epoch is one transaction", () => {
  let a: ApprovedCalibrationClose;
  let initial: State;

  beforeAll(async () => {
    a = await seedUnit("2026-05-10", "m15e-atomic@example.com", "gen-m15e-atomic");
    await installFunctionFor(a);
    initial = await stateOf(a);
    expect(initial.epoch).toBeNull();
    expect(initial.eventStatus).toBe("eligible");
  }, 120_000);

  for (const stage of ["epoch", "finalizing", "settled", "allocation", "event", "postcondition"]) {
    it(`injected failure after "${stage}": the whole close rolls back, initial state exactly restored`, async () => {
      const message = await callWithInjectedFailure(a.epochId, stage);
      expect(message).toMatch(/injected failure/);
      expect(await stateOf(a)).toEqual(initial);
    });
  }

  it("refuses any epoch id other than the approved one, before locking or reading", async () => {
    await expect(db.asServiceRole(`select * from public.close_development_calibration_epoch('epoch-2026-05-11')`)).rejects.toThrow(/not the owner-approved/);
    expect(await stateOf(a)).toEqual(initial);
  });

  it("refuses when a persisted fact drifts, and rolls back: score tampered", async () => {
    await db.asServiceRole(`update score_records set points = 2 where user_id = $1`, [a.userId]);
    await expect(db.asServiceRole(`select * from public.close_development_calibration_epoch($1)`, [a.epochId])).rejects.toThrow(/score for .* is 2/);
    await db.asServiceRole(`update score_records set points = 1 where user_id = $1`, [a.userId]);
    expect(await stateOf(a)).toEqual(initial);
  });

  it("anon and authenticated cannot execute it; service_role can", async () => {
    await expect(db.asAnon(`select * from public.close_development_calibration_epoch($1)`, [a.epochId])).rejects.toThrow(/permission denied/);
    await expect(db.asUser(a.userId, `select * from public.close_development_calibration_epoch($1)`, [a.epochId])).rejects.toThrow(/permission denied/);
  });

  it("the successful close: one transaction, zero points, zero ledger, event settled, audit facts returned", async () => {
    const [result] = await db.asServiceRole<Record<string, unknown>>(`select * from public.close_development_calibration_epoch($1)`, [a.epochId]);
    expect(result).toMatchObject({ epoch_id: a.epochId, state: "settled", protocol_version: "mining-dev-calibration-v1", scoring_version: "usage_score_v1", pricing_version: "usage-pricing-v2", claimable: false });
    expect(Number(result.network_score)).toBe(1);
    expect(Number(result.distributed_points)).toBe(0);
    expect(Number(result.ledger_points)).toBe(0);
    const after = await stateOf(a);
    expect(after.epoch).toEqual({ state: "settled", protocol: "mining-dev-calibration-v1" });
    expect(after.eventStatus).toBe("settled");
    expect(after.allocations).toBe(1);
    expect(after.ledgerRows).toBe(initial.ledgerRows);
    expect(after.ledgerTotal).toBe(initial.ledgerTotal);
    expect(after.balance).toBe(initial.balance);
    const [alloc] = await db.asServiceRole<{ points: string }>(`select points::text from reward_allocations where epoch_id = $1`, [a.epochId]);
    expect(Number(alloc.points)).toBe(0);
  });

  it("two closes: exactly one success and one clean refusal, never two settlements", async () => {
    // PGlite serialises transactions on its single connection, so this
    // exercises the ordering the advisory lock enforces on a real server:
    // the second attempt observes the first's committed state and raises.
    const results = await Promise.allSettled([
      db.asServiceRole(`select * from public.close_development_calibration_epoch($1)`, [a.epochId]),
      db.asServiceRole(`select * from public.close_development_calibration_epoch($1)`, [a.epochId]),
    ]);
    // The epoch is already settled by the previous test, so both are refusals here;
    // what matters is that nothing changed and the refusal is the settled one.
    for (const r of results) {
      expect(r.status).toBe("rejected");
      expect((r as PromiseRejectedResult).reason.message).toMatch(/already settled/);
    }
    const after = await stateOf(a);
    expect(after.allocations).toBe(1);
    expect(after.ledgerRows).toBe(initial.ledgerRows);
  });

  it("the settled calibration epoch is immutable afterwards", async () => {
    await expect(db.asServiceRole(`update reward_epochs set reward_pool_points = 100000 where id = $1`, [a.epochId])).rejects.toThrow(/immutable/);
    await expect(db.asServiceRole(`update usage_events set eligible_compute_micros = 5 where id = $1`, [a.eventId])).rejects.toThrow(/immutable/);
  });
});

describe("pending 0020: concurrency on a fresh epoch", () => {
  it("two simultaneous first attempts: one settles, the other is refused as already settled", async () => {
    const b = await seedUnit("2026-05-20", "m15e-race@example.com", "gen-m15e-race");
    await installFunctionFor(b);
    const results = await Promise.allSettled([
      db.asServiceRole(`select * from public.close_development_calibration_epoch($1)`, [b.epochId]),
      db.asServiceRole(`select * from public.close_development_calibration_epoch($1)`, [b.epochId]),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason.message).toMatch(/already settled/);
    const after = await stateOf(b);
    expect(after.epoch?.state).toBe("settled");
    expect(after.allocations).toBe(1);
    expect(after.eventStatus).toBe("settled");
    const [positive] = await db.asServiceRole<{ n: string }>(`select count(*)::text as n from reward_allocations where epoch_id = $1 and points > 0`, [b.epochId]);
    expect(Number(positive.n)).toBe(0);
  });
});
