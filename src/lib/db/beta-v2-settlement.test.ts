import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@/test/pg";

/**
 * M16A — the pending 0021: epoch-aware resolver in SQL, pricing v3 frozen,
 * mining-beta-v2 scheduled for a future epoch, and the ATOMIC v2 settlement
 * with positive ledger credits. Real PostgreSQL semantics (PGlite), chain
 * through 0020, pending 0021 applied explicitly. No production access.
 *
 * Fixture epochs are ENDED epochs of early September 2026 and the beta schedule
 * is moved to epoch-2026-09-05 in this test database, so "the epoch has ended"
 * holds and the production target date is not what the tests depend on.
 */

const PENDING = path.resolve(process.cwd(), "supabase/pending/0021_beta_v2_cutover.sql");
const USD = 1_000_000_000_000n; // pico per USD
let db: TestDb;

function withHooks(sql: string): string {
  return sql.replace(/^\s*-- @stage (\w+)\s*$/gm, (_m, stage: string) =>
    `  if current_setting('usage.test_fail_after', true) = '${stage}' then raise exception 'v2 settlement: injected failure after ${stage}'; end if;`);
}

async function seedUser(email: string): Promise<string> {
  return db.createUser(email);
}

/** A settled-looking eligible v3 unit in `epochId` for `user`, with exact pico, plus the matching v2 score row. */
async function seedUnit(user: string, epochId: string, pico: bigint, opts: { model?: string; pricing?: string; pending?: string[]; status?: string } = {}): Promise<string> {
  const day = epochId.slice("epoch-".length);
  const [row] = await db.asServiceRole<{ id: string }>(
    `insert into usage_events
       (user_id, provider, source, external_reference, model, occurred_at, input_tokens, cached_input_tokens, output_tokens, requests,
        actual_cost_micros, normalized_cost_micros, verification_type, verification_status, economic_status, protocol_compute_micros, pricing_status,
        protocol_pricing_version, protocol_pricing_basis, epoch_id, gateway_id, economic_source_class, eligible_compute_micros, reward_status,
        reward_policy_version, economic_event_key, dedupe_status, economic_verification_status, economic_verification_policy_version,
        protocol_compute_pico, eligible_compute_pico, pricing_components_pending, raw_metadata)
     values ($1, 'openrouter', 'gateway', 'live:' || gen_random_uuid()::text, $2, ($3 || 'T12:00:00Z')::timestamptz, 1000, 0, 100, 1,
        1, 1, 'routed', 'confirmed', $4, $5, 'priced', $6, 'protocol_pricing', $7, 'connection:22222222-2222-4222-8222-222222222222', 'metered_paid',
        $5, 'eligible', 'usage-reward-policy-v1', 'ecu1:' || encode(sha256(gen_random_uuid()::text::bytea), 'hex'), 'unique', 'verified', 'economic-verification-v1',
        $8, $8, $9, '{}'::jsonb)
     returning id`,
    [user, opts.model ?? "openai/gpt-5.4", day, opts.status ?? "eligible", Number((pico + 500_000n) / 1_000_000n), opts.pricing ?? "usage-pricing-v3", epochId, pico.toString(), opts.pending ?? []],
  );
  return row.id;
}

async function seedScore(user: string, epochId: string, pico: bigint): Promise<void> {
  await db.asServiceRole(
    `insert into score_records (user_id, day, algorithm_version, weighted_cost_micros, points, weighted_compute_pico)
     values ($1, $2, 'usage_score_v2', $3, $4, $5)
     on conflict (user_id, day, algorithm_version) do update set weighted_compute_pico = excluded.weighted_compute_pico, points = excluded.points`,
    [user, epochId.slice("epoch-".length), Number((pico + 500_000n) / 1_000_000n), Number((pico + 500_000n) / 1_000_000n), pico.toString()],
  );
}

async function ledger(): Promise<{ rows: number; total: number }> {
  const [r] = await db.asServiceRole<{ rows: string; total: string }>(`select count(*)::text as rows, coalesce(sum(amount), 0)::text as total from usage_point_ledger`);
  return { rows: Number(r.rows), total: Number(r.total) };
}

beforeAll(async () => {
  db = await createTestDb();
  // The pending migration verbatim, then a TEST-ONLY copy of the settlement
  // function with the stage markers turned into guarded RAISEs.
  const sql = readFileSync(PENDING, "utf8");
  await db.exec(sql);
  const fn = sql.slice(sql.indexOf("create or replace function public.settle_beta_v2_epoch"), sql.indexOf("revoke execute on function public.settle_beta_v2_epoch"));
  await db.exec(withHooks(fn));
  // Fixture schedule: the beta protocol governs from 2027-01-01 in this database.
  await db.asServiceRole(`update mining_protocol_versions set effective_from_epoch = 'epoch-2026-09-05', effective_from = '2026-09-05' where version = 'mining-beta-v2'`);
}, 120_000);

afterAll(async () => {
  await db?.close();
});

describe("0021 schedule and resolver", () => {
  it("mining-beta-v2 is SCHEDULED, not active; mining-dev-v1 stays the active network protocol; v3 is frozen with five models", async () => {
    const rows = await db.asServiceRole<{ version: string; status: string; role: string; effective_from_epoch: string | null }>(`select version, status, role, effective_from_epoch from mining_protocol_versions order by version`);
    expect(rows).toEqual([
      { version: "mining-beta-v2", status: "scheduled", role: "network", effective_from_epoch: "epoch-2026-09-05" },
      { version: "mining-dev-calibration-v1", status: "active", role: "calibration", effective_from_epoch: "epoch-2026-09-10" },
      { version: "mining-dev-v1", status: "active", role: "network", effective_from_epoch: "epoch-2026-09-01" },
    ]);
    const [pv] = await db.asServiceRole<{ status: string; n: string }>(`select v.status, (select count(*)::text from protocol_model_prices where pricing_version = 'usage-pricing-v3') as n from protocol_pricing_versions v where version = 'usage-pricing-v3'`);
    expect(pv).toEqual({ status: "frozen", n: "5" });
  });

  it("protocol_for_epoch: history unchanged, gap epochs on v1, boundary exact, bound rows win", async () => {
    const at = async (id: string) => (await db.asServiceRole<{ version: string }>(`select version from protocol_for_epoch($1)`, [id]))[0]?.version;
    expect(await at("epoch-2026-08-01")).toBe("mining-dev-v1"); // before genesis: genesis governs
    expect(await at("epoch-2026-09-04")).toBe("mining-dev-v1");
    expect(await at("epoch-2026-09-05")).toBe("mining-beta-v2");
    expect(await at("epoch-2030-01-01")).toBe("mining-beta-v2");
    // A bound epoch row wins over the schedule.
    await db.asServiceRole(`insert into reward_epochs (id, starts_at, ends_at, reward_pool_points, scoring_version, pricing_version, protocol_version, epoch_kind, state) values ('epoch-2026-09-04', '2026-09-04', '2026-09-05', 0, 'usage_score_v1', 'usage-pricing-v2', 'mining-dev-calibration-v1', 'development', 'open')`);
    expect(await at("epoch-2026-09-04")).toBe("mining-dev-calibration-v1");
  });

  it("the schedule refuses two network versions on one boundary and a scheduled version without an epoch", async () => {
    await expect(db.asServiceRole(`insert into mining_protocol_versions (version, epoch_duration_seconds, epoch_emission_points, scoring_version, pricing_version, effective_from, network, status, role, effective_from_epoch, emission_algorithm) values ('x', 86400, 1, 'usage_score_v2', 'usage-pricing-v3', '2026-09-05', 'development', 'scheduled', 'network', 'epoch-2026-09-05', 'fixed-pool-v1')`)).rejects.toThrow(/one_per_epoch/);
    await expect(db.asServiceRole(`insert into mining_protocol_versions (version, epoch_duration_seconds, epoch_emission_points, scoring_version, pricing_version, effective_from, network, status, role, emission_algorithm) values ('y', 86400, 1, 'usage_score_v2', 'usage-pricing-v3', '2026-09-05', 'development', 'scheduled', 'network', 'fixed-pool-v1')`)).rejects.toThrow(/network_needs_epoch/);
  });
});

describe("settle_beta_v2_epoch: refusals", () => {
  it("refuses an epoch that has not ended, a v1 epoch, and an unknown id", async () => {
    await expect(db.asServiceRole(`select * from settle_beta_v2_epoch('epoch-2099-01-01')`)).rejects.toThrow(/has not ended/);
    await expect(db.asServiceRole(`select * from settle_beta_v2_epoch('epoch-2026-09-03')`)).rejects.toThrow(/not a live baseline-linear-v1/);
    await expect(db.asServiceRole(`select * from settle_beta_v2_epoch('nope')`)).rejects.toThrow(/not an epoch id/);
  });

  it("refuses when an eligible unit lacks pico, carries a foreign pricing version, or is pending; and when score rows disagree", async () => {
    const u = await seedUser("m16a-refuse@example.com");
    const epoch = "epoch-2026-09-05";
    await seedUnit(u, epoch, 10n * USD, { pricing: "usage-pricing-v2" });
    await expect(db.asServiceRole(`select * from settle_beta_v2_epoch($1)`, [epoch])).rejects.toThrow(/not settleable/);
    await db.asServiceRole(`delete from usage_events where epoch_id = $1`, [epoch]);
    await seedUnit(u, epoch, 10n * USD, { pending: ["cacheRead"] });
    await expect(db.asServiceRole(`select * from settle_beta_v2_epoch($1)`, [epoch])).rejects.toThrow(/not settleable/);
    await db.asServiceRole(`delete from usage_events where epoch_id = $1`, [epoch]);
    await seedUnit(u, epoch, 10n * USD);
    await expect(db.asServiceRole(`select * from settle_beta_v2_epoch($1)`, [epoch])).rejects.toThrow(/score row/);
    await seedScore(u, epoch, 9n * USD);
    await expect(db.asServiceRole(`select * from settle_beta_v2_epoch($1)`, [epoch])).rejects.toThrow(/score row/);
    expect((await db.asServiceRole(`select 1 from reward_epochs where id = $1`, [epoch])).length).toBe(0);
  });

  it("anon and authenticated cannot execute it", async () => {
    const u = await seedUser("m16a-perm@example.com");
    await expect(db.asAnon(`select * from settle_beta_v2_epoch('epoch-2026-09-05')`)).rejects.toThrow(/permission denied/);
    await expect(db.asUser(u, `select * from settle_beta_v2_epoch('epoch-2026-09-05')`)).rejects.toThrow(/permission denied/);
  });
});

describe("settle_beta_v2_epoch: atomic positive-ledger settlement", () => {
  const epoch = "epoch-2026-09-06";
  let a: string;
  let b: string;
  let c: string;

  beforeAll(async () => {
    a = await seedUser("m16a-a@example.com");
    b = await seedUser("m16a-b@example.com");
    c = await seedUser("m16a-c@example.com");
    // $300 + $200 + $0.333… of eligible compute: below the $1,000 baseline,
    // so the pool unlocks partially and the remainder is never minted.
    await seedUnit(a, epoch, 300n * USD);
    await seedUnit(b, epoch, 150n * USD);
    await seedUnit(b, epoch, 50n * USD);
    await seedUnit(c, epoch, USD / 3n);
    await seedScore(a, epoch, 300n * USD);
    await seedScore(b, epoch, 200n * USD);
    await seedScore(c, epoch, USD / 3n);
  });

  for (const stage of ["finalizing", "settled", "allocation", "ledger", "events", "postcondition"]) {
    it(`injected failure after "${stage}" rolls everything back`, async () => {
      const before = await ledger();
      let message = "committed";
      try {
        await db.exec(`begin; select set_config('usage.test_fail_after', '${stage}', true); select * from public.settle_beta_v2_epoch('${epoch}'); commit;`);
      } catch (error) {
        await db.exec("rollback;");
        message = (error as Error).message;
      }
      expect(message).toMatch(/injected failure/);
      expect(await ledger()).toEqual(before);
      expect((await db.asServiceRole(`select 1 from reward_epochs where id = $1`, [epoch])).length).toBe(0);
      expect((await db.asServiceRole(`select 1 from reward_allocations where epoch_id = $1`, [epoch])).length).toBe(0);
      const [ev] = await db.asServiceRole<{ n: string }>(`select count(*)::text as n from usage_events where epoch_id = $1 and economic_status = 'settled'`, [epoch]);
      expect(Number(ev.n)).toBe(0);
    });
  }

  it("settles exactly once: effective = floor(100000 × N / B), allocations sum to it, ledger delta equals it, remainder never minted", async () => {
    const before = await ledger();
    const [r] = await db.asServiceRole<Record<string, string | boolean>>(`select * from settle_beta_v2_epoch($1)`, [epoch]);
    // N = 500.333… USD → effective = floor(100000 × 500.333…/1000) = 50033
    expect(r.state).toBe("settled");
    expect(r.protocol_version).toBe("mining-beta-v2");
    expect(r.scoring_version).toBe("usage_score_v2");
    expect(r.pricing_version).toBe("usage-pricing-v3");
    expect(BigInt(String(r.network_compute_pico))).toBe(500n * USD + USD / 3n);
    expect(Number(r.scheduled_points)).toBe(100_000);
    expect(Number(r.effective_points)).toBe(50_033);
    expect(Number(r.undistributed_points)).toBe(49_967);
    expect(Number(r.distributed_points)).toBe(50_033);
    expect(Number(r.ledger_points)).toBe(50_033);
    expect(Number(r.participants)).toBe(3);
    expect(r.claimable).toBe(false);

    const after = await ledger();
    expect(after.rows - before.rows).toBe(3);
    expect(after.total - before.total).toBe(50_033);
    const alloc = await db.asServiceRole<{ user_id: string; points: string }>(`select user_id, points::text from reward_allocations where epoch_id = $1 order by reward_allocations.points desc`, [epoch]);
    expect(alloc.map((x) => Number(x.points)).reduce((s, x) => s + x, 0)).toBe(50_033);
    // Proportional: a gets 300/500.33 ≈ 59.96%, b 39.97%, c 0.067%.
    expect(Number(alloc[0].points)).toBe(30_000);
    expect(Number(alloc[1].points)).toBe(20_000);
    expect(Number(alloc[2].points)).toBe(33);
    const [settled] = await db.asServiceRole<{ n: string }>(`select count(*)::text as n from usage_events where epoch_id = $1 and economic_status = 'settled'`, [epoch]);
    expect(Number(settled.n)).toBe(4);
    const [ep] = await db.asServiceRole<Record<string, unknown>>(`select to_char(starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as starts_at, claimable, epoch_kind from reward_epochs where id = $1`, [epoch]);
    expect(ep.starts_at).toBe("2026-09-06T00:00:00Z");
    expect(ep.claimable).toBe(false);
    expect(ep.epoch_kind).toBe("development");
  });

  it("a second attempt is refused and changes nothing; the settled epoch and its allocations are immutable", async () => {
    const before = await ledger();
    await expect(db.asServiceRole(`select * from settle_beta_v2_epoch($1)`, [epoch])).rejects.toThrow(/already settled/);
    expect(await ledger()).toEqual(before);
    await expect(db.asServiceRole(`update reward_epochs set effective_pool_points = 1 where id = $1`, [epoch])).rejects.toThrow(/immutable/);
    await expect(db.asServiceRole(`delete from usage_point_ledger where epoch_id = $1`, [epoch])).rejects.toThrow(/append-only/);
    await expect(db.asServiceRole(`update reward_epochs set claimable = true where id = $1`, [epoch])).rejects.toThrow(/immutable|not_claimable/);
  });

  it("above the baseline the whole cap is distributed and nothing is undistributed; an empty epoch distributes nothing", async () => {
    const big = "epoch-2026-09-07";
    const w = await seedUser("m16a-whale@example.com");
    await seedUnit(w, big, 2000n * USD);
    await seedScore(w, big, 2000n * USD);
    const [r] = await db.asServiceRole<Record<string, string>>(`select * from settle_beta_v2_epoch($1)`, [big]);
    expect(Number(r.effective_points)).toBe(100_000);
    expect(Number(r.undistributed_points)).toBe(0);
    const empty = "epoch-2026-09-08";
    const [e] = await db.asServiceRole<Record<string, string>>(`select * from settle_beta_v2_epoch($1)`, [empty]);
    expect(Number(e.effective_points)).toBe(0);
    expect(Number(e.participants)).toBe(0);
    expect(Number(e.ledger_points)).toBe(0);
  });

  it("two concurrent settlements of a fresh epoch: one success, one already-settled refusal", async () => {
    const race = "epoch-2026-09-09";
    const u = await seedUser("m16a-race@example.com");
    await seedUnit(u, race, 10n * USD);
    await seedScore(u, race, 10n * USD);
    const results = await Promise.allSettled([
      db.asServiceRole(`select * from settle_beta_v2_epoch($1)`, [race]),
      db.asServiceRole(`select * from settle_beta_v2_epoch($1)`, [race]),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason.message).toMatch(/already settled/);
    const [l] = await db.asServiceRole<{ total: string }>(`select coalesce(sum(amount), 0)::text as total from usage_point_ledger where epoch_id = $1`, [race]);
    expect(Number(l.total)).toBe(1000); // $10 of $1000 baseline → 1% of 100,000
  });
});
