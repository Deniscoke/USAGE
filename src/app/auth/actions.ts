"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createServerSupabase } from "@/lib/supabase/server";
import { safeRedirectPath } from "@/lib/auth/routing";

/**
 * Auth server actions.
 *
 * Kept server-side so session cookies are written by the server and never
 * handled in the browser. The redirect target is validated to a same-origin
 * path: an open redirect through `next=` would be a real vulnerability.
 */

export interface AuthFormState {
  error?: string;
  /** Something that went right. "Check your email" is not an error. */
  notice?: string;
}

/**
 * Where a confirmation email should send somebody back to.
 *
 * Stated explicitly rather than left to the Supabase project's Site URL: that
 * setting still read `http://localhost:3000` from development, so every
 * confirmation link USAGE sent pointed at the reader's own machine. A link in
 * an email is read on a device that is not this one, so the address has to be
 * the public one, and it has to come from the request rather than a constant
 * that a preview deployment would get wrong.
 */
async function confirmationRedirect(): Promise<string | undefined> {
  // NEVER the Host header on a deployed origin. A password-reset or
  // confirmation link built from a header the client controls is the classic
  // account-takeover path: poison the header, receive the victim's link. The
  // first draft of this function did exactly that, and it is not made safe by
  // Supabase's own allowlist -- that allowlist is a second lock, not this one.
  const configured =
    process.env.NEXT_PUBLIC_USAGE_URL ??
    // Set by the platform, not by the request.
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : null);
  if (configured) return new URL("/auth/callback", configured).toString();

  // Local development only, and only a host that cannot have come from
  // somewhere else. Exact match, no prefixes: "localhost.attacker.example"
  // starts with "localhost".
  const host = (await headers()).get("host");
  if (host && /^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/.test(host)) {
    return `http://${host}/auth/callback`;
  }

  // Nothing trustworthy to state. Omitting it lets Supabase fall back to the
  // project's own Site URL, which is configuration rather than input.
  return undefined;
}

function readCredentials(formData: FormData): { email: string; password: string } | null {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (!email || !password) return null;
  return { email, password };
}

export async function signIn(_state: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const supabase = await createServerSupabase();
  if (!supabase) return { error: "Supabase is not configured. See docs/STATE.md." };

  const credentials = readCredentials(formData);
  if (!credentials) return { error: "Email and password are required." };

  const { error } = await supabase.auth.signInWithPassword(credentials);
  if (error) return { error: error.message };

  revalidatePath("/dashboard");
  redirect(safeRedirectPath(formData.get("next")));
}

export async function signUp(_state: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const supabase = await createServerSupabase();
  if (!supabase) return { error: "Supabase is not configured. See docs/STATE.md." };

  const credentials = readCredentials(formData);
  if (!credentials) return { error: "Email and password are required." };
  if (credentials.password.length < 6) return { error: "Password must be at least 6 characters." };

  const emailRedirectTo = await confirmationRedirect();
  const { data, error } = await supabase.auth.signUp({
    ...credentials,
    ...(emailRedirectTo ? { options: { emailRedirectTo } } : {}),
  });
  if (error) return { error: error.message };

  // With email confirmation enabled there is no session yet. This is the
  // expected path, not a failure, and it no longer reads as one.
  if (!data.session) {
    return {
      notice: `Check ${credentials.email} for a confirmation link, then sign in. The link works once and expires.`,
    };
  }

  revalidatePath("/dashboard");
  redirect("/dashboard");
}

export async function signOut(): Promise<void> {
  const supabase = await createServerSupabase();
  if (supabase) await supabase.auth.signOut();
  revalidatePath("/", "layout");
  redirect("/");
}
