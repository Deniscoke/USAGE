import Link from "next/link";
import { redirect } from "next/navigation";
import { AppNav, StateBadge } from "@/components/product";
import { RevokeCredentialButton } from "@/components/revoke-credential";
import { Panel } from "@/components/ui";
import { signOut } from "@/app/auth/actions";
import { createServerSupabase } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { loadDashboardSnapshot } from "@/lib/db/usage-repository";
import { buildDashboardView, dashboardSinceDay } from "@/lib/pipeline/dashboard";

export const dynamic = "force-dynamic";

/**
 * Settings.
 *
 * Account, connections, miner credentials, privacy. A credential is listed by
 * its non-secret prefix only -- the stored hash is not readable by the user's
 * own client (column-level grants), and there is nothing here that could show
 * it even if it were.
 */
export default async function SettingsPage() {
  if (!isSupabaseConfigured()) redirect("/");

  const supabase = await createServerSupabase();
  if (!supabase) redirect("/");

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/settings");

  const now = new Date();
  const snapshot = await loadDashboardSnapshot(supabase, user.id, dashboardSinceDay(now));
  const data = buildDashboardView({ ...snapshot, now });

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-8 sm:px-6">
      <AppNav
        email={user.email}
        right={
          <form action={signOut}>
            <button
              type="submit"
              className="rounded-md border border-[var(--border)] px-2.5 py-1 text-[11px] text-[var(--muted)] hover:border-[var(--border-strong)] hover:text-[var(--foreground)]"
            >
              Sign out
            </button>
          </form>
        }
      />

      <h1 className="mb-6 text-2xl font-medium tracking-tight">Settings</h1>

      <div className="grid gap-4 sm:grid-cols-2">
        <Panel title="Account">
          <dl className="space-y-2.5 text-xs">
            <div className="flex justify-between gap-3">
              <dt className="text-[var(--muted)]">Email</dt>
              <dd className="truncate">{user.email}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-[var(--muted)]">USAGE balance</dt>
              <dd className="tnum">{data.settledPoints.toLocaleString("en-US")} settled</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-[var(--muted)]">Network</dt>
              <dd className="uppercase tracking-[0.1em] text-[var(--faint)]">
                {data.protocol.network}
              </dd>
            </div>
          </dl>
        </Panel>

        <Panel title="Wallet">
          <p className="text-xs text-[var(--muted)]">Not available yet.</p>
          <p className="mt-2 text-[11px] leading-relaxed text-[var(--faint)]">
            USAGE Points are off-chain, non-transferable and carry no monetary value. There is no
            token, no wallet custody and no trading. If a future token ever exists, your earned
            points are recorded per epoch and cannot be rewritten.
          </p>
        </Panel>

        <Panel title="AI connections" className="sm:col-span-2">
          <ul className="divide-y divide-[var(--border)]">
            {data.connectedAi.map((tool) => (
              <li key={tool.key} className="flex items-center justify-between gap-3 py-2.5 first:pt-0">
                <div className="min-w-0">
                  <p className="truncate text-xs">
                    {tool.label}
                    <span className="ml-2 text-[10px] text-[var(--faint)]">
                      {tool.method.replace("_", " ")}
                    </span>
                  </p>
                  {tool.note && (
                    <p className="truncate text-[10px] text-[var(--faint)]">{tool.note}</p>
                  )}
                </div>
                <StateBadge state={tool.state} />
              </li>
            ))}
          </ul>
          <Link
            href="/onboarding"
            className="mt-4 inline-block text-[11px] text-[var(--routed)] hover:underline"
          >
            Connect more AI →
          </Link>
        </Panel>

        <Panel title="Miner credentials" className="sm:col-span-2">
          {snapshot.minerCredentials.length === 0 ? (
            <p className="text-xs text-[var(--muted)]">
              No mining keys yet.{" "}
              <Link href="/onboarding" className="text-[var(--routed)] hover:underline">
                Enable mining
              </Link>{" "}
              to create one.
            </p>
          ) : (
            <ul className="divide-y divide-[var(--border)]">
              {snapshot.minerCredentials.map((credential) => (
                <li
                  key={credential.id}
                  className="flex items-center justify-between gap-3 py-2.5 first:pt-0"
                >
                  <div className="min-w-0">
                    <p className="truncate text-xs">{credential.name}</p>
                    <p className="tnum mt-0.5 text-[10px] text-[var(--faint)]">
                      {credential.tokenPrefix}… · created{" "}
                      {credential.createdAt.slice(0, 10)}
                      {credential.lastUsedAt
                        ? ` · last used ${credential.lastUsedAt.slice(0, 10)}`
                        : " · never used"}
                    </p>
                  </div>
                  {credential.revokedAt ? (
                    <span className="shrink-0 text-[10px] uppercase tracking-[0.1em] text-[var(--reported)]">
                      Revoked
                    </span>
                  ) : (
                    <RevokeCredentialButton credentialId={credential.id} />
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-[11px] leading-relaxed text-[var(--faint)]">
            USAGE stores only a hash of each key, so a key can never be shown again after it is
            created. Revoking one takes effect immediately and cannot be undone.
          </p>
        </Panel>

        <Panel title="Privacy" className="sm:col-span-2">
          <p className="text-xs leading-relaxed text-[var(--muted)]">
            USAGE records what your AI compute <em>was</em>, never what it <em>said</em>.
          </p>
          <ul className="mt-3 space-y-1.5 text-[11px] text-[var(--faint)]">
            <li>Stored: model, token counts, timestamps, provider, proof metadata.</li>
            <li>Never stored: prompts, responses, tool arguments, source code, conversations.</li>
            <li>Never logged: credentials of any kind, yours or ours.</li>
          </ul>
        </Panel>
      </div>
    </main>
  );
}
