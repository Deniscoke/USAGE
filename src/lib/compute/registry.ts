import { listProviders } from "@/lib/providers/catalog";
import type { ComputeGateway } from "./gateway";
import { vercelComputeGateway } from "./vercel-gateway";

/**
 * Gateway registry.
 *
 * One implementation exists today. The registry is not premature: it is what
 * makes "which gateway carried this request" a lookup rather than an
 * assumption, and it is what the provider catalog's `via` field refers to.
 *
 * Adding OpenRouterGateway or DirectProviderGateway means writing one file and
 * adding one entry. Nothing downstream changes, because everything downstream
 * consumes GatewayObservation.
 */

const GATEWAYS: readonly ComputeGateway[] = [vercelComputeGateway];

export function listComputeGateways(): readonly ComputeGateway[] {
  return GATEWAYS;
}

export function getComputeGateway(id: string): ComputeGateway | null {
  return GATEWAYS.find((gateway) => gateway.id === id) ?? null;
}

/**
 * The gateway that carries miner traffic today.
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
 * cannot claim routed mining "via" a gateway that was never implemented.
 */
export function unresolvedGatewayReferences(): string[] {
  const missing = new Set<string>();
  for (const provider of listProviders()) {
    for (const method of Object.values(provider.methods)) {
      if (method.via && !getComputeGateway(method.via)) missing.add(method.via);
    }
  }
  return [...missing];
}
