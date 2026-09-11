import type { NextRequest } from "next/server";
import { signedInUserId } from "@/lib/chat/auth";
import { configuredSharedGateway, pickChatRoute, type ChatRoute } from "@/lib/chat/route";
import { fundedUsageToday } from "@/lib/chat/funded-usage";
import { buildMinerRoutes } from "@/lib/miner/routes";
import { networkLabel } from "@/lib/miner/identity";
import { CURRENT_MINING_PROTOCOL } from "@/lib/protocol/emission";
import { epochIdForDate } from "@/lib/domain/epoch";
import { pricingForEpoch } from "@/lib/protocol/schedule";
import { getPricingSnapshot } from "@/lib/pricing/compute";
import { createConnectionStore } from "@/lib/providers/connections";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import type { ProviderModelRow } from "@/lib/supabase/database.types";

/**
 * What the chat panel needs before the first message: which way a message
 * would travel, whether it can earn, which models that route offers, and how
 * much of today's shared allowance is left.
 *
 * Read as the signed-in user. The route decision is the server's; the panel
 * displays it and cannot choose another.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ModelOption {
  id: string;
  label: string;
  priced: boolean;
}

const PREFERRED_DEFAULT = "anthropic/claude-sonnet-4.6";

export async function GET(request: NextRequest): Promise<Response> {
  const userId = await signedInUserId();
  if (!userId) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (!isSupabaseConfigured()) return Response.json({ error: "not_configured" }, { status: 503 });

  const admin = createAdminSupabase();
  const store = createConnectionStore(admin);
  const connections = await store.list(userId);
  const routes = buildMinerRoutes(connections, request.nextUrl.origin);
  const route = pickChatRoute({ routes, sharedGateway: configuredSharedGateway() });

  const models = await modelsFor(route, connections.map((c) => ({ id: c.id, definitionId: c.definitionId })), admin);
  const priced = models.filter((m) => m.priced);
  const defaultModel = priced.find((m) => m.id === PREFERRED_DEFAULT)?.id ?? priced[0]?.id ?? models[0]?.id ?? null;

  const cap = route.kind === "shared" ? await fundedUsageToday(admin, userId) : null;

  return Response.json(
    {
      userId,
      route,
      models,
      defaultModel,
      cap: cap
        ? { spentMicros: cap.spentMicros, capMicros: cap.capMicros, requestsToday: cap.requestsToday, requestLimit: cap.requestLimit }
        : null,
      networkLabel: networkLabel(CURRENT_MINING_PROTOCOL.network),
    },
    { headers: { "cache-control": "no-store" } },
  );
}

async function modelsFor(
  route: ChatRoute,
  connections: { id: string; definitionId: string | null }[],
  admin: ReturnType<typeof createAdminSupabase>,
): Promise<ModelOption[]> {
  if (route.kind === "shared") {
    // Only models with an approved protocol price: the shared route spends
    // USAGE's money and every unit it produces must at least be priceable.
    const snapshot = getPricingSnapshot(pricingForEpoch(epochIdForDate(new Date())));
    return (snapshot?.prices ?? []).map((price) => ({ id: price.model, label: price.model, priced: true }));
  }

  if (route.kind === "provider") {
    const definitionId = connections.find((c) => c.id === route.connectionId)?.definitionId ?? null;
    if (!definitionId) return [];
    const { data } = await admin
      .from("provider_models")
      .select("upstream_model_id, display_name, protocol_model_key, status")
      .eq("definition_id", definitionId)
      .not("status", "in", "(disabled,unsupported)");
    const rows = (data ?? []) as Pick<ProviderModelRow, "upstream_model_id" | "display_name" | "protocol_model_key" | "status">[];
    return rows
      .map((row) => ({ id: row.upstream_model_id, label: row.display_name ?? row.upstream_model_id, priced: row.protocol_model_key !== null }))
      .sort((a, b) => Number(b.priced) - Number(a.priced) || a.label.localeCompare(b.label));
  }

  return [];
}
