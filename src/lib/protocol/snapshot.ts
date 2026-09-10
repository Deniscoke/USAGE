import type { UsageEventRow } from "@/lib/supabase/database.types";

/**
 * Snapshot readiness. NOT a snapshot.
 *
 * No token exists and none is being built here. This module states, as code
 * that tests can hold to, what a future settled-points snapshot would need
 * from each row and which rows it must refuse -- so the data written today is
 * already in the shape that day would require, and so nobody can later argue
 * that a tracked-only or held row "counted".
 */

/** What a snapshot row must be able to name for every settled allocation. */
export const SNAPSHOT_REQUIRED_FIELDS = [
  "allocation_id",
  "user_id",
  "epoch_id",
  "settled_points",
  "scoring_version",
  "reward_policy_version",
  "economic_verification_policy_version",
  "proof_reference",
] as const;

export type SnapshotExclusion =
  | "not_confirmed"
  | "reported_only"
  | "reward_not_eligible"
  | "reward_held"
  | "not_priced"
  | "not_settled"
  | "duplicate_or_conflict"
  | "free_or_promotional";

/**
 * Would this usage event be admissible as an input to a settled snapshot?
 *
 * Every rung of the ladder has to hold at once. Local observations never reach
 * this function at all: they live in a table with no economic columns, so
 * "tracked-only", "device-attested-only" and "unmatched telemetry" are excluded
 * by never being candidates.
 */
export function snapshotExclusions(row: UsageEventRow): SnapshotExclusion[] {
  const out: SnapshotExclusion[] = [];
  if (row.verification_status !== "confirmed") out.push("not_confirmed");
  if (row.verification_type === "reported") out.push("reported_only");
  if (row.reward_status !== "eligible") out.push("reward_not_eligible");
  if (row.reward_hold) out.push("reward_held");
  if (row.pricing_status !== "priced" || row.protocol_pricing_version === null) out.push("not_priced");
  if (row.economic_status !== "settled") out.push("not_settled");
  const dedupe = row.raw_metadata?.dedupe_status;
  if (dedupe === "duplicate" || dedupe === "conflict") out.push("duplicate_or_conflict");
  if (row.economic_source_class === "free" || row.economic_source_class === "promotional") {
    out.push("free_or_promotional");
  }
  return out;
}

export function isSnapshotAdmissible(row: UsageEventRow): boolean {
  return snapshotExclusions(row).length === 0;
}
