import { createHmac, timingSafeEqual } from "node:crypto";
import type { WireSurface } from "@/lib/providers/surfaces";

/**
 * Route-session tokens (M16C0 §10).
 *
 * WHY THEY EXIST. Claude Code honours an external gateway reliably only when it
 * is given a gateway credential (`ANTHROPIC_AUTH_TOKEN`); with a saved
 * claude.ai login and no credential variable it keeps its own OAuth
 * Authorization header. The user's OpenRouter credential must never be that
 * value -- it stays on the server -- so the miner asks USAGE for a short-lived
 * credential that is worth exactly one thing: routing one tool, from one
 * device, through one named connection, on one wire surface, for a few hours.
 *
 * WHAT A TOKEN IS. `usgr_` + base64url(claims) + "." + base64url(HMAC-SHA256).
 * The claims are public (they are shown to the user as "selected route"); the
 * signature is what makes them USAGE's statement. Nothing in a token is a
 * provider credential, a miner credential, or anything that decrypts one.
 *
 * WHAT A TOKEN IS NOT. It is not a device credential: it cannot read config,
 * change mappings, heartbeat, rotate, or upload telemetry (`miner:route` is
 * its only scope). It cannot select any other connection or surface than the
 * ones it names (the gateway checks the binding on every request). It cannot
 * outlive the parent device credential: verification re-authenticates the
 * parent, so revoking the device kills every route session it minted.
 *
 * STATELESS, BY CHOICE. No table, no migration, no production DDL: the
 * signature and the parent-credential check are the whole story. The cost is
 * that a session cannot be individually revoked before it expires, which the
 * short TTL and the parent binding bound.
 */

export const ROUTE_SESSION_TOKEN_PREFIX = "usgr_";
export const ROUTE_SESSION_VERSION = 1;
/** A Claude Code session is hours, not days. */
export const ROUTE_SESSION_TTL_SECONDS = 8 * 60 * 60;

export interface RouteSessionClaims {
  v: number;
  /** Parent (device) credential id. Re-authenticated on every use. */
  c: string;
  /** Owner user id. Must match the parent credential's owner. */
  u: string;
  /** Device id the session was minted for. Display only; the parent binds it. */
  d: string | null;
  /** Tool this session was minted for. */
  t: string;
  /** The ONE connection this session may route through. */
  k: string;
  /** The ONE wire surface this session may use. */
  s: WireSurface;
  /** Issued-at and expiry, unix seconds. */
  iat: number;
  exp: number;
}

export interface RouteSessionBinding {
  connectionId: string;
  surface: WireSurface;
  tool: string;
  deviceId: string | null;
  expiresAt: string;
}

export function routeSessionSecret(): Buffer | null {
  const raw = process.env.USAGE_ROUTE_SESSION_SECRET?.trim();
  if (!raw || raw.length < 32) return null;
  return Buffer.from(raw, "utf8");
}

export function routeSessionsAvailable(): boolean {
  return routeSessionSecret() !== null;
}

function sign(secret: Buffer, payload: string): string {
  return createHmac("sha256", secret).update(payload, "utf8").digest("base64url");
}

export function isRouteSessionToken(value: string): boolean {
  return value.trim().startsWith(ROUTE_SESSION_TOKEN_PREFIX);
}

export function mintRouteSessionToken(
  input: {
    credentialId: string;
    userId: string;
    deviceId: string | null;
    tool: string;
    connectionId: string;
    surface: WireSurface;
    ttlSeconds?: number;
    now?: number;
  },
  secret: Buffer | null = routeSessionSecret(),
): { token: string; expiresAt: string; claims: RouteSessionClaims } | null {
  if (!secret) return null;
  const iat = Math.floor((input.now ?? Date.now()) / 1000);
  const claims: RouteSessionClaims = {
    v: ROUTE_SESSION_VERSION,
    c: input.credentialId,
    u: input.userId,
    d: input.deviceId,
    t: input.tool,
    k: input.connectionId,
    s: input.surface,
    iat,
    exp: iat + Math.min(Math.max(input.ttlSeconds ?? ROUTE_SESSION_TTL_SECONDS, 60), ROUTE_SESSION_TTL_SECONDS),
  };
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const token = `${ROUTE_SESSION_TOKEN_PREFIX}${payload}.${sign(secret, payload)}`;
  return { token, expiresAt: new Date(claims.exp * 1000).toISOString(), claims };
}

export type RouteSessionVerification =
  | { ok: true; claims: RouteSessionClaims }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" | "unavailable" };

export function verifyRouteSessionToken(
  token: string,
  secret: Buffer | null = routeSessionSecret(),
  now: number = Date.now(),
): RouteSessionVerification {
  if (!secret) return { ok: false, reason: "unavailable" };
  const trimmed = token.trim();
  if (!isRouteSessionToken(trimmed)) return { ok: false, reason: "malformed" };
  const body = trimmed.slice(ROUTE_SESSION_TOKEN_PREFIX.length);
  const dot = body.indexOf(".");
  if (dot <= 0) return { ok: false, reason: "malformed" };
  const payload = body.slice(0, dot);
  const signature = body.slice(dot + 1);
  const expected = sign(secret, payload);
  const a = Buffer.from(signature, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "bad_signature" };

  let claims: RouteSessionClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as RouteSessionClaims;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (
    claims.v !== ROUTE_SESSION_VERSION ||
    typeof claims.c !== "string" ||
    typeof claims.u !== "string" ||
    typeof claims.t !== "string" ||
    typeof claims.k !== "string" ||
    (claims.s !== "openai_compatible" && claims.s !== "anthropic_compatible") ||
    typeof claims.exp !== "number" ||
    typeof claims.iat !== "number"
  ) {
    return { ok: false, reason: "malformed" };
  }
  if (claims.exp * 1000 <= now) return { ok: false, reason: "expired" };
  return { ok: true, claims };
}

export function bindingFromClaims(claims: RouteSessionClaims): RouteSessionBinding {
  return {
    connectionId: claims.k,
    surface: claims.s,
    tool: claims.t,
    deviceId: claims.d,
    expiresAt: new Date(claims.exp * 1000).toISOString(),
  };
}
