"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";

/**
 * Browser client. Only ever sees the public key.
 *
 * Both public key names are read LITERALLY so Next.js inlines them into the
 * client bundle: production defines NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
 * older environments NEXT_PUBLIC_SUPABASE_ANON_KEY. Reading only the second
 * one was the M16B.1 production crash: `createBrowserClient` throws when the
 * key is undefined, and a throw inside a client effect takes the whole route
 * to Next's generic error screen.
 *
 * Returns null instead of throwing when the environment is incomplete, so a
 * live widget degrades to "unavailable" rather than destroying the page.
 */
export function createBrowserSupabase(): SupabaseClient<Database> | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  try {
    return createBrowserClient<Database>(url, key);
  } catch {
    return null;
  }
}
