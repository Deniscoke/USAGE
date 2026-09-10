import type { ProviderProtocolId } from "@/lib/protocols/protocol";

/**
 * Wire surfaces (M16C0).
 *
 * PROVIDER IDENTITY and WIRE PROTOCOL are different things. OpenRouter is one
 * provider, but it answers on two wire surfaces: an OpenAI-compatible
 * `/v1/chat/completions` (Codex, generic clients) and an Anthropic-compatible
 * `/v1/messages` (Claude Code). Before this module a connection carried one
 * protocol, so the owner's eligible OpenRouter OAuth connection -- stored as
 * `openai_compatible` -- was invisible to Claude Code, which speaks only the
 * Anthropic format, and the miner fell back to USAGE's own held gateway.
 *
 * A surface is a ROUTING capability. It does not create a second connection,
 * a second credential, a second funding context or a second reward identity:
 * both surfaces resolve to the same `provider_connections` row, the same
 * server-held secret and the same `connection:<id>` gateway id, so a proof
 * produced on either surface is economically one and the same connection.
 */

export type WireSurface = "openai_compatible" | "anthropic_compatible";

/** Provider families whose one credential is valid on both wire surfaces. */
const MULTI_SURFACE_FAMILIES: ReadonlySet<string> = new Set(["openrouter"]);

/**
 * The surfaces one connection can be routed on.
 *
 * The stored protocol is always first: that is the surface the connection was
 * validated on. A second surface is added only for a provider family USAGE
 * has verified against current documentation (OpenRouter's Anthropic Messages
 * endpoint, docs checked 2026-09-11). Custom endpoints never gain a surface
 * they were not validated on.
 */
export function wireSurfacesFor(input: {
  provider: string;
  providerFamily?: string | null;
  protocol: ProviderProtocolId | null;
}): WireSurface[] {
  if (input.protocol !== "openai_compatible" && input.protocol !== "anthropic_compatible") return [];
  const surfaces: WireSurface[] = [input.protocol];
  const family = (input.providerFamily ?? input.provider ?? "").toLowerCase();
  if (MULTI_SURFACE_FAMILIES.has(family)) {
    for (const extra of ["openai_compatible", "anthropic_compatible"] as const) {
      if (!surfaces.includes(extra)) surfaces.push(extra);
    }
  }
  return surfaces;
}

export function isMultiSurfaceFamily(family: string | null | undefined): boolean {
  return MULTI_SURFACE_FAMILIES.has((family ?? "").toLowerCase());
}

/**
 * Where a tool sends traffic for a connection on a given surface.
 *
 * The stored protocol keeps the universal route. The additional Anthropic
 * surface lives under `/anthropic` so a client can never pick a surface by
 * shaping a body: the URL decides the wire format, and the server decides
 * whether the connection is allowed on it.
 */
export function surfaceRoutePath(connectionId: string, surface: WireSurface, storedProtocol: ProviderProtocolId | null): string {
  const base = `/api/gateway/provider/${connectionId}`;
  if (surface === "anthropic_compatible" && storedProtocol !== "anthropic_compatible") return `${base}/anthropic`;
  return base;
}

export const SURFACE_LABELS: Record<WireSurface, string> = {
  openai_compatible: "OpenAI-compatible",
  anthropic_compatible: "Anthropic-compatible",
};
