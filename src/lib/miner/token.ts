import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Miner credentials.
 *
 * The token a miner client (Claude Code today) presents to the USAGE Gateway.
 * It is deliberately NOT the AI Gateway key: the upstream credential belongs to
 * USAGE and must never leave the server, so every miner gets its own revocable
 * identity instead.
 */

export const MINER_TOKEN_PREFIX = "usgm_";
const TOKEN_BYTES = 32;

export interface MintedMinerToken {
  /** Shown to the user exactly once, then unrecoverable. */
  token: string;
  tokenHash: string;
  /** Non-secret, for telling credentials apart in a list. */
  tokenPrefix: string;
}

export function mintMinerToken(): MintedMinerToken {
  const token = `${MINER_TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString("base64url")}`;
  return { token, tokenHash: hashMinerToken(token), tokenPrefix: minerTokenPrefix(token) };
}

/**
 * SHA-256, not a slow KDF, and that is the right choice here: the token is 256
 * bits of CSPRNG output, so there is no guessable password to grind. A KDF would
 * add latency to every gateway request while defending against an attack that
 * cannot happen.
 */
export function hashMinerToken(token: string): string {
  return createHash("sha256").update(token.trim(), "utf8").digest("hex");
}

/** First 12 characters. Enough to recognise, useless to replay. */
export function minerTokenPrefix(token: string): string {
  return token.trim().slice(0, 12);
}

/** Route-session tokens (M16C0) share the miner namespace: `usgr_`. */
export const ROUTE_SESSION_PREFIX = "usgr_";

export function looksLikeMinerToken(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith(MINER_TOKEN_PREFIX) || trimmed.startsWith(ROUTE_SESSION_PREFIX);
}

/** Constant-time comparison of two hex digests. */
export function hashesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

/**
 * Dedicated header for the miner credential.
 *
 * Needed because a Claude Code that is signed in to a Claude subscription puts
 * its own credential in `Authorization` and ignores ANTHROPIC_AUTH_TOKEN. Rather
 * than making the user log out, the miner token travels in its own header --
 * the same shape Vercel documents for gateway auth alongside a subscription.
 */
export const MINER_TOKEN_HEADER = "x-usage-miner-token";

/**
 * Pull the presented credential out of an Anthropic-compatible request.
 *
 * Checked in order: the dedicated header, `Authorization: Bearer`
 * (ANTHROPIC_AUTH_TOKEN), then `x-api-key` (ANTHROPIC_API_KEY). Only a value
 * that looks like a USAGE miner token is ever treated as one, so a client's
 * unrelated provider credential is never mistaken for authentication here.
 */
export function readPresentedToken(headers: Headers): string | null {
  const dedicated = headers.get(MINER_TOKEN_HEADER);
  if (dedicated?.trim()) return stripBearer(dedicated);

  const authorization = headers.get("authorization");
  if (authorization) {
    const candidate = stripBearer(authorization);
    if (looksLikeMinerToken(candidate)) return candidate;
  }

  const apiKey = headers.get("x-api-key");
  if (apiKey?.trim() && looksLikeMinerToken(apiKey)) return apiKey.trim();

  // Nothing miner-shaped was presented. Returning the raw Authorization value
  // would only risk logging or comparing somebody else's secret.
  return authorization || apiKey ? "presented-non-miner-credential" : null;
}

function stripBearer(value: string): string {
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return (match?.[1] ?? value).trim();
}
