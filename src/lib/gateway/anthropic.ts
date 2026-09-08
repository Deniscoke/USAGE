/**
 * USAGE Gateway — Anthropic-compatible surface.
 *
 * Claude Code points `ANTHROPIC_BASE_URL` at us; we forward to the Vercel AI
 * Gateway using OUR credential and observe the response.
 *
 * The proxy is transparent on purpose. Claude Code is an agentic client that
 * depends on streaming, tool calls, extended thinking, prompt caching and exact
 * error shapes, so the request and response bodies are passed through unchanged
 * except for one addition: server-side attribution.
 */

import { looksLikeMinerToken } from "@/lib/miner/token";

/** Vercel's Claude Code compatibility surface. The Anthropic SDK appends /v1/messages. */
export const DEFAULT_UPSTREAM_BASE_URL = "https://ai-gateway.vercel.sh/claude-code";

export function upstreamBaseUrl(): string {
  return (process.env.USAGE_UPSTREAM_BASE_URL || DEFAULT_UPSTREAM_BASE_URL).replace(/\/+$/, "");
}

/**
 * Headers never copied from the incoming request.
 *
 * The miner's credential is the important one: it authenticates the caller to
 * USAGE and has no meaning to Vercel. Forwarding it would leak a USAGE secret to
 * a third party. `authorization` is listed here too and re-set deliberately
 * below, so a client can never smuggle an auth header through by accident;
 * `x-ai-gateway-api-key` is ours to set and never the caller's to choose.
 */
const STRIPPED_REQUEST_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "x-usage-miner-token",
  "x-ai-gateway-api-key",
  "cookie",
  "host",
  "content-length",
  "connection",
  "accept-encoding",
  "transfer-encoding",
]);

/** Response headers never returned to the miner. */
const STRIPPED_RESPONSE_HEADERS = new Set([
  "set-cookie",
  "authorization",
  "x-api-key",
  "x-ai-gateway-api-key",
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
]);

/**
 * The Claude subscription credential Claude Code puts in `Authorization`.
 *
 * Returns null when there is none, and when the value is a USAGE miner token —
 * that one is ours, authenticates the caller to us, and never leaves the server.
 *
 * The value is treated as opaque: it is read to decide *where* it goes, never
 * parsed, stored, hashed, logged or copied anywhere else. USAGE is a courier
 * for it, not a holder of it.
 */
export function readSubscriptionAuthorization(incoming: Headers): string | null {
  const value = incoming.get("authorization");
  if (!value?.trim()) return null;
  const bare = value.trim().replace(/^Bearer\s+/i, "");
  return looksLikeMinerToken(bare) ? null : value;
}

/**
 * Headers for the upstream call.
 *
 * Two documented Vercel auth shapes, and three identities that stay separate:
 *
 *   API key mode      Authorization: Bearer <AI_GATEWAY_API_KEY>
 *   subscription mode Authorization: <Claude's own, forwarded opaquely>
 *                     x-ai-gateway-api-key: Bearer <AI_GATEWAY_API_KEY>
 *
 * Subscription mode is what lets a Claude Code signed in to a Claude
 * subscription mine: Anthropic authenticates the *user*, the gateway key
 * authenticates *USAGE*, and the miner token (already consumed and stripped)
 * authenticated the caller to us. Merging any two of them would let one party's
 * credential decide another party's bill.
 */
export function buildUpstreamHeaders(incoming: Headers, apiKey: string): Headers {
  const headers = new Headers();
  for (const [name, value] of incoming) {
    if (!STRIPPED_REQUEST_HEADERS.has(name.toLowerCase())) headers.set(name, value);
  }
  headers.set("content-type", "application/json");

  const subscription = readSubscriptionAuthorization(incoming);
  if (subscription) {
    headers.set("authorization", subscription);
    headers.set("x-ai-gateway-api-key", `Bearer ${apiKey}`);
    return headers;
  }

  // No subscription credential: the gateway key is the only identity, and it is
  // ours alone.
  headers.set("authorization", `Bearer ${apiKey}`);
  return headers;
}

export function sanitizeResponseHeaders(incoming: Headers): Headers {
  const headers = new Headers();
  for (const [name, value] of incoming) {
    if (!STRIPPED_RESPONSE_HEADERS.has(name.toLowerCase())) headers.set(name, value);
  }
  return headers;
}

export interface Attribution {
  /** Stable internal id. Never an email or a name. */
  user: string;
  tags: string[];
}

/**
 * Attach gateway attribution server-side.
 *
 * `providerOptions` is the documented way to pass gateway options on a raw
 * Anthropic-compatible request (it is what CLAUDE_CODE_EXTRA_BODY merges in).
 * We overwrite `user` and `tags` rather than merging: attribution the caller
 * controls is attribution we cannot trust.
 */
export function withAttribution(body: unknown, attribution: Attribution): unknown {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return body;

  const record = body as Record<string, unknown>;
  const providerOptions =
    typeof record.providerOptions === "object" && record.providerOptions !== null
      ? { ...(record.providerOptions as Record<string, unknown>) }
      : {};
  const gateway =
    typeof providerOptions.gateway === "object" && providerOptions.gateway !== null
      ? { ...(providerOptions.gateway as Record<string, unknown>) }
      : {};

  return {
    ...record,
    providerOptions: {
      ...providerOptions,
      gateway: { ...gateway, user: attribution.user, tags: attribution.tags },
    },
  };
}

/** Whether the caller asked for a streamed response. */
export function isStreamingRequest(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    (body as { stream?: unknown }).stream === true
  );
}

/**
 * Anthropic-shaped error, so a miner client sees a protocol it understands
 * rather than an HTML page. Never includes upstream credentials or internals.
 */
export function anthropicError(
  status: number,
  type: string,
  message: string,
): Response {
  return new Response(JSON.stringify({ type: "error", error: { type, message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}
