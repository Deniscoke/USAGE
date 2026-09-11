import { NextRequest } from "next/server";
import { createGatewayRoute } from "@/lib/gateway/handler";
import { resolveConnectionGateway } from "@/lib/gateway/connection-gateway";
import { authenticateWebSession } from "@/lib/chat/auth";
import { sanitizeChatBody } from "@/lib/chat/body";
import { CHAT_SYSTEM_PROMPT } from "@/lib/chat/system-prompt";
import { systemPromptWith } from "@/lib/chat/preferences";
import { configuredSharedGateway, pickChatRoute } from "@/lib/chat/route";
import { fundedUsageToday } from "@/lib/chat/funded-usage";
import { buildMinerRoutes } from "@/lib/miner/routes";
import { openRouterComputeGateway } from "@/lib/compute/openrouter-gateway";
import { vercelComputeGateway } from "@/lib/compute/vercel-gateway";
import { gatewayCredential } from "@/lib/compute/registry";
import { epochIdForDate } from "@/lib/domain/epoch";
import { pricingForEpoch } from "@/lib/protocol/schedule";
import { getPricingSnapshot } from "@/lib/pricing/compute";
import { createConnectionStore } from "@/lib/providers/connections";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { isSupabaseConfigured } from "@/lib/supabase/env";

/**
 * A chat message, sent through the USAGE Gateway.
 *
 * Two doors into the same trust boundary. `?via=provider:<id>` routes through
 * the person's own connection; `?via=shared` routes through USAGE's own key.
 * Both end in `createGatewayRoute`, which is where trust, observation, signing
 * and ingestion are decided -- so a chat reply is measured exactly the way a
 * Claude Code request from the miner is, and lands in the same tables with
 * the same verdicts.
 *
 * What this file adds in front of that boundary, and why:
 *
 *   - the body is rebuilt from an allowlist, because a browser tab is not a
 *     miner and must not be able to send arbitrary fields to a provider
 *   - the shared route is refused to anyone who has a route of their own that
 *     earns, so USAGE's money is never spent where the person's own would
 *     have earned them something
 *   - the shared route is capped per account per day, in money and in
 *     requests, before the provider is contacted
 *   - the shared route accepts only models with an approved protocol price,
 *     so every unit it produces is at least priceable
 *
 * Nothing here decides whether a unit earns. That is the reward policy's, and
 * for the shared route the answer is already known: HELD.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const PATH = ["chat", "completions"];

function openAiError(status: number, type: string, message: string): Response {
  return new Response(JSON.stringify({ error: { message, type, code: null, param: null } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const authenticate = () => authenticateWebSession();

/** The person's own connection: the universal provider route, session-authenticated. */
const providerChat = createGatewayRoute({
  clientType: "web-chat",
  error: openAiError,
  surface: "openai_compatible",
  authenticate,
  resolve: ({ userId, params }) =>
    resolveConnectionGateway({ connectionId: String(params.connectionId ?? ""), userId, error: openAiError }),
});

/** USAGE's own key: the same funded gateways the miner falls back to. */
const sharedChat = createGatewayRoute({
  clientType: "web-chat",
  error: openAiError,
  authenticate,
  async resolve() {
    const id = configuredSharedGateway();
    if (!id) return openAiError(503, "api_error", "The shared route is not configured on this deployment.");
    const credential = gatewayCredential(id);
    if (!credential) return openAiError(503, "api_error", "The shared route is not configured on this deployment.");
    return { gateway: id === "openrouter" ? openRouterComputeGateway : vercelComputeGateway, credential };
  },
});

export async function POST(request: NextRequest): Promise<Response> {
  const auth = await authenticateWebSession();
  if (!auth.ok) return openAiError(401, "authentication_error", "Sign in to chat.");
  if (!isSupabaseConfigured()) return openAiError(503, "api_error", "USAGE is not configured.");
  const userId = auth.identity.userId;

  const via = request.nextUrl.searchParams.get("via") ?? "";
  const target = parseVia(via);
  if (!target) return openAiError(400, "invalid_request_error", "Choose a route.");

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return openAiError(400, "invalid_request_error", "The request body must be JSON.");
  }

  // The user's own standing instructions, appended to the server's prompt in
  // a labelled section. It can shape the assistant; it cannot replace a rule.
  const systemPrompt = systemPromptWith(CHAT_SYSTEM_PROMPT, (raw as { preferences?: unknown } | null)?.preferences);

  const admin = createAdminSupabase();
  const store = createConnectionStore(admin);

  if (target.kind === "shared") {
    // Their own earning route must be used instead: that is the rule the
    // panel shows, enforced where the money is spent.
    const connections = await store.list(userId);
    const routes = buildMinerRoutes(connections, request.nextUrl.origin);
    const chosen = pickChatRoute({ routes, sharedGateway: configuredSharedGateway() });
    if (chosen.kind !== "shared") {
      return openAiError(409, "invalid_request_error", "You have a route of your own that earns; the shared route is refused.");
    }

    const usage = await fundedUsageToday(admin, userId);
    if (!usage.allowed) {
      const message =
        usage.refusal === "credit"
          ? "Your starting credit is used up. Connect a paid provider of your own to keep going."
          : "Today's allowance on the shared route is used up. It resets at midnight UTC, or connect a paid provider of your own.";
      return openAiError(429, "rate_limit_error", message);
    }

    const snapshot = getPricingSnapshot(pricingForEpoch(epochIdForDate(new Date())));
    const allowedModels = new Set((snapshot?.prices ?? []).map((price) => price.model));
    const sanitized = sanitizeChatBody(raw, {
      allowedModels,
      maxOutputTokens: 1024,
      includeCost: chosen.gatewayId === "openrouter",
      systemPrompt,
    });
    if (!sanitized.ok) return openAiError(400, "invalid_request_error", sanitized.message);

    return sharedChat.POST(rebuild(request, sanitized.body), { params: Promise.resolve({ path: PATH }) });
  }

  // Their own connection. The resolver refuses anything that is not theirs.
  const connections = await store.list(userId);
  const own = connections.find((c) => c.id === target.connectionId);
  if (!own) return openAiError(404, "invalid_request_error", "That connection is not yours or does not exist.");

  const sanitized = sanitizeChatBody(raw, {
    allowedModels: null,
    maxOutputTokens: 4096,
    includeCost: (own.providerFamily ?? own.provider) === "openrouter",
    systemPrompt,
  });
  if (!sanitized.ok) return openAiError(400, "invalid_request_error", sanitized.message);

  return providerChat.POST(rebuild(request, sanitized.body), {
    params: Promise.resolve({ connectionId: target.connectionId, path: PATH }),
  });
}

function parseVia(via: string): { kind: "shared" } | { kind: "provider"; connectionId: string } | null {
  if (via === "shared") return { kind: "shared" };
  const match = /^provider:([0-9a-f-]{36})$/i.exec(via);
  return match ? { kind: "provider", connectionId: match[1]! } : null;
}

/** The same request, carrying only the body this route rebuilt. */
function rebuild(request: NextRequest, body: unknown): NextRequest {
  const headers = new Headers(request.headers);
  headers.set("content-type", "application/json");
  headers.delete("content-length");
  return new NextRequest(request.url, { method: "POST", headers, body: JSON.stringify(body) });
}
