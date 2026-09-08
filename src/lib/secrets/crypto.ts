import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Provider credential encryption.
 *
 * A user's provider API key is their money: whoever holds it can spend their
 * account. USAGE needs it to route requests, so it cannot be hashed -- but it
 * must never be readable from the database alone.
 *
 * AES-256-GCM with a server-held key. The key lives only in server environment
 * configuration, so a database dump is inert without it, and GCM's tag makes
 * tampering with a stored ciphertext a decryption failure rather than a silently
 * different plaintext.
 *
 * WHY NOT SUPABASE VAULT (yet): Vault is the right home for this and the schema
 * is shaped for it -- `provider_connections.secret_ref` is an opaque handle, so
 * swapping the store means changing this file and nothing else. Vault is not
 * available in the in-process Postgres the integration tests run against, and a
 * credential path that cannot be tested is worse than one that can.
 *
 * The plaintext exists in memory for the duration of one request and is never
 * logged, never returned to a client, never written to a receipt, and never
 * stored anywhere but here, encrypted.
 */

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const VERSION = "v1";

export class SecretCryptoError extends Error {
  constructor(
    readonly code: "no_key" | "bad_key" | "malformed" | "undecryptable",
    message: string,
  ) {
    super(message);
    this.name = "SecretCryptoError";
  }
}

/**
 * The server encryption key, from configuration.
 *
 * Deliberately not defaulted. A default would mean every deployment that forgot
 * to set one shared the same key, which is the same as having no key.
 */
export function encryptionKey(): Buffer {
  const configured = process.env.USAGE_SECRET_ENCRYPTION_KEY?.trim();
  if (!configured) {
    throw new SecretCryptoError(
      "no_key",
      "USAGE_SECRET_ENCRYPTION_KEY is not configured; provider credentials cannot be stored.",
    );
  }

  const key = Buffer.from(configured, "base64");
  if (key.length !== KEY_BYTES) {
    throw new SecretCryptoError(
      "bad_key",
      `USAGE_SECRET_ENCRYPTION_KEY must be ${KEY_BYTES} bytes of base64.`,
    );
  }
  return key;
}

export function secretsConfigured(): boolean {
  try {
    encryptionKey();
    return true;
  } catch {
    return false;
  }
}

/** Generate a key for an operator to paste into configuration. */
export function generateEncryptionKey(): string {
  return randomBytes(KEY_BYTES).toString("base64");
}

/**
 * Encrypt a credential.
 *
 * The stored form is `v1.<iv>.<tag>.<ciphertext>`, all base64url. Versioned so
 * a future algorithm change can decrypt old values instead of orphaning them.
 */
export function encryptSecret(plaintext: string, key: Buffer = encryptionKey()): string {
  if (!plaintext) throw new SecretCryptoError("malformed", "Refusing to store an empty secret.");

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptSecret(stored: string, key: Buffer = encryptionKey()): string {
  const parts = stored.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new SecretCryptoError("malformed", "Stored secret is not in a recognised format.");
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(parts[1], "base64url"));
    decipher.setAuthTag(Buffer.from(parts[2], "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(parts[3], "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // Wrong key, or someone edited the ciphertext. Both mean the same thing to
    // a caller: this value cannot be trusted, so it is not returned.
    throw new SecretCryptoError("undecryptable", "Stored secret could not be decrypted.");
  }
}

/**
 * A non-secret fingerprint, so the UI can say "the key ending 4f2a" without
 * ever holding the key. Never enough to reconstruct anything.
 */
export function secretHint(plaintext: string): string {
  const tail = plaintext.trim().slice(-4);
  return tail.length === 4 ? `…${tail}` : "…";
}

/** Constant-time comparison, for anywhere a stored value is checked. */
export function secretsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}
