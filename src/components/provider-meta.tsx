import type { RouteStatus } from "@/lib/providers/catalog";

/**
 * How a capability status is shown.
 *
 * One place, so the coverage table, the provider detail page and onboarding
 * cannot drift into describing the same status three different ways.
 */

export const ROUTE_STATUS_LABEL: Record<RouteStatus, string> = {
  live: "Live",
  tested: "Tested",
  configured: "Configured",
  available: "Available",
  coming_soon: "Coming soon",
  unsupported: "—",
};

export const ROUTE_STATUS_COLOR: Record<RouteStatus, string> = {
  live: "var(--verified)",
  tested: "var(--routed)",
  configured: "var(--routed)",
  available: "var(--routed)",
  coming_soon: "var(--faint)",
  unsupported: "var(--faint)",
};

/** One sentence a user can act on, per status. */
export const ROUTE_STATUS_MEANING: Record<RouteStatus, string> = {
  live: "Exercised against the real provider in production.",
  tested: "Implemented and covered by tests; no live run yet.",
  configured: "Implemented, with a credential configured.",
  available: "Implemented and usable.",
  coming_soon: "Declared, not implemented yet.",
  unsupported: "Not available by this route.",
};
