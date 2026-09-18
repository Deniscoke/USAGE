# Provider-authoritative usage (M17C)

Status as of 2026-09-18: implemented in code, tested against PGlite with a stubbed GitHub, **not live**. Migration `0029_provider_billing_evidence.sql` is written and not applied to production. The GitHub App is not yet registered ([GITHUB_APP_SETUP.md](./GITHUB_APP_SETUP.md)).

## 1. Three evidence lanes

USAGE keeps three kinds of usage evidence apart. They are never summed and never correlated with each other.

| # | Lane | What it is | Written by | Granularity | Reward |
|---|---|---|---|---|---|
| 1 | **LOCAL TELEMETRY** (`local_usage_observations`, 0017) | What the person's own apps reported through USAGE Miner on a subscription login | Server, from device-signed miner uploads | Per request, as the app reports it | `local_only`, **0** |
| 2 | **ROUTED VERIFIED COMPUTE** (`usage_events`, proofs) | Requests USAGE carried itself or a provider confirmed per request | Server ingestion only | Per request, with proof | Reward policy **may** apply (confirmed + eligible only) |
| 3 | **PROVIDER BILLING EVIDENCE** (`provider_billing_*`, 0029) | Aggregates the provider's own billing system reports about the account | Server only, after its own authenticated fetch | Per day / per month, per product/SKU/model/unit | **0** until separately approved |

Lane 3 is authoritative about *money billed*, not about requests. It has no request identity upstream, so it can never be matched to a lane-1 observation or a lane-2 request, and the product never labels it "verified requests". The dashboard calls it **PROVIDER-CONFIRMED USAGE** in a neutral colour (`--billing`), never verified green.

Hard guarantees (tested in `src/lib/db/provider-billing.test.ts` and `src/lib/provider-billing/routes.test.ts`):

- `provider_billing_usage.reward_eligible` has `CHECK (reward_eligible = false)`, `authoritative` is `CHECK (= true)`, `economic_authority` is `CHECK (= 'provider_billing')`. No writer, including the service role, can change them.
- Clients (anon/authenticated) have SELECT on their own rows only (RLS + the 0027 second-factor restrictive policy) and no write privilege. The account's secret reference and lease columns are not even selectable (column grants).
- No route accepts a request body on this lane. The only routes touching it are the GitHub connect start/callback, refresh-now, disconnect and the cron. No miner or gateway route imports it, so a `usgm_` miner token cannot reach it.
- A sync that writes and corrects billing rows changes no other table: `usage_events`, the ledger, aggregates, scores and allocations keep their row counts; nothing economic has a view or trigger on the billing tables.
- Snapshots are append-only (trigger refuses UPDATE/DELETE, service role included).

## 2. GitHub Copilot personal AI-credit usage

### 2.1 Facts (official docs, verified 2026-09-18)

Endpoint: `GET https://api.github.com/users/{username}/settings/billing/ai_credit/usage`

- Query: `year` (default current), `month` 1-12 (default current), `day` 1-31 (optional), `model`, `product`. No hour, no user filter. Only the past 24 months.
- Headers: `Authorization: Bearer <token>`, `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2026-03-10` (supported: `2026-03-10`, `2022-11-28`). The version used is stored on every snapshot.
- Tokens accepted: GitHub App **user** access tokens (`ghu_`) and fine-grained PATs with the "Plan" user permission (read). Installation tokens are not accepted. USAGE uses GitHub App user tokens only and never asks for a PAT.
- Permission: account permission **"Plan"**, read. The GitHub permissions reference lists this endpoint under *User permissions for "Plan"* (read, user access token).
- 200 body: `timePeriod {year, month?, day?}`, `user`, optional `product`/`model`, and `usageItems[]` with `product, sku, model, unitType, pricePerUnit, grossQuantity, grossAmount, discountQuantity, discountAmount, netQuantity, netAmount`. The seven numeric fields are JSON numbers and can be fractional.
- Status codes: 200, 400, 403, 404, 500, 503.
- Coverage: only self-purchased Copilot plans. Usage billed to an organization or enterprise seat is **not** included.
- Allowances: included credits appear as `discountQuantity`/`discountAmount`; `net = gross - discount`. One AI credit is currently $0.01, but USAGE never hard-codes it: it stores the provider's `pricePerUnit`.
- There is no per-request data. Freshness and correction behaviour are not documented.

Sources:

- REST: permissions required for GitHub Apps (Plan): <https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps>
- REST: billing usage: <https://docs.github.com/en/rest/billing/usage>
- API versions: <https://docs.github.com/en/rest/about-the-rest-api/api-versions>
- User access tokens for a GitHub App (authorize, PKCE, exchange): <https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app>
- Refreshing user access tokens (rotation): <https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens>
- Delete an app authorization: <https://docs.github.com/en/rest/apps/oauth-applications#delete-an-app-authorization>
- Get the authenticated user: <https://docs.github.com/en/rest/users/users#get-the-authenticated-user>
- Registering a GitHub App using URL parameters: <https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-using-url-parameters>

### 2.2 Authorization

GitHub App user authorization; no installation is needed for account permissions.

1. `GET /api/providers/github/start` (signed in, second factor satisfied). A random `state` and a PKCE verifier are stored in `provider_oauth_requests` (0013) against the signed-in user with `provider_slug = 'github-billing'`; the browser goes to `https://github.com/login/oauth/authorize?client_id&redirect_uri&state&code_challenge&code_challenge_method=S256`. `redirect_uri` is exactly `<origin>/api/providers/github/callback`.
2. `GET /api/providers/github/callback`. The state is consumed atomically and only if it belongs to the **same signed-in user**, is unexpired (10 minutes) and unused; otherwise nothing is exchanged. Code exchange: `POST https://github.com/login/oauth/access_token` with `client_id, client_secret, code, redirect_uri, code_verifier` returns `access_token` (`ghu_`, `expires_in` 28800) and `refresh_token` (`ghr_`, `refresh_token_expires_in` 15897600). GitHub reports OAuth errors as HTTP 200 with an `error` field; both shapes are handled.
3. `GET https://api.github.com/user`: the numeric `id` (read from its exact JSON source text) is the canonical principal; `login` is mutable, used only as the `{username}` path value and re-resolved on every sync, so a rename just works.
4. Tokens are stored as **one** secret (Vault in production, `provider_secrets` AES in tests) holding both tokens, so a refresh-token rotation is a single write. They are never in a plaintext column, a URL, a response, a log line, or anything the miner receives.

**One GitHub account per USAGE account** (`unique (provider, provider_principal_id)`), and one GitHub billing account per USAGE account (`unique (user_id, provider)`). A disconnect keeps the row, so the binding persists: the same GitHub account cannot be moved between USAGE accounts to multiply anything (Sybil note). Connecting a GitHub account already bound elsewhere is refused and the fresh grant is revoked at GitHub immediately.

### 2.3 Sync

`src/lib/provider-billing/sync.ts`:

- A 2-minute lease per account, so a cron run and a manual refresh never refresh the same rotating refresh token at once.
- Refresh when the access token expires within 5 minutes; on rotation, the new pair is persisted before use. `bad_refresh_token` or an expired refresh token → `needs_reauth`. A 401 on `/user` triggers one refresh attempt; still 401 → `needs_reauth`.
- `/user` id different from the stored principal → refused, `needs_reauth`, `last_error_class = principal_mismatch`; no billing call is made.
- Requests (rate-conscious): the current month aggregate always; days only for months whose aggregate had items. On connect: every day of the month so far. Scheduled (daily cron, `40 1 * * *`): today and the two days before, plus last month's aggregate during the first three days of a month. Manual "Refresh now": today and yesterday, at most once per 5 minutes per account.
- Current day and month are treated as provisional and re-polled; snapshots are kept.
- Failure never deletes: 5xx/network/rate limit → `degraded`; 403 → billing scope `permission_insufficient`; 404 → `unavailable`; 401 after refresh → `needs_reauth`. Rows and snapshots stay exactly as they were.

### 2.4 Exact numbers

The response is parsed with a `JSON.parse` reviver that captures each number's **source text** (Node 21+; verified on Node 24.13). A float never carries a billing value. Each figure is stored twice: the provider's literal (authority, e.g. `"3.00"`) and a scaled integer computed from the string alone: micro-USD for `pricePerUnit` and amounts (via the existing string-based `usdCostToMicros`, rounding half-up at the micro boundary), micro-units for quantities. A runtime without source-text access refuses to parse rather than falling back to floats.

### 2.5 Storage

| Table | Holds | Mutability |
|---|---|---|
| `provider_billing_accounts` | Owner, principal id, login, billing scope, status, permission state, secret reference, token expiries, API version, sync bookkeeping | Server updates |
| `provider_billing_snapshots` | Request key/period, filters, API version, HTTP status, fetched_at, SHA-256 and the exact response text (billing aggregate only; names the GitHub login; no token, no header) | Append-only. Identical responses to the same request are recorded once (deduplicated by hash); a changed response is always a new row |
| `provider_billing_usage` | Current normalized rows | Identity `(provider, principal_id, billing_scope, period_kind, period_start, product, sku, model, unit_type)`; fetch time is not part of it. Same values → nothing changes, not even `revision`. Changed values → same row updated, `revision + 1`, `current_snapshot_id` repointed, `first_snapshot_id` and old snapshots kept. An item a later response no longer lists → `withdrawn_at` set, never deleted |

Product, SKU and unit strings are carried as given; GitHub's own examples vary ("Copilot AI Credits"/"AI Credit"/"ai-credits" vs "Copilot"/"Copilot AI Credits"/"credits"), so none is hard-coded. A missing `model` is stored as `""`.

### 2.6 Billing scope

| Response to the month request | `billing_scope` | Shown as |
|---|---|---|
| 200 with items | `personal` | Provider billing: AVAILABLE · Scope: Personal |
| 200 with no items | `no_data_or_managed` | "No personal billing usage found. If your Copilot is provided by an organization or enterprise, personal billing evidence is not available; an organization connector is required." Never "zero usage" |
| 403 (not rate-limited) | `permission_insufficient` | Permission missing |
| 404 | `unavailable` | Not applicable |
| 5xx / network / rate limit | unchanged | Degraded, previous data kept |

What GitHub returns for org-seat or Copilot Free users is undocumented; it may be any of the first four rows.

## 3. Organization and enterprise (design notes, not implemented)

- Organization billing usage endpoints need the organization **"Administration: read"** permission and the caller to be an organization owner/admin.
- Enterprise billing endpoints need an enterprise admin or billing manager.
- Copilot metrics APIs need "Organization Copilot metrics" / "Enterprise Copilot metrics" read.
- These would be separate connectors with their own tables of evidence scope (the payer is the organization, not the person), and attributing org-billed usage to one member needs a per-user breakdown the org endpoints would have to provide. Out of scope for M17C.

## 4. Why reward stays 0

- The lane is aggregate billing evidence: no request identity, no per-request proof, no way to dedupe against lanes 1 and 2.
- GitHub's Acceptable Use Policies, section 4 (spam and inauthentic activity), restrict activity driven by incentives such as rewards. Paying points for Copilot consumption risks being read as incentivizing inauthentic use of GitHub. Any reward for this lane needs its own review and a new, separately approved migration (the CHECK has to be replaced), not a flag.
  <https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies>

## 5. Open questions

1. **Freshness.** How soon after use does a day's usage appear? Undocumented; USAGE re-polls the last three days and the month.
2. **Corrections.** Does GitHub revise past days/months, and for how long? Undocumented; handled by revisions and immutable snapshots, and last month is re-read in the first three days of a month.
3. **Org-seat response.** For a user whose Copilot is organization- or enterprise-billed: 200 empty, 403 or 404? Unknown; all three are handled without implying zero usage.
4. **Copilot Free visibility.** Does Free usage appear at all? Unknown.
5. **Rate limits** for this endpoint specifically are not documented beyond the general REST limits; a 403/429 carrying rate-limit headers is treated as temporary.
6. **Binding release.** A GitHub account stays bound to the first USAGE account that connected it, even after a disconnect. Releasing one is an operator action today.
