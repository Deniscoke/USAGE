import type { SettlementStore } from "@/lib/db/settlement";
import type { EpochParticipant, RewardEpoch } from "@/lib/domain/epoch";
import type { TestDb } from "./pg";

/** SettlementStore over raw SQL, for exercising settlement against real Postgres. */
export function createSqlSettlementStore(db: TestDb): SettlementStore {
  return {
    async loadEpochScores(day, algorithmVersion): Promise<EpochParticipant[]> {
      const rows = await db.asServiceRole<{ user_id: string; points: string }>(
        `select user_id, points::text from score_records
         where day = $1 and algorithm_version = $2 and points > 0`,
        [day, algorithmVersion],
      );
      return rows.map((row) => ({ userId: row.user_id, score: Number(row.points) }));
    },

    async upsertEpoch(epoch: RewardEpoch, networkScore, epochKind) {
      await db.asServiceRole(
        `insert into reward_epochs
           (id, starts_at, ends_at, reward_pool_points, scoring_version, network_score, epoch_kind)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (id) do update
           set network_score = excluded.network_score, settled_at = now()`,
        [
          epoch.id,
          epoch.startsAt,
          epoch.endsAt,
          epoch.rewardPoolPoints,
          epoch.scoringVersion,
          networkScore,
          epochKind,
        ],
      );
    },

    async creditAllocations(epochId, entries) {
      let credited = 0;
      for (const entry of entries) {
        await db.asServiceRole(
          `insert into reward_allocations (epoch_id, user_id, score, network_share, points)
           values ($1, $2, $3, $4, $5)
           on conflict (epoch_id, user_id) do nothing`,
          [epochId, entry.userId, entry.score, entry.networkShare, entry.points],
        );

        if (entry.points <= 0) continue;
        // The unique allocation id is what makes a second settlement a no-op.
        const inserted = await db.asServiceRole<{ id: string }>(
          `insert into usage_point_ledger (user_id, epoch_id, allocation_id, amount, reason)
           values ($1, $2, $3, $4, 'epoch_settlement')
           on conflict (allocation_id) do nothing
           returning id`,
          [entry.userId, epochId, entry.allocationId, entry.points],
        );
        credited += inserted.length;
      }
      return credited;
    },

    async markSettled(day, userIds) {
      if (userIds.length === 0) return;
      await db.asServiceRole(
        `update usage_events set economic_status = 'settled'
         where user_id = any($1::uuid[])
           and economic_status = 'eligible'
           and occurred_at >= $2::date and occurred_at < ($2::date + interval '1 day')`,
        [userIds, day],
      );
    },
  };
}
