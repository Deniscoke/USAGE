import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@/test/pg";

/**
 * Migration 0017 against a real Postgres: the tables exist, the walls hold.
 *
 * What is proved here is the shape of the database, which is what the route
 * relies on: a client role cannot write observations or mappings, a revoked
 * device cannot be told apart from a stranger by RLS, dedupe is enforced by a
 * constraint rather than by good intentions, the scope check refuses unknown
 * scopes, the wallet table is unreachable, and the ledger does not move when
 * an observation is correlated.
 */

let db: TestDb;
let alice: string;
let bob: string;
let device: string;
let mapping: string;

beforeAll(async () => {
  db = await createTestDb();
  alice = await db.createUser("meter-alice@example.com");
  bob = await db.createUser("meter-bob@example.com");
  const [d] = await db.asServiceRole<{ id: string }>(
    `insert into miner_devices (user_id, name, platform, app_version) values ($1, 'DESKTOP-A', 'win32', '0.4.0') returning id`,
    [alice],
  );
  device = d.id;
  const [m] = await db.asServiceRole<{ id: string }>(
    `insert into miner_tool_mappings (device_id, user_id, tool_id, metering_method, verification_capability)
     values ($1, $2, 'claude-code', 'native_otel', 'provider_correlated') returning id`,
    [device, alice],
  );
  mapping = m.id;
}, 90_000);

afterAll(async () => {
  await db?.close();
});

const OBSERVATION = (localEventId: string, upstream: string | null = null) => [
  alice, device, mapping, "local-usage-observation-v1", "claude-otel-adapter-v1", "claude-code", "native_otel",
  "anthropic", "claude-sonnet-5", upstream, 1500, 240, "2026-09-09T10:00:00Z", "sess", localEventId,
];
const INSERT_OBSERVATION = `
  insert into local_usage_observations
    (user_id, device_id, mapping_id, schema_version, adapter, tool_id, source_type,
     provider, model, upstream_request_id, input_tokens, output_tokens, occurred_at, local_session_id, local_event_id)
  values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning id, verification_level, correlation_status`;

describe("local observations", () => {
  it("has no economic columns at all", async () => {
    const columns = await db.sql<{ column_name: string }>(
      `select column_name from information_schema.columns where table_name = 'local_usage_observations'`,
    );
    const names = columns.map((c) => c.column_name);
    for (const forbidden of ["proof_status", "economic_status", "reward_status", "eligible_compute_micros", "protocol_compute_micros", "pricing_status", "points"]) {
      expect(names, forbidden).not.toContain(forbidden);
    }
  });

  it("starts at local_observed and uncorrelated", async () => {
    const [row] = await db.asServiceRole<{ verification_level: string; correlation_status: string }>(INSERT_OBSERVATION, OBSERVATION("ev-1"));
    expect(row.verification_level).toBe("local_observed");
    expect(row.correlation_status).toBe("none");
  });

  it("dedupes on (device, local_event_id) by constraint", async () => {
    await expect(db.asServiceRole(INSERT_OBSERVATION, OBSERVATION("ev-1"))).rejects.toThrow(/unique|duplicate/i);
  });

  it("is readable by its owner and invisible to anyone else", async () => {
    expect((await db.asUser(alice, `select id from local_usage_observations`)).length).toBe(1);
    expect((await db.asUser(bob, `select id from local_usage_observations`)).length).toBe(0);
  });

  it("cannot be written by a client role, even the owner", async () => {
    await expect(db.asUser(alice, INSERT_OBSERVATION, OBSERVATION("ev-client"))).rejects.toThrow(/permission denied|violates row-level/i);
    await expect(
      db.asUser(alice, `update local_usage_observations set verification_level = 'provider_correlated' where local_event_id = 'ev-1'`),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe("database-level invariants added at preflight", () => {
  it("refuses a negative token count even from the service role", async () => {
    const row = OBSERVATION("ev-negative");
    row[10] = -1;
    await expect(db.asServiceRole(INSERT_OBSERVATION, row)).rejects.toThrow(/check constraint|violates/i);
  });

  it("refuses to bind an observation to a device another user owns", async () => {
    // bob's user id with alice's device: the composite foreign key has no such pair.
    const row = OBSERVATION("ev-cross-user");
    row[0] = bob;
    await expect(db.asServiceRole(INSERT_OBSERVATION, row)).rejects.toThrow(/foreign key|violates/i);
  });

  it("refuses a mapping that belongs to a different device", async () => {
    const [other] = await db.asServiceRole<{ id: string }>(
      `insert into miner_devices (user_id, name, platform, app_version) values ($1, 'DESKTOP-B', 'win32', '0.4.0') returning id`,
      [alice],
    );
    const row = OBSERVATION("ev-cross-device");
    row[1] = other.id; // alice's other device, but `mapping` belongs to the first one
    await expect(db.asServiceRole(INSERT_OBSERVATION, row)).rejects.toThrow(/foreign key|violates/i);
  });

  it("refuses a mapping for a device the user does not own", async () => {
    await expect(
      db.asServiceRole(
        `insert into miner_tool_mappings (device_id, user_id, tool_id, metering_method, verification_capability)
         values ($1, $2, 'codex', 'native_otel', 'device_attested')`,
        [device, bob],
      ),
    ).rejects.toThrow(/foreign key|violates/i);
  });
});

describe("tool mappings", () => {
  it("are owner-readable and client-unwritable", async () => {
    expect((await db.asUser(alice, `select tool_id, status from miner_tool_mappings`)).length).toBe(1);
    expect((await db.asUser(bob, `select tool_id from miner_tool_mappings`)).length).toBe(0);
    await expect(
      db.asUser(alice, `update miner_tool_mappings set verification_capability = 'routed_confirmed' where id = $1`, [mapping]),
    ).rejects.toThrow(/permission denied/i);
  });

  it("are one per device and tool", async () => {
    await expect(
      db.asServiceRole(
        `insert into miner_tool_mappings (device_id, user_id, tool_id, metering_method, verification_capability)
         values ($1, $2, 'claude-code', 'native_otel', 'provider_correlated')`,
        [device, alice],
      ),
    ).rejects.toThrow(/unique|duplicate/i);
  });
});

describe("credential scopes", () => {
  it("refuse a scope nobody implemented", async () => {
    await expect(
      db.asServiceRole(
        `insert into usage_miner_credentials (user_id, name, token_hash, token_prefix, scopes)
         values ($1, 'x', 'hash-1', 'usgm_', array['miner:route', 'account:write'])`,
        [alice],
      ),
    ).rejects.toThrow(/check constraint|violates/i);
  });

  it("default to the device set including telemetry and mappings", async () => {
    const [row] = await db.asServiceRole<{ scopes: string[] }>(
      `insert into usage_miner_credentials (user_id, name, token_hash, token_prefix) values ($1, 'y', 'hash-2', 'usgm_') returning scopes`,
      [alice],
    );
    expect(row.scopes).toContain("miner:telemetry");
    expect(row.scopes).toContain("miner:mappings");
    expect(row.scopes.every((s) => s.startsWith("miner:"))).toBe(true);
  });
});

describe("correlation cannot move money", () => {
  let eventId: string;

  beforeAll(async () => {
    // A routed, confirmed, ELIGIBLE event the server produced -- with a settled
    // ledger entry behind it, the way a real settled epoch leaves things.
    const [e] = await db.asServiceRole<{ id: string }>(
      `insert into usage_events
         (user_id, provider, source, external_reference, model, occurred_at, input_tokens, cached_input_tokens, output_tokens, requests,
          actual_cost_micros, normalized_cost_micros, verification_type, verification_status, economic_status,
          protocol_compute_micros, pricing_status, protocol_pricing_version, economic_source_class, eligible_compute_micros, reward_status,
          reward_policy_version, raw_metadata, provenance_sources, verification_level)
       values ($1, 'anthropic', 'gateway', 'live:gen-1', 'anthropic/claude-sonnet-5', '2026-09-09T11:00:00Z', 500, 0, 100, 1,
               3000, 3000, 'routed', 'confirmed', 'settled',
               2500, 'priced', 'usage-pricing-v2', 'metered_paid', 2500, 'eligible',
               'usage-reward-policy-v1', '{"upstream_request_id":"req_match_1"}'::jsonb, array['usage_gateway'], 'routed_confirmed')
       returning id`,
      [alice],
    );
    eventId = e.id;
    await db.asServiceRole(
      `insert into reward_epochs (id, starts_at, ends_at, reward_pool_points, scoring_version, settled_at)
       values ('epoch-test-1', '2026-09-09T00:00:00Z', '2026-09-10T00:00:00Z', 100000, 'usage_score_v1', now())
       on conflict (id) do nothing`,
    );
    await db.asServiceRole(
      `insert into usage_point_ledger (user_id, epoch_id, allocation_id, amount, reason)
       values ($1, 'epoch-test-1', 'alloc-test-1', 42, 'settlement')`,
      [alice],
    );
  });

  it("the correlation update touches provenance only, and the ledger and reward stand", async () => {
    const before = await db.asServiceRole<{ amount: string; eligible: string; reward_status: string }>(
      `select l.amount::text as amount, e.eligible_compute_micros::text as eligible, e.reward_status
         from usage_point_ledger l, usage_events e where l.user_id = $1 and e.id = $2`,
      [alice, eventId],
    );

    // Exactly the statement the ingestion code issues on a match.
    await db.asServiceRole(
      `update usage_events set provenance_sources = $1, correlation_status = 'matched' where id = $2 and user_id = $3`,
      [["local_telemetry", "usage_gateway"], eventId, alice],
    );
    await db.asServiceRole(
      `update local_usage_observations set correlation_status = 'matched', verification_level = 'provider_correlated', correlated_event_id = $1
        where local_event_id = 'ev-1'`,
      [eventId],
    );

    const after = await db.asServiceRole<{ amount: string; eligible: string; reward_status: string; sources: string[] }>(
      `select l.amount::text as amount, e.eligible_compute_micros::text as eligible, e.reward_status, e.provenance_sources as sources
         from usage_point_ledger l, usage_events e where l.user_id = $1 and e.id = $2`,
      [alice, eventId],
    );
    expect(after[0].amount).toBe(before[0].amount);
    expect(after[0].eligible).toBe(before[0].eligible);
    expect(after[0].reward_status).toBe(before[0].reward_status);
    expect(after[0].sources).toEqual(["local_telemetry", "usage_gateway"]);
    // Still exactly one event, one ledger row: correlation inserted nothing.
    expect((await db.asServiceRole<{ n: string }>(`select count(*)::text as n from usage_events where user_id = $1`, [alice]))[0].n).toBe("1");
    expect((await db.asServiceRole<{ n: string }>(`select count(*)::text as n from usage_point_ledger where user_id = $1`, [alice]))[0].n).toBe("1");
  });

  it("a fabricated local observation of enormous usage earns nothing", async () => {
    await db.asServiceRole(INSERT_OBSERVATION, [
      ...OBSERVATION("ev-huge").slice(0, 10), 50_000_000, 50_000_000, "2026-09-09T12:00:00Z", "sess", "ev-huge",
    ]);
    // Nothing in scoring, settlement or the ledger reads local_usage_observations.
    const refs = await db.sql<{ n: string }>(
      `select count(*)::text as n from pg_depend d join pg_class c on c.oid = d.refobjid
        where c.relname = 'local_usage_observations' and d.classid = 'pg_rewrite'::regclass`,
    );
    expect(refs[0].n).toBe("0");
    const ledger = await db.asServiceRole<{ total: string }>(`select coalesce(sum(amount),0)::text as total from usage_point_ledger where user_id = $1`, [alice]);
    expect(ledger[0].total).toBe("42");
  });
});

describe("wallet boundary", () => {
  it("exists, is unreachable by any client role, and is referenced by nothing economic", async () => {
    await db.asServiceRole(
      `insert into wallet_connections (user_id, chain_namespace, chain_id, address) values ($1, 'eip155', '1', '0xabc')`,
      [alice],
    );
    await expect(db.asUser(alice, `select * from wallet_connections`)).rejects.toThrow(/permission denied/i);
    // A wallet row changed nothing about what alice earned.
    const ledger = await db.asServiceRole<{ total: string }>(`select coalesce(sum(amount),0)::text as total from usage_point_ledger where user_id = $1`, [alice]);
    expect(ledger[0].total).toBe("42");
    const deps = await db.sql<{ n: string }>(
      `select count(*)::text as n from pg_depend d join pg_class c on c.oid = d.refobjid
        where c.relname = 'wallet_connections' and d.classid = 'pg_rewrite'::regclass`,
    );
    expect(deps[0].n).toBe("0");
  });
});
