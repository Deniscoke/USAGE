import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@/test/pg";
import { parseInstallationId } from "@/lib/miner/pairing-codes";

/**
 * Migration 0028: one live device row per installation per account.
 *
 * `approve()` reuses the row; these tests hold the database to the rules that
 * make reuse safe even if the server code is wrong or two approvals race.
 */

let db: TestDb;
let alice: string;
let bob: string;
const INSTALL = "5f0c2b7e-8d1a-4c3e-9b2f-6a7d8e9f0a1b";

beforeAll(async () => {
  db = await createTestDb();
  alice = await db.createUser("install-alice@example.com");
  bob = await db.createUser("install-bob@example.com");
}, 90_000);

afterAll(async () => {
  await db?.close();
});

function insertDevice(userId: string, installationId: string | null, name = "DESKTOP") {
  return db.asServiceRole<{ id: string }>(
    `insert into miner_devices (user_id, name, platform, app_version, installation_id)
     values ($1, $2, 'win32', '0.4.6', $3) returning id`,
    [userId, name, installationId],
  );
}

describe("installation id parsing", () => {
  it("keeps a well-formed id, normalised", () => {
    expect(parseInstallationId(INSTALL)).toBe(INSTALL);
    expect(parseInstallationId(` ${INSTALL.toUpperCase()} `)).toBe(INSTALL);
  });

  it("turns anything else into no id, never an error", () => {
    for (const value of [undefined, null, 42, "", "not-a-uuid", `${INSTALL}x`, "'; drop table miner_devices; --"]) {
      expect(parseInstallationId(value)).toBeNull();
    }
  });
});

describe("installation identity in the database", () => {
  it("allows only one live row per installation on an account", async () => {
    await insertDevice(alice, INSTALL);
    // Two approvals racing for the same installation: the loser fails.
    await expect(insertDevice(alice, INSTALL)).rejects.toThrow(/duplicate key|unique/i);
  });

  it("starts a new row after the owner revoked the old one", async () => {
    await db.asServiceRole(
      `update miner_devices set revoked_at = now() where user_id = $1 and installation_id = $2`,
      [alice, INSTALL],
    );
    const [fresh] = await insertDevice(alice, INSTALL);
    expect(fresh.id).toBeTruthy();
  });

  it("never links one account's installation to another account", async () => {
    // Same id on a different account is a different association, not a clash.
    const [row] = await insertDevice(bob, INSTALL);
    const visibleToAlice = await db.asUser(alice, `select id from miner_devices where id = $1`, [row.id]);
    expect(visibleToAlice).toHaveLength(0);
  });

  it("keeps old miners that send no id pairing as before", async () => {
    await insertDevice(alice, null, "OLD-MINER");
    await insertDevice(alice, null, "OLD-MINER");
    const rows = await db.sql(`select 1 from miner_devices where user_id = $1 and name = 'OLD-MINER'`, [alice]);
    expect(rows).toHaveLength(2);
  });

  it("refuses a malformed id even from the service role", async () => {
    await expect(insertDevice(alice, "not-a-uuid")).rejects.toThrow(/installation_id_format/);
    await expect(
      db.asServiceRole(
        `insert into miner_pairing_requests (user_code, poll_token_hash, device_name, platform, app_version, installation_id)
         values ('ZZZZ-ZZZZ', 'feed', 'x', 'win32', '0.4.6', 'nope')`,
      ),
    ).rejects.toThrow(/installation_id_format/);
  });

  it("gives clients no way to set an installation id on a device", async () => {
    await expect(
      db.asUser(alice, `update miner_devices set installation_id = $1`, [INSTALL]),
    ).rejects.toThrow(/permission denied/i);
  });
});
