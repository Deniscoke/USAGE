import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import type { NextRequest } from "next/server";
import {
  CLIENT_PROVIDER_CREDENTIAL_REFUSAL,
  CONSUMER_SUBSCRIPTION_REFUSAL,
  checkCredentialRelay,
} from "./credential-relay";
import { anthropicError } from "./anthropic";
import { createGatewayRoute } from "./handler";
import { resetRateLimits } from "./observability";
import { protocolGateway } from "@/lib/compute/protocol-gateway";
import { anthropicCompatibleProtocol } from "@/lib/protocols/anthropic-compatible";
import { authenticateMiner, type MinerCredentialStore } from "@/lib/miner/credentials";
import { mintRouteSessionToken } from "@/lib/miner/route-session";
import { readPresentedToken } from "@/lib/miner/token";
import type { MinerCredentialRow } from "@/lib/supabase/database.types";

/**
 * M17A: a consumer subscription credential is never routable through USAGE.
 *
 * Whatever sends it -- a 0.4.4-0.4.6 miner's retired Claude fallback, a stale
 * config, a hand-built client -- and whichever USAGE gateway it reaches, the
 * request is refused before authentication and before any upstream is
 * contacted. USAGE's own credentials (device tokens, route sessions) are the
 * only ones that pass.
 */

const OAUTH = "Bearer sk-ant-oat01-consumer-subscription-login";
const OAUTH_BETA = "oauth-2025-04-20,interleaved-thinking-2025-05-14";

describe("checkCredentialRelay", () => {
  it("lets USAGE's own credentials and credential-free requests through", () => {
    expect(checkCredentialRelay(new Headers())).toEqual({ ok: true });
    expect(checkCredentialRelay(new Headers({ authorization: "Bearer usgm_device" }))).toEqual({ ok: true });
    expect(checkCredentialRelay(new Headers({ authorization: "Bearer usgr_session.sig" }))).toEqual({ ok: true });
    expect(checkCredentialRelay(new Headers({ "x-api-key": "usgm_device" }))).toEqual({ ok: true });
    expect(checkCredentialRelay(new Headers({ "x-usage-miner-token": "usgm_device" }))).toEqual({ ok: true });
    // Claude Code with ANTHROPIC_API_KEY="" sends an empty key; that is no credential.
    expect(checkCredentialRelay(new Headers({ "x-api-key": "", authorization: "  " }))).toEqual({ ok: true });
    expect(checkCredentialRelay(new Headers({ "anthropic-beta": "interleaved-thinking-2025-05-14" }))).toEqual({ ok: true });
  });

  it("refuses a claude.ai login in Authorization", () => {
    expect(checkCredentialRelay(new Headers({ authorization: OAUTH }))).toEqual({
      ok: false,
      reason: CONSUMER_SUBSCRIPTION_REFUSAL,
      carrier: "authorization",
    });
  });

  it("refuses any foreign bearer that arrives with the OAuth capability, whatever its format", () => {
    const verdict = checkCredentialRelay(new Headers({ authorization: "Bearer opaque-future-format", "anthropic-beta": OAUTH_BETA }));
    expect(verdict).toMatchObject({ ok: false, reason: CONSUMER_SUBSCRIPTION_REFUSAL });
  });

  it("refuses the OAuth capability even when the credential itself was not sent", () => {
    expect(checkCredentialRelay(new Headers({ "anthropic-beta": OAUTH_BETA, "x-usage-miner-token": "usgm_x" }))).toEqual({
      ok: false,
      reason: CONSUMER_SUBSCRIPTION_REFUSAL,
      carrier: "anthropic-beta",
    });
  });

  it("refuses any other client-held provider credential, failing closed on formats it does not know", () => {
    for (const headers of [
      new Headers({ authorization: "Bearer sk-or-v1-client-key" }),
      new Headers({ authorization: "Bearer sk-proj-openai" }),
      new Headers({ "x-api-key": "sk-ant-api03-console-key" }),
      new Headers({ authorization: "Basic dXNlcjpwYXNz" }),
    ]) {
      expect(checkCredentialRelay(headers)).toMatchObject({ ok: false, reason: CLIENT_PROVIDER_CREDENTIAL_REFUSAL });
    }
  });

  it("never returns the credential value", () => {
    const verdict = checkCredentialRelay(new Headers({ authorization: OAUTH }));
    expect(JSON.stringify(verdict)).not.toContain("sk-ant-oat");
  });
});

describe("every USAGE gateway refuses a relayed subscription before spending", () => {
  const OLD_ENV = { ...process.env };
  let upstreamCalls = 0;
  let stdout: string[] = [];

  beforeEach(() => {
    resetRateLimits();
    upstreamCalls = 0;
    stdout = [];
    process.env.AI_GATEWAY_API_KEY = "sk-usage-held-gateway-key";
    process.env.OPENROUTER_API_KEY = "sk-or-usage-held-key";
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    vi.stubGlobal("fetch", async () => {
      upstreamCalls += 1;
      return new Response("{}", { status: 200 });
    });
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      stdout.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    process.env = { ...OLD_ENV };
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function post(routeModule: string, url: string, params: Record<string, unknown>, headers: Record<string, string>) {
    const { POST } = (await import(routeModule)) as { POST: (r: NextRequest, c: unknown) => Promise<Response> };
    const request = new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ model: "anthropic/claude-sonnet-4.6", max_tokens: 8, messages: [] }),
    });
    return POST(request as never, { params: Promise.resolve(params) });
  }

  const LEGACY_HEADERS = {
    authorization: OAUTH,
    "anthropic-beta": OAUTH_BETA,
    "x-usage-miner-token": "usgm_legacy_device_token",
  };

  const ROUTES: Array<[string, string, string, Record<string, unknown>]> = [
    ["USAGE-funded Claude fallback (Vercel)", "@/app/api/gateway/anthropic/[...path]/route", "http://localhost/api/gateway/anthropic/v1/messages", { path: ["v1", "messages"] }],
    ["USAGE-funded OpenRouter surface", "@/app/api/gateway/openrouter/[...path]/route", "http://localhost/api/gateway/openrouter/chat/completions", { path: ["chat", "completions"] }],
    ["an OpenRouter connection, Anthropic surface", "@/app/api/gateway/provider/[connectionId]/anthropic/[...path]/route", "http://localhost/api/gateway/provider/conn-1/anthropic/v1/messages", { connectionId: "conn-1", path: ["v1", "messages"] }],
    ["an arbitrary provider connection", "@/app/api/gateway/provider/[connectionId]/[...path]/route", "http://localhost/api/gateway/provider/conn-1/chat/completions", { connectionId: "conn-1", path: ["chat", "completions"] }],
  ];

  for (const [label, routeModule, url, params] of ROUTES) {
    it(`${label}: 403 consumer_subscription_credential_not_routable, no upstream call, nothing echoed or logged`, async () => {
      const response = await post(routeModule, url, params, LEGACY_HEADERS);

      expect(response.status).toBe(403);
      expect(response.headers.get("x-usage-refusal")).toBe(CONSUMER_SUBSCRIPTION_REFUSAL);
      expect(upstreamCalls).toBe(0);
      const body = await response.text();
      expect(body).toContain(CONSUMER_SUBSCRIPTION_REFUSAL);
      expect(body).not.toContain("sk-ant-oat");
      expect(stdout.join("")).not.toContain("sk-ant-oat");
      expect(stdout.join("")).not.toContain("usgm_legacy_device_token");
    });
  }

  it("refuses a client provider key the same way on a connection route", async () => {
    const response = await post(ROUTES[3][1], ROUTES[3][2], ROUTES[3][3], { authorization: "Bearer sk-or-v1-client-key" });
    expect(response.status).toBe(403);
    expect(response.headers.get("x-usage-refusal")).toBe(CLIENT_PROVIDER_CREDENTIAL_REFUSAL);
    expect(upstreamCalls).toBe(0);
  });
});

describe("a route session to the owner's OpenRouter connection still routes", () => {
  const SECRET = Buffer.from("test-route-session-secret-0123456789abcdef", "utf8");
  const SERVER_HELD = "sk-or-v1-server-held-connection-key";
  const PARENT: MinerCredentialRow = {
    id: "cred-parent",
    user_id: "00000000-0000-4000-8000-000000000001",
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
  const store: MinerCredentialStore = {
    findByTokenHash: async () => null,
    findById: async (id) => (id === PARENT.id ? PARENT : null),
    touch: async () => {},
    create: async () => ({ credentialId: "x", token: "y" }),
    revoke: async () => {},
    rotate: async () => ({ credentialId: "x2", token: "y2" }),
  };
  const OLD_ENV = { ...process.env };

  beforeEach(() => {
    resetRateLimits();
    process.env.USAGE_ROUTE_SESSION_SECRET = SECRET.toString("utf8");
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    process.env = { ...OLD_ENV };
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function route() {
    return createGatewayRoute({
      clientType: "usage-miner",
      error: anthropicError,
      surface: "anthropic_compatible",
      authenticate: async (request) => authenticateMiner(readPresentedToken(request.headers), store),
      resolve: async () => ({
        gateway: protocolGateway({
          protocol: anthropicCompatibleProtocol,
          connectionId: "conn-openrouter",
          baseUrl: "https://openrouter.ai/api",
          providerSlug: "openrouter",
          endpointTrusted: true,
          providerFamily: "openrouter",
          funding: null,
        }),
        credential: SERVER_HELD,
      }),
    });
  }

  async function call(authorization: string, beta: string) {
    let forwarded: Request | null = null;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      forwarded = new Request(url, init);
      return new Response(
        JSON.stringify({ id: "msg_or_1", model: "anthropic/claude-sonnet-4.6", stop_reason: "end_turn", usage: { input_tokens: 3, output_tokens: 2 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const request = new Request("http://localhost/api/gateway/provider/conn-openrouter/anthropic/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", authorization, "anthropic-beta": beta },
      body: JSON.stringify({ model: "anthropic/claude-sonnet-4.6", max_tokens: 8, messages: [] }),
    });
    const response = await route().POST(request as never, {
      params: Promise.resolve({ connectionId: "conn-openrouter", path: ["v1", "messages"] }),
    });
    return { response, forwarded: forwarded as Request | null };
  }

  it("carries the server-held provider credential and nothing of the client's", async () => {
    const session = mintRouteSessionToken(
      {
        credentialId: PARENT.id,
        userId: PARENT.user_id,
        deviceId: "device-1",
        tool: "claude-code",
        connectionId: "conn-openrouter",
        surface: "anthropic_compatible",
        now: Date.now(),
      },
      SECRET,
    )!;

    const { response, forwarded } = await call(`Bearer ${session.token}`, "interleaved-thinking-2025-05-14");

    expect(response.status).toBe(200);
    expect(forwarded).not.toBeNull();
    expect(forwarded!.url).toContain("openrouter.ai");
    expect(forwarded!.headers.get("x-api-key")).toBe(SERVER_HELD);
    expect(JSON.stringify([...forwarded!.headers])).not.toContain("usgr_");
    expect(forwarded!.headers.get("anthropic-beta")).toBe("interleaved-thinking-2025-05-14");
  });

  it("is refused the moment a subscription login rides along with the session", async () => {
    const { response, forwarded } = await call(OAUTH, OAUTH_BETA);
    expect(response.status).toBe(403);
    expect(response.headers.get("x-usage-refusal")).toBe(CONSUMER_SUBSCRIPTION_REFUSAL);
    expect(forwarded).toBeNull();
  });
});
