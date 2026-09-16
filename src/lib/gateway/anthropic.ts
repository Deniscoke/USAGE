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
 * Headers for the upstream call.
 *
 * USAGE's gateway key is the only identity that ever leaves this server. There
 * is no subscription mode: a client credential of any kind -- including a
 * claude.ai login Claude Code kept in `Authorization` -- is refused at the
 * handler before this runs (see credential-relay.ts), and is stripped here as
 * well, so no path can carry it upstream even if that check were bypassed.
 * The OAuth capability in `anthropic-beta` describes such a credential, so it
 * is dropped too; every other beta value is forwarded verbatim.
 */
export function buildUpstreamHeaders(incoming: Headers, apiKey: string): Headers {
  const headers = new Headers();
  for (const [name, value] of incoming) {
    if (!STRIPPED_REQUEST_HEADERS.has(name.toLowerCase())) headers.set(name, value);
  }
  headers.set("content-type", "application/json");
  headers.set("authorization", `Bearer ${apiKey}`);

  const beta = headers.get("anthropic-beta");
  if (beta) {
    const kept = beta.split(",").map((value) => value.trim()).filter((value) => value && !/^oauth-/i.test(value));
    if (kept.length > 0) headers.set("anthropic-beta", kept.join(","));
    else headers.delete("anthropic-beta");
  }
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
