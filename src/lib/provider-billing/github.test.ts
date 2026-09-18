import { describe, expect, it } from "vitest";
import { usdCostToMicros } from "@/lib/domain/money";
import { canonicalDecimal, formatMicroUnits, parseExactJson, scaleDecimal } from "./decimal";
import {
  buildGithubAuthorizeUrl,
  buildGithubUsageRequest,
  classifyBillingScope,
  classifyGithubStatus,
  fetchGithubUsage,
  githubAppConfig,
  GITHUB_API_VERSION,
  isValidGithubLogin,
  parseGithubUsageResponse,
  parseTokenPayload,
  sha256Hex,
} from "./github";

describe("exact decimals", () => {
  it("captures the source text of every JSON number instead of a float", () => {
    const parsed = parseExactJson('{"a":0.10,"b":[1e-2,3],"c":"0.1"}') as Record<string, unknown>;
    expect(parsed.a).toEqual({ kind: "decimal", source: "0.10" });
    expect(parsed.b).toEqual([
      { kind: "decimal", source: "1e-2" },
      { kind: "decimal", source: "3" },
    ]);
    expect(parsed.c).toBe("0.1");
  });

  it("canonicalizes literals exactly", () => {
    expect(canonicalDecimal("0.10")).toBe("0.1");
    expect(canonicalDecimal("1e-2")).toBe("0.01");
    expect(canonicalDecimal("12.500")).toBe("12.5");
    expect(canonicalDecimal("1.5E3")).toBe("1500");
    expect(canonicalDecimal("-0.0")).toBe("0");
    expect(canonicalDecimal("007")).toBe("7");
  });

  it("scales without floats, rounding half away from zero and saying so", () => {
    // 0.1 + 0.2 in floats is 0.30000000000000004; here it is exact.
    expect(scaleDecimal("0.3")).toEqual({ value: 300_000, rounded: false });
    expect(scaleDecimal("0.0000015")).toEqual({ value: 2, rounded: true });
    expect(scaleDecimal("0.0000014")).toEqual({ value: 1, rounded: true });
    expect(scaleDecimal("1e-2")).toEqual({ value: 10_000, rounded: false });
    expect(() => scaleDecimal("99999999999999999999")).toThrow(/range/);
  });

  it("agrees with the existing string-based money parser for USD", () => {
    for (const value of ["0.01", "1", "12.34", "0.0000004125", "1234.567891"]) {
      expect(scaleDecimal(value).value).toBe(usdCostToMicros(value).micros);
    }
  });

  it("formats micro-units for display", () => {
    expect(formatMicroUnits(12_500_000, 4)).toBe("12.5");
    expect(formatMicroUnits(1_234_000_000, 2)).toBe("1,234");
  });
});

const SELF_PAID = `{
  "timePeriod": {"year": 2026, "month": 9},
  "user": "octo-dev",
  "usageItems": [
    {"product": "Copilot", "sku": "Copilot AI Credits", "model": "gpt-5.1", "unitType": "credits",
     "pricePerUnit": 0.01, "grossQuantity": 1234.5, "grossAmount": 12.345,
     "discountQuantity": 300, "discountAmount": 3.00, "netQuantity": 934.5, "netAmount": 9.345},
    {"product": "Copilot AI Credits", "sku": "AI Credit", "model": "claude-sonnet-4.5", "unitType": "ai-credits",
     "pricePerUnit": 0.01, "grossQuantity": 0.1, "grossAmount": 0.001,
     "discountQuantity": 0.1, "discountAmount": 0.001, "netQuantity": 0, "netAmount": 0}
  ]
}`;

describe("GitHub billing response", () => {
  it("parses self-paid usage into exact figures, strings untouched", () => {
    const parsed = parseGithubUsageResponse(SELF_PAID);
    expect(parsed.timePeriod).toEqual({ year: 2026, month: 9, day: null });
    expect(parsed.user).toBe("octo-dev");
    const [a, b] = parsed.usageItems;
    expect(a.product).toBe("Copilot");
    expect(a.sku).toBe("Copilot AI Credits");
    expect(a.unitType).toBe("credits");
    expect(a.pricePerUnit).toEqual({ text: "0.01", scaled: 10_000 });
    expect(a.grossQuantity).toEqual({ text: "1234.5", scaled: 1_234_500_000 });
    expect(a.grossAmount).toEqual({ text: "12.345", scaled: 12_345_000 });
    expect(a.discountAmount).toEqual({ text: "3.00", scaled: 3_000_000 });
    expect(a.netAmount.scaled).toBe(a.grossAmount.scaled - a.discountAmount.scaled);
    expect(b.sku).toBe("AI Credit");
    expect(b.unitType).toBe("ai-credits");
    expect(b.grossAmount).toEqual({ text: "0.001", scaled: 1_000 });
    expect(b.netQuantity).toEqual({ text: "0", scaled: 0 });
  });

  it("accepts an empty usageItems list (and it is not zero usage)", () => {
    const parsed = parseGithubUsageResponse('{"timePeriod":{"year":2026,"month":9},"user":"x","usageItems":[]}');
    expect(parsed.usageItems).toEqual([]);
    expect(classifyBillingScope({ kind: "ok", itemCount: 0 }, "unknown")).toBe("no_data_or_managed");
  });

  it("rejects a response with a non-numeric amount instead of storing half of it", () => {
    expect(() =>
      parseGithubUsageResponse(
        '{"timePeriod":{"year":2026},"usageItems":[{"product":"p","sku":"s","unitType":"u","pricePerUnit":"0.01","grossQuantity":1,"grossAmount":1,"discountQuantity":0,"discountAmount":0,"netQuantity":1,"netAmount":1}]}',
      ),
    ).toThrow(/pricePerUnit/);
    expect(() => parseGithubUsageResponse("not json")).toThrow();
    expect(() => parseGithubUsageResponse('{"timePeriod":{"year":2026}}')).toThrow(/usageItems/);
  });
});

describe("request building", () => {
  it("pins every header and the API version, and encodes the path", () => {
    const request = buildGithubUsageRequest({ login: "octo-dev", accessToken: "ghu_test", period: { year: 2026, month: 9, day: 7 } });
    expect(request.url).toBe("https://api.github.com/users/octo-dev/settings/billing/ai_credit/usage?year=2026&month=9&day=7");
    expect(request.headers).toEqual({
      authorization: "Bearer ghu_test",
      accept: "application/vnd.github+json",
      "x-github-api-version": "2026-03-10",
    });
    expect(request.apiVersion).toBe(GITHUB_API_VERSION);
    expect(request.requestKey).toBe("2026-09-07");
    expect(buildGithubUsageRequest({ login: "a", accessToken: "t", period: { year: 2026, month: 9 } }).requestKey).toBe("2026-09");
  });

  it("refuses a login or period that could not be a GitHub value", () => {
    expect(isValidGithubLogin("../../orgs/x")).toBe(false);
    expect(isValidGithubLogin("octo_shortcode")).toBe(true);
    expect(() => buildGithubUsageRequest({ login: "a/b", accessToken: "t", period: { year: 2026, month: 9 } })).toThrow();
    expect(() => buildGithubUsageRequest({ login: "a", accessToken: "t", period: { year: 2026, month: 13 } })).toThrow();
  });

  it("builds the authorize URL with PKCE S256 and no extra scope", () => {
    const url = new URL(
      buildGithubAuthorizeUrl({ clientId: "Iv1.abc", redirectUri: "https://usage-ten.vercel.app/api/providers/github/callback", state: "s", codeChallenge: "c" }),
    );
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("redirect_uri")).toBe("https://usage-ten.vercel.app/api/providers/github/callback");
    expect(url.searchParams.has("scope")).toBe(false);
  });

  it("is unconfigured without both env names", () => {
    expect(githubAppConfig({})).toBeNull();
    expect(githubAppConfig({ GITHUB_APP_CLIENT_ID: "x" })).toBeNull();
    expect(githubAppConfig({ GITHUB_APP_CLIENT_ID: "x", GITHUB_APP_CLIENT_SECRET: "y" })).toEqual({ clientId: "x", clientSecret: "y" });
  });
});

describe("status classification", () => {
  it("maps each documented status", () => {
    expect(classifyGithubStatus(200)).toBe("ok");
    expect(classifyGithubStatus(401)).toBe("auth_expired");
    expect(classifyGithubStatus(403)).toBe("permission_insufficient");
    expect(classifyGithubStatus(404)).toBe("unavailable");
    expect(classifyGithubStatus(400)).toBe("bad_request");
    expect(classifyGithubStatus(500)).toBe("temporary");
    expect(classifyGithubStatus(503)).toBe("temporary");
  });

  it("treats a rate-limited 403 as temporary, not as a permission verdict", () => {
    expect(classifyGithubStatus(403, new Headers({ "x-ratelimit-remaining": "0" }))).toBe("rate_limited");
    expect(classifyGithubStatus(403, new Headers({ "retry-after": "60" }))).toBe("rate_limited");
    expect(classifyGithubStatus(429)).toBe("rate_limited");
  });

  it("derives billing scope and keeps the previous scope on a temporary failure", () => {
    expect(classifyBillingScope({ kind: "ok", itemCount: 2 }, "unknown")).toBe("personal");
    expect(classifyBillingScope({ kind: "error", failure: "permission_insufficient" }, "personal")).toBe("permission_insufficient");
    expect(classifyBillingScope({ kind: "error", failure: "unavailable" }, "personal")).toBe("unavailable");
    expect(classifyBillingScope({ kind: "error", failure: "temporary" }, "personal")).toBe("personal");
  });

  it("classifies a fetched 5xx without throwing, and hashes the exact body on 200", async () => {
    const fail: typeof fetch = async () => new Response("oops", { status: 503 });
    const r = await fetchGithubUsage({ login: "a", accessToken: "t", period: { year: 2026, month: 9 }, fetchImpl: fail });
    expect(r).toMatchObject({ kind: "error", status: 503, failure: "temporary" });

    const ok: typeof fetch = async () => new Response(SELF_PAID, { status: 200 });
    const good = await fetchGithubUsage({ login: "a", accessToken: "t", period: { year: 2026, month: 9 }, fetchImpl: ok });
    expect(good.kind).toBe("ok");
    if (good.kind === "ok") expect(good.sha256).toBe(sha256Hex(SELF_PAID));
  });
});

describe("token payloads", () => {
  it("computes expiries from GitHub's seconds", () => {
    const now = new Date("2026-09-18T00:00:00Z");
    const tokens = parseTokenPayload(
      { access_token: "ghu_a", refresh_token: "ghr_b", expires_in: 28800, refresh_token_expires_in: 15897600 },
      now,
    );
    expect(tokens.accessExpiresAt).toBe("2026-09-18T08:00:00.000Z");
    expect(tokens.refreshExpiresAt).toBe(new Date(now.getTime() + 15897600 * 1000).toISOString());
  });

  it("handles an app that does not expire tokens", () => {
    const tokens = parseTokenPayload({ access_token: "ghu_a" }, new Date());
    expect(tokens).toEqual({ accessToken: "ghu_a", refreshToken: null, accessExpiresAt: null, refreshExpiresAt: null });
  });
});
