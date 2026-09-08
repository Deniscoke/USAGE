import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { anthropicError, buildUpstreamHeaders, upstreamBaseUrl } from "@/lib/gateway/anthropic";
import { defaultComputeGateway } from "@/lib/compute/registry";
import {
  appendDevObservation,
  checkRateLimit,
  logGatewayRequest,
  scheduleAfterResponse,
} from "@/lib/gateway/observability";
import { authenticateMiner, createSupabaseMinerStore } from "@/lib/miner/credentials";
import { readPresentedToken } from "@/lib/miner/token";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import type { GatewayObservation } from "@/lib/providers/vercel-gateway/observation";
import { assessTrust, type TrustAssessment } from "@/lib/trust/production";

/**
 * USAGE Gateway — Anthropic-compatible endpoint.
 *
 *   Claude Code --(miner token)--> USAGE Gateway --(our key)--> Vercel AI Gateway
 *
 * The trust boundary lives here. The client authenticates as a miner and gets to
 * *initiate* a request; the server decides what evidence that produces. Nothing
 * in the request body or headers can influence verification type, token counts,
 * cost or identity of the resulting proof.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CLIENT_TYPE = "claude-code";

async function resolveMinerStore() {
  if (!isSupabaseConfigured()) return null;
  const { createAdminSupabase } = await import("@/lib/supabase/admin");
  return createSupabaseMinerStore(createAdminSupabase());
}

/**
 * Persist an observation. With a database configured this goes through the same
 * trusted ingestion as every other proof; without one it lands in a local
 * inspection log that is explicitly not production proof storage.
 */
async function recordObservation(
  observation: GatewayObservation,
  userId: string,
  trust: TrustAssessment,
  minerCredentialId: string,
): Promise<void> {
  if (!isSupabaseConfigured()) {
    // No trusted persistence available, so nothing here can be a confirmed
    // proof no matter what this process holds.
    await appendDevObservation(observation);
    return;
  }
  const { createAdminSupabase } = await import("@/lib/supabase/admin");
  const { createSupabaseIngestStore } = await import("@/lib/db/supabase-store");
  const { ingestGatewayObservations } = await import("@/lib/db/ingest");

  const store = createSupabaseIngestStore(createAdminSupabase());
  await ingestGatewayObservations(store, userId, [observation], {
    // Signing is what confirms a proof, and only trusted hosted infrastructure
    // holds the key. A local gateway passes null here and produces an
    // OBSERVED, economically ineligible record.
    issuance: trust.canIssueProduction ? trust.issuer : null,
    minerCredentialId,
  });
}

export async function POST(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const requestId = randomUUID();
  const startedAt = Date.now();
  const { path } = await context.params;
  const upstreamPath = path.join("/");

  const auth = await authenticateMiner(readPresentedToken(request.headers), await resolveMinerStore());
  if (!auth.ok) {
    logGatewayRequest({
      requestId,
      path: upstreamPath,
      status: 401,
      latencyMs: Date.now() - startedAt,
      outcome: `miner_${auth.reason}`,
    });
    // A rejected miner never reaches the AI Gateway, so it can never spend.
    return anthropicError(401, "authentication_error", `Invalid USAGE miner credential (${auth.reason}).`);
  }

  const limit = checkRateLimit(auth.identity.credentialId);
  if (!limit.allowed) {
    logGatewayRequest({
      requestId,
      userId: auth.identity.userId,
      path: upstreamPath,
      status: 429,
      latencyMs: Date.now() - startedAt,
      outcome: "rate_limited",
    });
    return anthropicError(429, "rate_limit_error", "Miner rate limit exceeded.");
  }

  const apiKey = process.env.AI_GATEWAY_API_KEY;
  if (!apiKey) {
    logGatewayRequest({
      requestId,
      userId: auth.identity.userId,
      path: upstreamPath,
      status: 503,
      latencyMs: Date.now() - startedAt,
      outcome: "upstream_not_configured",
    });
    return anthropicError(503, "api_error", "USAGE Gateway upstream is not configured.");
  }

  // Trust is assessed per request: the signing key must be present AND, when
  // configured, Vercel must confirm cryptographically which deployment this is.
  const trust = await assessTrust(request.headers);
  const environment = trust.canIssueProduction ? "live" : "development";

  // One gateway implementation carries miner traffic. Which one is a server
  // decision: letting a client pick its gateway would let it pick how its own
  // usage is observed.
  const gateway = defaultComputeGateway();

  const rawBody = await request.text();
  let parsedBody: unknown = null;
  try {
    parsedBody = rawBody ? JSON.parse(rawBody) : null;
  } catch {
    parsedBody = null;
  }

  const requestedModel =
    typeof (parsedBody as { model?: unknown } | null)?.model === "string"
      ? ((parsedBody as { model: string }).model)
      : null;
  const streaming = gateway.isStreaming(parsedBody);

  // Attribution is added by the server, from the authenticated identity.
  const call = gateway.buildUpstreamCall(
    {
      path,
      headers: request.headers,
      body: parsedBody,
      rawBody,
      attribution: {
        user: auth.identity.userId,
        tags: ["usage", "miner", CLIENT_TYPE, environment === "live" ? "production" : "development"],
      },
    },
    apiKey,
  );

  let upstream: Response;
  try {
    upstream = await fetch(call.url, {
      method: "POST",
      headers: call.headers,
      body: call.body,
      // Streaming must not be buffered by the runtime.
      cache: "no-store",
    });
  } catch (error) {
    logGatewayRequest({
      requestId,
      userId: auth.identity.userId,
      path: upstreamPath,
      status: 502,
      latencyMs: Date.now() - startedAt,
      outcome: "upstream_unreachable",
    });
    // The message is ours, not the raw error: upstream errors can echo config.
    void error;
    return anthropicError(502, "api_error", "USAGE Gateway could not reach the upstream provider.");
  }

  const responseHeaders = gateway.sanitizeResponseHeaders(upstream.headers);

  // A failed generation is not evidence that billable usage occurred.
  if (!upstream.ok) {
    const body = await upstream.text();
    logGatewayRequest({
      requestId,
      userId: auth.identity.userId,
      path: upstreamPath,
      status: upstream.status,
      latencyMs: Date.now() - startedAt,
      model: requestedModel,
      outcome: "upstream_error",
    });
    return new Response(body, { status: upstream.status, headers: responseHeaders });
  }

  const finish = (observation: GatewayObservation | null, status: number) => {
    logGatewayRequest({
      requestId,
      userId: auth.identity.userId,
      path: upstreamPath,
      status,
      latencyMs: Date.now() - startedAt,
      streaming,
      model: observation?.model ?? requestedModel,
      generationId: observation?.generationId ?? null,
      inputTokens: observation?.usage.inputTokens ?? null,
      outputTokens: observation?.usage.outputTokens ?? null,
      costMicroUsd: null,
      outcome: observation ? "usage_recorded" : "usage_unavailable",
    });

    if (!observation) return;
    // Recording must not delay the client's response -- but a serverless
    // function is frozen the moment the response completes, so a plain
    // fire-and-forget promise is simply never finished. after() keeps the
    // invocation alive until the write lands.
    scheduleAfterResponse(
      recordObservation(
        observation,
        auth.identity.userId,
        trust,
        auth.identity.credentialId,
      ).catch(() => {
      logGatewayRequest({
        requestId,
        userId: auth.identity.userId,
        path: upstreamPath,
        status,
        latencyMs: Date.now() - startedAt,
        outcome: "observation_persist_failed",
      });
      }),
    );
  };

  if (streaming && upstream.body) {
    const observer = gateway.observeStream(upstream.headers);
    const decoder = new TextDecoder();

    // Bytes pass through untouched; the observer only reads a copy of the text.
    const passthrough = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk);
        observer.push(decoder.decode(chunk, { stream: true }));
      },
      flush() {
        finish(
          gateway.toObservation({
            observed: observer.result(),
            requestedModel,
            environment,
            clientType: CLIENT_TYPE,
            occurredAt: new Date(),
            latencyMs: Date.now() - startedAt,
          }),
          upstream.status,
        );
      },
    });

    return new Response(upstream.body.pipeThrough(passthrough), {
      status: upstream.status,
      headers: responseHeaders,
    });
  }

  const text = await upstream.text();
  let payload: unknown = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = null;
  }

  finish(
    gateway.toObservation({
      observed: gateway.observe(payload, upstream.headers),
      requestedModel,
      environment,
      clientType: CLIENT_TYPE,
      occurredAt: new Date(),
      latencyMs: Date.now() - startedAt,
    }),
    upstream.status,
  );

  return new Response(text, { status: upstream.status, headers: responseHeaders });
}

/** Model discovery and other reads. Transparent; produces no usage evidence. */
export async function GET(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  const auth = await authenticateMiner(readPresentedToken(request.headers), await resolveMinerStore());
  if (!auth.ok) {
    return anthropicError(401, "authentication_error", "Invalid USAGE miner credential.");
  }

  const apiKey = process.env.AI_GATEWAY_API_KEY;
  if (!apiKey) return anthropicError(503, "api_error", "USAGE Gateway upstream is not configured.");

  const upstream = await fetch(`${upstreamBaseUrl()}/${path.join("/")}${request.nextUrl.search}`, {
    headers: buildUpstreamHeaders(request.headers, apiKey),
    cache: "no-store",
  });

  return new Response(await upstream.text(), {
    status: upstream.status,
    headers: defaultComputeGateway().sanitizeResponseHeaders(upstream.headers),
  });
}
