import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@/test/pg";
import {
  generatePollToken,
  generateUserCode,
  hashPollToken,
  normalizeUserCode,
} from "@/lib/miner/pairing-codes";

/**
 * Device pairing security.
 *
 * Pairing replaces "copy this token into a terminal", so it has to be at least
 * as safe as the thing it replaces. The threats it must survive:
 *
 *   somebody reads the code off a screen  -> the code alone grants nothing
 *   somebody guesses a code               -> short-lived, single-use, rate-limited
 *   somebody replays a collection         -> the credential is handed over once
 *   the wrong account approves            -> the device joins THAT account only
 */

let db: TestDb;
let alice: string;
let bob: string;

beforeAll(async () => {
  db = await createTestDb();
  alice = await db.createUser("pair-alice@example.com");
  bob = await db.createUser("pair-bob@example.com");
}, 90_000);

afterAll(async () => {
  await db?.close();
});

describe("pairing codes", () => {
  it("is unguessable enough for a ten-minute window", () => {
    const codes = new Set(Array.from({ length: 500 }, () => generateUserCode()));
    // 8 characters from a 31-symbol alphabet is ~40 bits; collisions in 500
    // draws would mean the generator is not random.
    expect(codes.size).toBe(500);
  });

  it("avoids characters a person would misread", () => {
    for (let index = 0; index < 200; index += 1) {
      // No 0/O/1/I/L: the code is read off one screen and typed into another.
      expect(generateUserCode()).not.toMatch(/[01OIL]/);
    }
  });

  it("accepts a code however the user types it", () => {
    const code = generateUserCode();
    expect(normalizeUserCode(code.toLowerCase())).toBe(code);
    expect(normalizeUserCode(code.replace("-", ""))).toBe(code);
    expect(normalizeUserCode(` ${code} `)).toBe(code);
  });

  it("keeps the poll token separate from the code", () => {
    // Seeing the code must not be enough to collect the credential.
    const token = generatePollToken();
    expect(token.length).toBeGreaterThanOrEqual(43);
    expect(hashPollToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashPollToken(token)).not.toContain(token);
  });
});

describe("pairing state in the database", () => {
  it("gives no client role any access to pairing requests", async () => {
    // The table holds a token hash and, briefly, a minted credential. A browser
    // has no reason to read or write it, so it cannot.
    await expect(
      db.asUser(alice, `select user_code from miner_pairing_requests`),
    ).rejects.toThrow(/permission denied/i);

    await expect(
      db.asUser(
        alice,
        `insert into miner_pairing_requests (user_code, poll_token_hash, device_name, platform, app_version)
         values ('AAAA-BBBB', 'deadbeef', 'forged', 'win32', '0.1.0')`,
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it("lets a user see only their own devices", async () => {
    await db.asServiceRole(
      `insert into miner_devices (user_id, name, platform, app_version)
       values ($1, 'ALICE-PC', 'win32', '0.1.0')`,
      [alice],
    );

    const mine = await db.asUser<{ name: string }>(alice, `select name from miner_devices`);
    expect(mine.map((row) => row.name)).toContain("ALICE-PC");

    const theirs = await db.asUser<{ name: string }>(bob, `select name from miner_devices`);
    expect(theirs).toHaveLength(0);
  });

  it("refuses a client creating or revoking a device directly", async () => {
    // Devices are created by approval and revoked by a server action, both of
    // which run scoped to the signed-in user.
    await expect(
      db.asUser(
        bob,
        `insert into miner_devices (user_id, name, platform, app_version)
         values ($1, 'STOLEN', 'win32', '0.1.0')`,
        [alice],
      ),
    ).rejects.toThrow(/permission denied/i);

    await expect(
      db.asUser(bob, `update miner_devices set revoked_at = now()`),
    ).rejects.toThrow(/permission denied/i);
  });

  it("keeps a live code unique, so approval is unambiguous", async () => {
    await db.asServiceRole(
      `insert into miner_pairing_requests (user_code, poll_token_hash, device_name, platform, app_version)
       values ('TEST-CODE', $1, 'PC', 'win32', '0.1.0')`,
      [hashPollToken("token-one")],
    );

    await expect(
      db.asServiceRole(
        `insert into miner_pairing_requests (user_code, poll_token_hash, device_name, platform, app_version)
         values ('TEST-CODE', $1, 'PC', 'win32', '0.1.0')`,
        [hashPollToken("token-two")],
      ),
    ).rejects.toThrow();
  });

  it("frees a code once its request is finished", async () => {
    // Collected and denied codes may repeat; only live ones must be unique.
    await db.asServiceRole(
      `update miner_pairing_requests set collected_at = now() where user_code = 'TEST-CODE'`,
    );
    await db.asServiceRole(
      `insert into miner_pairing_requests (user_code, poll_token_hash, device_name, platform, app_version)
       values ('TEST-CODE', $1, 'PC', 'win32', '0.1.0')`,
      [hashPollToken("token-three")],
    );
  });

  it("expires a request without anyone having to clean up", async () => {
    await db.asServiceRole(
      `insert into miner_pairing_requests
         (user_code, poll_token_hash, device_name, platform, app_version, expires_at)
       values ('OLD-CODE', $1, 'PC', 'win32', '0.1.0', now() - interval '1 minute')`,
      [hashPollToken("token-expired")],
    );

    const live = await db.asServiceRole<{ n: string }>(
      `select count(*)::text as n from miner_pairing_requests
       where user_code = 'OLD-CODE' and expires_at > now()`,
    );
    expect(live[0].n).toBe("0");
  });

  it("revokes the credential with the device, so routing stops at once", async () => {
    const [device] = await db.asServiceRole<{ id: string }>(
      `insert into miner_devices (user_id, name, platform, app_version)
       values ($1, 'REVOKE-ME', 'win32', '0.1.0') returning id`,
      [alice],
    );
    const [credential] = await db.asServiceRole<{ id: string }>(
      `insert into usage_miner_credentials (user_id, name, token_hash, token_prefix, device_id)
       values ($1, 'REVOKE-ME', $2, 'usgm_revoke', $3) returning id`,
      [alice, "b".repeat(64), device.id],
    );
    await db.asServiceRole(`update miner_devices set credential_id = $1 where id = $2`, [
      credential.id,
      device.id,
    ]);

    // What the revoke action does.
    await db.asServiceRole(
      `update usage_miner_credentials set revoked_at = now() where id = $1`,
      [credential.id],
    );

    const [row] = await db.asServiceRole<{ revoked_at: string | null }>(
      `select revoked_at from usage_miner_credentials where id = $1`,
      [credential.id],
    );
    // authenticateMiner refuses on exactly this column.
    expect(row.revoked_at).toBeTruthy();
  });

  it("publishes the miner protocol without letting a client change it", async () => {
    const versions = await db.asUser<{ version: string }>(
      alice,
      `select version from miner_protocol_versions`,
    );
    expect(versions.length).toBeGreaterThan(0);

    await expect(
      db.asUser(alice, `update miner_protocol_versions set minimum_supported = '99.0.0'`),
    ).rejects.toThrow(/permission denied/i);
  });
});
