import { looksLikeMinerToken } from "@/lib/miner/token";

/**
 * The subscription boundary (M17A).
 *
 * A USAGE gateway authenticates exactly two kinds of caller credential: a
 * device token (`usgm_`) and a route session (`usgr_`). Everything a gateway
 * sends upstream is authenticated with a credential USAGE holds server-side.
 *
 * So a request that arrives carrying ANY other credential -- a claude.ai
 * subscription login that Claude Code kept in `Authorization`, an `oauth-*`
 * capability in `anthropic-beta` describing that login, a provider API key in
 * `x-api-key` -- is refused before authentication, before a gateway is
 * resolved and before anything is fetched. It is never forwarded, never
 * stripped-and-continued (that would spend a server-held credential on a
 * request the client meant for its own subscription), never logged, hashed or
 * echoed.
 *
 * This is the server half of a policy the miner also follows. It exists so
 * that an old miner, a stale configuration or a hand-built client cannot relay
 * a consumer subscription credential through USAGE to any upstream, whatever
 * the client version.
 *
 * The check is deliberately shape-based and fails closed: it does not need to
 * recognise a credential format to refuse it, only to recognise USAGE's own.
 */

/** A consumer subscription login (OAuth) reached a USAGE gateway. */
export const CONSUMER_SUBSCRIPTION_REFUSAL = "consumer_subscription_credential_not_routable";
/** Some other client-held provider credential reached a USAGE gateway. */
export const CLIENT_PROVIDER_CREDENTIAL_REFUSAL = "client_provider_credential_not_routable";

export type CredentialRelayRefusal =
  | typeof CONSUMER_SUBSCRIPTION_REFUSAL
  | typeof CLIENT_PROVIDER_CREDENTIAL_REFUSAL;

export type CredentialRelayVerdict =
  | { ok: true }
  | {
      ok: false;
      reason: CredentialRelayRefusal;
      /** Which header carried it. Never the value. */
      carrier: "authorization" | "x-api-key" | "anthropic-beta";
    };

/** Header name for the machine-readable refusal reason on a refused response. */
export const REFUSAL_HEADER = "x-usage-refusal";

function bare(value: string): string {
  return value.trim().replace(/^Bearer\s+/i, "").trim();
}

/**
 * Anthropic's subscription OAuth access tokens carry this prefix. Used only to
 * pick the more specific refusal reason; a foreign credential is refused
 * whether or not it matches.
 */
function looksLikeSubscriptionToken(value: string): boolean {
  return /^sk-ant-oat/i.test(value);
}

export function checkCredentialRelay(headers: Headers): CredentialRelayVerdict {
  const beta = headers.get("anthropic-beta") ?? "";
  const oauthCapability = beta
    .split(",")
    .map((part) => part.trim())
    .some((part) => /^oauth-/i.test(part));

  const authorization = headers.get("authorization");
  if (authorization && bare(authorization) && !looksLikeMinerToken(bare(authorization))) {
    const consumer = oauthCapability || looksLikeSubscriptionToken(bare(authorization));
    return {
      ok: false,
      reason: consumer ? CONSUMER_SUBSCRIPTION_REFUSAL : CLIENT_PROVIDER_CREDENTIAL_REFUSAL,
      carrier: "authorization",
    };
  }

  const apiKey = headers.get("x-api-key");
  if (apiKey && bare(apiKey) && !looksLikeMinerToken(bare(apiKey))) {
    return {
      ok: false,
      reason: looksLikeSubscriptionToken(bare(apiKey)) ? CONSUMER_SUBSCRIPTION_REFUSAL : CLIENT_PROVIDER_CREDENTIAL_REFUSAL,
      carrier: "x-api-key",
    };
  }

  // The capability without the credential still says the client is signed in
  // to a subscription it expects the upstream to honour.
  if (oauthCapability) {
    return { ok: false, reason: CONSUMER_SUBSCRIPTION_REFUSAL, carrier: "anthropic-beta" };
  }

  return { ok: true };
}

/** What the caller is told. Names the fix; contains nothing from the request. */
export function credentialRelayMessage(reason: CredentialRelayRefusal): string {
  return reason === CONSUMER_SUBSCRIPTION_REFUSAL
    ? `${reason}: a subscription sign-in cannot be routed through USAGE. Update USAGE Miner and use "Track only" to measure subscription usage locally, or connect a provider in USAGE and start with a route session.`
    : `${reason}: USAGE gateways accept only a USAGE device credential or route session. Remove the provider key from this client; the provider credential belongs in a USAGE connection.`;
}
