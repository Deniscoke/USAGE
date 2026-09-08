import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@/test/pg";
import { createSqlIngestStore } from "@/test/sql-ingest-store";
import { ingestDemoUsage } from "./ingest";
import { MICROS_PER_USD } from "@/lib/domain/money";

/**
 * Authorization tests.
 *
 * The claim under test is not "the UI filters by user" -- it is that Postgres
 * refuses. Every assertion here runs as role `authenticated` with a real JWT
 * claim, exactly as a request through PostgREST would.
 */

let db: TestDb;
let alice: string;
let bob: string;

beforeAll(async () => {
  db = await createTestDb();
  alice = await db.createUser("alice@example.com");
  bob = await db.createUser("bob@example.com");

  await ingestDemoUsage(createSqlIngestStore(db), {
    userId: alice,
    now: new Date("2026-03-15T12:00:00.000Z"),
    historyDays: 3,
  });
}, 90_000);

afterAll(async () => {
  await db?.close();
});

async function countAs(userId: string, table: string): Promise<number> {
  const rows = await db.asUser<{ n: string }>(userId, `select count(*)::text as n from ${table}`);
  return Number(rows[0].n);
}

describe("row level security", () => {
  it("lets a user read their own usage", async () => {
    expect(await countAs(alice, "usage_events")).toBeGreaterThan(0);
    expect(await countAs(alice, "usage_daily_aggregates")).toBeGreaterThan(0);
    expect(await countAs(alice, "score_records")).toBeGreaterThan(0);
  });

  it("hides one user's usage from another authenticated user", async () => {
    expect(await countAs(bob, "usage_events")).toBe(0);
    expect(await countAs(bob, "usage_daily_aggregates")).toBe(0);
    expect(await countAs(bob, "score_records")).toBe(0);
    expect(await countAs(bob, "provider_connections")).toBe(0);
  });

  it("does not let a user read another user's rows even when naming their id", async () => {
    const rows = await db.asUser<{ n: string }>(
      bob,
      `select count(*)::text as n from usage_events where user_id = $1`,
      [alice],
    );
    expect(Number(rows[0].n)).toBe(0);
  });

  it("shows a user only their own profile", async () => {
    const rows = await db.asUser<{ id: string }>(bob, `select id from profiles`);
    expect(rows).toEqual([{ id: bob }]);
  });

  it("does not let a user modify another user's profile", async () => {
    await db.asUser(bob, `update profiles set display_name = 'hacked' where id = $1`, [alice]);
    const rows = await db.asServiceRole<{ display_name: string }>(
      `select display_name from profiles where id = $1`,
      [alice],
    );
    expect(rows[0].display_name).toBe("alice");
  });

  it("does not let a user create a connection at all, for anyone", async () => {
    // Tightened in M8: a connection now carries a base URL, a credential handle
    // and a mining eligibility, so it is written only by trusted server code.
    // A client-written row could route to an endpoint that was never validated.
    await expect(
      db.asUser(
        bob,
        `insert into provider_connections (user_id, provider, account_label)
         values ($1, 'demo-provider', 'stolen')`,
        [alice],
      ),
    ).rejects.toThrow(/permission denied/i);

    await expect(
      db.asUser(
        bob,
        `insert into provider_connections (user_id, provider, account_label)
         values ($1, 'demo-provider', 'mine')`,
        [bob],
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it("lets a user rename their own connection, and nothing else", async () => {
    const [connection] = await db.asServiceRole<{ id: string }>(
      `insert into provider_connections (user_id, provider, account_label, base_url)
       values ($1, 'renamable', 'before', 'https://api.example.com') returning id`,
      [alice],
    );

    await db.asUser(
      alice,
      `update provider_connections set account_label = 'after' where id = $1`,
      [connection.id],
    );

    // The endpoint a request would be sent to is not the user's to change.
    await expect(
      db.asUser(
        alice,
        `update provider_connections set base_url = 'https://evil.example.com' where id = $1`,
        [connection.id],
      ),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe("verification is a server-side boundary", () => {
  const insertEvent = (userId: string, verification: string) =>
    db.asUser(
      userId,
      `insert into usage_events
         (user_id, provider, source, external_reference, model, occurred_at,
          normalized_cost_micros, verification_type, verification_status)
       values ($1, 'demo-provider', 'provider_usage_api', 'forged', 'demo-large',
               now(), $2, $3::verification_type, 'confirmed')`,
      [userId, 1_000 * MICROS_PER_USD, verification],
    );

  it("refuses a client attempt to create verified usage", async () => {
    await expect(insertEvent(bob, "verified")).rejects.toThrow(/permission denied/i);
  });

  it("refuses a client attempt to create usage of any verification level", async () => {
    await expect(insertEvent(bob, "reported")).rejects.toThrow(/permission denied/i);
    await expect(insertEvent(bob, "routed")).rejects.toThrow(/permission denied/i);
  });

  it("refuses a client attempt to upgrade stored usage to verified", async () => {
    await expect(
      db.asUser(bob, `update usage_events set verification_type = 'verified'`),
    ).rejects.toThrow(/permission denied/i);
  });

  it("refuses a client attempt to declare a proof confirmed", async () => {
    await expect(
      db.asUser(
        bob,
        `insert into proof_records
           (user_id, usage_event_id, verification_type, proof_kind, proof_status, issuer, signature)
         values ($1, gen_random_uuid(), 'routed', 'gateway_observation', 'confirmed',
                 'usage://issuer/production', 'forged')`,
        [bob],
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it("refuses a client attempt to mark usage economically eligible", async () => {
    await expect(
      db.asUser(bob, `update usage_events set economic_status = 'eligible'`),
    ).rejects.toThrow(/permission denied/i);

    await expect(
      db.asUser(
        bob,
        `insert into usage_events
           (user_id, provider, source, external_reference, model, occurred_at,
            normalized_cost_micros, verification_type, economic_status)
         values ($1, 'vercel-ai-gateway', 'vercel_ai_gateway', 'live:forged',
                 'anthropic/claude-opus-5', now(), 999000000, 'routed', 'eligible')`,
        [bob],
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it("refuses client-written scores and aggregates", async () => {
    await expect(
      db.asUser(
        bob,
        `insert into score_records (user_id, day, algorithm_version, points)
         values ($1, current_date, 'usage_score_v1', 999999)`,
        [bob],
      ),
    ).rejects.toThrow(/permission denied/i);

    await expect(
      db.asUser(
        bob,
        `insert into usage_daily_aggregates
           (user_id, day, provider, model, verification_type, cost_micros)
         values ($1, current_date, 'demo-provider', 'demo-large', 'verified', 999999)`,
        [bob],
      ),
    ).rejects.toThrow(/permission denied/i);
  });
});
