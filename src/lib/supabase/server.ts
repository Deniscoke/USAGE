import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";
import { supabasePublicEnv } from "./env";

/**
 * Request-scoped Supabase client for Server Components, Server Actions and
 * Route Handlers. Reads the session from cookies, so every query it makes runs
 * as the signed-in user and is subject to RLS.
 */
export async function createServerSupabase(): Promise<SupabaseClient<Database> | null> {
  const env = supabasePublicEnv();
  if (!env) return null;

  const cookieStore = await cookies();

  return createServerClient<Database>(env.url, env.anonKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server Components cannot set cookies; middleware refreshes the
          // session instead. Safe to ignore.
        }
      },
    },
  });
}
