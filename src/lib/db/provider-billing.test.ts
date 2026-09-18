import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "@/test/pg";
import { createSqlBillingStore, createSqlSecretStore } from "@/test/sql-billing-store";
import { completeGithubConnection, disconnectGithubBilling, startGithubConnection } from "@/lib/provider-billing/connect";
import { syncBillingAccount, type SyncDeps } from "@/lib/provider-billing/sync";
import type { BillingStore } from "@/lib/provider-billing/store";
import type { SecretStore } from "@/lib/secrets/store";

/**
 * M17C against a real Postgres, with GitHub replaced by a stub that behaves
 * the way GitHub documents: rotating refresh tokens, 200-with-error OAuth
 * failures, 401 for a dead token, and billing aggregates as raw JSON text.
 * No live GitHub call is made anywhere in this file.
 */

// ------------------------------------------------------------ GitHub stub

interface Call {
  method: string;
  url: string;
  authorization: string | null;
}

type UsageReply = { status: number; body?: string; headers?: Record<string, string> };

class FakeGithub {
  user = { id: "583231", login: "octo-dev" };
  /** Overrides by request key ("2026-09" / "2026-09-03"); else `defaultUsage`. */
  usage = new Map<string, UsageReply>();
  defaultUsage: (key: string) => UsageReply = (key) => ({ status: 200, body: selfPaid(key) });
  calls: Call[] = [];
  private access = new Set<string>();
  private refresh = new Set<string>();
  private issued = 0;
  /** Access token -> the principal id it belongs to (for the mismatch test). */
  idOverride: string | null = null;

  revokeEverything() {
    this.access.clear();
    this.refresh.clear();
  }

  private issue() {
    this.issued += 1;
    const access = `ghu_stubAccessToken${this.issued}xyz`;
    const refresh = `ghr_stubRefreshToken${this.issued}xyz`;
    this.access.add(access);
    this.refresh.add(refresh);
    return { access_token: access, refresh_token: refresh, expires_in: 28800, refresh_token_expires_in: 15897600, token_type: "bearer" };
  }

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const authorization = headers.get("authorization");
    this.calls.push({ method, url: url.toString(), authorization });
    const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;

    if (url.host === "github.com" && url.pathname === "/login/oauth/access_token") {
      const body = JSON.parse(String(init?.body)) as Record<string, string>;
      if (body.grant_type === "refresh_token") {
        if (!this.refresh.has(body.refresh_token)) return Response.json({ error: "bad_refresh_token" });
        // Rotation: the old pair dies.
        this.refresh.delete(body.refresh_token);
        this.access.clear();
        return Response.json(this.issue());
      }
      if (body.code !== "good-code" || !body.code_verifier || !body.redirect_uri) {
        return Response.json({ error: "bad_verification_code" });
      }
      return Response.json(this.issue());
    }
    if (url.host === "api.github.com" && url.pathname === "/user") {
      if (!bearer || !this.access.has(bearer)) return new Response('{"message":"Bad credentials"}', { status: 401 });
      return new Response(`{"login":"${this.user.login}","id":${this.idOverride ?? this.user.id},"type":"User"}`, { status: 200 });
    }
    if (url.host === "api.github.com" && url.pathname.endsWith("/grant") && method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    const match = /^\/users\/([^/]+)\/settings\/billing\/ai_credit\/usage$/.exec(url.pathname);
    if (url.host === "api.github.com" && match) {
      if (!bearer || !this.access.has(bearer)) return new Response('{"message":"Bad credentials"}', { status: 401 });
      if (decodeURIComponent(match[1]) !== this.user.login) return new Response('{"message":"Not Found"}', { status: 404 });
      const y = url.searchParams.get("year")!;
      const m = url.searchParams.get("month")!.padStart(2, "0");
      const d = url.searchParams.get("day");
      const key = d ? `${y}-${m}-${d.padStart(2, "0")}` : `${y}-${m}`;
      const reply = this.usage.get(key) ?? this.defaultUsage(key);
      return new Response(reply.body ?? "{}", { status: reply.status, headers: reply.headers });
    }
    return new Response("unexpected", { status: 500 });
  };

  usageCalls(): Call[] {
    return this.calls.filter((c) => c.url.includes("/settings/billing/ai_credit/usage"));
  }
}

/** A self-paid response. Month: 1234.5 credits; each day: 12.5. */
function selfPaid(key: string, netAmount = key.length === 7 ? "9.345" : "0.125"): string {
  const isMonth = key.length === 7;
  return `{"timePeriod":{"year":2026,"month":9${isMonth ? "" : `,"day":${Number(key.slice(8))}`}},"user":"octo-dev","usageItems":[
{"product":"Copilot","sku":"Copilot AI Credits","model":"gpt-5.1","unitType":"credits","pricePerUnit":0.01,
 "grossQuantity":${isMonth ? "1234.5" : "12.5"},"grossAmount":${isMonth ? "12.345" : "0.125"},
 "discountQuantity":${isMonth ? "300" : "0"},"discountAmount":${isMonth ? "3.00" : "0"},
 "netQuantity":${isMonth ? "934.5" : "12.5"},"netAmount":${netAmount}}]}`;
}

const EMPTY = '{"timePeriod":{"year":2026,"month":9},"user":"managed-user","usageItems":[]}';

// ------------------------------------------------------------------ setup

let db: TestDb;
let store: BillingStore;
let secrets: SecretStore;
let alice: string;
let bob: string;
let carol: string;
let aliceAccount: string;
let now = new Date("2026-09-03T12:00:00Z");
const github = new FakeGithub();
const ORIGIN = "https://usage-ten.vercel.app";
const captured: string[] = [];

function deps(fake: FakeGithub = github): SyncDeps {
  return { store, secrets, config: { clientId: "Iv1.stubclient", clientSecret: "stub-client-secret-value" }, fetchImpl: fake.fetch, now: () => now };
}

function advance(minutes: number) {
  now = new Date(now.getTime() + minutes * 60_000);
}

async function connect(userId: string, fake: FakeGithub = github) {
  const url = new URL(await startGithubConnection({ store, config: deps(fake).config, userId, origin: ORIGIN }));
  return completeGithubConnection(deps(fake), { sessionUserId: userId, state: url.searchParams.get("state"), code: "good-code", origin: ORIGIN });
}

async function count(table: string, where = "true", params: unknown[] = []): Promise<number> {
  const [row] = await db.asServiceRole<{ n: string }>(`select count(*)::text as n from ${table} where ${where}`, params);
  return Number(row.n);
}

async function allRowCounts(): Promise<Record<string, number>> {
  const tables = await db.sql<{ name: string }>(
    `select table_name as name from information_schema.tables where table_type = 'BASE TABLE' and table_schema = 'public' order by 1`,
  );
  const counts: Record<string, number> = {};
  for (const t of tables) counts[t.name] = await count(`public."${t.name}"`);
  return counts;
}

beforeAll(async () => {
  // Everything this file prints, anywhere, is kept and checked for tokens.
  const keep = (...args: unknown[]) => {
    captured.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  for (const method of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, method).mockImplementation(keep);
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
    captured.push(String(chunk));
    return (out as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write);
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
    captured.push(String(chunk));
    return (err as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write);

  db = await createTestDb();
  store = createSqlBillingStore(db);
  secrets = createSqlSecretStore(db);
  alice = await db.createUser("billing-alice@example.com");
  bob = await db.createUser("billing-bob@example.com");
  carol = await db.createUser("billing-carol@example.com");
}, 120_000);

afterAll(async () => {
  vi.restoreAllMocks();
  await db?.close();
});

// ------------------------------------------------------------------ tests

describe("connecting (stubbed GitHub)", () => {
  it("rejects a missing state and never exchanges a code", async () => {
    const before = github.calls.length;
    expect(await completeGithubConnection(deps(), { sessionUserId: alice, state: null, code: "good-code", origin: ORIGIN })).toEqual({
      ok: false,
      error: "state_invalid",
    });
    expect(await completeGithubConnection(deps(), { sessionUserId: alice, state: "made-up", code: "good-code", origin: ORIGIN })).toEqual({
      ok: false,
      error: "state_invalid",
    });
    expect(github.calls.length).toBe(before);
  });

  it("rejects an expired state", async () => {
    const url = new URL(await startGithubConnection({ store, config: deps().config, userId: alice, origin: ORIGIN }));
    const state = url.searchParams.get("state")!;
    // Expired by the clock the flow runs on.
    await db.sql(`update provider_oauth_requests set expires_at = $2 where state = $1`, [state, new Date(now.getTime() - 60_000).toISOString()]);
    const result = await completeGithubConnection(deps(), { sessionUserId: alice, state, code: "good-code", origin: ORIGIN });
    expect(result).toEqual({ ok: false, error: "state_invalid" });
  });

  it("rejects a state minted for a different signed-in user", async () => {
    const url = new URL(await startGithubConnection({ store, config: deps().config, userId: bob, origin: ORIGIN }));
    const state = url.searchParams.get("state")!;
    const result = await completeGithubConnection(deps(), { sessionUserId: alice, state, code: "good-code", origin: ORIGIN });
    expect(result).toEqual({ ok: false, error: "state_invalid" });
  });

  it("authorizes with PKCE S256 and the registered callback, no secret in the URL", async () => {
    const url = new URL(await startGithubConnection({ store, config: deps().config, userId: alice, origin: ORIGIN }));
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/api/providers/github/callback`);
    expect(url.toString()).not.toContain("stub-client-secret-value");
    const [pending] = await db.sql<{ code_verifier: string }>(`select code_verifier from provider_oauth_requests where state = $1`, [
      url.searchParams.get("state"),
    ]);
    expect(url.toString()).not.toContain(pending.code_verifier);
  });

  it("connects a personal account and syncs the month and each day so far, exactly", async () => {
    const result = await connect(alice);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    aliceAccount = result.accountId;
    expect(result.sync).toMatchObject({ outcome: "ok", billingScope: "personal", status: "connected" });
    // Month + days 1..3, each fetched once, all with the pinned API version.
    expect(github.usageCalls().map((c) => new URL(c.url).search)).toEqual([
      "?year=2026&month=9",
      "?year=2026&month=9&day=1",
      "?year=2026&month=9&day=2",
      "?year=2026&month=9&day=3",
    ]);

    const [account] = await db.asServiceRole<Record<string, unknown>>(`select * from provider_billing_accounts where id = $1`, [aliceAccount]);
    expect(account).toMatchObject({ provider_principal_id: "583231", provider_login: "octo-dev", billing_scope: "personal", status: "connected", permission_state: "plan:read", api_version: "2026-03-10" });
    expect(JSON.stringify(account)).not.toMatch(/ghu_|ghr_/);
    const secretsRows = await db.asServiceRole<Record<string, unknown>>(`select * from provider_secrets where user_id = $1`, [alice]);
    expect(secretsRows).toHaveLength(1);
    expect(JSON.stringify(secretsRows)).not.toMatch(/ghu_|ghr_/);

    const [month] = await db.asServiceRole<Record<string, string | number | boolean>>(
      `select price_per_unit_text, price_per_unit_micros::text as ppu, gross_quantity_text, gross_quantity_micro_units::text as gq,
              discount_amount_text, discount_amount_micros::text as da, net_amount_text, net_amount_micros::text as na,
              gross_amount_micros::text as ga, reward_eligible, authoritative, economic_authority, revision, product, sku, unit_type, model
         from provider_billing_usage where account_id = $1 and period_kind = 'month' and period_start = '2026-09-01'`,
      [aliceAccount],
    );
    expect(month).toEqual({
      price_per_unit_text: "0.01",
      ppu: "10000",
      gross_quantity_text: "1234.5",
      gq: "1234500000",
      discount_amount_text: "3.00",
      da: "3000000",
      net_amount_text: "9.345",
      na: "9345000",
      ga: "12345000",
      reward_eligible: false,
      authoritative: true,
      economic_authority: "provider_billing",
      revision: 1,
      product: "Copilot",
      sku: "Copilot AI Credits",
      unit_type: "credits",
      model: "gpt-5.1",
    });
    expect(await count("provider_billing_usage", "account_id = $1 and period_kind = 'day'", [aliceAccount])).toBe(3);
    expect(await count("provider_billing_snapshots", "account_id = $1", [aliceAccount])).toBe(4);
  });

  it("refuses the same GitHub account on a second USAGE account, and hands the grant back", async () => {
    const before = github.calls.filter((c) => c.method === "DELETE").length;
    const result = await connect(bob);
    expect(result).toEqual({ ok: false, error: "principal_taken" });
    expect(github.calls.filter((c) => c.method === "DELETE").length).toBe(before + 1);
    expect(await count("provider_billing_accounts", "user_id = $1", [bob])).toBe(0);
    expect(await count("provider_secrets", "user_id = $1", [bob])).toBe(0);
  });
});

describe("ownership and the database walls", () => {
  it("is readable by its owner and invisible to anyone else", async () => {
    expect(await db.asUser(alice, `select id from provider_billing_accounts`)).toHaveLength(1);
    expect((await db.asUser(alice, `select id from provider_billing_usage`)).length).toBeGreaterThan(0);
    expect((await db.asUser(alice, `select id from provider_billing_snapshots`)).length).toBeGreaterThan(0);
    for (const table of ["provider_billing_accounts", "provider_billing_usage", "provider_billing_snapshots"]) {
      expect(await db.asUser(bob, `select 1 from ${table}`), table).toHaveLength(0);
      expect(await db.asAnon(`select 1 from ${table}`).catch(() => []), table).toHaveLength(0);
    }
  });

  it("never shows even the secret reference to a browser session", async () => {
    await expect(db.asUser(alice, `select token_secret_id from provider_billing_accounts`)).rejects.toThrow(/permission denied/i);
    await expect(db.asUser(alice, `select sync_lease_until from provider_billing_accounts`)).rejects.toThrow(/permission denied/i);
  });

  it("gives no client role any write, not even the owner", async () => {
    await expect(db.asUser(alice, `update provider_billing_usage set net_amount_micros = 0`)).rejects.toThrow(/permission denied/i);
    await expect(db.asUser(alice, `update provider_billing_accounts set status = 'connected'`)).rejects.toThrow(/permission denied/i);
    await expect(db.asUser(alice, `delete from provider_billing_snapshots`)).rejects.toThrow(/permission denied/i);
    await expect(
      db.asUser(
        alice,
        `insert into provider_billing_snapshots (account_id, provider, principal_id, request_key, period_year, api_version, http_status, response_sha256, response_text)
         values ($1, 'github', '583231', '2026-09', 2026, 'x', 200, repeat('a', 64), '{}')`,
        [aliceAccount],
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it("another user's session cannot disconnect or sync someone else's account", async () => {
    expect(await disconnectGithubBilling(deps(), { userId: bob })).toEqual({ ok: false, revokedAtProvider: false });
    expect(await store.getAccountForUser(bob, "github")).toBeNull();
    const [account] = await db.asServiceRole<{ status: string }>(`select status from provider_billing_accounts where id = $1`, [aliceAccount]);
    expect(account.status).toBe("connected");
  });

  it("pins reward_eligible to false and authority to provider_billing, even for the service role", async () => {
    await expect(db.asServiceRole(`update provider_billing_usage set reward_eligible = true where account_id = $1`, [aliceAccount])).rejects.toThrow(
      /check constraint|violates/i,
    );
    await expect(db.asServiceRole(`update provider_billing_usage set authoritative = false where account_id = $1`, [aliceAccount])).rejects.toThrow(
      /check constraint|violates/i,
    );
    await expect(
      db.asServiceRole(`update provider_billing_usage set economic_authority = 'usage_gateway' where account_id = $1`, [aliceAccount]),
    ).rejects.toThrow(/check constraint|violates/i);
  });

  it("keeps snapshots immutable, even for the service role", async () => {
    await expect(db.asServiceRole(`update provider_billing_snapshots set response_text = '{}' where account_id = $1`, [aliceAccount])).rejects.toThrow(
      /append-only/i,
    );
    await expect(db.asServiceRole(`delete from provider_billing_snapshots where account_id = $1`, [aliceAccount])).rejects.toThrow(/append-only/i);
  });
});

describe("re-polling and corrections", () => {
  it("the same response 100 times leaves one row per identity, the same revision, and no new snapshot", async () => {
    // Warm-up: early in a month the scheduled run also reads last month once.
    advance(1);
    await syncBillingAccount(deps(), { accountId: aliceAccount, mode: "scheduled" });
    const rowsBefore = await db.asServiceRole<{ id: string; revision: number; current_snapshot_id: string }>(
      `select id, revision, current_snapshot_id from provider_billing_usage where account_id = $1 order by id`,
      [aliceAccount],
    );
    const snapshotsBefore = await count("provider_billing_snapshots", "account_id = $1", [aliceAccount]);
    for (let i = 0; i < 100; i += 1) {
      advance(1);
      const result = await syncBillingAccount(deps(), { accountId: aliceAccount, mode: "scheduled" });
      expect(result.outcome).toBe("ok");
      expect(result.rowsInserted + result.rowsUpdated + result.rowsWithdrawn).toBe(0);
    }
    const rowsAfter = await db.asServiceRole<{ id: string; revision: number; current_snapshot_id: string }>(
      `select id, revision, current_snapshot_id from provider_billing_usage where account_id = $1 order by id`,
      [aliceAccount],
    );
    expect(rowsAfter).toEqual(rowsBefore);
    // Decision: identical responses are recorded once (deduplicated by hash).
    expect(await count("provider_billing_snapshots", "account_id = $1", [aliceAccount])).toBe(snapshotsBefore);
  }, 120_000);

  it("a corrected response updates the same identity, revision + 1, and keeps the old snapshot untouched", async () => {
    const [before] = await db.asServiceRole<{ id: string; revision: number; first_snapshot_id: string; current_snapshot_id: string }>(
      `select id, revision, first_snapshot_id, current_snapshot_id from provider_billing_usage where account_id = $1 and period_kind = 'month' and period_start = '2026-09-01'`,
      [aliceAccount],
    );
    const [oldSnapshot] = await db.asServiceRole<{ response_text: string; response_sha256: string }>(
      `select response_text, response_sha256 from provider_billing_snapshots where id = $1`,
      [before.current_snapshot_id],
    );

    github.usage.set("2026-09", { status: 200, body: selfPaid("2026-09", "9.40") });
    advance(60);
    const result = await syncBillingAccount(deps(), { accountId: aliceAccount, mode: "scheduled" });
    expect(result).toMatchObject({ outcome: "ok", rowsUpdated: 1, rowsInserted: 0, snapshotsRecorded: 1 });

    const rows = await db.asServiceRole<{ id: string; revision: number; first_snapshot_id: string; current_snapshot_id: string; net_amount_text: string; net: string }>(
      `select id, revision, first_snapshot_id, current_snapshot_id, net_amount_text, net_amount_micros::text as net
         from provider_billing_usage where account_id = $1 and period_kind = 'month' and period_start = '2026-09-01'`,
      [aliceAccount],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(before.id);
    expect(rows[0].revision).toBe(before.revision + 1);
    expect(rows[0].first_snapshot_id).toBe(before.first_snapshot_id);
    expect(rows[0].current_snapshot_id).not.toBe(before.current_snapshot_id);
    expect(rows[0].net_amount_text).toBe("9.40");
    expect(rows[0].net).toBe("9400000");

    const [stillOld] = await db.asServiceRole<{ response_text: string; response_sha256: string }>(
      `select response_text, response_sha256 from provider_billing_snapshots where id = $1`,
      [before.current_snapshot_id],
    );
    expect(stillOld).toEqual(oldSnapshot);
  });
});

describe("identity", () => {
  it("follows a username rename: principal unchanged, new login used in the path", async () => {
    github.user.login = "octo-renamed";
    advance(60);
    const result = await syncBillingAccount(deps(), { accountId: aliceAccount, mode: "scheduled" });
    expect(result.outcome).toBe("ok");
    const [account] = await db.asServiceRole<{ provider_principal_id: string; provider_login: string }>(
      `select provider_principal_id, provider_login from provider_billing_accounts where id = $1`,
      [aliceAccount],
    );
    expect(account).toEqual({ provider_principal_id: "583231", provider_login: "octo-renamed" });
    expect(github.usageCalls().at(-1)!.url).toContain("/users/octo-renamed/");
  });

  it("refuses a token that now belongs to a different GitHub account", async () => {
    github.idOverride = "999999";
    const usageBefore = github.usageCalls().length;
    advance(60);
    const result = await syncBillingAccount(deps(), { accountId: aliceAccount, mode: "scheduled" });
    expect(result.outcome).toBe("principal_mismatch");
    expect(github.usageCalls().length).toBe(usageBefore);
    const [account] = await db.asServiceRole<{ status: string; last_error_class: string; provider_principal_id: string }>(
      `select status, last_error_class, provider_principal_id from provider_billing_accounts where id = $1`,
      [aliceAccount],
    );
    expect(account).toEqual({ status: "needs_reauth", last_error_class: "principal_mismatch", provider_principal_id: "583231" });
    // Reset for the rest of the file.
    github.idOverride = null;
    await db.asServiceRole(`update provider_billing_accounts set status = 'connected', last_error_class = null where id = $1`, [aliceAccount]);
  });
});

describe("tokens", () => {
  it("refreshes an expiring token and persists the rotated pair in one write", async () => {
    await db.asServiceRole(`update provider_billing_accounts set access_token_expires_at = $2 where id = $1`, [
      aliceAccount,
      new Date(now.getTime() + 60_000).toISOString(),
    ]);
    const [secretBefore] = await db.asServiceRole<{ ciphertext: string }>(
      `select s.ciphertext from provider_secrets s join provider_billing_accounts a on a.token_secret_id = s.id where a.id = $1`,
      [aliceAccount],
    );
    advance(1);
    const result = await syncBillingAccount(deps(), { accountId: aliceAccount, mode: "scheduled" });
    expect(result.outcome).toBe("ok");
    expect(github.calls.some((c) => c.url.endsWith("/login/oauth/access_token"))).toBe(true);
    const [secretAfter] = await db.asServiceRole<{ ciphertext: string }>(
      `select s.ciphertext from provider_secrets s join provider_billing_accounts a on a.token_secret_id = s.id where a.id = $1`,
      [aliceAccount],
    );
    expect(secretAfter.ciphertext).not.toBe(secretBefore.ciphertext);
    const [account] = await db.asServiceRole<{ access_token_expires_at: Date }>(
      `select access_token_expires_at from provider_billing_accounts where id = $1`,
      [aliceAccount],
    );
    expect(new Date(account.access_token_expires_at).getTime()).toBe(now.getTime() + 28800 * 1000);
  });

  it("rate-limits Refresh now to once per five minutes", async () => {
    advance(10);
    expect((await syncBillingAccount(deps(), { accountId: aliceAccount, mode: "manual" })).outcome).toBe("ok");
    advance(2);
    expect((await syncBillingAccount(deps(), { accountId: aliceAccount, mode: "manual" })).outcome).toBe("rate_limited");
    advance(4);
    expect((await syncBillingAccount(deps(), { accountId: aliceAccount, mode: "manual" })).outcome).toBe("ok");
  });

  it("never runs two syncs of one account at once", async () => {
    await db.asServiceRole(`update provider_billing_accounts set sync_lease_until = $2 where id = $1`, [
      aliceAccount,
      new Date(now.getTime() + 60_000).toISOString(),
    ]);
    expect((await syncBillingAccount(deps(), { accountId: aliceAccount, mode: "scheduled" })).outcome).toBe("busy");
    await db.asServiceRole(`update provider_billing_accounts set sync_lease_until = null where id = $1`, [aliceAccount]);
  });
});

describe("failure keeps history", () => {
  async function history() {
    return db.asServiceRole<Record<string, unknown>>(
      `select id, revision, net_amount_text, current_snapshot_id, withdrawn_at from provider_billing_usage where account_id = $1 order by id`,
      [aliceAccount],
    );
  }

  it("5xx: degraded, nothing deleted or changed", async () => {
    const before = await history();
    github.defaultUsage = () => ({ status: 503, body: '{"message":"unavailable"}' });
    github.usage.clear();
    advance(60);
    const result = await syncBillingAccount(deps(), { accountId: aliceAccount, mode: "scheduled" });
    expect(result).toMatchObject({ outcome: "degraded", status: "degraded", billingScope: "personal" });
    expect(await history()).toEqual(before);
    github.defaultUsage = (key) => ({ status: 200, body: selfPaid(key) });
  });

  it("403: permission_insufficient, history kept", async () => {
    const before = await history();
    github.usage.set("2026-09", { status: 403, body: '{"message":"Resource not accessible by integration"}' });
    advance(60);
    const result = await syncBillingAccount(deps(), { accountId: aliceAccount, mode: "scheduled" });
    expect(result.billingScope).toBe("permission_insufficient");
    const [account] = await db.asServiceRole<{ billing_scope: string; permission_state: string; status: string }>(
      `select billing_scope, permission_state, status from provider_billing_accounts where id = $1`,
      [aliceAccount],
    );
    expect(account).toEqual({ billing_scope: "permission_insufficient", permission_state: "insufficient", status: "connected" });
    expect(await history()).toEqual(before);
    github.usage.clear();
  });

  it("revoked at GitHub (401, then bad_refresh_token): needs_reauth, history kept", async () => {
    const before = await history();
    github.revokeEverything();
    advance(60);
    const result = await syncBillingAccount(deps(), { accountId: aliceAccount, mode: "scheduled" });
    expect(result.outcome).toBe("needs_reauth");
    const [account] = await db.asServiceRole<{ status: string; last_error_class: string }>(
      `select status, last_error_class from provider_billing_accounts where id = $1`,
      [aliceAccount],
    );
    expect(account).toEqual({ status: "needs_reauth", last_error_class: "refresh_rejected" });
    expect(await history()).toEqual(before);
    // The owner still reads their history.
    expect((await db.asUser(alice, `select id from provider_billing_usage`)).length).toBe(before.length);
    // And a needs_reauth account is not polled again until reconnected.
    expect((await syncBillingAccount(deps(), { accountId: aliceAccount, mode: "scheduled" })).outcome).toBe("needs_reauth");
  });

  it("reconnecting the same GitHub account restores it on the same row", async () => {
    const result = await connect(alice);
    expect(result).toMatchObject({ ok: true, accountId: aliceAccount });
    expect(await count("provider_secrets", "user_id = $1", [alice])).toBe(1);
  });
});

describe("organization-managed or empty", () => {
  it("200 with no items is no_data_or_managed: no rows, no day requests, never zero usage", async () => {
    const managed = new FakeGithub();
    managed.user = { id: "777001", login: "managed-user" };
    managed.defaultUsage = () => ({ status: 200, body: EMPTY });
    const result = await connect(carol, managed);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sync).toMatchObject({ outcome: "ok", billingScope: "no_data_or_managed" });
    expect(managed.usageCalls()).toHaveLength(1);
    expect(await count("provider_billing_usage", "account_id = $1", [result.accountId])).toBe(0);
    // The evidence that GitHub said "nothing" is still kept.
    expect(await count("provider_billing_snapshots", "account_id = $1", [result.accountId])).toBe(1);
  });
});

describe("isolation from the economic lane", () => {
  it("a billing sync with corrections adds rows only to provider billing tables", async () => {
    await db.asServiceRole(
      `insert into usage_events (user_id, provider, source, external_reference, model, occurred_at, input_tokens, output_tokens, requests,
         actual_cost_micros, normalized_cost_micros, verification_type, verification_status)
       values ($1, 'anthropic', 'gateway', 'm17c:iso-1', 'claude', '2026-09-03T10:00:00Z', 10, 10, 1, 100, 100, 'routed', 'confirmed')`,
      [alice],
    );
    const before = await allRowCounts();
    github.usage.set("2026-09", { status: 200, body: selfPaid("2026-09", "11.11") });
    github.usage.set("2026-09-04", { status: 200, body: selfPaid("2026-09-04", "0.5") });
    advance(60 * 24);
    const result = await syncBillingAccount(deps(), { accountId: aliceAccount, mode: "scheduled" });
    expect(result.outcome).toBe("ok");
    expect(result.rowsUpdated + result.rowsInserted).toBeGreaterThan(0);
    const after = await allRowCounts();
    const changed = Object.keys(after).filter((t) => after[t] !== before[t]);
    expect(changed.every((t) => t === "provider_billing_snapshots" || t === "provider_billing_usage")).toBe(true);
    for (const table of ["usage_events", "usage_point_ledger", "usage_daily_aggregates", "score_records", "reward_allocations", "usage_wallet_entries"]) {
      if (table in before) expect(after[table], table).toBe(before[table]);
    }
    expect(Object.keys(before)).toEqual(expect.arrayContaining(["usage_events", "usage_point_ledger"]));
  });

  it("nothing economic reads the billing tables, and they carry no trigger that could", async () => {
    const deps = await db.sql<{ n: string }>(
      `select count(*)::text as n from pg_depend d join pg_class c on c.oid = d.refobjid
        where c.relname in ('provider_billing_usage', 'provider_billing_snapshots') and d.classid = 'pg_rewrite'::regclass`,
    );
    expect(deps[0].n).toBe("0");
    const triggers = await db.sql<{ n: string }>(
      `select count(*)::text as n from pg_trigger t join pg_class c on c.oid = t.tgrelid
        where c.relname = 'provider_billing_usage' and not t.tgisinternal`,
    );
    expect(triggers[0].n).toBe("0");
  });
});

describe("disconnect", () => {
  it("revokes at GitHub, destroys the tokens, keeps history marked disconnected", async () => {
    const historyBefore = await count("provider_billing_usage", "account_id = $1", [aliceAccount]);
    const deletesBefore = github.calls.filter((c) => c.method === "DELETE").length;
    const result = await disconnectGithubBilling(deps(), { userId: alice });
    expect(result).toEqual({ ok: true, revokedAtProvider: true });
    const revoke = github.calls.filter((c) => c.method === "DELETE").at(-1)!;
    expect(github.calls.filter((c) => c.method === "DELETE").length).toBe(deletesBefore + 1);
    expect(revoke.url).toBe("https://api.github.com/applications/Iv1.stubclient/grant");
    expect(revoke.authorization).toBe(`Basic ${Buffer.from("Iv1.stubclient:stub-client-secret-value").toString("base64")}`);

    const [account] = await db.asServiceRole<Record<string, unknown>>(
      `select status, token_secret_id, secret_backend, disconnected_at is not null as disconnected from provider_billing_accounts where id = $1`,
      [aliceAccount],
    );
    expect(account).toEqual({ status: "revoked", token_secret_id: null, secret_backend: null, disconnected: true });
    expect(await count("provider_secrets", "user_id = $1", [alice])).toBe(0);
    expect(await count("provider_billing_usage", "account_id = $1", [aliceAccount])).toBe(historyBefore);
    expect((await syncBillingAccount(deps(), { accountId: aliceAccount, mode: "scheduled" })).outcome).toBe("not_connected");
  });
});

describe("miner protocol reference", () => {
  it("lists miner-protocol-v2", async () => {
    const rows = await db.asAnon<{ version: string; minimum_supported: string }>(
      `select version, minimum_supported from miner_protocol_versions where version = 'miner-protocol-v2'`,
    );
    expect(rows).toEqual([{ version: "miner-protocol-v2", minimum_supported: "0.4.0" }]);
  });
});

describe("secrets never leak", () => {
  it("no token appeared in any log line, stdout or stderr", () => {
    const text = captured.join("\n");
    expect(text).not.toMatch(/ghu_stub|ghr_stub|stub-client-secret-value/);
  });

  it("no domain result carries a token", async () => {
    const managed = new FakeGithub();
    managed.user = { id: "777002", login: "leak-check" };
    const dave = await db.createUser("billing-dave@example.com");
    const result = await connect(dave, managed);
    expect(JSON.stringify(result)).not.toMatch(/ghu_|ghr_|stub-client-secret-value/);
    if (result.ok) {
      const sync = await syncBillingAccount(deps(managed), { accountId: result.accountId, mode: "scheduled" });
      expect(JSON.stringify(sync)).not.toMatch(/ghu_|ghr_/);
    }
  });
});

describe("account deletion", () => {
  it("deleting a person removes their billing evidence despite the append-only snapshots", async () => {
    const [dave] = await db.sql<{ id: string }>(`select id from auth.users where email = 'billing-dave@example.com'`);
    expect(await count("provider_billing_usage u join provider_billing_accounts a on a.id = u.account_id", "a.user_id = $1", [dave.id])).toBeGreaterThan(0);
    await db.sql(`delete from auth.users where id = $1`, [dave.id]);
    expect(await count("provider_billing_accounts", "user_id = $1", [dave.id])).toBe(0);
    expect(await count("provider_billing_snapshots", "principal_id = '777002'")).toBe(0);
    expect(await count("provider_billing_usage", "principal_id = '777002'")).toBe(0);
  });
});
