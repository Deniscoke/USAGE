import { anthropicCompatibleProtocol } from "./anthropic-compatible";
import { openAiCompatibleProtocol } from "./openai-compatible";
import type { ProviderProtocol, ProviderProtocolId } from "./protocol";

/**
 * Protocol registry.
 *
 * Two routable protocols cover most of the AI industry, because most providers
 * chose one of two wire formats. `usage_import` and `custom_unsupported` are
 * declared but not routable: an import is not a request USAGE executes, and an
 * unsupported custom protocol is a connection USAGE can record but not observe.
 */

const ROUTABLE: readonly ProviderProtocol[] = [
  openAiCompatibleProtocol,
  anthropicCompatibleProtocol,
];

export function listRoutableProtocols(): readonly ProviderProtocol[] {
  return ROUTABLE;
}

export function getProtocol(id: string): ProviderProtocol | null {
  return ROUTABLE.find((protocol) => protocol.id === id) ?? null;
}

export function isRoutableProtocol(id: string): id is ProviderProtocolId {
  return getProtocol(id) !== null;
}

/** Every protocol the product can talk about, routable or not. */
export const PROTOCOL_LABELS: Record<ProviderProtocolId, string> = {
  openai_compatible: "OpenAI compatible",
  anthropic_compatible: "Anthropic compatible",
  usage_import: "USAGE import API",
  custom_unsupported: "Custom adapter",
};

export const PROTOCOL_BLURBS: Record<ProviderProtocolId, string> = {
  openai_compatible:
    "Works with any provider exposing an OpenAI-style /v1/chat/completions endpoint.",
  anthropic_compatible:
    "Works with any provider exposing an Anthropic-style /v1/messages endpoint.",
  usage_import:
    "Import usage a provider already recorded, through its own authenticated admin API.",
  custom_unsupported:
    "Something else. Tell us about it — USAGE cannot route it yet, and will not pretend to.",
};
