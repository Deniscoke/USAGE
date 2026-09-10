import { randomUUID } from "node:crypto";
import { MiningEventSequencer } from "@/lib/live/broadcast";
import type { FailedEvent, OutcomeEvent, ProgressEvent, StartedEvent, VerifyingEvent } from "@/lib/live/events";
import { usdStringToMicros } from "@/lib/domain/money";
import type { NextRequest } from "next/server";
import {
  appendDevObservation,
  checkRateLimit,
  logGatewayRequest,
  scheduleAfterResponse,
} from "@/lib/gateway/observability";
import { authenticateMiner, createSupabaseMinerStore, hasScope } from "@/lib/miner/credentials";
import { readPresentedToken } from "@/lib/miner/token";
import type { MinerIdentity } from "@/lib/miner/credentials";
import type { WireSurface } from "@/lib/providers/surfaces";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import type { ComputeGateway } from "@/lib/compute/gateway";
import type { GatewayObservation } from "@/lib/providers/vercel-gateway/observation";
import { assessTrust, type TrustAssessment } from "@/lib/trust/production";

/**
 * The USAGE Gateway request path, shared by every gateway.
 *
 *   miner client --(miner token)--> USAGE --(our credential)--> a compute gateway
 *
 * This file is the trust boundary, and there is exactly one of it on purpose.
 * A second gateway meant either duplicating this logic or extracting it, and
 * duplicating the place where verification type, trust and signing are decided
 * is how two gateways quietly grow two different security models.
 *
 * The client authenticates as a miner and gets to *initiate* a request. Nothing
 * in its body or headers can influence verification type, token counts, cost,
 * gateway identity or the identity of the resulting proof.
 */

/**
 * What carries this request, resolved per request.
 *
 * A static gateway for the built-in routes; a user's validated connection for
 * the universal route. Resolution happens AFTER miner authentication, so an
 * unauthenticated caller can never cause a connection lookup, and the resolved
 * user id is what the lookup is scoped to.
 */
export interface ResolvedGateway {
  gateway: ComputeGateway;
  credential: string;
  /** Called after the request completes, for connection health. */
  onOutcome?(outcome: { ok: boolean; errorCode?: string }): void;
}

export interface GatewayRouteOptions {
  /** The gateway, when it is fixed for the route. */
  gateway?: ComputeGateway;
  /** Server-side credential for that gateway. Never reaches a client. */
  credential?(): string | null;
  /**
   * Dynamic resolution, for routes where the gateway depends on the caller.
   * Returning a Response rejects the request without touching upstream.
   */
  resolve?(input: {
    userId: string;
    params: Record<string, string | string[]>;
  }): Promise<ResolvedGateway | Response>;
  /** What produced the traffic, e.g. "claude-code". Non-PII. */
  clientType: string;
  /**
   * The wire surface this route serves for a `[connectionId]` route (M16C0).
   * A route-session token is bound to one connection and one surface and is
   * refused everywhere else, including USAGE's own funded gateways, which
   * declare no surface.
   */
  surface?: WireSurface;
  /** Protocol-shaped error body, so a client sees something it understands. */
  error(status: number, type: string, message: string): Response;
}

/**
 * Why a route session may not use this route, or null when it may.
 *
 * Checked before rate limiting and before the gateway resolves, so a session
 * minted for connection A never even looks up connection B.
 */
export function routeBindingViolation(
  identity: Pick<MinerIdentity, "routeSession">,
  surface: WireSurface | undefined,
  params: Record<string, string | string[] | undefined>,
): string | null {
  const session = identity.routeSession;
  if (!session) return null;
  if (!surface) return "This route session is bound to a provider connection and cannot use this route.";
  const connectionId = String(params.connectionId ?? "");
  if (session.surface !== surface || session.connectionId !== connectionId) {
    return "This route session is bound to a different connection or wire surface.";
  }
  return null;
}

/** Micro-USD from a provider cost string, or null. Display/verifying only; ingestion parses authoritatively. */
function costMicrosOrNull(value: string): number | null {
  try {
    return usdStringToMicros(value);
  } catch {
    return null;
  }
}

/**
 * After ingestion committed, read the persisted unit back and broadcast its
 * outcome. Read from the database, never from the in-memory observation, so
 * the browser sees exactly what was stored (including a dedupe downgrade).
 */
async function broadcastPersistedOutcome(live: MiningEventSequencer, userId: string, observation: GatewayObservation): Promise<void> {
  if (!isSupabaseConfigured()) return;
  const { createAdminSupabase } = await import("@/lib/supabase/admin");
  const admin = createAdminSupabase();
  const { data } = await admin
    .from("usage_events")
    .select("occurred_at, epoch_id, verification_status, economic_status, reward_status, reward_reason, protocol_compute_micros, eligible_compute_micros, protocol_compute_pico, eligible_compute_pico, input_tokens, output_tokens, cached_input_tokens, provider, model")
    .eq("user_id", userId)
    .eq("gateway_id", observation.gatewayId ?? "")
    .like("external_reference", `%${observation.generationId}`)
    .maybeSingle();
  if (!data) return;
  const name = data.reward_status === "eligible" ? "mining.request.verified" : data.reward_status === "held" ? "mining.request.held" : "mining.request.ineligible";
  live.emit<OutcomeEvent>({
    name,
    model: data.model,
    persistedAt: Date.now(),
    occurredAt: data.occurred_at,
    epochId: data.epoch_id,
    verificationStatus: data.verification_status,
    economicStatus: data.economic_status,
    rewardStatus: data.reward_status,
    rewardReason: data.reward_reason,
    protocolComputeMicros: data.protocol_compute_micros,
    eligibleComputeMicros: data.eligible_compute_micros,
    protocolComputePico: data.protocol_compute_pico ?? null,
    eligibleComputePico: data.eligible_compute_pico ?? null,
    inputTokens: data.input_tokens,
    outputTokens: data.output_tokens,
    cacheReadTokens: data.cached_input_tokens,
  } as never);
}

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

export function createGatewayRoute(options: GatewayRouteOptions) {
  const { clientType, error } = options;

  /** The gateway and credential for this request, or a Response refusing it. */
  async function resolveGateway(
    userId: string,
    params: Record<string, string | string[]>,
  ): Promise<ResolvedGateway | Response> {
    if (options.resolve) return options.resolve({ userId, params });

    const gateway = options.gateway;
    const credential = options.credential?.() ?? null;
    if (!gateway) return error(503, "api_error", "USAGE Gateway is not configured.");
    if (!credential) {
      return error(503, "api_error", `USAGE Gateway upstream (${gateway.id}) is not configured.`);
    }
    return { gateway, credential };
  }

  async function POST(
    request: NextRequest,
    context: { params: Promise<Record<string, string | string[]>> },
  ) {
    const requestId = randomUUID();
    const startedAt = Date.now();
    const params = await context.params;
    const path = (params.path ?? []) as string[];
    const upstreamPath = path.join("/");

    const auth = await authenticateMiner(
      readPresentedToken(request.headers),
      await resolveMinerStore(),
    );
    if (!auth.ok) {
      logGatewayRequest({
        requestId,
        path: upstreamPath,
        status: 401,
        latencyMs: Date.now() - startedAt,
        outcome: `miner_${auth.reason}`,
      });
      // A rejected miner never reaches upstream, so it can never spend.
      return error(401, "authentication_error", `Invalid USAGE miner credential (${auth.reason}).`);
    }

    const violation = routeBindingViolation(auth.identity, options.surface, params);
    if (violation) {
      logGatewayRequest({
        requestId,
        userId: auth.identity.userId,
        path: upstreamPath,
        status: 403,
        latencyMs: Date.now() - startedAt,
        outcome: "route_session_binding",
      });
      return error(403, "permission_error", violation);
    }

    // Routing is the one ability that spends money, so it is the one most worth
    // being able to withhold from a credential without withdrawing the rest.
    if (!hasScope(auth.identity, "miner:route")) {
      logGatewayRequest({
        requestId,
        path: upstreamPath,
        status: 403,
        latencyMs: Date.now() - startedAt,
        outcome: "miner_insufficient_scope",
      });
      return error(403, "permission_error", "This credential may not route requests.");
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
      return error(429, "rate_limit_error", "Miner rate limit exceeded.");
    }

    // Live UX events (M16B): ephemeral, per-user, never economic authority.
    // `requestId` is server-minted and correlates the browser's view of this
    // request with the eventual persisted unit; the client chooses nothing.
    // Emitted the moment the miner is authenticated, before the gateway is
    // resolved, so MINING_LIVE reaches the browser as early as the server
    // truthfully knows a request from this user exists.
    const live = new MiningEventSequencer(
      isSupabaseConfigured() ? (await import("@/lib/supabase/admin")).createAdminSupabase() : null,
      auth.identity.userId,
      { requestId, route: `${clientType} → resolving`, provider: "resolving", model: null },
    );
    live.emit<StartedEvent>({ name: "mining.request.started", model: null, startedAt, eligibleRoute: false } as never);

    // Resolved only after authentication, and scoped to the authenticated user.
    const resolved = await resolveGateway(auth.identity.userId, params);
    if (resolved instanceof Response) {
      logGatewayRequest({
        requestId,
        userId: auth.identity.userId,
        path: upstreamPath,
        status: resolved.status,
        latencyMs: Date.now() - startedAt,
        outcome: "gateway_unavailable",
      });
      return resolved;
    }
    const { gateway, credential } = resolved;

    // Trust is assessed per request: the signing key must be present AND, when
    // configured, Vercel must confirm cryptographically which deployment this is.
    const trust = await assessTrust(request.headers);
    const environment = trust.canIssueProduction ? "live" : "development";

    const rawBody = await request.text();
    let parsedBody: unknown = null;
    try {
      parsedBody = rawBody ? JSON.parse(rawBody) : null;
    } catch {
      parsedBody = null;
    }

    const requestedModel =
      typeof (parsedBody as { model?: unknown } | null)?.model === "string"
        ? (parsedBody as { model: string }).model
        : null;
    const streaming = gateway.isStreaming(parsedBody);
    live.setRoute(`${clientType} → ${gateway.providerSlug}`, gateway.providerSlug);
    live.emit<ProgressEvent>({ name: "mining.request.progress", model: requestedModel, firstChunkAt: null, chunks: 0, streamedChars: 0 } as never);

    const call = gateway.buildUpstreamCall(
      {
        path,
        headers: request.headers,
        body: parsedBody,
        rawBody,
        attribution: {
          user: auth.identity.userId,
          tags: [
            "usage",
            "miner",
            clientType,
            environment === "live" ? "production" : "development",
          ],
        },
      },
      credential,
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
    } catch (caught) {
      logGatewayRequest({
        requestId,
        userId: auth.identity.userId,
        path: upstreamPath,
        status: 502,
        latencyMs: Date.now() - startedAt,
        outcome: "upstream_unreachable",
      });
      // The message is ours, not the raw error: upstream errors can echo config.
      void caught;
      resolved.onOutcome?.({ ok: false, errorCode: "unreachable" });
      live.emit<FailedEvent>({ name: "mining.request.failed", model: requestedModel, status: 502, reason: "unreachable" } as never);
      return error(502, "api_error", "USAGE Gateway could not reach the upstream provider.");
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
      resolved.onOutcome?.({ ok: false, errorCode: `http_${upstream.status}` });
      live.emit<FailedEvent>({ name: "mining.request.failed", model: requestedModel, status: upstream.status, reason: `http_${upstream.status}` } as never);
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
        gateway: gateway.id,
        model: observation?.model ?? requestedModel,
        generationId: observation?.generationId ?? null,
        inputTokens: observation?.usage.inputTokens ?? null,
        outputTokens: observation?.usage.outputTokens ?? null,
        costMicroUsd: null,
        outcome: observation ? "usage_recorded" : "usage_unavailable",
      });

      resolved.onOutcome?.({ ok: true });
      if (!observation) {
        live.emit<FailedEvent>({ name: "mining.request.failed", model: requestedModel, status, reason: "usage_unavailable" } as never);
        return;
      }
      // The provider's terminal usage is authoritative for the provider but
      // not yet persisted: VERIFYING, never VERIFIED, until ingestion lands.
      live.emit<VerifyingEvent>({
        name: "mining.request.verifying",
        model: observation.model,
        terminalAt: Date.now(),
        inputTokens: observation.usage.inputTokens ?? null,
        outputTokens: observation.usage.outputTokens ?? null,
        cacheReadTokens: observation.usage.inputTokenDetails?.cacheReadTokens ?? null,
        reasoningTokens: observation.usage.outputTokenDetails?.reasoningTokens ?? null,
        providerCostMicros: observation.cost?.value !== undefined && observation.cost?.value !== null ? costMicrosOrNull(String(observation.cost.value)) : null,
      } as never);
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
        ).then(() => broadcastPersistedOutcome(live, auth.identity.userId, observation)).catch(() => {
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
      let chunks = 0;
      let streamedChars = 0;
      let firstChunkAt: number | null = null;
      let lastProgressAt = 0;
      const passthrough = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          controller.enqueue(chunk);
          const text = decoder.decode(chunk, { stream: true });
          observer.push(text);
          // Live progress: what the server can truthfully observe before the
          // provider's terminal usage -- that bytes are flowing, and how many.
          // At most one event per second; the browser paints the seconds itself.
          chunks += 1;
          streamedChars += text.length;
          const now = Date.now();
          if (firstChunkAt === null || now - lastProgressAt >= 1000) {
            firstChunkAt = firstChunkAt ?? now;
            lastProgressAt = now;
            live.emit<ProgressEvent>({ name: "mining.request.progress", model: requestedModel, firstChunkAt, chunks, streamedChars } as never);
          }
        },
        flush() {
          finish(
            gateway.toObservation({
              observed: observer.result(),
              requestedModel,
              environment,
              clientType,
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
        clientType,
        occurredAt: new Date(),
        latencyMs: Date.now() - startedAt,
      }),
      upstream.status,
    );

    return new Response(text, { status: upstream.status, headers: responseHeaders });
  }

  /** Model discovery and other reads. Transparent; produces no usage evidence. */
  async function GET(
    request: NextRequest,
    context: { params: Promise<Record<string, string | string[]>> },
  ) {
    const params = await context.params;
    const path = (params.path ?? []) as string[];
    const auth = await authenticateMiner(
      readPresentedToken(request.headers),
      await resolveMinerStore(),
    );
    if (!auth.ok) {
      return error(401, "authentication_error", "Invalid USAGE miner credential.");
    }
    const violation = routeBindingViolation(auth.identity, options.surface, params);
    if (violation) return error(403, "permission_error", violation);

    const resolved = await resolveGateway(auth.identity.userId, params);
    if (resolved instanceof Response) return resolved;
    const { gateway, credential } = resolved;

    const call = gateway.buildUpstreamCall(
      {
        path,
        headers: request.headers,
        body: null,
        rawBody: "",
        attribution: { user: auth.identity.userId, tags: [] },
      },
      credential,
    );

    const upstream = await fetch(`${call.url}${request.nextUrl.search}`, {
      headers: call.headers,
      cache: "no-store",
    });

    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: gateway.sanitizeResponseHeaders(upstream.headers),
    });
  }

  return { POST, GET };
}
