import { listProviders, findProvider } from "@/lib/providers/catalog";
import type { ComputeGateway } from "./gateway";
import { openRouterComputeGateway, OPENROUTER_GATEWAY_ID } from "./openrouter-gateway";
import { vercelComputeGateway, VERCEL_COMPUTE_GATEWAY_ID } from "./vercel-gateway";

/**
 * Gateway registry and routing policy.
 *
 * Two real implementations now, which is the point of the milestone: nothing
 * downstream of `GatewayObservation` knows which one ran, and neither does the
 * mining engine. Adding a third means writing one file and adding one entry.
 */

const GATEWAYS: readonly ComputeGateway[] = [vercelComputeGateway, openRouterComputeGateway];

export function listComputeGateways(): readonly ComputeGateway[] {
  return GATEWAYS;
}

export function getComputeGateway(id: string): ComputeGateway | null {
  return GATEWAYS.find((gateway) => gateway.id === id) ?? null;
}

/**
 * The credential each gateway needs, by gateway id.
 *
 * Server-only, always. A gateway with no credential is not usable, and saying
 * so plainly is better than discovering it as a 401 mid-request.
 */
export function gatewayCredential(id: string): string | null {
  if (id === VERCEL_COMPUTE_GATEWAY_ID) return process.env.AI_GATEWAY_API_KEY?.trim() || null;
  if (id === OPENROUTER_GATEWAY_ID) return process.env.OPENROUTER_API_KEY?.trim() || null;
  return null;
}

export function isGatewayConfigured(id: string): boolean {
  return gatewayCredential(id) !== null;
}

/**
 * Deterministic routing policy.
 *
 * Deliberately not a router. It answers one question -- "which gateway should
 * carry this provider's traffic?" -- from the registry order, and it does NOT
 * retry across gateways at runtime.
 *
 * That restraint is the important part. Failing over mid-request would change
 * which credential paid, which account the usage appears under, and which
 * upstream terms applied. A proof records the gateway that actually executed
 * it, so a silent switch would make that record a guess rather than evidence.
 */
export interface RoutingPolicy {
  providerSlug: string;
  preferred: string;
  fallback: readonly string[];
}

export function routingPolicyFor(providerSlug: string): RoutingPolicy | null {
  const provider = findProvider(providerSlug);
  if (!provider || provider.routes.length === 0) return null;

  // Catalog order is the preference order, so preference is declared data
  // rather than a rule hidden in code.
  const [preferred, ...rest] = provider.routes.map((route) => route.gateway);
  return { providerSlug, preferred, fallback: rest };
}

export type GatewaySelection =
  | { ok: true; gateway: ComputeGateway; credential: string; reason: "preferred" | "fallback" }
  | { ok: false; reason: "unknown_provider" | "not_configured" };

/**
 * Choose the gateway for a provider, at request time, before anything is sent.
 *
 * Fallback is used only when the preferred gateway has no credential at all --
 * a configuration fact known up front, not a failure discovered mid-flight.
 */
export function selectGateway(providerSlug: string): GatewaySelection {
  const policy = routingPolicyFor(providerSlug);
  if (!policy) return { ok: false, reason: "unknown_provider" };

  const candidates: { id: string; reason: "preferred" | "fallback" }[] = [
    { id: policy.preferred, reason: "preferred" },
    ...policy.fallback.map((id) => ({ id, reason: "fallback" as const })),
  ];

  for (const candidate of candidates) {
    const gateway = getComputeGateway(candidate.id);
    const credential = gatewayCredential(candidate.id);
    if (gateway && credential) {
      return { ok: true, gateway, credential, reason: candidate.reason };
    }
  }
  return { ok: false, reason: "not_configured" };
}

/**
 * The gateway that carries Anthropic-protocol miner traffic today.
 *
 * A single default rather than per-request selection: routing choice is a
 * server decision, and letting a client pick its gateway would let it pick how
 * its own usage is observed.
 */
export function defaultComputeGateway(): ComputeGateway {
  return vercelComputeGateway;
}

/**
 * Every gateway the provider catalog names must actually exist.
 *
 * The registry is where the catalog's honesty rule is enforceable: a provider
 * cannot claim a route "via" a gateway that was never implemented.
 */
export function unresolvedGatewayReferences(): string[] {
  const missing = new Set<string>();
  for (const provider of listProviders()) {
    for (const route of provider.routes) {
      if (!getComputeGateway(route.gateway)) missing.add(route.gateway);
    }
  }
  return [...missing];
}
