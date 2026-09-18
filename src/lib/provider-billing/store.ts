import type { BillingScope } from "./github";
import type { NormalizedBillingRow, PeriodKind, StoredBillingRow, UsageUpsertPlan } from "./normalize";

/**
 * Persistence the provider-billing lane needs, as an interface so the domain
 * logic stays framework-free: production implements it over the service-role
 * Supabase client (supabase-store.ts), tests over PGlite SQL. Every method is
 * a server-side write path; no client can reach any of them.
 */

export type BillingAccountStatus = "connected" | "degraded" | "needs_reauth" | "revoked";

export interface BillingAccount {
  id: string;
  userId: string;
  provider: "github";
  principalId: string;
  login: string | null;
  billingScope: BillingScope;
  status: BillingAccountStatus;
  permissionState: string;
  tokenSecretId: string | null;
  secretBackend: "vault" | "aes" | null;
  accessExpiresAt: string | null;
  refreshExpiresAt: string | null;
  lastSyncAt: string | null;
  lastSuccessAt: string | null;
  lastManualSyncAt: string | null;
  lastErrorClass: string | null;
}

export interface BillingAccountPatch {
  login?: string | null;
  billingScope?: BillingScope;
  status?: BillingAccountStatus;
  permissionState?: string;
  tokenSecretId?: string | null;
  secretBackend?: "vault" | "aes" | null;
  accessExpiresAt?: string | null;
  refreshExpiresAt?: string | null;
  apiVersion?: string;
  lastSyncAt?: string;
  lastSuccessAt?: string;
  lastErrorClass?: string | null;
  disconnectedAt?: string | null;
}

export interface SnapshotInput {
  accountId: string;
  provider: string;
  principalId: string;
  requestKey: string;
  year: number;
  month: number;
  day: number | null;
  queryFilters: Record<string, string>;
  apiVersion: string;
  httpStatus: number;
  fetchedAt: string;
  responseSha256: string;
  responseText: string;
}

export interface BillingStore {
  getAccount(accountId: string): Promise<BillingAccount | null>;
  getAccountForUser(userId: string, provider: "github"): Promise<BillingAccount | null>;
  findAccountByPrincipal(provider: "github", principalId: string): Promise<BillingAccount | null>;
  /** Throws PrincipalTakenError on a unique violation. */
  insertAccount(input: {
    userId: string;
    provider: "github";
    principalId: string;
    login: string;
    tokenSecretId: string;
    secretBackend: "vault" | "aes";
    accessExpiresAt: string | null;
    refreshExpiresAt: string | null;
    apiVersion: string;
  }): Promise<BillingAccount>;
  updateAccount(accountId: string, patch: BillingAccountPatch, now: string): Promise<void>;
  /** Take the sync lease if free or expired. */
  acquireLease(accountId: string, now: string, until: string): Promise<boolean>;
  releaseLease(accountId: string): Promise<void>;
  /** Record a manual refresh if the last one is older than `notAfter`. */
  claimManualSync(accountId: string, now: string, notAfter: string): Promise<boolean>;
  /** Insert, or return the existing identical snapshot. Never updates. */
  recordSnapshot(input: SnapshotInput): Promise<{ id: string; inserted: boolean }>;
  loadPeriodRows(accountId: string, periodKind: PeriodKind, periodStart: string): Promise<StoredBillingRow[]>;
  applyUsagePlan(input: {
    accountId: string;
    plan: UsageUpsertPlan;
    snapshotId: string;
    now: string;
  }): Promise<void>;
  /** Accounts the scheduled sync should visit, least recently synced first. */
  listAccountsForScheduledSync(limit: number): Promise<string[]>;
  createOAuthRequest(input: { state: string; userId: string; providerSlug: string; codeVerifier: string }): Promise<void>;
  /**
   * Consume a pending authorization atomically: it must match the state, the
   * provider, the SIGNED-IN user, be unexpired and unconsumed. A replay, a
   * state minted for someone else, or an expired one returns null.
   */
  consumeOAuthRequest(input: { state: string; userId: string; providerSlug: string; now: string }): Promise<{ codeVerifier: string } | null>;
}

export class PrincipalTakenError extends Error {
  constructor() {
    super("That GitHub account is already connected to another USAGE account.");
    this.name = "PrincipalTakenError";
  }
}

export type { NormalizedBillingRow };
