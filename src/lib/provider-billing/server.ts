import "server-only";

import { createAdminSupabase } from "@/lib/supabase/admin";
import { resolveSecretStore } from "@/lib/secrets/store";
import { githubAppConfig } from "./github";
import { createSupabaseBillingStore } from "./supabase-store";
import type { SyncDeps } from "./sync";

/**
 * Wiring for the route handlers: the service-role store, the secret store
 * (Vault in production) and the GitHub App configuration. Null when the
 * deployment has no GitHub App configured -- callers say so and do nothing.
 */
export async function createGithubBillingDeps(): Promise<SyncDeps | null> {
  const config = githubAppConfig();
  if (!config) return null;
  const admin = createAdminSupabase();
  return { store: createSupabaseBillingStore(admin), secrets: await resolveSecretStore(admin), config };
}

export function githubBillingConfigured(): boolean {
  return githubAppConfig() !== null;
}

/**
 * Same-origin check for the POST routes. Session cookies are SameSite=Lax, so
 * a cross-site form cannot carry them anyway; this refuses one outright.
 */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin === null) return true;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}
