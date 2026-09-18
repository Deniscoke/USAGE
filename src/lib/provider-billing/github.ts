import { createHash } from "node:crypto";
import { usdCostToMicros } from "@/lib/domain/money";
import {
  canonicalDecimal,
  decimalToSafeInteger,
  ExactJsonUnsupportedError,
  isDecimalLiteral,
  parseExactJson,
  scaleDecimal,
} from "./decimal";

/**
 * GitHub Copilot personal AI-credit billing, as GitHub documents it
 * (docs/PROVIDER_AUTHORITATIVE_USAGE.md has the sources, verified 2026-09-18).
 *
 *   GET https://api.github.com/users/{username}/settings/billing/ai_credit/usage
 *       ?year&month[&day]      (no hour, no user filter, past 24 months only)
 *
 * Authorized with a GitHub App USER access token (ghu_) whose app holds the
 * "Plan" account permission (read). USAGE never asks anybody for a personal
 * access token. Only self-purchased Copilot plans appear here: usage billed to
 * an organization or enterprise seat is NOT included, so an empty response is
 * never presented as "zero usage".
 *
 * Framework-free: every network call takes an injected `fetch`. No function
 * here logs, and no error message carries a token or a response body.
 */

export const GITHUB_API_BASE = "https://api.github.com";
export const GITHUB_OAUTH_BASE = "https://github.com/login/oauth";
/** Supported: 2026-03-10 and 2022-11-28. Recorded on every snapshot. */
export const GITHUB_API_VERSION = "2026-03-10";
/** provider_oauth_requests.provider_slug for this flow. */
export const GITHUB_BILLING_OAUTH_SLUG = "github-billing";
export const GITHUB_REQUEST_TIMEOUT_MS = 15_000;

export interface GithubAppConfig {
  clientId: string;
  clientSecret: string;
}

/** Server-only configuration. Null when the deployment has no GitHub App. */
export function githubAppConfig(env: Record<string, string | undefined> = process.env): GithubAppConfig | null {
  const clientId = env.GITHUB_APP_CLIENT_ID?.trim();
  const clientSecret = env.GITHUB_APP_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

// ------------------------------------------------------------------ authorize

/**
 * The GitHub App user-authorization URL. PKCE S256; `redirect_uri` must match
 * a registered callback exactly, so nothing else rides on it. No `scope`:
 * a GitHub App's permissions are fixed at registration (Plan: read), and USAGE
 * never asks for more.
 */
export function buildGithubAuthorizeUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL(`${GITHUB_OAUTH_BASE}/authorize`);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("allow_signup", "false");
  return url.toString();
}

// ---------------------------------------------------------------- tokens

export interface GithubTokenSet {
  accessToken: string;
  /** Null when the app does not expire user tokens. */
  refreshToken: string | null;
  accessExpiresAt: string | null;
  refreshExpiresAt: string | null;
}

export type GithubAuthErrorCode =
  | "bad_refresh_token"
  | "bad_verification_code"
  | "rejected"
  | "unreachable"
  | "malformed";

export class GithubAuthError extends Error {
  constructor(readonly code: GithubAuthErrorCode) {
    // Our words only: an upstream body can echo request parameters.
    super(`GitHub authorization failed (${code}).`);
    this.name = "GithubAuthError";
  }
}

async function postTokenEndpoint(
  body: Record<string, string>,
  fetchImpl: typeof fetch,
  now: Date,
): Promise<GithubTokenSet> {
  let response: Response;
  try {
    response = await fetchImpl(`${GITHUB_OAUTH_BASE}/access_token`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new GithubAuthError("unreachable");
  }
  if (response.status >= 500) throw new GithubAuthError("unreachable");

  let payload: Record<string, unknown>;
  try {
    payload = (await response.json()) as Record<string, unknown>;
  } catch {
    throw new GithubAuthError("malformed");
  }
  // GitHub reports OAuth errors as 200 with an `error` field.
  if (typeof payload.error === "string") {
    if (payload.error === "bad_refresh_token") throw new GithubAuthError("bad_refresh_token");
    if (payload.error === "bad_verification_code") throw new GithubAuthError("bad_verification_code");
    throw new GithubAuthError("rejected");
  }
  if (!response.ok) throw new GithubAuthError("rejected");
  return parseTokenPayload(payload, now);
}

export function parseTokenPayload(payload: Record<string, unknown>, now: Date): GithubTokenSet {
  const accessToken = payload.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) throw new GithubAuthError("malformed");
  const refreshToken = typeof payload.refresh_token === "string" && payload.refresh_token ? payload.refresh_token : null;
  const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : Number(payload.expires_in);
  const refreshExpiresIn =
    typeof payload.refresh_token_expires_in === "number"
      ? payload.refresh_token_expires_in
      : Number(payload.refresh_token_expires_in);
  const at = (seconds: number) =>
    Number.isFinite(seconds) && seconds > 0 ? new Date(now.getTime() + seconds * 1000).toISOString() : null;
  return {
    accessToken,
    refreshToken,
    accessExpiresAt: at(expiresIn),
    refreshExpiresAt: refreshToken ? at(refreshExpiresIn) : null,
  };
}

/** Exchange an authorization code (PKCE verifier included) for user tokens. */
export function exchangeGithubCode(input: {
  config: GithubAppConfig;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
  now?: Date;
}): Promise<GithubTokenSet> {
  return postTokenEndpoint(
    {
      client_id: input.config.clientId,
      client_secret: input.config.clientSecret,
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier,
    },
    input.fetchImpl ?? fetch,
    input.now ?? new Date(),
  );
}

/**
 * Refresh. GitHub ROTATES refresh tokens: on success the old refresh token and
 * the old access token stop working, so the caller must persist the returned
 * pair in one write before using it.
 */
export function refreshGithubTokens(input: {
  config: GithubAppConfig;
  refreshToken: string;
  fetchImpl?: typeof fetch;
  now?: Date;
}): Promise<GithubTokenSet> {
  return postTokenEndpoint(
    {
      client_id: input.config.clientId,
      client_secret: input.config.clientSecret,
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
    },
    input.fetchImpl ?? fetch,
    input.now ?? new Date(),
  );
}

/**
 * Remove the user's authorization of the app (DELETE /applications/{id}/grant).
 * Best effort: returns whether GitHub confirmed (204).
 */
export async function revokeGithubGrant(input: {
  config: GithubAppConfig;
  accessToken: string;
  fetchImpl?: typeof fetch;
}): Promise<boolean> {
  const basic = Buffer.from(`${input.config.clientId}:${input.config.clientSecret}`).toString("base64");
  try {
    const response = await (input.fetchImpl ?? fetch)(
      `${GITHUB_API_BASE}/applications/${encodeURIComponent(input.config.clientId)}/grant`,
      {
        method: "DELETE",
        headers: {
          authorization: `Basic ${basic}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": GITHUB_API_VERSION,
          "content-type": "application/json",
        },
        body: JSON.stringify({ access_token: input.accessToken }),
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
      },
    );
    return response.status === 204;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------- classification

export type GithubFailureClass =
  | "auth_expired"
  | "permission_insufficient"
  | "unavailable"
  | "rate_limited"
  | "bad_request"
  | "temporary"
  | "malformed";

/**
 * What a non-200 means. 401 is an expired or revoked token; 403 is a missing
 * permission or a billing scope the endpoint does not serve -- unless it
 * carries rate-limit headers, in which case it is temporary; 404 is an
 * unsupported account or endpoint; 5xx is GitHub's problem, retried later.
 */
export function classifyGithubStatus(status: number, headers?: Headers): "ok" | GithubFailureClass {
  if (status === 200) return "ok";
  if (status === 401) return "auth_expired";
  if (status === 429) return "rate_limited";
  if (status === 403) {
    const remaining = headers?.get("x-ratelimit-remaining");
    if (remaining === "0" || headers?.has("retry-after")) return "rate_limited";
    return "permission_insufficient";
  }
  if (status === 404) return "unavailable";
  if (status === 400 || status === 422) return "bad_request";
  if (status >= 500) return "temporary";
  return "temporary";
}

function apiHeaders(accessToken: string): Record<string, string> {
  return {
    authorization: `Bearer ${accessToken}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": GITHUB_API_VERSION,
  };
}

// ---------------------------------------------------------------- identity

export type GithubUserResult =
  | { kind: "ok"; id: string; login: string }
  | { kind: "error"; status: number; failure: GithubFailureClass };

/**
 * GET /user. The numeric `id` (int64, read from its exact source text) is the
 * canonical principal; `login` is mutable and only ever used as a path value.
 */
export async function fetchGithubUser(input: { accessToken: string; fetchImpl?: typeof fetch }): Promise<GithubUserResult> {
  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(`${GITHUB_API_BASE}/user`, {
      headers: apiHeaders(input.accessToken),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
    });
  } catch {
    return { kind: "error", status: 0, failure: "temporary" };
  }
  const failure = classifyGithubStatus(response.status, response.headers);
  if (failure !== "ok") return { kind: "error", status: response.status, failure };
  try {
    const parsed = parseExactJson(await response.text()) as Record<string, unknown>;
    const id = isDecimalLiteral(parsed.id) ? canonicalDecimal(parsed.id.source) : null;
    const login = typeof parsed.login === "string" ? parsed.login : null;
    if (!id || !/^[0-9]{1,20}$/.test(id) || !login || !isValidGithubLogin(login)) {
      return { kind: "error", status: 200, failure: "malformed" };
    }
    return { kind: "ok", id, login };
  } catch {
    return { kind: "error", status: 200, failure: "malformed" };
  }
}

/**
 * GitHub logins: alphanumerics and hyphens, up to 39 characters; managed
 * (EMU) accounts add an underscore shortcode. Anything else never reaches a
 * URL path.
 */
export function isValidGithubLogin(login: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,98})$/.test(login);
}

// ---------------------------------------------------------------- usage

export interface UsagePeriod {
  year: number;
  month: number;
  /** Absent for a month aggregate. */
  day?: number;
}

export interface GithubUsageRequest {
  url: string;
  headers: Record<string, string>;
  apiVersion: string;
  requestKey: string;
  period: UsagePeriod;
}

export function usageRequestKey(period: UsagePeriod): string {
  const month = String(period.month).padStart(2, "0");
  return period.day === undefined
    ? `${period.year}-${month}`
    : `${period.year}-${month}-${String(period.day).padStart(2, "0")}`;
}

/** The request, with every header explicit and the API version pinned. */
export function buildGithubUsageRequest(input: {
  login: string;
  accessToken: string;
  period: UsagePeriod;
}): GithubUsageRequest {
  if (!isValidGithubLogin(input.login)) throw new Error("Invalid GitHub login.");
  const { year, month, day } = input.period;
  if (!Number.isInteger(year) || year < 2000 || year > 9999) throw new Error("Invalid year.");
  if (!Number.isInteger(month) || month < 1 || month > 12) throw new Error("Invalid month.");
  if (day !== undefined && (!Number.isInteger(day) || day < 1 || day > 31)) throw new Error("Invalid day.");

  const url = new URL(
    `${GITHUB_API_BASE}/users/${encodeURIComponent(input.login)}/settings/billing/ai_credit/usage`,
  );
  url.searchParams.set("year", String(year));
  url.searchParams.set("month", String(month));
  if (day !== undefined) url.searchParams.set("day", String(day));
  return {
    url: url.toString(),
    headers: apiHeaders(input.accessToken),
    apiVersion: GITHUB_API_VERSION,
    requestKey: usageRequestKey(input.period),
    period: input.period,
  };
}

/** One exact figure: the provider's literal and its scaled integer. */
export interface ExactFigure {
  text: string;
  scaled: number;
}

export interface GithubUsageItem {
  product: string;
  sku: string;
  model: string;
  unitType: string;
  /** USD per unit; scaled is micro-USD. */
  pricePerUnit: ExactFigure;
  /** Quantities; scaled is micro-units. */
  grossQuantity: ExactFigure;
  discountQuantity: ExactFigure;
  netQuantity: ExactFigure;
  /** USD; scaled is micro-USD. */
  grossAmount: ExactFigure;
  discountAmount: ExactFigure;
  netAmount: ExactFigure;
}

export interface GithubUsageResponse {
  timePeriod: { year: number; month: number | null; day: number | null };
  user: string | null;
  usageItems: GithubUsageItem[];
}

export class GithubUsageParseError extends Error {
  constructor(readonly reason: string) {
    super(`Unexpected GitHub billing response (${reason}).`);
    this.name = "GithubUsageParseError";
  }
}

function usdFigure(value: unknown, field: string): ExactFigure {
  if (!isDecimalLiteral(value)) throw new GithubUsageParseError(`${field} is not a number`);
  const text = value.source;
  const plain = canonicalDecimal(text);
  // String-based, rounding half-up at the micro boundary (sub-micro amounts
  // are not silently truncated to zero). The exact text stays the authority.
  const scaled = usdCostToMicros(plain).micros;
  if (!Number.isSafeInteger(scaled)) throw new GithubUsageParseError(`${field} out of range`);
  return { text, scaled };
}

function quantityFigure(value: unknown, field: string): ExactFigure {
  if (!isDecimalLiteral(value)) throw new GithubUsageParseError(`${field} is not a number`);
  try {
    return { text: value.source, scaled: scaleDecimal(value.source, 6).value };
  } catch {
    throw new GithubUsageParseError(`${field} out of range`);
  }
}

function label(value: unknown, field: string, optional = false): string {
  if (typeof value === "string") return value;
  if (optional && (value === undefined || value === null)) return "";
  throw new GithubUsageParseError(`${field} is not a string`);
}

function periodPart(value: unknown): number | null {
  return isDecimalLiteral(value) ? decimalToSafeInteger(value.source) : null;
}

/**
 * Parse a 200 body into exact figures. Product, sku and unit strings are
 * carried through as given -- GitHub's own examples vary ("Copilot AI
 * Credits"/"AI Credit"/"ai-credits"), so none is hard-coded. A missing `model`
 * becomes "" (part of the identity key). Anything else malformed rejects the
 * whole response: a partial billing picture is worse than none.
 */
export function parseGithubUsageResponse(text: string): GithubUsageResponse {
  let parsed: unknown;
  try {
    parsed = parseExactJson(text);
  } catch (error) {
    if (error instanceof ExactJsonUnsupportedError) throw error;
    throw new GithubUsageParseError("invalid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new GithubUsageParseError("not an object");
  }
  const body = parsed as Record<string, unknown>;
  const items = body.usageItems;
  if (!Array.isArray(items)) throw new GithubUsageParseError("usageItems missing");
  const time = (body.timePeriod ?? {}) as Record<string, unknown>;
  const year = periodPart(time.year);
  if (year === null) throw new GithubUsageParseError("timePeriod.year missing");

  return {
    timePeriod: { year, month: periodPart(time.month), day: periodPart(time.day) },
    user: typeof body.user === "string" ? body.user : null,
    usageItems: items.map((raw, index) => {
      if (typeof raw !== "object" || raw === null) throw new GithubUsageParseError(`usageItems[${index}]`);
      const item = raw as Record<string, unknown>;
      return {
        product: label(item.product, "product"),
        sku: label(item.sku, "sku"),
        model: label(item.model, "model", true),
        unitType: label(item.unitType, "unitType"),
        pricePerUnit: usdFigure(item.pricePerUnit, "pricePerUnit"),
        grossQuantity: quantityFigure(item.grossQuantity, "grossQuantity"),
        discountQuantity: quantityFigure(item.discountQuantity, "discountQuantity"),
        netQuantity: quantityFigure(item.netQuantity, "netQuantity"),
        grossAmount: usdFigure(item.grossAmount, "grossAmount"),
        discountAmount: usdFigure(item.discountAmount, "discountAmount"),
        netAmount: usdFigure(item.netAmount, "netAmount"),
      };
    }),
  };
}

export type GithubUsageFetchResult =
  | {
      kind: "ok";
      status: 200;
      request: GithubUsageRequest;
      text: string;
      sha256: string;
      response: GithubUsageResponse;
    }
  | { kind: "error"; status: number; request: GithubUsageRequest; failure: GithubFailureClass };

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Fetch one period. Never throws; failures are classified. */
export async function fetchGithubUsage(input: {
  login: string;
  accessToken: string;
  period: UsagePeriod;
  fetchImpl?: typeof fetch;
}): Promise<GithubUsageFetchResult> {
  const request = buildGithubUsageRequest(input);
  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(request.url, {
      headers: request.headers,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
    });
  } catch {
    return { kind: "error", status: 0, request, failure: "temporary" };
  }
  const failure = classifyGithubStatus(response.status, response.headers);
  if (failure !== "ok") return { kind: "error", status: response.status, request, failure };

  let text: string;
  try {
    text = await response.text();
  } catch {
    return { kind: "error", status: 200, request, failure: "temporary" };
  }
  try {
    const parsed = parseGithubUsageResponse(text);
    return { kind: "ok", status: 200, request, text, sha256: sha256Hex(text), response: parsed };
  } catch {
    return { kind: "error", status: 200, request, failure: "malformed" };
  }
}

// ------------------------------------------------------------ billing scope

export type BillingScope =
  | "personal"
  | "no_data_or_managed"
  | "permission_insufficient"
  | "unavailable"
  | "unknown";

/**
 * What the month request says about whose billing this account can show.
 * Items present: personal billing evidence. 200 with no items: nothing
 * self-billed was found -- which is ALSO what an organization- or
 * enterprise-provided seat looks like, so it is never "zero usage". 403: the
 * permission or billing scope is not available. 404: not supported. Anything
 * temporary keeps whatever was known before.
 */
export function classifyBillingScope(
  result: { kind: "ok"; itemCount: number } | { kind: "error"; failure: GithubFailureClass },
  previous: BillingScope,
): BillingScope {
  if (result.kind === "ok") return result.itemCount > 0 ? "personal" : "no_data_or_managed";
  if (result.failure === "permission_insufficient") return "permission_insufficient";
  if (result.failure === "unavailable") return "unavailable";
  return previous;
}

export const NO_PERSONAL_BILLING_COPY =
  "No personal billing usage found. If your Copilot is provided by an organization or enterprise, personal billing evidence is not available; an organization connector is required.";
