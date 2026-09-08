import { createHash, randomBytes, randomInt } from "node:crypto";

/**
 * Pairing code primitives.
 *
 * Deliberately free of any server dependency so they can be tested directly:
 * the security of pairing rests on these being genuinely random and on the two
 * secrets staying separate, and that should be provable without a database.
 */

/**
 * Human-readable alphabet.
 *
 * No 0/O/1/I/L: a code is read off one screen and typed into another, and a
 * misread character is a support ticket. 8 characters from 28 symbols is ~38
 * bits, which is far beyond brute-forceable inside a ten-minute window against
 * a rate limit.
 */
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE_LENGTH = 8;

export function generateUserCode(): string {
  let code = "";
  for (let index = 0; index < CODE_LENGTH; index += 1) {
    // randomInt, not Math.random: this is a credential, not a nonce.
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export function generatePollToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashPollToken(token: string): string {
  return createHash("sha256").update(token.trim(), "utf8").digest("hex");
}

/** Codes are compared case-insensitively and without the display hyphen. */
export function normalizeUserCode(input: string): string {
  const cleaned = input.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  return cleaned.length === CODE_LENGTH ? `${cleaned.slice(0, 4)}-${cleaned.slice(4)}` : cleaned;
}

