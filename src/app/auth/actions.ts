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
async function confirmationRedirect(): Promise<string> {
  const configured = process.env.NEXT_PUBLIC_USAGE_URL;
  if (configured) return new URL("/auth/callback", configured).toString();
  const host = (await headers()).get("host");
  const protocol = host?.startsWith("localhost") ? "http" : "https";
  return host ? `${protocol}://${host}/auth/callback` : "/auth/callback";
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

  const { data, error } = await supabase.auth.signUp({
    ...credentials,
    options: { emailRedirectTo: await confirmationRedirect() },
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
