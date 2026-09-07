"use server";

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

  const { data, error } = await supabase.auth.signUp(credentials);
  if (error) return { error: error.message };

  // With email confirmation enabled there is no session yet.
  if (!data.session) {
    return { error: "Check your email to confirm your account, then sign in." };
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
