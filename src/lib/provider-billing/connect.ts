import { createOAuthState, createPkcePair } from "@/lib/providers/oauth";
import type { SecretStore } from "@/lib/secrets/store";
import {
  buildGithubAuthorizeUrl,
  exchangeGithubCode,
  fetchGithubUser,
  GITHUB_API_VERSION,
  GITHUB_BILLING_OAUTH_SLUG,
  revokeGithubGrant,
  type GithubAppConfig,
  type GithubTokenSet,
} from "./github";
import { PrincipalTakenError, type BillingStore } from "./store";
import { serializeTokenBundle, parseTokenBundle, syncBillingAccount, type SyncResult } from "./sync";

/**
 * Connecting and disconnecting a GitHub billing account.
 *
 * The flow reuses the provider OAuth request table (0013): a random state and
 * a PKCE verifier, stored server-side against the SIGNED-IN user. The callback
 * consumes that row atomically and only for the same signed-in user, so a
 * replayed, expired, missing or someone-else's state is refused before any
 * code is exchanged.
 *
 * Tokens go straight into the secret store as one bundle. They are never put
 * in a URL, a response, a log line or a database column.
 */

/** Path of the callback; the registered GitHub App callback must equal origin + this. */
export const GITHUB_CALLBACK_PATH = "/api/providers/github/callback";

export function githubRedirectUri(origin: string): string {
  return new URL(GITHUB_CALLBACK_PATH, origin).toString();
}

export async function startGithubConnection(input: {
  store: BillingStore;
  config: GithubAppConfig;
  userId: string;
  origin: string;
}): Promise<string> {
  const pkce = createPkcePair();
  const state = createOAuthState();
  await input.store.createOAuthRequest({
    state,
    userId: input.userId,
    providerSlug: GITHUB_BILLING_OAUTH_SLUG,
    codeVerifier: pkce.verifier,
  });
  return buildGithubAuthorizeUrl({
    clientId: input.config.clientId,
    redirectUri: githubRedirectUri(input.origin),
    state,
    codeChallenge: pkce.challenge,
  });
}

export type ConnectError =
  | "state_invalid"
  | "exchange_failed"
  | "identity_failed"
  | "principal_taken"
  | "different_account"
  | "storage_failed";

export type ConnectResult =
  | { ok: true; accountId: string; sync: SyncResult | null }
  | { ok: false; error: ConnectError };

export interface ConnectDeps {
  store: BillingStore;
  secrets: SecretStore;
  config: GithubAppConfig;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export async function completeGithubConnection(
  deps: ConnectDeps,
  input: { sessionUserId: string; state: string | null; code: string | null; origin: string; runInitialSync?: boolean },
): Promise<ConnectResult> {
  const clock = deps.now ?? (() => new Date());
  const { store, secrets, config } = deps;
  if (!input.state || !input.code) return { ok: false, error: "state_invalid" };

  const pending = await store.consumeOAuthRequest({
    state: input.state,
    userId: input.sessionUserId,
    providerSlug: GITHUB_BILLING_OAUTH_SLUG,
    now: clock().toISOString(),
  });
  if (!pending) return { ok: false, error: "state_invalid" };

  let tokens: GithubTokenSet;
  try {
    tokens = await exchangeGithubCode({
      config,
      code: input.code,
      codeVerifier: pending.codeVerifier,
      redirectUri: githubRedirectUri(input.origin),
      fetchImpl: deps.fetchImpl,
      now: clock(),
    });
  } catch {
    return { ok: false, error: "exchange_failed" };
  }

  const user = await fetchGithubUser({ accessToken: tokens.accessToken, fetchImpl: deps.fetchImpl });
  if (user.kind === "error") return { ok: false, error: "identity_failed" };

  // A grant USAGE will not keep is handed back immediately.
  const release = () => revokeGithubGrant({ config, accessToken: tokens.accessToken, fetchImpl: deps.fetchImpl });

  const owner = await store.findAccountByPrincipal("github", user.id);
  if (owner && owner.userId !== input.sessionUserId) {
    await release();
    return { ok: false, error: "principal_taken" };
  }
  const existing = await store.getAccountForUser(input.sessionUserId, "github");
  if (existing && existing.principalId !== user.id) {
    await release();
    return { ok: false, error: "different_account" };
  }

  let secretRef: { id: string; backend: "vault" | "aes" };
  try {
    const created = await secrets.create({
      userId: input.sessionUserId,
      secret: serializeTokenBundle(tokens),
      label: "github billing tokens",
    });
    secretRef = { id: created.id, backend: created.backend };
  } catch {
    await release();
    return { ok: false, error: "storage_failed" };
  }

  let accountId: string;
  const nowIso = clock().toISOString();
  try {
    if (existing) {
      await store.updateAccount(
        existing.id,
        {
          login: user.login,
          status: "connected",
          tokenSecretId: secretRef.id,
          secretBackend: secretRef.backend,
          accessExpiresAt: tokens.accessExpiresAt,
          refreshExpiresAt: tokens.refreshExpiresAt,
          apiVersion: GITHUB_API_VERSION,
          lastErrorClass: null,
          disconnectedAt: null,
        },
        nowIso,
      );
      accountId = existing.id;
      // The previous bundle, if one survived, is superseded.
      if (existing.tokenSecretId && existing.tokenSecretId !== secretRef.id) {
        await secrets.delete({ id: existing.tokenSecretId, userId: existing.userId }).catch(() => undefined);
      }
    } else {
      const account = await store.insertAccount({
        userId: input.sessionUserId,
        provider: "github",
        principalId: user.id,
        login: user.login,
        tokenSecretId: secretRef.id,
        secretBackend: secretRef.backend,
        accessExpiresAt: tokens.accessExpiresAt,
        refreshExpiresAt: tokens.refreshExpiresAt,
        apiVersion: GITHUB_API_VERSION,
      });
      accountId = account.id;
    }
  } catch (error) {
    await secrets.delete({ id: secretRef.id, userId: input.sessionUserId }).catch(() => undefined);
    await release();
    return { ok: false, error: error instanceof PrincipalTakenError ? "principal_taken" : "storage_failed" };
  }

  let sync: SyncResult | null = null;
  if (input.runInitialSync !== false) {
    try {
      sync = await syncBillingAccount(deps, { accountId, mode: "connect" });
    } catch {
      // The connection stands; the next scheduled sync tries again.
      sync = null;
    }
  }
  return { ok: true, accountId, sync };
}

export interface DisconnectResult {
  ok: boolean;
  /** Whether GitHub confirmed the authorization was removed. */
  revokedAtProvider: boolean;
}

/**
 * Disconnect: revoke the grant at GitHub (best effort), destroy the stored
 * tokens, mark the account revoked. Billing history stays -- it is the
 * person's own evidence -- and the account row stays so the GitHub account
 * stays bound to this USAGE account (see migration 0029, Sybil note).
 */
export async function disconnectGithubBilling(deps: ConnectDeps, input: { userId: string }): Promise<DisconnectResult> {
  const clock = deps.now ?? (() => new Date());
  const account = await deps.store.getAccountForUser(input.userId, "github");
  if (!account || account.userId !== input.userId) return { ok: false, revokedAtProvider: false };

  let revokedAtProvider = false;
  const secretId = account.tokenSecretId;
  if (secretId) {
    try {
      const bundle = parseTokenBundle(await deps.secrets.read({ id: secretId, userId: account.userId }));
      if (bundle) {
        revokedAtProvider = await revokeGithubGrant({
          config: deps.config,
          accessToken: bundle.accessToken,
          fetchImpl: deps.fetchImpl,
        });
      }
    } catch {
      revokedAtProvider = false;
    }
  }

  // Stop using it first, then destroy it.
  await deps.store.updateAccount(
    account.id,
    {
      status: "revoked",
      tokenSecretId: null,
      secretBackend: null,
      accessExpiresAt: null,
      refreshExpiresAt: null,
      disconnectedAt: clock().toISOString(),
    },
    clock().toISOString(),
  );
  if (secretId) await deps.secrets.delete({ id: secretId, userId: account.userId }).catch(() => undefined);
  return { ok: true, revokedAtProvider };
}
