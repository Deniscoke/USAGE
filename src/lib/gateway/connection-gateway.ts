import { protocolGateway } from "@/lib/compute/protocol-gateway";
import { fundingEvidenceForConnection } from "@/lib/protocol/funding";
import { createConnectionStore, ConnectionError } from "@/lib/providers/connections";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { SsrfError } from "@/lib/net/ssrf";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import type { ResolvedGateway } from "./handler";

/**
 * A user's own connection, resolved into a gateway the trust boundary can use.
 *
 * Lifted out of the universal provider route so the web chat and the miner
 * route share it byte for byte. The connection id selects a row the SERVER
 * validated and owns; the caller never supplies a base URL, so it cannot aim
 * USAGE at an address of its choosing. Ownership, revocation, protocol and a
 * fresh SSRF check all happen inside `resolveForRequest`.
 *
 * A connection that is not yours is indistinguishable from one that does not
 * exist, so probing for other users' ids reveals nothing.
 */
export async function resolveConnectionGateway(input: {
  connectionId: string;
  userId: string;
  error(status: number, type: string, message: string): Response;
}): Promise<ResolvedGateway | Response> {
  const { connectionId, userId, error } = input;
  if (!isSupabaseConfigured()) return error(503, "api_error", "USAGE is not configured.");
  if (!connectionId) return error(400, "invalid_request_error", "A connection id is required.");

  const store = createConnectionStore(createAdminSupabase());

  try {
    const resolved = await store.resolveForRequest(connectionId, userId);
    return {
      gateway: protocolGateway({
        protocol: resolved.protocol,
        connectionId,
        baseUrl: resolved.baseUrl,
        providerSlug: resolved.connection.provider,
        endpointTrusted: resolved.endpointTrusted,
        pathPrefix: resolved.pathPrefix,
        providerFamily: resolved.providerFamily,
        // What the provider told USAGE about this account when it was
        // connected. Nothing in the request can change it.
        funding: fundingEvidenceForConnection(resolved.connection),
      }),
      credential: resolved.credential,
      onOutcome: (outcome) => {
        void store.recordOutcome(connectionId, outcome).catch(() => undefined);
      },
    };
  } catch (caught) {
    if (caught instanceof ConnectionError) {
      const status = caught.code === "not_found" ? 404 : caught.code === "revoked" ? 403 : 400;
      return error(status, "invalid_request_error", caught.message);
    }
    if (caught instanceof SsrfError) return error(400, "invalid_request_error", caught.message);
    return error(500, "api_error", "That connection could not be used.");
  }
}
