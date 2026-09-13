import type { NextRequest } from "next/server";
import { authenticateMiner, createSupabaseMinerStore } from "@/lib/miner/credentials";
import { readPresentedToken } from "@/lib/miner/token";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { defaultComputeGateway } from "@/lib/compute/registry";
import { protocolForEpoch } from "@/lib/protocol/schedule";
import { epochIdForDate } from "@/lib/domain/epoch";
import { listMiningProviders } from "@/lib/providers/catalog";

/**
 * Miner status and configuration.
 *
 * The whole miner API surface, deliberately: a miner authenticates, learns
 * where to route and what is supported, and reports that it is alive. It has no
 * way to submit usage, and there must never be one -- token counts, cost, proof
 * status, protocol compute and points are all derived by USAGE infrastructure
 * from what USAGE itself observed. A miner that could report its own numbers
 * could mint its own rewards.
 *
 * Nothing secret is returned. Not the gateway key, not the signing key, not the
 * miner's own token.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function resolveStore() {
  if (!isSupabaseConfigured()) return null;
  const { createAdminSupabase } = await import("@/lib/supabase/admin");
  return createSupabaseMinerStore(createAdminSupabase());
}

export async function GET(request: NextRequest) {
  const store = await resolveStore();
  const auth = await authenticateMiner(readPresentedToken(request.headers), store);

  if (!auth.ok) {
    return Response.json(
      { state: "unauthenticated", reason: auth.reason },
      { status: 401, headers: { "cache-control": "no-store" } },
    );
  }

  // A successful status check is a liveness signal, and the only thing a miner
  // is trusted to tell us about itself.
  if (store && auth.identity.credentialId !== "dev-miner") {
    await store.touch(auth.identity.credentialId).catch(() => undefined);
  }

  const gateway = defaultComputeGateway();
  return Response.json(
    {
      state: "active",
      miner: { name: auth.identity.name },
      routing: {
        // Relative on purpose: the miner already knows which host it reached.
        endpoint: "/api/gateway/anthropic",
        protocol: "anthropic-messages",
        gateway: gateway.id,
      },
      // The protocol governing TODAY'S epoch. A deploy-time constant stayed
      // dev-v1 after the beta-v2 cutover and told every miner the wrong rule.
      protocol: todayProtocolForMiner(),
      providers: listMiningProviders().map((provider) => provider.slug),
      privacy: {
        recorded: ["model", "token_counts", "timestamps"],
        neverRecorded: ["prompts", "responses", "tool_arguments", "source_code"],
      },
    },
    { headers: { "cache-control": "no-store" } },
  );
}

function todayProtocolForMiner(): { version: string; network: string; scoringVersion: string } {
  const today = protocolForEpoch(epochIdForDate(new Date()));
  return { version: today.version, network: today.network, scoringVersion: today.scoringVersion };
}
