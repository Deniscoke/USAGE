/**
 * Starting credit on the shared route.
 *
 * Everybody who signs in gets a small amount of USAGE's money to talk with
 * before they have connected anything. It is a grant, not a balance somebody
 * paid in: it is the same for every account, it never grows, and when it is
 * gone the honest next step is to connect a paid provider of their own.
 *
 * There is no credits table. The grant is a constant and the spend is the
 * sum of what this account has already cost on USAGE's funded gateways,
 * read from the persisted units -- so the number the chat shows is derived
 * from the same rows everything else is measured from, and cannot drift
 * from them. A top-up bought with real money will need a ledger of its own,
 * and with it the payments, invoices and VAT that make it real; that is a
 * later decision, and nothing here pretends otherwise.
 */

export const DEFAULT_STARTING_CREDIT_MICROS = 500_000; // $0.50 per account, once

export interface CreditDecision {
  grantMicros: number;
  spentMicros: number;
  remainingMicros: number;
  allowed: boolean;
}

export function startingCreditMicros(raw: string | undefined = process.env.USAGE_CHAT_STARTING_CREDIT_MICROS): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : DEFAULT_STARTING_CREDIT_MICROS;
}

export function creditDecision(input: { grantMicros: number; spentLifetimeMicros: number }): CreditDecision {
  const grant = Math.max(0, Math.floor(input.grantMicros));
  const spent = Math.max(0, Math.floor(input.spentLifetimeMicros));
  const remaining = Math.max(0, grant - spent);
  return {
    grantMicros: grant,
    spentMicros: spent,
    remainingMicros: remaining,
    // A reply may cost up to its whole length, so the last cent is allowed to
    // go a little negative on the books; the daily request budget keeps that
    // from repeating.
    allowed: remaining > 0,
  };
}
