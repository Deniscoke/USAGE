import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import type { PeriodKind } from "./normalize";
import { ACCOUNT_COLUMNS, accountFromRow, patchToRow, storedFromUsageRow, usageRowValues } from "./rows";
import { PrincipalTakenError, type BillingStore } from "./store";

/**
 * BillingStore over the service-role Supabase client. Server-side sync only:
 * the service role bypasses RLS, so it is never used to serve a read (the
 * dashboard reads through view.ts as the signed-in user).
 *
 * Errors carry our wording plus the database message -- never a token, which
 * this module never sees (tokens live in the secret store).
 */
export function createSupabaseBillingStore(admin: SupabaseClient<Database>): BillingStore {
  const fail = (what: string, message: string): never => {
    throw new Error(`provider billing ${what}: ${message}`);
  };

  return {
    async getAccount(accountId) {
      const { data, error } = await admin.from("provider_billing_accounts").select(ACCOUNT_COLUMNS).eq("id", accountId).maybeSingle();
      if (error) fail("getAccount", error.message);
      return data ? accountFromRow(data) : null;
    },

    async getAccountForUser(userId, provider) {
      const { data, error } = await admin
        .from("provider_billing_accounts")
        .select(ACCOUNT_COLUMNS)
        .eq("user_id", userId)
        .eq("provider", provider)
        .maybeSingle();
      if (error) fail("getAccountForUser", error.message);
      return data ? accountFromRow(data) : null;
    },

    async findAccountByPrincipal(provider, principalId) {
      const { data, error } = await admin
        .from("provider_billing_accounts")
        .select(ACCOUNT_COLUMNS)
        .eq("provider", provider)
        .eq("provider_principal_id", principalId)
        .maybeSingle();
      if (error) fail("findAccountByPrincipal", error.message);
      return data ? accountFromRow(data) : null;
    },

    async insertAccount(input) {
      const { data, error } = await admin
        .from("provider_billing_accounts")
        .insert({
          user_id: input.userId,
          provider: input.provider,
          provider_principal_id: input.principalId,
          provider_login: input.login,
          token_secret_id: input.tokenSecretId,
          secret_backend: input.secretBackend,
          access_token_expires_at: input.accessExpiresAt,
          refresh_token_expires_at: input.refreshExpiresAt,
          api_version: input.apiVersion,
          status: "connected",
        })
        .select(ACCOUNT_COLUMNS)
        .single();
      if (error?.code === "23505") throw new PrincipalTakenError();
      if (error || !data) return fail("insertAccount", error?.message ?? "no row");
      return accountFromRow(data);
    },

    async updateAccount(accountId, patch, now) {
      const { error } = await admin.from("provider_billing_accounts").update(patchToRow(patch, now)).eq("id", accountId);
      if (error) fail("updateAccount", error.message);
    },

    async acquireLease(accountId, now, until) {
      const { data, error } = await admin
        .from("provider_billing_accounts")
        .update({ sync_lease_until: until })
        .eq("id", accountId)
        .or(`sync_lease_until.is.null,sync_lease_until.lt.\"${now}\"`)
        .select("id");
      if (error) fail("acquireLease", error.message);
      return (data ?? []).length === 1;
    },

    async releaseLease(accountId) {
      const { error } = await admin.from("provider_billing_accounts").update({ sync_lease_until: null }).eq("id", accountId);
      if (error) fail("releaseLease", error.message);
    },

    async claimManualSync(accountId, now, notAfter) {
      const { data, error } = await admin
        .from("provider_billing_accounts")
        .update({ last_manual_sync_at: now })
        .eq("id", accountId)
        .or(`last_manual_sync_at.is.null,last_manual_sync_at.lt.\"${notAfter}\"`)
        .select("id");
      if (error) fail("claimManualSync", error.message);
      return (data ?? []).length === 1;
    },

    async recordSnapshot(input) {
      const row = {
        account_id: input.accountId,
        provider: input.provider,
        principal_id: input.principalId,
        request_key: input.requestKey,
        period_year: input.year,
        period_month: input.month,
        period_day: input.day,
        query_filters: input.queryFilters,
        api_version: input.apiVersion,
        http_status: input.httpStatus,
        fetched_at: input.fetchedAt,
        response_sha256: input.responseSha256,
        response_text: input.responseText,
      };
      const { data, error } = await admin
        .from("provider_billing_snapshots")
        .upsert(row, { onConflict: "account_id,request_key,response_sha256", ignoreDuplicates: true })
        .select("id");
      if (error) fail("recordSnapshot", error.message);
      if (data && data.length === 1) return { id: data[0].id, inserted: true };
      const existing = await admin
        .from("provider_billing_snapshots")
        .select("id")
        .eq("account_id", input.accountId)
        .eq("request_key", input.requestKey)
        .eq("response_sha256", input.responseSha256)
        .single();
      if (existing.error || !existing.data) return fail("recordSnapshot", existing.error?.message ?? "no row");
      return { id: existing.data.id, inserted: false };
    },

    async loadPeriodRows(accountId, periodKind: PeriodKind, periodStart) {
      const { data, error } = await admin
        .from("provider_billing_usage")
        .select("*")
        .eq("account_id", accountId)
        .eq("period_kind", periodKind)
        .eq("period_start", periodStart);
      if (error) fail("loadPeriodRows", error.message);
      return (data ?? []).map(storedFromUsageRow);
    },

    async applyUsagePlan({ accountId, plan, snapshotId, now }) {
      if (plan.inserts.length > 0) {
        const { error } = await admin.from("provider_billing_usage").insert(
          plan.inserts.map((row) => ({
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
            ...usageRowValues(row),
            first_snapshot_id: snapshotId,
            current_snapshot_id: snapshotId,
          })),
        );
        if (error) fail("insertUsage", error.message);
      }
      for (const update of plan.updates) {
        const { error } = await admin
          .from("provider_billing_usage")
          .update({
            ...usageRowValues(update.row),
            revision: update.revision,
            current_snapshot_id: snapshotId,
            withdrawn_at: null,
            updated_at: now,
          })
          .eq("id", update.id)
          .eq("account_id", accountId);
        if (error) fail("updateUsage", error.message);
      }
      for (const withdrawal of plan.withdrawals) {
        const { error } = await admin
          .from("provider_billing_usage")
          .update({ withdrawn_at: now, revision: withdrawal.revision, current_snapshot_id: snapshotId, updated_at: now })
          .eq("id", withdrawal.id)
          .eq("account_id", accountId);
        if (error) fail("withdrawUsage", error.message);
      }
    },

    async listAccountsForScheduledSync(limit) {
      const { data, error } = await admin
        .from("provider_billing_accounts")
        .select("id")
        .in("status", ["connected", "degraded"])
        .order("last_sync_at", { ascending: true, nullsFirst: true })
        .limit(limit);
      if (error) fail("listAccountsForScheduledSync", error.message);
      return (data ?? []).map((row) => row.id);
    },

    async createOAuthRequest(input) {
      const { error } = await admin.from("provider_oauth_requests").insert({
        state: input.state,
        user_id: input.userId,
        provider_slug: input.providerSlug,
        code_verifier: input.codeVerifier,
      });
      if (error) fail("createOAuthRequest", error.message);
    },

    async consumeOAuthRequest(input) {
      const { data, error } = await admin
        .from("provider_oauth_requests")
        .update({ consumed_at: input.now })
        .eq("state", input.state)
        .eq("provider_slug", input.providerSlug)
        .eq("user_id", input.userId)
        .is("consumed_at", null)
        .gt("expires_at", input.now)
        .select("code_verifier")
        .maybeSingle();
      if (error) return null;
      return data ? { codeVerifier: data.code_verifier } : null;
    },
  };
}
