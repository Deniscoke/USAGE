/**
 * The three ledgers.
 *
 * They answer three different questions and must never be merged. Merging any
 * two of them is how a metering system quietly becomes a payments system, or
 * how a reward becomes a refund claim.
 *
 *   A. COMPUTE LEDGER   what AI compute happened?
 *                       -> usage_events + proof_records
 *                       -> unit: tokens, and protocol compute value in micro-USD
 *
 *   B. REWARD LEDGER    how many Usage Points were earned?
 *                       -> reward_allocations + usage_point_ledger
 *                       -> unit: whole Usage Points, from a fixed epoch emission
 *
 *   C. PAYMENT LEDGER   who paid for the compute, and with what?
 *                       -> not implemented
 *                       -> unit: micro-USD of real money
 *
 * A future fourth layer (on-chain $USAGE) does not exist. Nothing here mints,
 * transfers, prices or promises a token.
 */

export type LedgerKind = "compute" | "reward" | "payment";

/**
 * Who paid the provider for a unit of compute.
 *
 *   provider_billed   the user's own arrangement with the provider: their key,
 *                     their subscription, their invoice. USAGE only meters it.
 *   usage_credits     (future) the user pre-funded USAGE Compute Credits and
 *                     USAGE paid the upstream provider.
 *   usage_absorbed    USAGE's own gateway budget covered it, as in development.
 *
 * This is recorded for accounting clarity. It has NO effect on mining: the
 * protocol values verified compute, not who was billed for it, and a change in
 * payment mode must never change what a proof earns.
 */
export type ComputePaymentMode = "provider_billed" | "usage_credits" | "usage_absorbed";

/**
 * Compute Credits are NOT Usage Points.
 *
 *   Compute Credits   pre-funded money, denominated in micro-USD, spendable on
 *                     upstream compute. A liability USAGE owes the user.
 *   Usage Points      earned protocol rewards, off-chain and non-transferable,
 *                     with no monetary value and no redemption path.
 *
 * They are different units, in different ledgers, with different legal
 * character. Nothing may convert one into the other, and no code should be
 * written that could.
 */
export interface ComputeCreditBalance {
  userId: string;
  /** Integer micro-USD, like every other money value in USAGE. */
  availableMicros: number;
  currency: "USD";
}

/** Deliberately unimplemented. Present so the distinction is impossible to lose. */
export const COMPUTE_CREDITS_IMPLEMENTED = false;
