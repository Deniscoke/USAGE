import type { SettlementStore } from "@/lib/db/settlement";
import type { EpochParticipant, EpochState, RewardEpoch } from "@/lib/domain/epoch";
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

    async loadEpochState(epochId): Promise<EpochState | null> {
      const rows = await db.asServiceRole<{ state: EpochState }>(
        `select state from reward_epochs where id = $1`,
        [epochId],
      );
      return rows[0]?.state ?? null;
    },

    async upsertEpoch(epoch: RewardEpoch, networkScore, epochKind) {
      await db.asServiceRole(
        `insert into reward_epochs
           (id, starts_at, ends_at, reward_pool_points, scoring_version, network_score,
            epoch_kind, state, finalizing_at, settled_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8,
                 case when $8 in ('finalizing', 'settled') then now() end,
                 case when $8 = 'settled' then now() end)
         on conflict (id) do update
           set network_score = excluded.network_score,
               state = excluded.state,
               finalizing_at = coalesce(reward_epochs.finalizing_at, excluded.finalizing_at),
               settled_at = coalesce(reward_epochs.settled_at, excluded.settled_at)`,
        [
          epoch.id,
          epoch.startsAt,
          epoch.endsAt,
          epoch.rewardPoolPoints,
          epoch.scoringVersion,
          networkScore,
          epochKind,
          epoch.state,
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

    async markSettled(epochId, userIds) {
      if (userIds.length === 0) return;
      // By epoch assignment, not by timestamp: a carried-forward event settles
      // with the epoch it was actually assigned to.
      await db.asServiceRole(
        `update usage_events set economic_status = 'settled'
         where user_id = any($1::uuid[])
           and economic_status = 'eligible'
           and epoch_id = $2`,
        [userIds, epochId],
      );
    },
  };
}
