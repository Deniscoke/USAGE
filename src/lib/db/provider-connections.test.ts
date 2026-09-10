import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@/test/pg";
import {
  decryptSecret,
  encryptSecret,
  generateEncryptionKey,
  secretHint,
  SecretCryptoError,
} from "@/lib/secrets/crypto";

/**
 * Provider connections: ownership, secrecy, and revocation, against a real
 * Postgres.
 *
 * These are the guarantees that make "connect any provider" safe to offer. A
 * provider API key is the user's money; if any of these fail, USAGE is a
 * credential-harvesting service with a dashboard.
 */

let db: TestDb;
let alice: string;
let bob: string;
let aliceSecret: string;
let aliceConnection: string;
let aliceDefinition: string;

const KEY = Buffer.from(generateEncryptionKey(), "base64");

beforeAll(async () => {
  db = await createTestDb();
  alice = await db.createUser("conn-alice@example.com");
  bob = await db.createUser("conn-bob@example.com");

  const [definition] = await db.asServiceRole<{ id: string }>(
    `insert into provider_definitions
       (slug, display_name, protocol, origin, owner_user_id, default_base_url,
        supports_usage, supports_request_identity, verification_capability)
     values ('deepseek', 'DeepSeek', 'openai_compatible', 'custom', $1,
             'https://api.deepseek.com', true, true, 'routed')
     returning id`,
    [alice],
  );
  aliceDefinition = definition.id;

  const [secret] = await db.asServiceRole<{ id: string }>(
    `insert into provider_secrets (user_id, ciphertext, hint)
     values ($1, $2, $3) returning id`,
    [alice, encryptSecret("sk-alice-provider-key", KEY), secretHint("sk-alice-provider-key")],
  );
  aliceSecret = secret.id;

  const [connection] = await db.asServiceRole<{ id: string }>(
    `insert into provider_connections
       (user_id, provider, account_label, method, status, definition_id, protocol,
        base_url, secret_id, connection_status, mining_eligibility)
     values ($1, 'deepseek', 'DeepSeek', 'byok', 'active', $2, 'openai_compatible',
             'https://api.deepseek.com', $3, 'active', 'pending_pricing')
     returning id`,
    [alice, aliceDefinition, aliceSecret],
  );
  aliceConnection = connection.id;
}, 90_000);

afterAll(async () => {
  await db?.close();
});

describe("credential encryption", () => {
  it("round-trips a credential", () => {
    const stored = encryptSecret("sk-test-credential", KEY);
    expect(decryptSecret(stored, KEY)).toBe("sk-test-credential");
  });

  it("never stores the plaintext", () => {
    const stored = encryptSecret("sk-super-secret-value", KEY);
    expect(stored).not.toContain("sk-super-secret-value");
    expect(stored).not.toContain("super");
    expect(stored.startsWith("v1.")).toBe(true);
  });

  it("produces a different ciphertext every time", () => {
    // A deterministic ciphertext would leak that two users share a key.
    expect(encryptSecret("same", KEY)).not.toBe(encryptSecret("same", KEY));
  });

  it("is useless without the key", () => {
    const stored = encryptSecret("sk-value", KEY);
    const other = Buffer.from(generateEncryptionKey(), "base64");
    expect(() => decryptSecret(stored, other)).toThrow(SecretCryptoError);
  });

  it("detects tampering rather than returning something else", () => {
    const stored = encryptSecret("sk-value", KEY);
    const parts = stored.split(".");
    const tampered = [parts[0], parts[1], parts[2], Buffer.from("evil").toString("base64url")].join(".");
    expect(() => decryptSecret(tampered, KEY)).toThrow(/could not be decrypted/);
  });

  it("refuses to store an empty secret", () => {
    expect(() => encryptSecret("", KEY)).toThrow(SecretCryptoError);
  });

  it("gives a hint that identifies without revealing", () => {
    const hint = secretHint("sk-proj-abcdefgh1234");
    expect(hint).toBe("…1234");
    expect(hint).not.toContain("sk-proj");
  });
});

describe("a client can never read a stored credential", () => {
  it("gives no client role any access to provider_secrets at all", async () => {
    // Not "cannot read someone else's" -- cannot read ANY, their own included.
    // They supplied the secret; they do not need it back, and a read path is a
    // leak waiting for a bug.
    await expect(
      db.asUser(alice, `select ciphertext from provider_secrets where user_id = $1`, [alice]),
    ).rejects.toThrow(/permission denied/i);

    await expect(
      db.asUser(alice, `select count(*) from provider_secrets`),
    ).rejects.toThrow(/permission denied/i);
  });

  it("refuses a client writing its own secret row", async () => {
    await expect(
      db.asUser(
        alice,
        `insert into provider_secrets (user_id, ciphertext) values ($1, 'v1.a.b.c')`,
        [alice],
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it("exposes only a handle on the connection, never the credential", async () => {
    const [row] = await db.asUser<{ secret_id: string; base_url: string }>(
      alice,
      `select secret_id, base_url from provider_connections where id = $1`,
      [aliceConnection],
    );
    expect(row.secret_id).toBe(aliceSecret);
    // The handle is a uuid. It is not, and cannot become, a credential.
    expect(row.secret_id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("connections and definitions belong to their owner", () => {
  it("lets a user see only their own connections", async () => {
    const mine = await db.asUser<{ id: string }>(alice, `select id from provider_connections`);
    expect(mine.map((row) => row.id)).toContain(aliceConnection);

    const theirs = await db.asUser<{ id: string }>(bob, `select id from provider_connections`);
    expect(theirs.map((row) => row.id)).not.toContain(aliceConnection);
  });

  it("keeps a custom provider definition private to its creator", async () => {
    // One person adding "DeepSeek" must not publish a provider for everybody.
    const mine = await db.asUser<{ id: string }>(alice, `select id from provider_definitions`);
    expect(mine.map((row) => row.id)).toContain(aliceDefinition);

    const theirs = await db.asUser<{ id: string }>(bob, `select id from provider_definitions`);
    expect(theirs.map((row) => row.id)).not.toContain(aliceDefinition);
  });

  it("shows official definitions to everyone", async () => {
    await db.asServiceRole(
      `insert into provider_definitions (slug, display_name, protocol, origin, verification_capability)
       values ('official-thing', 'Official Thing', 'openai_compatible', 'official', 'routed')`,
    );
    const visible = await db.asUser<{ slug: string }>(bob, `select slug from provider_definitions`);
    expect(visible.map((row) => row.slug)).toContain("official-thing");
  });

  it("refuses a client creating a definition or claiming capabilities", async () => {
    // Capabilities are discovered by the server. A user declaring
    // supports_usage would be declaring their own mining eligibility.
    await expect(
      db.asUser(
        bob,
        `insert into provider_definitions (slug, display_name, protocol, origin, owner_user_id, supports_usage)
         values ('forged', 'Forged', 'openai_compatible', 'custom', $1, true)`,
        [bob],
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it("refuses a client declaring its own mining eligibility", async () => {
    await expect(
      db.asUser(
        alice,
        `update provider_connections set mining_eligibility = 'eligible_route'
         where id = $1`,
        [aliceConnection],
      ),
    ).rejects.toThrow(/permission denied|denied/i);
  });

  it("refuses a client declaring protocol pricing for its own model", async () => {
    // The anti-fraud rule: a custom provider cannot price itself into rewards.
    await db.asServiceRole(
      `insert into provider_models (definition_id, upstream_model_id)
       values ($1, 'deepseek-chat')`,
      [aliceDefinition],
    );

    await expect(
      db.asUser(
        alice,
        `update provider_models set protocol_model_key = 'anthropic/claude-opus-5'`,
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it("stores an unknown model as unpriced rather than guessing", async () => {
    const [model] = await db.asServiceRole<{ protocol_model_key: string | null }>(
      `select protocol_model_key from provider_models where definition_id = $1`,
      [aliceDefinition],
    );
    expect(model.protocol_model_key).toBeNull();
  });
});

describe("revocation", () => {
  it("takes effect immediately for routing", async () => {
    const [connection] = await db.asServiceRole<{ id: string }>(
      `insert into provider_connections
         (user_id, provider, account_label, method, status, definition_id, protocol,
          base_url, secret_id, connection_status)
       values ($1, 'temp', 'Temp', 'byok', 'active', $2, 'openai_compatible',
               'https://api.example.com', $3, 'active')
       returning id`,
      [alice, aliceDefinition, aliceSecret],
    );

    await db.asServiceRole(
      `update provider_connections
       set connection_status = 'revoked', revoked_at = now()
       where id = $1`,
      [connection.id],
    );

    // What resolveForRequest checks before it will route anything.
    const [row] = await db.asServiceRole<{ revoked_at: string | null; connection_status: string }>(
      `select revoked_at, connection_status from provider_connections where id = $1`,
      [connection.id],
    );
    expect(row.revoked_at).toBeTruthy();
    expect(row.connection_status).toBe("revoked");
  });
});

describe("connection status is specific enough to act on", () => {
  it("refuses a status the vocabulary does not define", async () => {
    await expect(
      db.asServiceRole(
        `update provider_connections set connection_status = 'vibes' where id = $1`,
        [aliceConnection],
      ),
    ).rejects.toThrow();
  });

  it("keeps every documented status usable", async () => {
    for (const status of [
      "validating",
      "active",
      "limited",
      "invalid_credentials",
      "unsupported_usage",
      "pending_pricing",
      "error",
      "revoked",
    ]) {
      await db.asServiceRole(
        `update provider_connections set connection_status = $2 where id = $1`,
        [aliceConnection, status],
      );
    }
  });
});

describe("reconnecting a revoked provider", () => {
  it("the schema allows one row per (user, provider, label): a second insert is refused, so reconnect must revive", async () => {
    const bob = { id: await db.createUser("bob-reconnect@example.com") };
    const [secret] = await db.asServiceRole<{ id: string }>(
      `insert into provider_secrets (user_id, ciphertext, hint) values ($1, $2, $3) returning id`,
      [bob.id, encryptSecret("sk-or-old", KEY), secretHint("sk-or-old")],
    );
    const [old] = await db.asServiceRole<{ id: string }>(
      `insert into provider_connections
         (user_id, provider, account_label, method, auth_method, status, definition_id, protocol,
          base_url, secret_id, connection_status, mining_eligibility, revoked_at)
       values ($1, 'openrouter', 'OpenRouter', 'byok', 'oauth', 'revoked', $2, 'openai_compatible',
               'https://openrouter.ai/api', $3, 'revoked', 'eligible_route', now())
       returning id`,
      [bob.id, aliceDefinition, secret.id],
    );

    // What the callback used to do: insert again. The database says no.
    await expect(
      db.asServiceRole(
        `insert into provider_connections
           (user_id, provider, account_label, method, auth_method, status, definition_id, protocol,
            base_url, secret_id, connection_status, mining_eligibility)
         values ($1, 'openrouter', 'OpenRouter', 'byok', 'oauth', 'active', $2, 'openai_compatible',
                 'https://openrouter.ai/api', $3, 'active', 'eligible_route')`,
        [bob.id, aliceDefinition, secret.id],
      ),
    ).rejects.toThrow(/provider_connections_user_id_provider_account_label_key/);

    // What it does now: revive the same row with the new credential.
    const [fresh] = await db.asServiceRole<{ id: string }>(
      `insert into provider_secrets (user_id, ciphertext, hint) values ($1, $2, $3) returning id`,
      [bob.id, encryptSecret("sk-or-new", KEY), secretHint("sk-or-new")],
    );
    const [revived] = await db.asServiceRole<{ id: string; revoked_at: string | null; secret_id: string; connection_status: string }>(
      `update provider_connections
         set secret_id = $2, status = 'active', connection_status = 'active', revoked_at = null,
             account_context = '{"is_free_tier": false}'::jsonb
       where user_id = $1 and provider = 'openrouter' and account_label = 'OpenRouter' and revoked_at is not null
       returning id, revoked_at, secret_id, connection_status`,
      [bob.id, fresh.id],
    );
    expect(revived.id).toBe(old.id);
    expect(revived.revoked_at).toBeNull();
    expect(revived.secret_id).toBe(fresh.id);
    expect(revived.connection_status).toBe("active");
  });
});
