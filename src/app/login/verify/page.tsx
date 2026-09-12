import { redirect } from "next/navigation";
import { signOut } from "@/app/auth/actions";
import { createServerSupabase } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { mfaState } from "@/lib/auth/mfa";
import { safeRedirectPath } from "@/lib/auth/routing";
import { MfaChallenge } from "@/components/mfa-challenge";

export const dynamic = "force-dynamic";

/**
 * The second step of signing in.
 *
 * The middleware sends people here; this page checks the same thing again on
 * the server, because a middleware decision is UX and a server check is the
 * one that has to hold.
 */
export default async function VerifyPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  if (!isSupabaseConfigured()) redirect("/");

  const supabase = await createServerSupabase();
  if (!supabase) redirect("/");

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: levels } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  const state = mfaState(levels);
  const { next } = await searchParams;

  // Nothing to verify: this screen would be a dead end.
  if (state.kind !== "challenge_required") redirect(safeRedirectPath(next));

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-4 py-16">
      <h1 className="text-2xl font-medium tracking-tight">One more step</h1>
      <p className="mt-2 text-sm leading-relaxed text-[var(--muted)]">
        This account uses two-factor authentication. Enter the current code to finish signing in as{" "}
        {user.email}.
      </p>

      <div className="mt-8">
        <MfaChallenge next={next} />
      </div>

      <form action={signOut} className="mt-10 border-t border-[var(--border)] pt-5">
        <p className="text-[11px] leading-relaxed text-[var(--faint)]">
          Lost the authenticator? There are no recovery codes, so the account cannot be reached
          without it. Sign out here and contact the operator.
        </p>
        <button type="submit" className="chat-link mt-2 text-[11px]">
          Sign out
        </button>
      </form>
    </main>
  );
}
