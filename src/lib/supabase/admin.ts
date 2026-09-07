import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";
import { supabasePublicEnv, supabaseServiceRoleKey } from "./env";

/**
 * Service-role client. BYPASSES RLS.
 *
 * Only trusted server-side ingestion may use this: it is the component allowed
 * to assign a verification type, which is why clients have no INSERT privilege
 * on usage tables at all. Never use it to serve a dashboard read -- those run
 * as the signed-in user so the database enforces ownership.
 */
export function createAdminSupabase(): SupabaseClient<Database> {
  const env = supabasePublicEnv();
  if (!env) throw new Error("Supabase is not configured.");

  return createClient<Database>(env.url, supabaseServiceRoleKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
