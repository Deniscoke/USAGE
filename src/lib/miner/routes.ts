import type { ConnectionSummaryView } from "@/lib/providers/connections";
import { SURFACE_LABELS, surfaceRoutePath, wireSurfacesFor, type WireSurface } from "@/lib/providers/surfaces";

/**
 * What `/api/miner/config` tells a device about its routes (M16C0).
 *
 * One entry per (connection, surface). The OpenRouter OAuth connection
 * therefore appears twice -- once OpenAI-compatible for Codex, once
 * Anthropic-compatible for Claude Code -- with the SAME connection id, the
 * same reward verdict and the same label, because it is the same connection.
 * Nothing here is a credential; the route URL plus the device's own token (or
 * a route session minted from it) is all a tool ever holds.
 */

export interface MinerRouteEntry {
  connectionId: string;
  label: string;
  protocol: WireSurface;
  surface: WireSurface;
  surfaceLabel: string;
  url: string;
  /** ROUTE capability (routable, measurable, priced). Not the reward. */
  miningEligibility: string;
  /** The server's economic verdict. What every surface shows. */
  rewardStatus: "eligible" | "held" | "ineligible" | "unavailable";
  miningLabel: string;
  /** Registry family, so a tool can say "OpenRouter" rather than a label. */
  providerFamily: string;
}

export function buildMinerRoutes(
  connections: readonly ConnectionSummaryView[],
  origin: string,
  input: { providerFamilyOf?: (connection: ConnectionSummaryView) => string | null } = {},
): MinerRouteEntry[] {
  const usable = connections.filter(
    (connection) =>
      connection.revokedAt === null &&
      connection.protocol !== null &&
      ["active", "limited", "pending_pricing"].includes(connection.status),
  );

  const routes: MinerRouteEntry[] = [];
  for (const connection of usable) {
    const family = input.providerFamilyOf?.(connection) ?? connection.provider;
    const surfaces = wireSurfacesFor({ provider: connection.provider, providerFamily: family, protocol: connection.protocol });
    for (const surface of surfaces) {
      routes.push({
        connectionId: connection.id,
        label: connection.displayName,
        protocol: surface,
        surface,
        surfaceLabel: SURFACE_LABELS[surface],
        url: `${origin}${surfaceRoutePath(connection.id, surface, connection.protocol)}`,
        miningEligibility: connection.miningEligibility,
        rewardStatus: connection.view.mining.outcome,
        miningLabel: `Mining ${connection.view.mining.label.toLowerCase()} — ${connection.view.mining.reason}`,
        providerFamily: family ?? connection.provider,
      });
    }
  }
  return routes;
}

/**
 * The route a tool should use, by REWARD first.
 *
 *   1. an eligible route
 *   2. a held route, only when nothing eligible exists
 *   3. never ineligible/unavailable ahead of either
 *   4. the USAGE-funded fallback only when no connected route can carry the tool
 *
 * Route capability (`eligible_route`) is not reward eligibility; this is the
 * server's copy of the rule the miner applies, so the two cannot drift.
 */
export function preferredRoute<T extends { rewardStatus: MinerRouteEntry["rewardStatus"] }>(routes: readonly T[]): T | null {
  return (
    routes.find((route) => route.rewardStatus === "eligible") ??
    routes.find((route) => route.rewardStatus === "held") ??
    null
  );
}
