import { describe, expect, it } from "vitest";
import { customProfile, isRecognisedEndpoint, normalizeCustomBaseUrl, profileForFamily, profileForUrl, PROVIDER_PROFILES, resolveBaseUrl } from "./profiles";
import { validateConnection } from "./validate";
import { upstreamPath } from "@/lib/protocols/protocol";

/**
 * A valid key must never be called invalid because the probe was wrong.
 * Every case here is a fetch mock; nothing leaves the process.
 */

const resolve = async () => ["93.184.216.34"];

function respond(status: number, body: unknown, headers: Record<string, string> = { "content-type": "application/json" }): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
}

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init)) as typeof fetch;
}

const seen = (fetchImpl: ReturnType<typeof mockFetch>) => fetchImpl;

describe("profiles", () => {
  it("every known provider cites its documentation and a fixed API host", () => {
    for (const p of PROVIDER_PROFILES) {
      expect(p.docs, p.family).toMatch(/https?:\/\//);
      expect(p.baseUrl).toMatch(/^https:\/\//);
      expect(p.hosts).toContain(new URL(p.baseUrl).hostname);
      expect(p.verifiedOn).toMatch(/^2026-/);
    }
  });

  it("recognises a provider by any of its hosts, including the website a user might type", () => {
    expect(profileForUrl("https://openai.com")?.family).toBe("openai");
    expect(profileForUrl("https://api.openai.com/v1")?.family).toBe("openai");
    expect(profileForUrl("https://api.deepseek.com")).toBeNull();
    expect(resolveBaseUrl(profileForFamily("openai")!, "https://openai.com")).toBe("https://api.openai.com");
  });

  it("normalizes custom base URLs without inventing or removing path", () => {
    for (const typed of ["https://provider.example", "https://provider.example/", "https://provider.example/v1", "https://provider.example/v1/"]) {
      expect(normalizeCustomBaseUrl(typed)).toBe("https://provider.example");
    }
    expect(normalizeCustomBaseUrl("https://provider.example/some/path/openai/")).toBe("https://provider.example/some/path/openai");
    expect(normalizeCustomBaseUrl("https://provider.example/some/path/openai/v1")).toBe("https://provider.example/some/path/openai");
  });

  it("never appends /v1 twice, and drops the prefix where the base carries its version", () => {
    expect(upstreamPath(["v1", "chat", "completions"])).toBe("v1/chat/completions");
    expect(upstreamPath(["chat", "completions"])).toBe("v1/chat/completions");
    expect(upstreamPath(["v1", "chat", "completions"], "")).toBe("chat/completions");
    expect(profileForFamily("google")?.apiPathPrefix).toBe("");
    expect(`${profileForFamily("google")!.baseUrl}/${upstreamPath(["v1", "chat", "completions"], "")}`).toBe(
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    );
  });

  it("uses the documented auth strategy per provider, and OpenRouter's key endpoint", () => {
    expect(profileForFamily("anthropic")?.authStrategy).toBe("anthropic_x_api_key");
    expect(profileForFamily("openai")?.authStrategy).toBe("bearer");
    expect(profileForFamily("openrouter")?.validation).toEqual({ kind: "key_info", path: "/v1/key", modelsPublic: true });
  });

  it("treats a known provider's host as a recognised endpoint and anything else as the user's", () => {
    expect(isRecognisedEndpoint("openai", "https://api.openai.com")).toBe(true);
    expect(isRecognisedEndpoint("openai", "https://evil.example")).toBe(false);
    expect(isRecognisedEndpoint(null, "https://api.openai.com")).toBe(false);
  });
});

describe("validation verdicts", () => {
  const openai = profileForFamily("openai")!;
  const anthropic = profileForFamily("anthropic")!;
  const openrouter = profileForFamily("openrouter")!;
  const custom = customProfile("openai_compatible", "https://api.deepseek.com/v1/");

  it("valid Bearer key: accepted, models discovered, capabilities from the profile not the list", async () => {
    let auth = "";
    const fetchImpl = mockFetch((url, init) => {
      auth = new Headers(init?.headers).get("authorization") ?? "";
      expect(url).toBe("https://api.openai.com/v1/models");
      return respond(200, { data: [{ id: "gpt-5.4" }, { id: "gpt-5.4-mini" }] });
    });
    const r = await validateConnection({ profile: openai, baseUrl: openai.baseUrl, credential: "sk-test", fetchImpl, resolve });
    expect(auth).toBe("Bearer sk-test");
    expect(r.verdict).toBe("accepted");
    expect(r.models.map((m) => m.upstreamModelId)).toEqual(["gpt-5.4", "gpt-5.4-mini"]);
    expect(r.capabilities.authenticated).toBe(true);
    expect(r.capabilities.models).toBe(true);
    // Documented for OpenAI, not inferred from the list.
    expect(r.capabilities.usage).toBe(true);
    expect(r.capabilities.requestIdentity).toBe(true);
  });

  it("invalid Bearer key: rejected only on a documented 401", async () => {
    const r = await validateConnection({ profile: openai, baseUrl: openai.baseUrl, credential: "sk-bad", fetchImpl: mockFetch(() => respond(401, { error: "x" })), resolve });
    expect(r).toMatchObject({ verdict: "rejected", failure: "invalid_credentials" });
    expect(r.message).not.toContain("sk-bad");
  });

  it("valid x-api-key: Anthropic's headers, accepted", async () => {
    let headers = new Headers();
    const fetchImpl = mockFetch((url, init) => {
      headers = new Headers(init?.headers);
      expect(url).toBe("https://api.anthropic.com/v1/models");
      return respond(200, { data: [{ id: "claude-sonnet-5", display_name: "Claude Sonnet 5" }] });
    });
    const r = await validateConnection({ profile: anthropic, baseUrl: anthropic.baseUrl, credential: "sk-ant-test", fetchImpl, resolve });
    expect(headers.get("x-api-key")).toBe("sk-ant-test");
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
    expect(headers.get("authorization")).toBeNull();
    expect(r.verdict).toBe("accepted");
    expect(r.models[0].displayName).toBe("Claude Sonnet 5");
  });

  it("403 on the provider's real API is a permission problem, not a wrong key", async () => {
    const r = await validateConnection({ profile: openai, baseUrl: openai.baseUrl, credential: "k", fetchImpl: mockFetch(() => respond(403, {})), resolve });
    expect(r).toMatchObject({ verdict: "rejected", failure: "forbidden" });
    expect(r.message).toMatch(/permissions or billing/);
  });

  it("403 from a custom host is a wrong endpoint, and the key is NOT called invalid", async () => {
    const r = await validateConnection({ profile: custom, baseUrl: custom.baseUrl, credential: "k", fetchImpl: mockFetch(() => respond(403, "<html>")), resolve });
    expect(r).toMatchObject({ verdict: "inconclusive", failure: "wrong_endpoint" });
    expect(r.message).not.toMatch(/rejected|invalid/i);
  });

  it("404 / 405 model list on a custom endpoint is inconclusive: saved, unproven", async () => {
    for (const status of [404, 405]) {
      const r = await validateConnection({ profile: custom, baseUrl: custom.baseUrl, credential: "k", fetchImpl: mockFetch(() => respond(status, "")), resolve });
      expect(r.verdict, String(status)).toBe("inconclusive");
      expect(r.failure).toBe("no_model_list");
      expect(r.message).toMatch(/saved/);
    }
  });

  it("429 is inconclusive", async () => {
    const r = await validateConnection({ profile: openai, baseUrl: openai.baseUrl, credential: "k", fetchImpl: mockFetch(() => respond(429, {})), resolve });
    expect(r).toMatchObject({ verdict: "inconclusive", failure: "rate_limited" });
  });

  it("a timeout is inconclusive and unreachable, never a rejection", async () => {
    const fetchImpl = mockFetch((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }));
    const r = await validateConnection({ profile: openai, baseUrl: openai.baseUrl, credential: "k", fetchImpl, resolve, timeoutMs: 20 });
    expect(r).toMatchObject({ verdict: "inconclusive", failure: "unreachable" });
  });

  it("a malformed model list is inconclusive", async () => {
    const r = await validateConnection({ profile: custom, baseUrl: custom.baseUrl, credential: "k", fetchImpl: mockFetch(() => respond(200, { models: "nope" })), resolve });
    expect(r).toMatchObject({ verdict: "inconclusive", failure: "malformed" });
    const r2 = await validateConnection({ profile: custom, baseUrl: custom.baseUrl, credential: "k", fetchImpl: mockFetch(() => respond(200, "not json")), resolve });
    expect(r2.failure).toBe("malformed");
  });

  it("a nested base path is kept, and a trailing /v1 is not doubled", async () => {
    const urls: string[] = [];
    const nested = customProfile("openai_compatible", "https://host.example/some/path/openai/v1/");
    await validateConnection({ profile: nested, baseUrl: nested.baseUrl, credential: "k", fetchImpl: mockFetch((url) => { urls.push(url); return respond(200, { data: [] }); }), resolve });
    expect(urls).toEqual(["https://host.example/some/path/openai/v1/models"]);
  });

  it("OpenRouter: the key endpoint proves the credential; the public list proves nothing about it", async () => {
    const urls: string[] = [];
    const fetchImpl = mockFetch((url) => {
      urls.push(url);
      if (url.endsWith("/api/v1/key")) return respond(200, { data: { label: "k", usage: 0.5, limit: null, is_free_tier: false } });
      return respond(200, { data: [{ id: "openai/gpt-5.4-mini" }] });
    });
    const r = await validateConnection({ profile: openrouter, baseUrl: openrouter.baseUrl, credential: "sk-or-x", fetchImpl, resolve });
    expect(urls[0]).toBe("https://openrouter.ai/api/v1/key");
    expect(r.verdict).toBe("accepted");
    expect(r.accountContext).toEqual({ label: "k", usage: 0.5, limit: null, is_free_tier: false });
    expect(r.models).toHaveLength(1);
    // A bad key: the public list still answers 200, but the verdict is the key endpoint's.
    const bad = await validateConnection({ profile: openrouter, baseUrl: openrouter.baseUrl, credential: "bad", fetchImpl: mockFetch((url) => url.endsWith("/key") ? respond(401, {}) : respond(200, { data: [{ id: "x" }] })), resolve });
    expect(bad.verdict).toBe("rejected");
  });

  it("valid credential but model list forbidden on a custom host stays saveable", async () => {
    const r = await validateConnection({ profile: custom, baseUrl: custom.baseUrl, credential: "k", fetchImpl: mockFetch(() => respond(403, { error: "no models scope" })), resolve });
    expect(r.verdict).toBe("inconclusive");
  });

  it("a custom endpoint never gets generation capabilities from a model list", async () => {
    const r = await validateConnection({ profile: custom, baseUrl: custom.baseUrl, credential: "k", fetchImpl: mockFetch(() => respond(200, { data: [{ id: "deepseek-chat" }] })), resolve });
    expect(r.verdict).toBe("accepted");
    expect(r.capabilities.authenticated).toBe(true);
    expect(r.capabilities.models).toBe(true);
    expect(r.capabilities.usage).toBe(false);
    expect(r.capabilities.streaming).toBe(false);
    expect(r.capabilities.requestIdentity).toBe(false);
  });

  it("never echoes the credential in any message or probed label", async () => {
    for (const status of [200, 401, 403, 404, 429, 500]) {
      const r = await validateConnection({ profile: openai, baseUrl: openai.baseUrl, credential: "sk-SECRET-VALUE", fetchImpl: mockFetch(() => respond(status, status === 200 ? { data: [] } : {})), resolve });
      expect(JSON.stringify({ m: r.message, p: r.probed, f: r.failure })).not.toContain("SECRET");
    }
  });

  void seen;
});

describe("what a verdict does to the connection being created", () => {
  it("rejected and unreachable store nothing; inconclusive is saved as validating; accepted is active", async () => {
    const { decideCreateOutcome } = await import("./validate");
    const base = { message: "m", capabilities: { authenticated: false, models: false, streaming: false, usage: false, cacheUsage: false, reasoningUsage: false, requestIdentity: false, cost: false }, models: [], accountContext: null, probed: "x" };
    expect(decideCreateOutcome({ ...base, verdict: "rejected", failure: "invalid_credentials" })).toMatchObject({ store: false, error: "credential_rejected" });
    expect(decideCreateOutcome({ ...base, verdict: "inconclusive", failure: "unreachable" })).toMatchObject({ store: false, error: "unreachable" });
    expect(decideCreateOutcome({ ...base, verdict: "inconclusive", failure: "no_model_list" })).toEqual({ store: true, provisionalStatus: "validating", ok: false });
    expect(decideCreateOutcome({ ...base, verdict: "accepted", failure: null })).toEqual({ store: true, provisionalStatus: null, ok: true });
  });
});
