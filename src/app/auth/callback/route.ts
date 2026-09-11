import { redirect } from "next/navigation";
import { createServerSupabase } from "@/lib/supabase/server";
import { safeRedirectPath } from "@/lib/auth/routing";

/**
 * Where a confirmation email lands.
 *
 * Until this existed there was nowhere for it to land at all. Sign-up called
 * `signUp()` without an `emailRedirectTo`, so Supabase fell back to the
 * project's Site URL -- which was still `http://localhost:3000` from
 * development. Every confirmation link USAGE has ever sent pointed at the
 * reader's own machine, where nothing is listening. The first person outside
 * this account to try signing up hit exactly that, and could not get in.
 *
 * Supabase sends people here two different ways depending on the flow, and
 * both are handled rather than guessed at:
 *
 *   `?code=`                  PKCE: exchange it for a session
 *   `?token_hash=&type=`      the verification link: verify the one-time token
 *
 * An error arrives as `?error=&error_code=`, and the commonest one by far is
 * an expired or already-used link -- mail scanners follow links before people
 * do, which consumes them. That is not the reader's fault and the message says
 * so, instead of leaving them on a page that says access denied.
 *
 * Nothing here trusts the `next` parameter beyond `safeRedirectPath`: an open
 * redirect on an auth callback is how sessions get stolen.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function failed(reason: string): never {
  redirect(`/login?notice=${encodeURIComponent(reason)}`);
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const next = safeRedirectPath(url.searchParams.get("next"));

  const errorCode = url.searchParams.get("error_code");
  if (errorCode) {
    failed(
      errorCode === "otp_expired"
        ? "That confirmation link has expired or was already used. Sign in below, or sign up again to get a new one."
        : "That link could not be used. Try signing in below.",
    );
  }

  const supabase = await createServerSupabase();
  if (!supabase) failed("Sign-in is not configured on this deployment.");

  const code = url.searchParams.get("code");
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type");

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) failed("That confirmation link could not be used. Try signing in below.");
    redirect(next);
  }

  if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({
      type: type as "signup" | "email" | "recovery" | "email_change" | "invite" | "magiclink",
      token_hash: tokenHash,
    });
    if (error) {
      failed(
        /expired|invalid/i.test(error.message)
          ? "That confirmation link has expired or was already used. Sign in below, or sign up again to get a new one."
          : "That confirmation link could not be used. Try signing in below.",
      );
    }
    redirect(next);
  }

  failed("That link is missing its confirmation code. Try signing in below.");
}
