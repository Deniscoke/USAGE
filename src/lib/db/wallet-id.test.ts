import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@/test/pg";

/**
 * 0025 — the wallet identifier, on real Postgres.
 *
 * The point of the test is not that a string is produced. It is that every
 * account has one without anybody remembering to ask, that two accounts can
 * never share one, and that knowing somebody's identifier still gets you
 * nothing -- because the moment an identifier starts behaving like a
 * credential, it is one.
 */

const FORMAT = /^USG-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

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

describe("wallet_id", () => {
  it("is given to every account by the database, not by application code", async () => {
    const rows = await db.sql<{ wallet_id: string }>(`select wallet_id from profiles`);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const row of rows) expect(row.wallet_id).toMatch(FORMAT);
  });

  it("uses no character that can be misread down a phone line", async () => {
    const rows = await db.sql<{ wallet_id: string }>(`select wallet_id from profiles`);
    for (const row of rows) {
      // The USG- prefix is fixed and spoken as a word; only the random part
      // has to survive being read aloud.
      const random = row.wallet_id.slice("USG-".length).replace("-", "");
      expect(random, row.wallet_id).not.toMatch(/[ILOU]/);
      expect(random).toHaveLength(8);
    }
  });

  it("gives two accounts two different identifiers", async () => {
    const rows = await db.sql<{ wallet_id: string }>(`select wallet_id from profiles`);
    const unique = new Set(rows.map((row) => row.wallet_id));
    expect(unique.size).toBe(rows.length);
  });

  it("does not repeat itself across many draws", async () => {
    const rows = await db.sql<{ id: string }>(
      `select public.new_wallet_id() as id from generate_series(1, 300)`,
    );
    expect(new Set(rows.map((row) => row.id)).size).toBe(300);
  });

  it("refuses a hand-written identifier in the wrong shape", async () => {
    await expect(db.sql(`update profiles set wallet_id = 'usg-lower-case' where id = $1`, [alice])).rejects.toThrow();
    await expect(db.sql(`update profiles set wallet_id = 'USG-IIII-OOOO' where id = $1`, [alice])).rejects.toThrow();
    await expect(db.sql(`update profiles set wallet_id = 'ABC-1234-5678' where id = $1`, [alice])).rejects.toThrow();
  });

  it("refuses to give one account another's identifier", async () => {
    const [other] = await db.sql<{ wallet_id: string }>(`select wallet_id from profiles where id = $1`, [bob]);
    await expect(
      db.sql(`update profiles set wallet_id = $1 where id = $2`, [other!.wallet_id, alice]),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it("cannot be left empty", async () => {
    await expect(db.sql(`update profiles set wallet_id = null where id = $1`, [alice])).rejects.toThrow();
  });
});

describe("the identifier is not a credential", () => {
  it("shows one person nothing of another's wallet, identifier or not", async () => {
    const seen = await db.asUser<{ id: string }>(bob, `select id from profiles`);
    expect(seen.every((row) => row.id === bob)).toBe(true);
  });

  it("does not appear in any row-level policy", async () => {
    // A policy that mentioned wallet_id would be treating it as a secret.
    const policies = await db.sql<{ qual: string | null; with_check: string | null }>(
      `select qual, with_check from pg_policies where schemaname = 'public'`,
    );
    for (const policy of policies) {
      expect(`${policy.qual ?? ""} ${policy.with_check ?? ""}`).not.toContain("wallet_id");
    }
  });
});
