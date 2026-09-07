import { toIntegration, type ProviderIntegration } from "./adapter";
import { demoGatewayAdapter } from "./demo/gateway";
import { demoLocalCliAdapter } from "./demo/local-cli";
import { demoProviderAdapter } from "./demo/provider-api";
import { vercelGatewayAdapter } from "./vercel-gateway/adapter";

/**
 * Adapter registry.
 *
 * Adding a real provider means adding one adapter file and one entry here.
 * Nothing downstream changes, because everything downstream only ever sees
 * NormalizedUsageRecord.
 */
const INTEGRATIONS: readonly ProviderIntegration[] = [
  toIntegration(demoProviderAdapter),
  toIntegration(demoGatewayAdapter),
  toIntegration(demoLocalCliAdapter),
  toIntegration(vercelGatewayAdapter),
];

export function listIntegrations(): readonly ProviderIntegration[] {
  return INTEGRATIONS;
}

/** Integrations USAGE can fetch history from. Observation-mode ones are pushed to. */
export function listPullIntegrations(): readonly ProviderIntegration[] {
  return INTEGRATIONS.filter((integration) => integration.ingestionMode === "pull");
}

export function getIntegration(provider: string): ProviderIntegration {
  const integration = INTEGRATIONS.find((i) => i.provider === provider);
  if (!integration) throw new Error(`No adapter registered for provider: ${provider}`);
  return integration;
}
