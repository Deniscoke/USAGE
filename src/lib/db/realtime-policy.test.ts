import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@/test/pg";

/**
 * M16B — migration 0021's Realtime Authorization policy, checked against a
 * real PostgreSQL with the realtime schema shimmed (src/test/pg.ts).
 * `realtime.topic()` is what the Realtime server evaluates when a browser
 * joins a private channel; here it reads a transaction-local setting.
 */

let db: TestDb;
let alice: string;
let bob: string;

beforeAll(async () => {
  db = await createTestDb();
  alice = await db.createUser("live-alice@example.com");
  bob = await db.createUser("live-bob@example.com");
  await db.asServiceRole(`insert into realtime.messages (topic, extension, payload) values ($1, 'broadcast', '{"name":"mining.request.started"}'), ($2, 'broadcast', '{"name":"mining.request.started"}'), ($1, 'presence', '{}')`, [`mining:${alice}`, `mining:${bob}`]);
}, 90_000);

afterAll(async () => {
  await db?.close();
});

describe("private mining channel policy", () => {
  it("a user receives broadcasts on their own topic only", async () => {
    // The policy compares realtime.topic() with mining:<auth.uid()>; set the
    // joined topic inside the same transaction the policy is evaluated in.
    const own = await db.asUser<{ n: string }>(alice, `select count(*)::text as n from (select set_config('realtime.topic', $1, true)) s, realtime.messages m where m.topic = $1`, [`mining:${alice}`]);
    expect(Number(own[0].n)).toBe(1); // the broadcast row, not the presence row
    const other = await db.asUser<{ n: string }>(alice, `select count(*)::text as n from (select set_config('realtime.topic', $1, true)) s, realtime.messages m where m.topic = $1`, [`mining:${bob}`]);
    // Alice joining Bob's topic: policy false for every row.
    expect(Number(other[0].n)).toBe(0);
  });

  it("User A cannot read User B's live events even by querying the table directly", async () => {
    const rows = await db.asUser<{ topic: string }>(alice, `select topic from realtime.messages`, []);
    // Without joining any topic, realtime.topic() is null and the policy grants nothing.
    expect(rows).toEqual([]);
  });

  it("anon receives nothing; the service role (publisher) bypasses the policy", async () => {
    const anon = await db.asAnon<{ n: string }>(`select count(*)::text as n from (select set_config('realtime.topic', $1, true)) s, realtime.messages m where m.topic = $1`, [`mining:${alice}`]);
    expect(Number(anon[0].n)).toBe(0);
    const all = await db.asServiceRole<{ n: string }>(`select count(*)::text as n from realtime.messages`);
    expect(Number(all[0].n)).toBe(3);
  });

  it("browsers cannot publish: no insert policy exists for authenticated", async () => {
    await expect(db.asUser(alice, `insert into realtime.messages (topic, extension, payload) values ($1, 'broadcast', '{}')`, [`mining:${alice}`])).rejects.toThrow(/permission denied|row-level security/);
  });
});
