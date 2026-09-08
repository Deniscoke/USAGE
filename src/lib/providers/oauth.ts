import { createHash, randomBytes } from "node:crypto";
import { safeFetch } from "@/lib/net/ssrf";
import type { ProviderProtocolId } from "@/lib/protocols/protocol";

/**
 * One-click provider connection.
 *
 * The user clicks Connect, signs in at the provider, approves, and comes back
 * connected. No credential is ever typed into USAGE, and none is shown.
 *
 * PKCE, not a client secret: USAGE's half of the exchange is a random verifier
 * generated per attempt and kept server-side, so intercepting the redirect is
 * not enough to obtain the credential. The provider only ever sees its SHA-256
 * challenge.
 *
 * WHO SUPPORTS THIS. Very few AI providers do. OpenRouter publishes a PKCE flow
 * that returns a user-owned API key; OpenAI, Anthropic, Google, Mistral and xAI
 * publish no equivalent for third-party access to API usage, so those stay on
 * the paste-a-key path and the registry says so rather than implying otherwise.
 */

export interface OAuthProviderConfig {
  slug: string;
  displayName: string;
  /** Where the user is sent to sign in and approve. */
  authorizeUrl: string;
  /** Where USAGE exchanges the returned code for a credential. */
  tokenUrl: string;
  /** The API base the resulting credential is used against. */
  apiBaseUrl: string;
  protocol: ProviderProtocolId;
  /** What the user is actually approving, in one honest sentence. */
  consentSummary: string;
}

/**
 * OpenRouter.
 *
 * Worth calling out why this one provider matters so much: OpenRouter is a
 * router in front of hundreds of models from Anthropic, OpenAI, Google, Meta
 * and others. One OAuth connection therefore measures compute across many
 * providers at once -- which is closer to "measure my AI usage everywhere" than
 * any single model lab could offer.
 */
export const OPENROUTER_OAUTH: OAuthProviderConfig = {
  slug: "openrouter",
  displayName: "OpenRouter",
  authorizeUrl: "https://openrouter.ai/auth",
  tokenUrl: "https://openrouter.ai/api/v1/auth/keys",
  apiBaseUrl: "https://openrouter.ai/api",
  protocol: "openai_compatible",
  consentSummary:
    "OpenRouter will ask you to approve a key for USAGE. USAGE uses it to route the requests you send through USAGE and to read your account's usage totals. It never reads your prompts or responses.",
};

const PROVIDERS: readonly OAuthProviderConfig[] = [OPENROUTER_OAUTH];

export function listOAuthProviders(): readonly OAuthProviderConfig[] {
  return PROVIDERS;
}

export function getOAuthProvider(slug: string): OAuthProviderConfig | null {
  return PROVIDERS.find((provider) => provider.slug === slug) ?? null;
}

export interface PkcePair {
  /** Secret. Stays on the server for the duration of one attempt. */
  verifier: string;
  /** Public. Sent to the provider so it can bind the code to this attempt. */
  challenge: string;
  method: "S256";
}

export function createPkcePair(): PkcePair {
  // 64 bytes of CSPRNG, base64url: comfortably above the RFC's 43-character
  // minimum and nowhere near its 128-character maximum.
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge, method: "S256" };
}

/** Single-use, unguessable, and the only thing the provider hands back. */
export function createOAuthState(): string {
  return randomBytes(32).toString("base64url");
}

export function buildAuthorizeUrl(input: {
  provider: OAuthProviderConfig;
  callbackUrl: string;
  challenge: string;
  state: string;
}): string {
  const url = new URL(input.provider.authorizeUrl);
  // OpenRouter round-trips the callback's own query string, so `state` rides
  // along on the callback URL rather than as a separate parameter.
  const callback = new URL(input.callbackUrl);
  callback.searchParams.set("state", input.state);

  url.searchParams.set("callback_url", callback.toString());
  url.searchParams.set("code_challenge", input.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export class OAuthExchangeError extends Error {
  constructor(
    readonly code: "expired" | "rejected" | "unreachable" | "malformed",
    message: string,
  ) {
    super(message);
    this.name = "OAuthExchangeError";
  }
}

/**
 * Exchange the returned code for a credential.
 *
 * Goes through the SSRF guard like every other outbound request, so a
 * misconfigured or hostile token URL cannot become a way to reach an internal
 * address. The credential is returned to the caller in memory and never logged.
 */
export async function exchangeCodeForKey(input: {
  provider: OAuthProviderConfig;
  code: string;
  verifier: string;
  fetchImpl?: typeof fetch;
  resolve?: (hostname: string) => Promise<string[]>;
}): Promise<string> {
  let response: Response;
  try {
    response = await safeFetch(
      input.provider.tokenUrl,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          code: input.code,
          code_verifier: input.verifier,
          code_challenge_method: "S256",
        }),
        cache: "no-store",
      },
      { fetchImpl: input.fetchImpl, resolve: input.resolve },
    );
  } catch {
    throw new OAuthExchangeError("unreachable", "Could not reach the provider to finish signing in.");
  }

  if (!response.ok) {
    // A code is valid for ten minutes and once only; the common failure is
    // simply taking too long or reloading the callback.
    throw new OAuthExchangeError(
      response.status === 400 || response.status === 401 ? "expired" : "rejected",
      "That sign-in could not be completed. Please try connecting again.",
    );
  }

  let payload: { key?: unknown };
  try {
    payload = (await response.json()) as { key?: unknown };
  } catch {
    throw new OAuthExchangeError("malformed", "The provider returned an unexpected response.");
  }

  if (typeof payload.key !== "string" || payload.key.length === 0) {
    throw new OAuthExchangeError("malformed", "The provider did not return a credential.");
  }
  return payload.key;
}

export interface OpenRouterAccount {
  /** All-time spend on this key, in USD. */
  usage: number;
  /** Credit limit, or null for an unlimited/pay-as-you-go account. */
  limit: number | null;
  /**
   * Whether the account is on the free tier.
   *
   * TRUSTED ECONOMIC EVIDENCE: this comes from OpenRouter, not from the user,
   * and it is what tells the reward policy that compute here is free rather
   * than paid.
   */
  isFreeTier: boolean;
}

/**
 * Read the account context a credential grants.
 *
 * `GET /api/v1/key` reports spend totals and tier, NOT per-request token
 * counts. That makes it good for showing a user what their account has done and
 * for classifying economic source -- and useless for mining, which needs tokens,
 * a model and a request identity. It is used for exactly what it can support.
 */
export async function readOpenRouterAccount(input: {
  credential: string;
  fetchImpl?: typeof fetch;
  resolve?: (hostname: string) => Promise<string[]>;
}): Promise<OpenRouterAccount | null> {
  let response: Response;
  try {
    response = await safeFetch(
      "https://openrouter.ai/api/v1/key",
      {
        headers: { authorization: `Bearer ${input.credential}` },
        cache: "no-store",
      },
      { fetchImpl: input.fetchImpl, resolve: input.resolve },
    );
  } catch {
    return null;
  }
  if (!response.ok) return null;

  try {
    const payload = (await response.json()) as {
      data?: { usage?: number; limit?: number | null; is_free_tier?: boolean };
    };
    const data = payload.data ?? {};
    return {
      usage: typeof data.usage === "number" ? data.usage : 0,
      limit: typeof data.limit === "number" ? data.limit : null,
      // Absent means unknown, and unknown is not "paid".
      isFreeTier: data.is_free_tier === true,
    };
  } catch {
    return null;
  }
}
