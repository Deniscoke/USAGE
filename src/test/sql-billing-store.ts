import type { SecretStore, StoredSecretRef } from "@/lib/secrets/store";
import { decryptSecret, encryptSecret, generateEncryptionKey, secretHint } from "@/lib/secrets/crypto";
import type { ProviderBillingAccountRow, ProviderBillingUsageRow } from "@/lib/supabase/database.types";
import { ACCOUNT_COLUMNS, accountFromRow, patchToRow, storedFromUsageRow, usageRowValues } from "@/lib/provider-billing/rows";
import { PrincipalTakenError, type BillingStore } from "@/lib/provider-billing/store";
import type { TestDb } from "./pg";

/**
 * BillingStore over raw SQL, as `service_role`, for exercising the provider
 * billing lane against a real Postgres (PGlite). Same statements, same
 * constraints and triggers as production; only the client differs.
 */
export function createSqlBillingStore(db: TestDb): BillingStore {
  type AccountSelect = Parameters<typeof accountFromRow>[0];
  const one = async (query: string, params: unknown[]) => {
    const rows = await db.asServiceRole<AccountSelect>(query, params);
    return rows[0] ? accountFromRow(normalizeTimes(rows[0])) : null;
  };

  return {
    getAccount: (id) => one(`select ${ACCOUNT_COLUMNS} from provider_billing_accounts where id = $1`, [id]),
    getAccountForUser: (userId, provider) =>
      one(`select ${ACCOUNT_COLUMNS} from provider_billing_accounts where user_id = $1 and provider = $2`, [userId, provider]),
    findAccountByPrincipal: (provider, principalId) =>
      one(`select ${ACCOUNT_COLUMNS} from provider_billing_accounts where provider = $1 and provider_principal_id = $2`, [
        provider,
        principalId,
      ]),

    async insertAccount(input) {
      try {
        const row = await one(
          `insert into provider_billing_accounts
             (user_id, provider, provider_principal_id, provider_login, token_secret_id, secret_backend,
              access_token_expires_at, refresh_token_expires_at, api_version, status)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'connected') returning ${ACCOUNT_COLUMNS}`,
          [
            input.userId,
            input.provider,
            input.principalId,
            input.login,
            input.tokenSecretId,
            input.secretBackend,
            input.accessExpiresAt,
            input.refreshExpiresAt,
            input.apiVersion,
          ],
        );
        return row!;
      } catch (error) {
        if (/unique|duplicate/i.test(String(error))) throw new PrincipalTakenError();
        throw error;
      }
    },

    async updateAccount(accountId, patch, now) {
      const row = patchToRow(patch, now) as Record<string, unknown>;
      const columns = Object.keys(row);
      const sets = columns.map((c, i) => `${c} = $${i + 2}`).join(", ");
      await db.asServiceRole(`update provider_billing_accounts set ${sets} where id = $1`, [accountId, ...columns.map((c) => row[c])]);
    },

    async acquireLease(accountId, now, until) {
      const rows = await db.asServiceRole(
        `update provider_billing_accounts set sync_lease_until = $3
          where id = $1 and (sync_lease_until is null or sync_lease_until < $2) returning id`,
        [accountId, now, until],
      );
      return rows.length === 1;
    },

    async releaseLease(accountId) {
      await db.asServiceRole(`update provider_billing_accounts set sync_lease_until = null where id = $1`, [accountId]);
    },

    async claimManualSync(accountId, now, notAfter) {
      const rows = await db.asServiceRole(
        `update provider_billing_accounts set last_manual_sync_at = $2
          where id = $1 and (last_manual_sync_at is null or last_manual_sync_at < $3) returning id`,
        [accountId, now, notAfter],
      );
      return rows.length === 1;
    },

    async recordSnapshot(input) {
      const inserted = await db.asServiceRole<{ id: string }>(
        `insert into provider_billing_snapshots
           (account_id, provider, principal_id, request_key, period_year, period_month, period_day, query_filters,
            api_version, http_status, fetched_at, response_sha256, response_text)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         on conflict (account_id, request_key, response_sha256) do nothing
         returning id`,
        [
          input.accountId,
          input.provider,
          input.principalId,
          input.requestKey,
          input.year,
          input.month,
          input.day,
          JSON.stringify(input.queryFilters),
          input.apiVersion,
          input.httpStatus,
          input.fetchedAt,
          input.responseSha256,
          input.responseText,
        ],
      );
      if (inserted[0]) return { id: inserted[0].id, inserted: true };
      const [existing] = await db.asServiceRole<{ id: string }>(
        `select id from provider_billing_snapshots where account_id = $1 and request_key = $2 and response_sha256 = $3`,
        [input.accountId, input.requestKey, input.responseSha256],
      );
      return { id: existing.id, inserted: false };
    },

    async loadPeriodRows(accountId, periodKind, periodStart) {
      const rows = await db.asServiceRole<ProviderBillingUsageRow>(
        `select *, period_start::text as period_start from provider_billing_usage
          where account_id = $1 and period_kind = $2 and period_start = $3`,
        [accountId, periodKind, periodStart],
      );
      return rows.map(storedFromUsageRow);
    },

    async applyUsagePlan({ accountId, plan, snapshotId, now }) {
      for (const row of plan.inserts) {
        const values = usageRowValues(row);
        const record: Record<string, unknown> = {
          account_id: accountId,
          provider: row.provider,
          principal_id: row.principalId,
          billing_scope: row.billingScope,
          period_kind: row.periodKind,
          period_start: row.periodStart,
          product: row.product,
          sku: row.sku,
          model: row.model,
          unit_type: row.unitType,
          ...values,
          first_snapshot_id: snapshotId,
          current_snapshot_id: snapshotId,
        };
        const cols = Object.keys(record);
        await db.asServiceRole(
          `insert into provider_billing_usage (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")})`,
          cols.map((c) => record[c]),
        );
      }
      for (const update of plan.updates) {
        const record: Record<string, unknown> = {
          ...usageRowValues(update.row),
          revision: update.revision,
          current_snapshot_id: snapshotId,
          withdrawn_at: null,
          updated_at: now,
        };
        const cols = Object.keys(record);
        await db.asServiceRole(
          `update provider_billing_usage set ${cols.map((c, i) => `${c} = $${i + 3}`).join(", ")} where id = $1 and account_id = $2`,
          [update.id, accountId, ...cols.map((c) => record[c])],
        );
      }
      for (const withdrawal of plan.withdrawals) {
        await db.asServiceRole(
          `update provider_billing_usage set withdrawn_at = $3, revision = $4, current_snapshot_id = $5, updated_at = $3
            where id = $1 and account_id = $2`,
          [withdrawal.id, accountId, now, withdrawal.revision, snapshotId],
        );
      }
    },

    async listAccountsForScheduledSync(limit) {
      const rows = await db.asServiceRole<{ id: string }>(
        `select id from provider_billing_accounts where status in ('connected','degraded')
          order by last_sync_at asc nulls first limit $1`,
        [limit],
      );
      return rows.map((r) => r.id);
    },

    async createOAuthRequest(input) {
      await db.asServiceRole(
        `insert into provider_oauth_requests (state, user_id, provider_slug, code_verifier) values ($1,$2,$3,$4)`,
        [input.state, input.userId, input.providerSlug, input.codeVerifier],
      );
    },

    async consumeOAuthRequest(input) {
      const rows = await db.asServiceRole<{ code_verifier: string }>(
        `update provider_oauth_requests set consumed_at = $4
          where state = $1 and provider_slug = $2 and user_id = $3 and consumed_at is null and expires_at > $4
          returning code_verifier`,
        [input.state, input.providerSlug, input.userId, input.now],
      );
      return rows[0] ? { codeVerifier: rows[0].code_verifier } : null;
    },
  };
}

function normalizeTimes<T extends Record<string, unknown>>(row: T): T {
  const out: Record<string, unknown> = { ...row };
  for (const [key, value] of Object.entries(out)) {
    if (value instanceof Date) out[key] = value.toISOString();
  }
  return out as T;
}

/** AES secret store over provider_secrets, with a throwaway key. */
export function createSqlSecretStore(db: TestDb): SecretStore {
  const key = Buffer.from(generateEncryptionKey(), "base64");
  return {
    backend: "aes",
    async create({ userId, secret }): Promise<StoredSecretRef> {
      const [row] = await db.asServiceRole<{ id: string }>(
        `insert into provider_secrets (user_id, ciphertext, hint, backend) values ($1,$2,$3,'aes') returning id`,
        [userId, encryptSecret(secret, key), secretHint(secret)],
      );
      return { id: row.id, backend: "aes", hint: secretHint(secret) };
    },
    async read({ id, userId }) {
      const [row] = await db.asServiceRole<{ ciphertext: string }>(
        `select ciphertext from provider_secrets where id = $1 and user_id = $2`,
        [id, userId],
      );
      if (!row) throw new Error("No such secret.");
      return decryptSecret(row.ciphertext, key);
    },
    async update({ id, userId, secret }) {
      await db.asServiceRole(`update provider_secrets set ciphertext = $3, hint = $4, rotated_at = now() where id = $1 and user_id = $2`, [
        id,
        userId,
        encryptSecret(secret, key),
        secretHint(secret),
      ]);
    },
    async delete({ id, userId }) {
      await db.asServiceRole(`delete from provider_secrets where id = $1 and user_id = $2`, [id, userId]);
    },
  };
}

export type { ProviderBillingAccountRow };
