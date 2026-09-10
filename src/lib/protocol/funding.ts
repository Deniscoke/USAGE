import type { ProviderConnectionRow } from "@/lib/supabase/database.types";
import type { FundingEvidence } from "./economic-unit";

/**
 * Funding evidence for a request, from the connection that carried it.
 *
 * Read from what the PROVIDER told USAGE about the account at connection time
 * (`account_context`, written by the OAuth callback from OpenRouter's
 * `GET /api/v1/key`), never from anything in the request. An API-key
 * connection has no account context, so it yields `unknown` -- which the
 * verification policy holds. That is the honest answer: a key alone says
 * nothing about whether the account behind it has ever paid.
 *
 * Staleness is recorded, not hidden. An account that buys credit after
 * connecting keeps reading as free-tier until the context is refreshed, which
 * errs on the side of holding a reward rather than paying one.
 */
export function fundingEvidenceForConnection(
  connection: Pick<ProviderConnectionRow, "provider" | "auth_method" | "account_context" | "validated_at">,
): FundingEvidence | null {
  const context = connection.account_context;
  if (!context || typeof context !== "object") return null;

  if (connection.provider === "openrouter" && typeof context.is_free_tier === "boolean") {
    return {
      class: context.is_free_tier ? "free_tier_account" : "paid_account",
      basis: "openrouter:/api/v1/key#is_free_tier",
      observedAt: connection.validated_at ?? null,
    };
  }
  return null;
}
