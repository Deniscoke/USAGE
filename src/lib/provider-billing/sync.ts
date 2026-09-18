import type { SecretStore } from "@/lib/secrets/store";
import {
  classifyBillingScope,
  fetchGithubUsage,
  fetchGithubUser,
  GITHUB_API_VERSION,
  GithubAuthError,
  refreshGithubTokens,
  type BillingScope,
  type GithubAppConfig,
  type GithubFailureClass,
  type GithubTokenSet,
  type UsagePeriod,
} from "./github";
import { DuplicateIdentityError, normalizeGithubUsage, periodStartFor, planUsageUpsert } from "./normalize";
import type { BillingAccount, BillingAccountPatch, BillingAccountStatus, BillingStore } from "./store";

/**
 * One sync of one provider billing account.
 *
 *   1. Take a short lease, so two syncs never race a rotating refresh token.
 *   2. Make sure the access token is fresh: refresh when it expires within five
 *      minutes; GitHub rotates the refresh token, so the new pair is written in
 *      ONE secret update before it is used.
 *   3. GET /user and check the numeric id is the one this account was
 *      connected with. A different id is refused outright -- the grant now
 *      belongs to somebody else. A changed login is simply adopted: it is only
 *      a path value.
 *   4. Fetch the month aggregate, then the days the mode calls for, and
 *      normalize each 200 into current rows (snapshot first, always kept).
 *
 * Failure never deletes anything. It changes the account's status and error
 * class and leaves every previous snapshot and row exactly as it was.
 *
 * No function here logs. Tokens exist only in local variables and the secret
 * store.
 */

export type SyncMode = "connect" | "scheduled" | "manual";

/** Refresh when the access token has less than this left. */
export const REFRESH_MARGIN_MS = 5 * 60 * 1000;
/** Manual "Refresh now" at most this often per account. */
export const MANUAL_SYNC_INTERVAL_MS = 5 * 60 * 1000;
export const SYNC_LEASE_MS = 2 * 60 * 1000;

export type SyncOutcome =
  | "ok"
  | "busy"
  | "rate_limited"
  | "not_connected"
  | "needs_reauth"
  | "principal_mismatch"
  | "degraded";

export interface SyncResult {
  outcome: SyncOutcome;
  status: BillingAccountStatus | null;
  billingScope: BillingScope | null;
  requests: number;
  snapshotsRecorded: number;
  rowsInserted: number;
  rowsUpdated: number;
  rowsWithdrawn: number;
  errorClass: string | null;
}

export interface SyncDeps {
  store: BillingStore;
  secrets: SecretStore;
  config: GithubAppConfig;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

// ------------------------------------------------------------ token bundle

interface TokenBundle {
  v: 1;
  accessToken: string;
  refreshToken: string | null;
}

export function serializeTokenBundle(tokens: Pick<GithubTokenSet, "accessToken" | "refreshToken">): string {
  return JSON.stringify({ v: 1, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken } satisfies TokenBundle);
}

export function parseTokenBundle(text: string): TokenBundle | null {
  try {
    const value = JSON.parse(text) as Partial<TokenBundle>;
    if (value.v !== 1 || typeof value.accessToken !== "string" || !value.accessToken) return null;
    return {
      v: 1,
      accessToken: value.accessToken,
      refreshToken: typeof value.refreshToken === "string" && value.refreshToken ? value.refreshToken : null,
    };
  } catch {
    return null;
  }
}

// --------------------------------------------------------------- planning

function utcParts(date: Date): { year: number; month: number; day: number } {
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

export interface PlannedRequests {
  months: UsagePeriod[];
  /** Days, grouped under the month aggregate they belong to. */
  days: UsagePeriod[];
}

/**
 * What to ask GitHub for. Rate-conscious: the current month aggregate always;
 * days only where they can still move.
 *
 *   connect    every day of the current month up to today
 *   scheduled  today and the two days before (freshness is undocumented, so
 *              recent days are provisional and re-polled); in the first three
 *              days of a month, last month's aggregate too, so its final
 *              corrections land
 *   manual     today and yesterday
 */
export function planSyncRequests(mode: SyncMode, now: Date): PlannedRequests {
  const today = utcParts(now);
  const months: UsagePeriod[] = [{ year: today.year, month: today.month }];
  const lookback = mode === "connect" ? today.day - 1 : mode === "scheduled" ? 2 : 1;
  const days: UsagePeriod[] = [];
  for (let back = lookback; back >= 0; back -= 1) {
    const d = utcParts(addDays(now, -back));
    days.push({ year: d.year, month: d.month, day: d.day });
  }
  if (mode === "scheduled" && today.day <= 3) {
    const previous = utcParts(addDays(new Date(Date.UTC(today.year, today.month - 1, 1)), -1));
    months.push({ year: previous.year, month: previous.month });
  }
  // The current month is always fetched first: a throttled or failing older
  // period must never stop the month that matters most from syncing.
  // A day in a month we did not plan an aggregate for pulls that aggregate in.
  for (const day of days) {
    if (!months.some((m) => m.year === day.year && m.month === day.month)) {
      months.push({ year: day.year, month: day.month });
    }
  }
  return { months, days };
}

// ------------------------------------------------------------------- sync

function emptyResult(outcome: SyncOutcome, account: BillingAccount | null, errorClass: string | null = null): SyncResult {
  return {
    outcome,
    status: account?.status ?? null,
    billingScope: account?.billingScope ?? null,
    requests: 0,
    snapshotsRecorded: 0,
    rowsInserted: 0,
    rowsUpdated: 0,
    rowsWithdrawn: 0,
    errorClass,
  };
}

function isExpiring(iso: string | null, now: Date, margin: number): boolean {
  if (!iso) return false;
  return new Date(iso).getTime() - now.getTime() < margin;
}

export async function syncBillingAccount(
  deps: SyncDeps,
  input: { accountId: string; mode: SyncMode },
): Promise<SyncResult> {
  const clock = deps.now ?? (() => new Date());
  const { store } = deps;
  const startedAt = clock();
  const nowIso = startedAt.toISOString();

  const account = await store.getAccount(input.accountId);
  if (!account || account.status === "revoked") return emptyResult("not_connected", account);
  if (account.status === "needs_reauth") return emptyResult("needs_reauth", account, account.lastErrorClass);

  if (input.mode === "manual") {
    const notAfter = new Date(startedAt.getTime() - MANUAL_SYNC_INTERVAL_MS).toISOString();
    if (!(await store.claimManualSync(account.id, nowIso, notAfter))) return emptyResult("rate_limited", account);
  }

  if (!(await store.acquireLease(account.id, nowIso, new Date(startedAt.getTime() + SYNC_LEASE_MS).toISOString()))) {
    return emptyResult("busy", account);
  }

  try {
    return await runSync(deps, account, input.mode, startedAt);
  } finally {
    await store.releaseLease(account.id);
  }
}

async function runSync(deps: SyncDeps, account: BillingAccount, mode: SyncMode, startedAt: Date): Promise<SyncResult> {
  const { store, secrets, config } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const nowIso = startedAt.toISOString();
  const result = emptyResult("ok", account);

  const finish = async (outcome: SyncOutcome, patch: BillingAccountPatch): Promise<SyncResult> => {
    await store.updateAccount(account.id, { lastSyncAt: nowIso, apiVersion: GITHUB_API_VERSION, ...patch }, nowIso);
    return {
      ...result,
      outcome,
      status: patch.status ?? account.status,
      billingScope: patch.billingScope ?? account.billingScope,
      errorClass: patch.lastErrorClass === undefined ? result.errorClass : patch.lastErrorClass,
    };
  };
  const needsReauth = (errorClass: string) =>
    finish(errorClass === "principal_mismatch" ? "principal_mismatch" : "needs_reauth", {
      status: "needs_reauth",
      lastErrorClass: errorClass,
    });
  const degraded = (errorClass: string) => finish("degraded", { status: "degraded", lastErrorClass: errorClass });

  // ---- tokens
  if (!account.tokenSecretId) return needsReauth("no_credential");
  let bundle: TokenBundle | null = null;
  try {
    bundle = parseTokenBundle(await secrets.read({ id: account.tokenSecretId, userId: account.userId }));
  } catch {
    return degraded("secret_unavailable");
  }
  if (!bundle) return needsReauth("no_credential");
  let tokens: TokenBundle = bundle;
  let refreshed = false;

  const refresh = async (): Promise<"ok" | "reauth" | "temporary" | "persist_failed"> => {
    if (!tokens.refreshToken) return "reauth";
    if (account.refreshExpiresAt && new Date(account.refreshExpiresAt).getTime() <= startedAt.getTime()) return "reauth";
    let next: GithubTokenSet;
    try {
      next = await refreshGithubTokens({ config, refreshToken: tokens.refreshToken, fetchImpl, now: startedAt });
    } catch (error) {
      if (error instanceof GithubAuthError && (error.code === "unreachable" || error.code === "malformed")) return "temporary";
      return "reauth";
    }
    // The old pair is dead upstream from this moment. One write, both tokens.
    try {
      await secrets.update({ id: account.tokenSecretId!, userId: account.userId, secret: serializeTokenBundle(next) });
    } catch {
      return "persist_failed";
    }
    tokens = { v: 1, accessToken: next.accessToken, refreshToken: next.refreshToken };
    refreshed = true;
    await store.updateAccount(
      account.id,
      { accessExpiresAt: next.accessExpiresAt, refreshExpiresAt: next.refreshExpiresAt },
      nowIso,
    );
    return "ok";
  };
  const refreshFailure = (outcome: "reauth" | "temporary" | "persist_failed") =>
    outcome === "temporary"
      ? degraded("refresh_temporary")
      : needsReauth(outcome === "persist_failed" ? "token_persist_failed" : "refresh_rejected");

  if (isExpiring(account.accessExpiresAt, startedAt, REFRESH_MARGIN_MS)) {
    const outcome = await refresh();
    if (outcome !== "ok") return refreshFailure(outcome);
  }

  // ---- identity
  result.requests += 1;
  let user = await fetchGithubUser({ accessToken: tokens.accessToken, fetchImpl });
  if (user.kind === "error" && user.failure === "auth_expired" && !refreshed) {
    const outcome = await refresh();
    if (outcome !== "ok") return refreshFailure(outcome);
    result.requests += 1;
    user = await fetchGithubUser({ accessToken: tokens.accessToken, fetchImpl });
  }
  if (user.kind === "error") {
    if (user.failure === "auth_expired") return needsReauth("auth_revoked");
    return degraded(`identity_${user.failure}`);
  }
  if (user.id !== account.principalId) return needsReauth("principal_mismatch");
  const login = user.login;

  // ---- billing
  const plan = planSyncRequests(mode, startedAt);
  let billingScope: BillingScope = account.billingScope;
  let permissionState = account.permissionState;
  let lastFailure: GithubFailureClass | null = null;
  let currentMonthOk = false;
  const monthsWithItems = new Set<string>();
  // planSyncRequests always puts the current month first.
  const currentMonthKey = `${plan.months[0]!.year}-${plan.months[0]!.month}`;

  const ingest = async (period: UsagePeriod): Promise<{ ok: boolean; items: number; failure?: GithubFailureClass }> => {
    result.requests += 1;
    const fetched = await fetchGithubUsage({ login, accessToken: tokens.accessToken, period, fetchImpl });
    if (fetched.kind === "error") return { ok: false, items: 0, failure: fetched.failure };

    const snapshot = await store.recordSnapshot({
      accountId: account.id,
      provider: "github",
      principalId: account.principalId,
      requestKey: fetched.request.requestKey,
      year: period.year,
      month: period.month,
      day: period.day ?? null,
      queryFilters: {},
      apiVersion: fetched.request.apiVersion,
      httpStatus: 200,
      fetchedAt: clockIso(deps),
      responseSha256: fetched.sha256,
      responseText: fetched.text,
    });
    if (snapshot.inserted) result.snapshotsRecorded += 1;

    let rows;
    try {
      rows = normalizeGithubUsage({ response: fetched.response, principalId: account.principalId, period });
    } catch (error) {
      if (error instanceof DuplicateIdentityError) return { ok: false, items: 0, failure: "malformed" };
      throw error;
    }
    const { kind, start } = periodStartFor(period);
    const existing = await store.loadPeriodRows(account.id, kind, start);
    const upsert = planUsageUpsert(existing, rows);
    if (upsert.inserts.length + upsert.updates.length + upsert.withdrawals.length > 0) {
      await store.applyUsagePlan({ accountId: account.id, plan: upsert, snapshotId: snapshot.id, now: nowIso });
    }
    result.rowsInserted += upsert.inserts.length;
    result.rowsUpdated += upsert.updates.length;
    result.rowsWithdrawn += upsert.withdrawals.length;
    return { ok: true, items: rows.length };
  };

  for (const month of plan.months) {
    const outcome = await ingest(month);
    const key = `${month.year}-${month.month}`;
    const isCurrent = key === currentMonthKey;
    if (outcome.ok) {
      if (outcome.items > 0) monthsWithItems.add(key);
      if (isCurrent) {
        currentMonthOk = true;
        billingScope = classifyBillingScope({ kind: "ok", itemCount: outcome.items }, billingScope);
        permissionState = "plan:read";
      }
    } else {
      lastFailure = outcome.failure ?? "temporary";
      if (isCurrent) {
        billingScope = classifyBillingScope({ kind: "error", failure: lastFailure }, billingScope);
        if (lastFailure === "permission_insufficient") permissionState = "insufficient";
      }
      if (lastFailure === "auth_expired") return needsReauth("auth_revoked");
      // Nothing more will succeed this run on a hard or throttled failure.
      if (lastFailure === "rate_limited" || lastFailure === "temporary") break;
    }
  }

  // Days only for months that have self-billed items: an empty or failed
  // aggregate means the days are empty too, and asking costs rate limit.
  if (lastFailure !== "rate_limited" && lastFailure !== "temporary") {
    for (const day of plan.days) {
      if (!monthsWithItems.has(`${day.year}-${day.month}`)) continue;
      const outcome = await ingest(day);
      if (!outcome.ok) {
        lastFailure = outcome.failure ?? "temporary";
        if (lastFailure === "auth_expired") return needsReauth("auth_revoked");
        break;
      }
    }
  }

  const patch: BillingAccountPatch = { login, billingScope, permissionState };
  if (currentMonthOk) patch.lastSuccessAt = nowIso;
  if (lastFailure === null) {
    return finish("ok", { ...patch, status: "connected", lastErrorClass: null });
  }
  // A missing permission or an unsupported account is a steady state, not an
  // outage: the connection works, the evidence is just not there to read.
  if (lastFailure === "permission_insufficient" || lastFailure === "unavailable") {
    return finish("ok", { ...patch, status: "connected", lastErrorClass: lastFailure });
  }
  return finish("degraded", { ...patch, status: "degraded", lastErrorClass: lastFailure });
}

function clockIso(deps: SyncDeps): string {
  return (deps.now ?? (() => new Date()))().toISOString();
}
