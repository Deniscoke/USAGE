import type { MinerRouteEntry } from "@/lib/miner/routes";

/**
 * Which way a chat message travels, and whether it can earn.
 *
 * The same three-step rule the miner applies, in the same order, so a person
 * sees one story whichever surface they use:
 *
 *   1. their own connection, when the server's verdict is ELIGIBLE -- the only
 *      route that earns, so it goes first even though USAGE's shared key would
 *      be free for them
 *   2. USAGE's shared key, measured and attributed to their account, HELD --
 *      USAGE paid for it, so it is proven compute that earns nothing, exactly
 *      like the miner's fallback gateway; capped per account per day
 *   3. their own connection when it is merely HELD -- their credit, their
 *      provider's limits, still nothing earned
 *
 * Nothing here decides eligibility. `rewardStatus` is the server's verdict on
 * the connection, carried through unchanged.
 */

export type SharedGatewayId = "openrouter" | "vercel-ai-gateway";

export type ChatRoute =
  | {
      kind: "provider";
      connectionId: string;
      label: string;
      providerFamily: string;
      rewardStatus: "eligible" | "held";
      reason: string;
    }
  | {
      kind: "shared";
      gatewayId: SharedGatewayId;
      label: string;
      rewardStatus: "held";
      reason: string;
    }
  | { kind: "none"; reason: string };

export const SHARED_ROUTE_REASON =
  "USAGE's own key paid for this, so it is measured and attributed to you but cannot earn. Connect a paid provider of your own to earn.";

export function pickChatRoute(input: {
  routes: readonly MinerRouteEntry[];
  /** The shared gateway this deployment has a key for, or null. */
  sharedGateway: SharedGatewayId | null;
}): ChatRoute {
  // Chat speaks the OpenAI-compatible wire format; the Anthropic surface of
  // the same connection is the same connection and adds nothing here.
  const chat = input.routes.filter((route) => route.surface === "openai_compatible");

  const eligible = chat.find((route) => route.rewardStatus === "eligible");
  if (eligible) return own(eligible, "eligible");

  if (input.sharedGateway) {
    return {
      kind: "shared",
      gatewayId: input.sharedGateway,
      label: input.sharedGateway === "openrouter" ? "USAGE shared route (OpenRouter)" : "USAGE shared route (Vercel AI Gateway)",
      rewardStatus: "held",
      reason: SHARED_ROUTE_REASON,
    };
  }

  const held = chat.find((route) => route.rewardStatus === "held");
  if (held) return own(held, "held");

  return {
    kind: "none",
    reason: "No route can carry chat yet. Connect OpenRouter by signing in, or ask the operator to configure the shared route.",
  };
}

function own(route: MinerRouteEntry, rewardStatus: "eligible" | "held"): ChatRoute {
  return {
    kind: "provider",
    connectionId: route.connectionId,
    label: route.label,
    providerFamily: route.providerFamily,
    rewardStatus,
    reason: route.miningLabel,
  };
}

/** Which shared gateway is configured. OpenRouter first: it states cost per request. */
export function configuredSharedGateway(env: Record<string, string | undefined> = process.env): SharedGatewayId | null {
  if (env.OPENROUTER_API_KEY?.trim()) return "openrouter";
  if (env.AI_GATEWAY_API_KEY?.trim()) return "vercel-ai-gateway";
  return null;
}
