import Link from "next/link";
import { redirect } from "next/navigation";
import { AppNav } from "@/components/product";
import { Panel } from "@/components/ui";
import { MfaSettings } from "@/components/mfa-settings";
import { createServerSupabase } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { mfaState } from "@/lib/auth/mfa";

export const dynamic = "force-dynamic";

/**
 * Security.
 *
 * One thing lives here today: the second factor. It is its own page rather
 * than a row in settings because it is the only control on the site that
 * changes how somebody signs in, and burying it under connections and
 * credentials would say it is optional trivia.
 */
export default async function SecurityPage() {
  if (!isSupabaseConfigured()) redirect("/");

  const supabase = await createServerSupabase();
  if (!supabase) redirect("/");

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/settings/security");

  const { data: levels } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  const state = mfaState(levels);

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 sm:px-6">
      <AppNav email={user.email} />

      <div className="mt-8 flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-3xl font-medium tracking-tight">Security</h1>
        <Link href="/settings" className="chat-link text-[11px]">
          Back to settings
        </Link>
      </div>

      <p className="mt-3 max-w-2xl text-sm leading-relaxed text-[var(--muted)]">
        This account holds wallet credit, connected provider keys and everything you have earned.
        A second factor protects all three at once, which is why it lives on the account rather
        than on any one of them.
      </p>

      <Panel
        title="Two-factor authentication"
        hint={state.kind === "verified" || state.kind === "challenge_required" ? "On" : "Off"}
        className="mt-6"
      >
        <MfaSettings />
      </Panel>

      <Panel title="What a second factor does not do" className="mt-5">
        <ul className="flex list-disc flex-col gap-2 pl-4 text-[12px] leading-relaxed text-[var(--muted)]">
          <li>
            It does not encrypt your provider keys. Those are already encrypted and stored server
            side; USAGE never shows them back to you or to anyone else.
          </li>
          <li>
            It does not make USAGE Points transferable or tradable. They remain an off-chain record
            with no monetary value.
          </li>
          <li>
            It does not protect against a lost password alone. It protects against a lost password
            plus somebody trying to use it.
          </li>
        </ul>
      </Panel>
    </main>
  );
}
