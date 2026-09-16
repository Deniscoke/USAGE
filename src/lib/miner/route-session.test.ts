import { describe, expect, it } from "vitest";
import {
  bindingFromClaims,
  mintRouteSessionToken,
  ROUTE_SESSION_TOKEN_PREFIX,
  ROUTE_SESSION_TTL_SECONDS,
  verifyRouteSessionToken,
} from "./route-session";
import { authenticateMiner, hasScope, type MinerCredentialStore } from "./credentials";
import { readPresentedToken } from "./token";
import { routeBindingViolation } from "@/lib/gateway/handler";
import { checkCredentialRelay } from "@/lib/gateway/credential-relay";
import type { MinerCredentialRow } from "@/lib/supabase/database.types";

/**
 * Route sessions (M16C0 §10, §17).
 *
 * A route session is a USAGE statement, not a provider credential: it names
 * one parent device credential, one connection, one surface, one tool, and
 * expires. The gateway must refuse it everywhere else.
 */

const SECRET = Buffer.from("test-route-session-secret-0123456789abcdef", "utf8");
const T0 = Date.parse("2026-09-11T10:00:00.000Z");

const PARENT: MinerCredentialRow = {
  id: "cred-parent",
  user_id: "user-1",
  name: "Denis-PC",
  token_hash: "x",
  token_prefix: "usgm_abcdefg",
  scopes: ["miner:route", "miner:config", "miner:heartbeat", "miner:rotate", "miner:telemetry", "miner:mappings"],
  rotated_to: null,
  rotated_at: null,
  created_at: "2026-09-01T00:00:00.000Z",
  last_used_at: null,
  revoked_at: null,
  device_id: "device-1",
};

function storeWith(parent: MinerCredentialRow | null): MinerCredentialStore {
  return {
    findByTokenHash: async () => null,
    findById: async (id) => (parent && id === parent.id ? parent : null),
    touch: async () => {},
    create: async () => ({ credentialId: "x", token: "y" }),
    revoke: async () => {},
    rotate: async () => ({ credentialId: "x2", token: "y2" }),
  };
}

function mint(overrides: Partial<Parameters<typeof mintRouteSessionToken>[0]> = {}) {
  return mintRouteSessionToken(
    {
      credentialId: PARENT.id,
      userId: PARENT.user_id,
      deviceId: "device-1",
      tool: "claude-code",
      connectionId: "conn-openrouter",
      surface: "anthropic_compatible",
      now: T0,
      ...overrides,
    },
    SECRET,
  )!;
}

describe("route-session tokens", () => {
  it("mint and verify round-trip, with the claims the miner shows before launch", () => {
    const minted = mint();
    expect(minted.token.startsWith(ROUTE_SESSION_TOKEN_PREFIX)).toBe(true);
    const verified = verifyRouteSessionToken(minted.token, SECRET, T0 + 1000);
    expect(verified.ok).toBe(true);
    if (!verified.ok) throw new Error("unreachable");
    expect(bindingFromClaims(verified.claims)).toEqual({
      connectionId: "conn-openrouter",
      surface: "anthropic_compatible",
      tool: "claude-code",
      deviceId: "device-1",
      expiresAt: new Date(T0 + ROUTE_SESSION_TTL_SECONDS * 1000).toISOString(),
    });
  });

  it("is not a provider credential and carries nothing secret", () => {
    const minted = mint();
    const payload = Buffer.from(minted.token.slice(ROUTE_SESSION_TOKEN_PREFIX.length).split(".")[0], "base64url").toString("utf8");
    // The claims are public routing facts and only those.
    expect(Object.keys(JSON.parse(payload)).sort()).toEqual(["c", "d", "exp", "iat", "k", "s", "t", "u", "v"]);
    expect(payload).not.toMatch(/sk-|usgm_/);
  });

  it("expires, and cannot be minted for longer than the ceiling", () => {
    const minted = mint({ ttlSeconds: 10 * 24 * 60 * 60 });
    expect(Date.parse(minted.expiresAt) - T0).toBe(ROUTE_SESSION_TTL_SECONDS * 1000);
    // Expired, and says so with its genuine claims attached, so the caller can
    // decide renewal by liveness without trusting anything unsigned.
    expect(verifyRouteSessionToken(minted.token, SECRET, T0 + ROUTE_SESSION_TTL_SECONDS * 1000 + 1)).toMatchObject({ ok: false, reason: "expired", claims: { c: PARENT.id } });
  });

  it("refuses a tampered token, a foreign signature and a missing secret", () => {
    const minted = mint();
    const [payload, signature] = minted.token.slice(ROUTE_SESSION_TOKEN_PREFIX.length).split(".");
    const tampered = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString("utf8")), k: "conn-other" }), "utf8").toString("base64url");
    expect(verifyRouteSessionToken(`${ROUTE_SESSION_TOKEN_PREFIX}${tampered}.${signature}`, SECRET, T0)).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyRouteSessionToken(minted.token, Buffer.from("another-secret-another-secret-another"), T0)).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyRouteSessionToken(minted.token, null, T0)).toEqual({ ok: false, reason: "unavailable" });
    expect(verifyRouteSessionToken(`${ROUTE_SESSION_TOKEN_PREFIX}garbage`, SECRET, T0)).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("authenticating with a route session", () => {
  it("is read out of Authorization: Bearer, and is never mistaken for a Claude subscription", () => {
    const minted = mint();
    const headers = new Headers({ authorization: `Bearer ${minted.token}` });
    expect(readPresentedToken(headers)).toBe(minted.token);
    // A route session is USAGE's own credential, so the subscription boundary
    // lets it through; a claude.ai login in the same place would be refused.
    expect(checkCredentialRelay(headers)).toEqual({ ok: true });
  });

  it("resolves to the parent device credential, narrowed to routing only", async () => {
    process.env.USAGE_ROUTE_SESSION_SECRET = SECRET.toString("utf8");
    try {
      const minted = mint({ now: Date.now() });
      const result = await authenticateMiner(minted.token, storeWith(PARENT));
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.identity.credentialId).toBe(PARENT.id);
      expect(result.identity.userId).toBe(PARENT.user_id);
      expect(hasScope(result.identity, "miner:route")).toBe(true);
      expect(hasScope(result.identity, "miner:config")).toBe(false);
      expect(hasScope(result.identity, "miner:telemetry")).toBe(false);
      expect(result.identity.routeSession?.connectionId).toBe("conn-openrouter");
    } finally {
      delete process.env.USAGE_ROUTE_SESSION_SECRET;
    }
  });

  it("dies with its parent: a revoked device credential revokes every session it minted", async () => {
    process.env.USAGE_ROUTE_SESSION_SECRET = SECRET.toString("utf8");
    try {
      const minted = mint({ now: Date.now() });
      expect(await authenticateMiner(minted.token, storeWith({ ...PARENT, revoked_at: "2026-09-11T11:00:00.000Z" }))).toEqual({ ok: false, reason: "revoked" });
      expect(await authenticateMiner(minted.token, storeWith(null))).toEqual({ ok: false, reason: "unknown" });
      expect(await authenticateMiner(minted.token, storeWith({ ...PARENT, user_id: "someone-else" }))).toEqual({ ok: false, reason: "unknown" });
    } finally {
      delete process.env.USAGE_ROUTE_SESSION_SECRET;
    }
  });

  it("is rejected when expired, and when the server holds no secret", async () => {
    process.env.USAGE_ROUTE_SESSION_SECRET = SECRET.toString("utf8");
    try {
      const old = mint({ now: Date.now() - (ROUTE_SESSION_TTL_SECONDS + 5) * 1000 });
      expect(await authenticateMiner(old.token, storeWith(PARENT))).toEqual({ ok: false, reason: "expired" });
    } finally {
      delete process.env.USAGE_ROUTE_SESSION_SECRET;
    }
    const minted = mint({ now: Date.now() });
    expect(await authenticateMiner(minted.token, storeWith(PARENT))).toEqual({ ok: false, reason: "unknown" });
  });
});

describe("route binding at the gateway", () => {
  const session = { routeSession: { connectionId: "conn-openrouter", surface: "anthropic_compatible" as const, tool: "claude-code", deviceId: "device-1", expiresAt: "" } };

  it("allows exactly the connection and surface it was minted for", () => {
    expect(routeBindingViolation(session, "anthropic_compatible", { connectionId: "conn-openrouter", path: ["v1", "messages"] })).toBeNull();
  });

  it("cannot select another connection", () => {
    expect(routeBindingViolation(session, "anthropic_compatible", { connectionId: "conn-other" })).toMatch(/different connection/);
  });

  it("cannot cross to the other wire surface of the same connection", () => {
    expect(routeBindingViolation(session, "openai_compatible", { connectionId: "conn-openrouter" })).toMatch(/different connection or wire surface/);
  });

  it("cannot use USAGE's own funded gateways, which declare no surface", () => {
    expect(routeBindingViolation(session, undefined, {})).toMatch(/bound to a provider connection/);
  });

  it("does not constrain a full device credential", () => {
    expect(routeBindingViolation({}, undefined, {})).toBeNull();
    expect(routeBindingViolation({ routeSession: undefined }, "openai_compatible", { connectionId: "any" })).toBeNull();
  });
});

describe("an expired route session while its miner is still running", () => {
  const HOUR = 60 * 60 * 1000;

  function storeAlive(lastSeenAt: string | null, parent: MinerCredentialRow = PARENT): MinerCredentialStore {
    return { ...storeWith(parent), deviceLastSeenAt: async (id) => (id === parent.device_id ? lastSeenAt : null) };
  }

  async function withSecret<T>(fn: () => Promise<T>): Promise<T> {
    process.env.USAGE_ROUTE_SESSION_SECRET = SECRET.toString("utf8");
    try {
      return await fn();
    } finally {
      delete process.env.USAGE_ROUTE_SESSION_SECRET;
    }
  }

  it("keeps routing the morning after, when the miner that launched it is still beating", async () => {
    await withSecret(async () => {
      const overnight = mint({ now: Date.now() - 16 * HOUR });
      const result = await authenticateMiner(overnight.token, storeAlive(new Date(Date.now() - 45_000).toISOString()));
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.identity.scopes).toEqual(["miner:route"]);
      expect(result.identity.routeSession?.connectionId).toBe("conn-openrouter");
    });
  });

  it("stops once the miner has gone quiet: close the console and the session ends", async () => {
    await withSecret(async () => {
      const overnight = mint({ now: Date.now() - 16 * HOUR });
      const stale = new Date(Date.now() - 30 * 60_000).toISOString();
      expect(await authenticateMiner(overnight.token, storeAlive(stale))).toEqual({ ok: false, reason: "expired" });
      expect(await authenticateMiner(overnight.token, storeAlive(null))).toEqual({ ok: false, reason: "expired" });
    });
  });

  it("never lives past a day, however alive the device is", async () => {
    await withSecret(async () => {
      const ancient = mint({ now: Date.now() - 25 * HOUR });
      expect(await authenticateMiner(ancient.token, storeAlive(new Date().toISOString()))).toEqual({ ok: false, reason: "expired" });
    });
  });

  it("does not borrow liveness from a different device", async () => {
    await withSecret(async () => {
      const overnight = mint({ now: Date.now() - 16 * HOUR, deviceId: "device-other" });
      expect(await authenticateMiner(overnight.token, storeAlive(new Date().toISOString()))).toEqual({ ok: false, reason: "expired" });
    });
  });

  it("still dies at once with a revoked device credential", async () => {
    await withSecret(async () => {
      const overnight = mint({ now: Date.now() - 16 * HOUR });
      const revoked = { ...PARENT, revoked_at: new Date().toISOString() };
      expect(await authenticateMiner(overnight.token, storeAlive(new Date().toISOString(), revoked))).toEqual({ ok: false, reason: "revoked" });
    });
  });

  it("is not fooled by a heartbeat timestamp from the future", async () => {
    await withSecret(async () => {
      const overnight = mint({ now: Date.now() - 16 * HOUR });
      const future = new Date(Date.now() + HOUR).toISOString();
      expect(await authenticateMiner(overnight.token, storeAlive(future))).toEqual({ ok: false, reason: "expired" });
    });
  });

  it("still refuses a tampered token outright, expired or not", async () => {
    await withSecret(async () => {
      const overnight = mint({ now: Date.now() - 16 * HOUR });
      const tampered = overnight.token.slice(0, -2) + (overnight.token.endsWith("A") ? "BB" : "AA");
      expect(await authenticateMiner(tampered, storeAlive(new Date().toISOString()))).toEqual({ ok: false, reason: "malformed" });
    });
  });
});
