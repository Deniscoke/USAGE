# Registering the GitHub App (M17C)

USAGE reads a person's GitHub Copilot **personal** AI-credit billing with a GitHub App **user access token**. The app needs exactly one permission, the account permission **Plan: read-only**, and nothing on repositories or organizations. See [PROVIDER_AUTHORITATIVE_USAGE.md](./PROVIDER_AUTHORITATIVE_USAGE.md) for what it is used for.

Nothing here is automated. The owner registers the app by hand, then sets two server-only environment variables.

## 1. Prefilled creation link

Open this while signed in to the GitHub account that should own the app:

```
https://github.com/settings/apps/new?name=USAGE%20Copilot%20Billing&description=Reads%20your%20GitHub%20Copilot%20AI-credit%20billing%20(read-only)%20for%20USAGE.&url=https%3A%2F%2Fusage-ten.vercel.app&callback_urls[]=https%3A%2F%2Fusage-ten.vercel.app%2Fapi%2Fproviders%2Fgithub%2Fcallback&request_oauth_on_install=false&public=false&webhook_active=false&plan=read
```

Parameter names were checked against GitHub's "Registering a GitHub App using URL parameters" page (2026-09-18): `name`, `description`, `url`, `callback_urls[]`, `request_oauth_on_install`, `public`, `webhook_active` are documented. Permissions take their parameterized name with `read`/`write`; that page defers the list of names to "Permissions required for GitHub Apps", which shows the heading *User permissions for "Plan"* but not its parameter name. `plan=read` is our reading of the naming convention, **not confirmed**. After the page opens, check the form before saving (section 2). If Plan is not preselected, set it by hand. There is no URL parameter for "Expire user authorization tokens", so check that box by hand too.

## 2. Settings to confirm on the form

| Setting | Value | Why |
|---|---|---|
| GitHub App name | `USAGE Copilot Billing` (any unique name works) | Shown to people on the consent screen |
| Homepage URL | `https://usage-ten.vercel.app` | |
| Callback URL | `https://usage-ten.vercel.app/api/providers/github/callback` | Must match exactly; GitHub rejects any other `redirect_uri`. For local development add a second callback `http://localhost:3000/api/providers/github/callback` (up to 10 are allowed) |
| Expire user authorization tokens | **ON** | 8-hour access tokens plus rotating refresh tokens. USAGE refreshes and rotates them automatically |
| Request user authorization (OAuth) during installation | **OFF** | USAGE never asks anyone to install the app; it uses user authorization only |
| Enable Device Flow | OFF | Not used |
| Setup URL | empty | |
| Webhook → Active | **OFF** (inactive) | Nothing to receive yet. Limitation: with no webhook, USAGE does not get `github_app_authorization` events, so when a person revokes the app from GitHub's settings, USAGE only notices on the next sync (401 then `bad_refresh_token` → "needs reconnect"). Acceptable for the beta; revisit if prompt revocation matters |
| Repository permissions | **none** | |
| Organization permissions | **none** | |
| Account permissions | **Plan: Read-only**, and nothing else | The one permission the AI-credit usage endpoint needs |
| Subscribe to events | none | |
| Where can this GitHub App be installed? | **Only on this account** for the owner test; switch to **Any account** when opening the beta | See below |

**"Only on this account" vs "Any account".** A private app can only be *authorized* by the account that owns it. For the owner's own end-to-end test that is enough. Before anyone else can connect, the app must be made public ("Any account"). Making it public does not list it in the Marketplace and grants nothing by itself; each person still authorizes it for their own account only.

## 3. Credentials

After creating the app:

1. Copy the **Client ID** (starts with `Iv`).
2. Click **Generate a new client secret** and copy it once.
3. Do **not** generate a private key: USAGE never authenticates as the app itself, only exchanges user codes.

Set them in Vercel (Production; add Preview only if a preview deployment is also registered as a callback), as **Sensitive** variables:

```
GITHUB_APP_CLIENT_ID=<client id>
GITHUB_APP_CLIENT_SECRET=<client secret>
```

Both are server-only: never `NEXT_PUBLIC_`, never in git, never logged. `.env.example` lists the names only. Without them, the Providers page shows "GitHub connector is not configured on this deployment" and nothing else changes.

The daily sync (`/api/cron/provider-billing-sync`, `40 1 * * *` in `vercel.json`) uses the existing `CRON_SECRET`.

## 4. Before the first real connection

1. Apply migration `0029_provider_billing_evidence.sql` to production. This is production DDL: announce it and get agreement first (CLAUDE.md rule 13).
2. Deploy.
3. On `/providers`, "GitHub Copilot" → **Connect GitHub**. The consent screen should list only "Plan (read)".
4. After the redirect: CONNECTED · Provider billing AVAILABLE (self-paid plan) or NOT APPLICABLE (organization-provided or none) · Reward NOT ENABLED.

## 5. Rotating or removing

- **Rotate the client secret:** generate a new one, update `GITHUB_APP_CLIENT_SECRET`, redeploy, then delete the old secret on GitHub. Stored user tokens keep working.
- **Remove everything:** people disconnect from `/providers`, which calls `DELETE /applications/{client_id}/grant` and destroys the stored tokens. Deleting the app on GitHub revokes every authorization at once; accounts then show "needs reconnect" on the next sync. Billing history stays either way.
