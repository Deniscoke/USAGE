import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

/**
 * Profile safety net.
 *
 * Profiles are created by the `on_auth_user_created` trigger (migration 0002).
 * This repairs the one case the trigger cannot cover -- a user who signed up
 * before the trigger existed -- so an authenticated request can never fail
 * because its profile row is missing. Idempotent: existing rows are untouched.
 */
export async function ensureProfile(
  admin: SupabaseClient<Database>,
  userId: string,
  email: string | null,
): Promise<void> {
  const { error } = await admin
    .from("profiles")
    .upsert(
      { id: userId, display_name: email ? email.split("@")[0] : null },
      { onConflict: "id", ignoreDuplicates: true },
    );
  if (error) throw new Error(`ensureProfile: ${error.message}`);
}
