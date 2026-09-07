import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import type { EpochParticipant, RewardEpoch } from "@/lib/domain/epoch";
import type { SettlementStore } from "./settlement";

/** SettlementStore over the Supabase service-role client. */
export function createSupabaseSettlementStore(
  admin: SupabaseClient<Database>,
): SettlementStore {
  function fail(context: string, error: { message: string } | null): void {
    if (error) throw new Error(`${context}: ${error.message}`);
  }

  return {
    async loadEpochScores(day, algorithmVersion): Promise<EpochParticipant[]> {
      const { data, error } = await admin
        .from("score_records")
        .select("user_id, points")
        .eq("day", day)
        .eq("algorithm_version", algorithmVersion)
        .gt("points", 0);
      fail("loadEpochScores", error);
      return (data ?? []).map((row) => ({ userId: row.user_id, score: Number(row.points) }));
    },

    async upsertEpoch(epoch: RewardEpoch, networkScore, epochKind) {
      const { error } = await admin.from("reward_epochs").upsert(
        {
          id: epoch.id,
          starts_at: epoch.startsAt,
          ends_at: epoch.endsAt,
          reward_pool_points: epoch.rewardPoolPoints,
          scoring_version: epoch.scoringVersion,
          network_score: networkScore,
          epoch_kind: epochKind,
          settled_at: new Date().toISOString(),
        },
        { onConflict: "id" },
      );
      fail("upsertEpoch", error);
    },

    async creditAllocations(epochId, entries) {
      if (entries.length === 0) return 0;

      const { error: allocationError } = await admin.from("reward_allocations").upsert(
        entries.map((entry) => ({
          epoch_id: epochId,
          user_id: entry.userId,
          score: entry.score,
          network_share: entry.networkShare,
          points: entry.points,
        })),
        { onConflict: "epoch_id,user_id", ignoreDuplicates: true },
      );
      fail("creditAllocations", allocationError);

      const credits = entries.filter((entry) => entry.points > 0);
      if (credits.length === 0) return 0;

      // The unique allocation id is what makes a repeated settlement a no-op.
      const { data, error } = await admin
        .from("usage_point_ledger")
        .upsert(
          credits.map((entry) => ({
            user_id: entry.userId,
            epoch_id: epochId,
            allocation_id: entry.allocationId,
            amount: entry.points,
            reason: "epoch_settlement",
          })),
          { onConflict: "allocation_id", ignoreDuplicates: true },
        )
        .select("id");
      fail("creditLedger", error);
      return data?.length ?? 0;
    },

    async markSettled(day, userIds) {
      if (userIds.length === 0) return;
      const from = `${day}T00:00:00.000Z`;
      const to = new Date(new Date(from).getTime() + 86_400_000).toISOString();

      const { error } = await admin
        .from("usage_events")
        .update({ economic_status: "settled" })
        .in("user_id", [...userIds])
        .eq("economic_status", "eligible")
        .gte("occurred_at", from)
        .lt("occurred_at", to);
      fail("markSettled", error);
    },
  };
}
