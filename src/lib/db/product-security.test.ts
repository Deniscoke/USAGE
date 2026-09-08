import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@/test/pg";
import { hashMinerToken, mintMinerToken } from "@/lib/miner/token";

/**
 * Authorization for the product surfaces added in M6.
 *
 * The product now lets users create and revoke mining credentials and read a
 * network denominator. Each of those is a new place a user could try to reach
 * something that is not theirs, so each is tested against the database rather
 * than against the code that calls it.
 */

let db: TestDb;
let alice: string;
let bob: string;
let aliceCredential: string;

beforeAll(async () => {
  db = await createTestDb();
  alice = await db.createUser("product-alice@example.com");
  bob = await db.createUser("product-bob@example.com");

  const minted = mintMinerToken();
  const rows = await db.asServiceRole<{ id: string }>(
    `insert into usage_miner_credentials (user_id, name, token_hash, token_prefix)
     values ($1, 'alice miner', $2, $3) returning id`,
    [alice, minted.tokenHash, minted.tokenPrefix],
  );
  aliceCredential = rows[0].id;
}, 90_000);

afterAll(async () => {
  await db?.close();
});

describe("miner credentials belong to their owner", () => {
  it("lets a user see only their own credentials", async () => {
    const mine = await db.asUser<{ id: string }>(
      alice,
      `select id from usage_miner_credentials`,
    );
    expect(mine.map((row) => row.id)).toEqual([aliceCredential]);

    const theirs = await db.asUser(bob, `select id from usage_miner_credentials`);
    expect(theirs).toHaveLength(0);
  });

  it("never exposes the stored hash to a client", async () => {
    // Column-level grants, not a SELECT list we remembered to write correctly.
    await expect(
      db.asUser(alice, `select token_hash from usage_miner_credentials where id = $1`, [
        aliceCredential,
      ]),
    ).rejects.toThrow(/permission denied/i);
  });

  it("refuses a client-minted credential", async () => {
    // The server generates the secret; a self-issued credential would be a
    // self-issued identity.
    await expect(
      db.asUser(
        bob,
        `insert into usage_miner_credentials (user_id, name, token_hash, token_prefix)
         values ($1, 'forged', 'deadbeef', 'usgm_forged')`,
        [bob],
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it("lets an owner revoke, and silently does nothing for anyone else", async () => {
    const stolen = await db.asUser(
      bob,
      `update usage_miner_credentials set revoked_at = now() where id = $1 returning id`,
      [aliceCredential],
    );
    // RLS filters the row out, so the update matches nothing at all.
    expect(stolen).toHaveLength(0);

    const own = await db.asUser<{ id: string }>(
      alice,
      `update usage_miner_credentials set revoked_at = now() where id = $1 returning id`,
      [aliceCredential],
    );
    expect(own).toHaveLength(1);
  });

  it("keeps a revoked credential revoked for the gateway to reject", async () => {
    const minted = mintMinerToken();
    await db.asServiceRole(
      `insert into usage_miner_credentials (user_id, name, token_hash, token_prefix, revoked_at)
       values ($1, 'revoked miner', $2, $3, now())`,
      [alice, minted.tokenHash, minted.tokenPrefix],
    );

    const rows = await db.asServiceRole<{ revoked_at: string | null }>(
      `select revoked_at from usage_miner_credentials where token_hash = $1`,
      [hashMinerToken(minted.token)],
    );
    // authenticateMiner refuses on exactly this column; see gateway.test.ts.
    expect(rows[0].revoked_at).toBeTruthy();
  });
});

describe("platform tables are read-only to users", () => {
  it("publishes the provider registry but does not let a user edit it", async () => {
    const rows = await db.asUser(alice, `select slug from providers`);
    expect(Array.isArray(rows)).toBe(true);

    await expect(
      db.asUser(
        alice,
        `insert into providers (slug, name, category, status, integration_version)
         values ('forged', 'Forged', 'model_provider', 'beta', 'x@1')`,
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it("refuses a user rewriting the mining protocol", async () => {
    // Emission is protocol configuration. A user who could edit it could mint.
    await expect(
      db.asUser(
        alice,
        `update mining_protocol_versions set epoch_emission_points = 999999999`,
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it("refuses a user writing their own balance snapshot", async () => {
    await expect(
      db.asUser(
        alice,
        `insert into point_balance_snapshots (user_id, epoch_id, points_credited, balance_after)
         values ($1, 'epoch-2026-09-08', 1000000, 1000000)`,
        [alice],
      ),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe("the network denominator is an aggregate, not a leak", () => {
  beforeAll(async () => {
    await db.asServiceRole(
      `insert into score_records (user_id, day, algorithm_version, points)
       values ($1, '2026-09-08', 'usage_score_v1', 40),
              ($2, '2026-09-08', 'usage_score_v1', 60)
       on conflict (user_id, day, algorithm_version) do update set points = excluded.points`,
      [alice, bob],
    );
  });

  it("totals every participant, including ones the caller cannot read", async () => {
    // Alice cannot see Bob's score row...
    const visible = await db.asUser<{ n: string }>(
      alice,
      `select count(*)::text as n from score_records where day = '2026-09-08'`,
    );
    expect(Number(visible[0].n)).toBe(1);

    // ...but the epoch total is the whole network, which is what a share needs.
    const totals = await db.asUser<{ network_score: string; participants: string }>(
      alice,
      `select network_score::text, participants::text from epoch_network_totals
       where day = '2026-09-08' and algorithm_version = 'usage_score_v1'`,
    );
    expect(Number(totals[0].network_score)).toBe(100);
    expect(Number(totals[0].participants)).toBe(2);
  });

  it("exposes no user identity through the view", async () => {
    const columns = await db.asUser<{ column_name: string }>(
      alice,
      `select column_name from information_schema.columns
       where table_name = 'epoch_network_totals'`,
    );
    const names = columns.map((row) => row.column_name);
    expect(names).not.toContain("user_id");
    expect(names.sort()).toEqual(["algorithm_version", "day", "network_score", "participants"]);
  });
});
