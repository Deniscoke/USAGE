import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@/test/pg";
import { createSqlIngestStore } from "@/test/sql-ingest-store";
import { ingestGatewayObservations, type IngestStore } from "./ingest";
import { generateSigningKeyPair } from "@/lib/domain/signing";
import type { GatewayObservation } from "@/lib/providers/vercel-gateway/observation";

/**
 * The PREPARED migration 0018, applied on top of the production migrations in
 * PGlite only. Production has not run it; nothing deployed depends on it.
 * This proves that, when it is approved, the database itself will enforce
 * what ingestion code enforces today.
 */

const PENDING = path.resolve(process.cwd(), "supabase/pending/0018_economic_unit.sql");
const KEY = generateSigningKeyPair("m18-key");
const ISSUANCE = { issuer: "usage://issuer/production", keyId: KEY.keyId, privateKeyBase64: KEY.privateKeyBase64 };

let db: TestDb;
let store: IngestStore;
let user: string;

function paid(generationId: string, requestId: string): GatewayObservation {
  return {
    environment: "live",
    generationId,
    model: "openai/gpt-5.4",
    providerSlug: "openai",
    gatewayId: "connection:11111111-1111-4111-8111-111111111111",
    endpointTrusted: true,
    funding: { class: "paid_account", basis: "fixture:SIMULATED paid_account" },
    upstreamRequestId: requestId,
    occurredAt: "2026-07-10T10:00:00.000Z",
    usage: { inputTokens: 1_000, outputTokens: 250 },
    cost: { value: "4.00", currency: "USD" },
  };
}

beforeAll(async () => {
  db = await createTestDb();
  store = createSqlIngestStore(db);
  user = await db.createUser("m18@example.com");
  // Rows written BEFORE the migration, the way production rows are today.
  await ingestGatewayObservations(store, user, [paid("gen_pre", "req_pre"), paid("gen_pre_dup", "req_pre")], { issuance: ISSUANCE });
  await db.exec(readFileSync(PENDING, "utf8"));
}, 120_000);

afterAll(async () => {
  await db?.close();
});

describe("migration 0018 (prepared)", () => {
  it("backfills the key and statuses from raw_metadata without touching money", async () => {
    const rows = await db.asServiceRole<{ external_reference: string; economic_event_key: string | null; dedupe_status: string; economic_verification_status: string | null; eligible_compute_micros: string; reward_status: string }>(
      `select external_reference, economic_event_key, dedupe_status, economic_verification_status, eligible_compute_micros::text, reward_status
         from usage_events where user_id = $1 order by created_at`,
      [user],
    );
    expect(rows[0].economic_event_key).toMatch(/^ecu1:/);
    expect(rows[0].dedupe_status).toBe("unique");
    expect(rows[0].economic_verification_status).toBe("verified");
    expect(rows[0].reward_status).toBe("eligible");
    expect(rows[1].economic_event_key).toBe(rows[0].economic_event_key);
    expect(rows[1].dedupe_status).toBe("duplicate");
    expect(rows[1].eligible_compute_micros).toBe("0");
  });

  it("refuses the same key as a unit for ANOTHER user, and keeps the first owner", async () => {
    const other = await db.createUser("m18-other@example.com");
    const [primary] = await db.asServiceRole<{ economic_event_key: string; user_id: string }>(
      `select economic_event_key, user_id from usage_events where user_id = $1 and dedupe_status = 'unique'`,
      [user],
    );
    await expect(
      db.asServiceRole(
        `insert into usage_events (user_id, provider, source, external_reference, model, occurred_at, normalized_cost_micros, verification_type, economic_event_key, dedupe_status)
         values ($1, 'openai', 'gateway', 'live:other_users_claim', 'openai/gpt-5.4', now(), 0, 'routed', $2, 'unique')`,
        [other, primary.economic_event_key],
      ),
    ).rejects.toThrow(/usage_events_one_unit_per_key|duplicate key/i);
    // Nor can the unit be handed over.
    await expect(
      db.asServiceRole(`update usage_events set user_id = $1 where economic_event_key = $2 and dedupe_status = 'unique'`, [other, primary.economic_event_key]),
    ).rejects.toThrow(/user_id is immutable/);
    expect(primary.user_id).toBe(user);
  });

  it("refuses a second primary unit for the same key, even from the service role", async () => {
    const [primary] = await db.asServiceRole<{ economic_event_key: string; id: string }>(
      `select economic_event_key, id from usage_events where user_id = $1 and dedupe_status = 'unique'`,
      [user],
    );
    await expect(
      db.asServiceRole(
        `insert into usage_events (user_id, provider, source, external_reference, model, occurred_at, normalized_cost_micros, verification_type, economic_event_key, dedupe_status)
         values ($1, 'openai', 'gateway', 'live:forged_second_unit', 'openai/gpt-5.4', now(), 0, 'routed', $2, 'unique')`,
        [user, primary.economic_event_key],
      ),
    ).rejects.toThrow(/usage_events_one_unit_per_key|duplicate key/i);
    // Evidence may still share the key.
    await db.asServiceRole(
      `insert into usage_events (user_id, provider, source, external_reference, model, occurred_at, normalized_cost_micros, verification_type, economic_event_key, dedupe_status, reward_hold)
       values ($1, 'openai', 'provider_usage_api', 'import:req_pre', 'openai/gpt-5.4', now(), 0, 'verified', $2, 'duplicate', true)`,
      [user, primary.economic_event_key],
    );
    // Promoting evidence to a unit is refused too: a duplicate stays one.
    await expect(
      db.asServiceRole(`update usage_events set dedupe_status = 'unique' where external_reference = 'import:req_pre' and user_id = $1`, [user]),
    ).rejects.toThrow(/usage_events_one_unit_per_key|duplicate key/i);
  });

  it("refuses a malformed key and an unknown verification status", async () => {
    await expect(
      db.asServiceRole(`update usage_events set economic_event_key = 'sha256:not-ours' where user_id = $1 and dedupe_status = 'duplicate'`, [user]),
    ).rejects.toThrow(/usage_events_economic_key_shape/);
    await expect(
      db.asServiceRole(`update usage_events set economic_verification_status = 'paid' where user_id = $1`, [user]),
    ).rejects.toThrow(/usage_events_economic_verification_known/);
  });

  it("makes a settled row's economics immutable while leaving provenance writable", async () => {
    await db.asServiceRole(`update usage_events set economic_status = 'settled' where user_id = $1 and dedupe_status = 'unique'`, [user]);
    for (const set of [
      `eligible_compute_micros = 1`,
      `reward_status = 'held'`,
      `economic_status = 'eligible'`,
      `protocol_pricing_version = 'usage-pricing-v99'`,
      `reward_policy_version = 'usage-reward-policy-v9'`,
      `economic_event_key = null`,
      `epoch_id = '1999-01-01'`,
    ]) {
      await expect(db.asServiceRole(`update usage_events set ${set} where user_id = $1 and economic_status = 'settled'`, [user]), set).rejects.toThrow(/immutable/);
    }
    // A later correlation may still add provenance to a settled row.
    await db.asServiceRole(
      `update usage_events set provenance_sources = array['local_telemetry','usage_gateway'], correlation_status = 'matched' where user_id = $1 and economic_status = 'settled'`,
      [user],
    );
  });

  it("refuses to delete a settled unit, and allows deleting an unsettled evidence row", async () => {
    await expect(db.asServiceRole(`delete from usage_events where user_id = $1 and economic_status = 'settled'`, [user])).rejects.toThrow(/cannot be deleted/);
    await db.asServiceRole(
      `insert into usage_events (user_id, provider, source, external_reference, model, occurred_at, normalized_cost_micros, verification_type)
       values ($1, 'openai', 'gateway', 'live:throwaway', 'openai/gpt-5.4', now(), 0, 'routed')`,
      [user],
    );
    await db.asServiceRole(`delete from usage_events where user_id = $1 and external_reference = 'live:throwaway'`, [user]);
  });

  it("makes the ledger and allocations append-only", async () => {
    await db.asServiceRole(
      `insert into reward_epochs (id, starts_at, ends_at, reward_pool_points, scoring_version, settled_at)
       values ('epoch-m18', '2026-07-10T00:00:00Z', '2026-07-11T00:00:00Z', 100000, 'usage_score_v1', now())`,
    );
    await db.asServiceRole(`insert into reward_allocations (epoch_id, user_id, score, network_share, points) values ('epoch-m18', $1, 1, 1, 100000)`, [user]);
    await db.asServiceRole(`insert into usage_point_ledger (user_id, epoch_id, allocation_id, amount, reason) values ($1, 'epoch-m18', 'epoch-m18:x', 100000, 'settlement')`, [user]);
    await expect(db.asServiceRole(`update usage_point_ledger set amount = 999999 where user_id = $1`, [user])).rejects.toThrow(/append-only/);
    await expect(db.asServiceRole(`delete from usage_point_ledger where user_id = $1`, [user])).rejects.toThrow(/append-only/);
    await expect(db.asServiceRole(`update reward_allocations set points = 1 where user_id = $1`, [user])).rejects.toThrow(/append-only/);
    await expect(db.asServiceRole(`delete from reward_allocations where user_id = $1`, [user])).rejects.toThrow(/append-only/);
  });

  it("freezes a settled epoch, and leaves an open one free", async () => {
    for (const set of [
      `reward_pool_points = 1`,
      `network_score = 5`,
      `scoring_version = 'usage_score_v9'`,
      `starts_at = '2000-01-01'`,
      `ends_at = '2100-01-01'`,
      `state = 'finalizing'`,
      `settled_at = null`,
      `epoch_kind = 'production'`,
    ]) {
      await expect(db.asServiceRole(`update reward_epochs set ${set} where id = 'epoch-m18'`), set).rejects.toThrow(/immutable/);
    }
    await expect(db.asServiceRole(`delete from reward_epochs where id = 'epoch-m18'`)).rejects.toThrow(/cannot be deleted/);
    await db.asServiceRole(
      `insert into reward_epochs (id, starts_at, ends_at, reward_pool_points, scoring_version) values ('epoch-m18-open', '2026-07-12T00:00:00Z', '2026-07-13T00:00:00Z', 1, 'usage_score_v1')`,
    );
    await db.asServiceRole(`update reward_epochs set reward_pool_points = 2, state = 'finalizing', finalizing_at = now() where id = 'epoch-m18-open'`);
    await db.asServiceRole(`delete from reward_epochs where id = 'epoch-m18-open'`);
  });

  it("freezes the scores a settled epoch was distributed from, and only those", async () => {
    // The score for 2026-07-10 exists from ingestion, and epoch-m18 (settled)
    // covers that day under usage_score_v1.
    await expect(db.asServiceRole(`update score_records set points = 999 where user_id = $1 and day = '2026-07-10'`, [user])).rejects.toThrow(/immutable/);
    await expect(db.asServiceRole(`delete from score_records where user_id = $1 and day = '2026-07-10'`, [user])).rejects.toThrow(/immutable/);
    // A different algorithm version on the same day is not what was settled.
    await db.asServiceRole(`insert into score_records (user_id, day, algorithm_version, points) values ($1, '2026-07-10', 'usage_score_v2', 1)`, [user]);
    await db.asServiceRole(`update score_records set points = 2 where user_id = $1 and day = '2026-07-10' and algorithm_version = 'usage_score_v2'`, [user]);
    // An open day recomputes freely.
    await db.asServiceRole(`insert into score_records (user_id, day, algorithm_version, points) values ($1, '2026-07-20', 'usage_score_v1', 1)`, [user]);
    await db.asServiceRole(`update score_records set points = 2 where user_id = $1 and day = '2026-07-20'`, [user]);
    await db.asServiceRole(`delete from score_records where user_id = $1 and day = '2026-07-20'`, [user]);
  });

  it("freezes published rates and versions; republishing the same rates is allowed", async () => {
    await db.asServiceRole(
      `insert into protocol_pricing_versions (version, source, effective_from, captured_at) values ('usage-pricing-test', 'fixture', '2026-07-01', now())`,
    );
    await db.asServiceRole(
      `insert into protocol_model_prices (pricing_version, model, provider_family, input_micros_per_million, output_micros_per_million) values ('usage-pricing-test', 'openai/gpt-5.4', 'openai', 2500000, 15000000)`,
    );
    const [v] = await db.asServiceRole<{ version: string }>(`select version from protocol_pricing_versions where version = 'usage-pricing-test'`);
    const [price] = await db.asServiceRole<{ model: string; input_micros_per_million: string }>(
      `select model, input_micros_per_million::text from protocol_model_prices where pricing_version = $1 limit 1`,
      [v.version],
    );
    await expect(db.asServiceRole(`update protocol_model_prices set input_micros_per_million = input_micros_per_million + 1 where pricing_version = $1 and model = $2`, [v.version, price.model])).rejects.toThrow(/immutable/);
    await expect(db.asServiceRole(`delete from protocol_model_prices where pricing_version = $1 and model = $2`, [v.version, price.model])).rejects.toThrow(/cannot be deleted/);
    // The publish script upserts identical rows: a no-op update passes.
    await db.asServiceRole(`update protocol_model_prices set input_micros_per_million = $3 where pricing_version = $1 and model = $2`, [v.version, price.model, price.input_micros_per_million]);
    await expect(db.asServiceRole(`update protocol_pricing_versions set effective_from = '2000-01-01' where version = $1`, [v.version])).rejects.toThrow(/immutable/);
    await expect(db.asServiceRole(`delete from protocol_pricing_versions where version = $1`, [v.version])).rejects.toThrow(/cannot be deleted/);
    await db.asServiceRole(`update protocol_pricing_versions set status = 'frozen' where version = $1`, [v.version]);
  });

  it("keeps every policy version resolvable: superseded, never edited or removed", async () => {
    await expect(db.asServiceRole(`update reward_policy_versions set effective_from = '2000-01-01' where version = 'usage-reward-policy-v1'`)).rejects.toThrow(/immutable/);
    await expect(db.asServiceRole(`delete from reward_policy_versions where version = 'usage-reward-policy-v1'`)).rejects.toThrow(/cannot be deleted/);
    await db.asServiceRole(`update reward_policy_versions set status = status where version = 'usage-reward-policy-v1'`);
  });

  it("gives correlation_status the word conflict", async () => {
    const values = await db.sql<{ v: string }>(`select enumlabel as v from pg_enum where enumtypid = 'public.correlation_status'::regtype order by enumsortorder`);
    expect(values.map((r) => r.v)).toContain("conflict");
  });

  it("keeps the client roles out of the new columns", async () => {
    await expect(db.asUser(user, `update usage_events set dedupe_status = 'unique'`)).rejects.toThrow(/permission denied/i);
    await expect(db.asUser(user, `select usage_events_settled_immutable()`)).rejects.toThrow(/permission denied|does not exist|trigger/i);
  });
});
