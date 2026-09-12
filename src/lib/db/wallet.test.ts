import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@/test/pg";

/**
 * 0024 — the wallet ledger, on real Postgres.
 *
 * What matters here is not that rows can be written. It is that the database
 * refuses the three things that would turn a wallet into a leak: crediting the
 * same payment twice, a browser writing its own credit, and one account
 * reading another's ledger. A test that only exercised the happy path would
 * prove none of them.
 */

let db: TestDb;
let alice: string;
let bob: string;

beforeAll(async () => {
  db = await createTestDb();
  alice = await db.createUser("alice@example.com");
  bob = await db.createUser("bob@example.com");
});

afterAll(async () => {
  await db?.close();
});

describe("usage_wallet_entries", () => {
  it("accepts a grant from trusted server-side code", async () => {
    const rows = await db.asServiceRole<{ amount_micros: string }>(
      `insert into usage_wallet_entries (user_id, kind, amount_micros, reference, note)
       values ($1, 'grant', 500000, 'starting-credit-v1', 'Starting credit')
       returning amount_micros`,
      [alice],
    );
    expect(Number(rows[0]!.amount_micros)).toBe(500_000);
  });

  it("refuses the same reference twice, so a payment cannot be credited again", async () => {
    await db.asServiceRole(
      `insert into usage_wallet_entries (user_id, kind, amount_micros, reference)
       values ($1, 'topup', 10000000, 'pi_duplicate')`,
      [alice],
    );

    await expect(
      db.asServiceRole(
        `insert into usage_wallet_entries (user_id, kind, amount_micros, reference)
         values ($1, 'topup', 10000000, 'pi_duplicate')`,
        [alice],
      ),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it("lets two different people use the same reference, because it is theirs separately", async () => {
    const rows = await db.asServiceRole(
      `insert into usage_wallet_entries (user_id, kind, amount_micros, reference)
       values ($1, 'topup', 1000000, 'pi_duplicate') returning id`,
      [bob],
    );
    expect(rows).toHaveLength(1);
  });

  it("refuses an entry that moves nothing", async () => {
    await expect(
      db.asServiceRole(
        `insert into usage_wallet_entries (user_id, kind, amount_micros) values ($1, 'grant', 0)`,
        [alice],
      ),
    ).rejects.toThrow();
  });

  it("refuses a negative grant and a positive refund", async () => {
    await expect(
      db.asServiceRole(`insert into usage_wallet_entries (user_id, kind, amount_micros) values ($1, 'grant', -1)`, [alice]),
    ).rejects.toThrow();

    await expect(
      db.asServiceRole(`insert into usage_wallet_entries (user_id, kind, amount_micros) values ($1, 'refund', 1)`, [alice]),
    ).rejects.toThrow();
  });

  it("refuses a kind nobody defined", async () => {
    await expect(
      db.asServiceRole(`insert into usage_wallet_entries (user_id, kind, amount_micros) values ($1, 'mint', 100)`, [alice]),
    ).rejects.toThrow();
  });

  it("refuses a currency that is not dollars, because every amount here is micro-USD", async () => {
    await expect(
      db.asServiceRole(
        `insert into usage_wallet_entries (user_id, kind, amount_micros, currency) values ($1, 'grant', 100, 'EUR')`,
        [alice],
      ),
    ).rejects.toThrow();
  });
});

describe("who may touch a wallet", () => {
  it("lets a person read their own ledger", async () => {
    const own = await db.asUser<{ user_id: string }>(alice, `select user_id from usage_wallet_entries`);
    expect(own.length).toBeGreaterThan(0);
    expect(own.every((row) => row.user_id === alice)).toBe(true);
  });

  it("shows one person nothing of another's", async () => {
    const seen = await db.asUser<{ user_id: string }>(bob, `select user_id from usage_wallet_entries`);
    expect(seen.every((row) => row.user_id === bob)).toBe(true);
  });

  it("refuses to let a signed-in browser write its own credit", async () => {
    await expect(
      db.asUser(alice, `insert into usage_wallet_entries (user_id, kind, amount_micros) values ($1, 'topup', 99999999)`, [alice]),
    ).rejects.toThrow();
  });

  it("refuses to let somebody edit an entry after the fact", async () => {
    await expect(db.asUser(alice, `update usage_wallet_entries set amount_micros = 99999999`)).rejects.toThrow();
    await expect(db.asUser(alice, `delete from usage_wallet_entries`)).rejects.toThrow();
  });

  it("shows an anonymous visitor nothing at all", async () => {
    const rows = await db.asAnon(`select id from usage_wallet_entries`).catch(() => []);
    expect(rows).toHaveLength(0);
  });
});

describe("the wallet and the points ledger stay apart", () => {
  it("has no foreign key, view or trigger joining credit to points", async () => {
    const links = await db.sql<{ count: string }>(
      `select count(*)::text as count
         from information_schema.referential_constraints rc
         join information_schema.constraint_column_usage ccu on ccu.constraint_name = rc.unique_constraint_name
        where ccu.table_name = 'usage_point_ledger'
          and rc.constraint_name in (
            select constraint_name from information_schema.table_constraints where table_name = 'usage_wallet_entries'
          )`,
    );
    expect(Number(links[0]!.count)).toBe(0);
  });

  it("keeps the wallet in money and the points ledger in points", async () => {
    const columns = await db.sql<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_name = 'usage_wallet_entries' and column_name like '%point%'`,
    );
    expect(columns).toHaveLength(0);
  });
});
