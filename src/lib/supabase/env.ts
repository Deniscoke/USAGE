/**
 * Supabase environment access.
 *
 * The app is usable before a database exists: when Supabase is not configured
 * the UI shows a setup state instead of crashing. Nothing here reads a secret
 * that is safe to ship to the browser except the two NEXT_PUBLIC_ values, which
 * are public by design (RLS is what protects the data).
 */

export interface SupabasePublicEnv {
  url: string;
  anonKey: string;
}

export function supabasePublicEnv(): SupabasePublicEnv | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  // Supabase renamed the browser key to "publishable"; the legacy anon JWT is
  // still accepted so an existing project keeps working.
  const anonKey =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;
  return { url, anonKey };
}

export function isSupabaseConfigured(): boolean {
  return supabasePublicEnv() !== null;
}

/**
 * Service role key. Bypasses RLS, so it may only ever be read in server-side
 * code. Importing this module from a client component is a build error via the
 * `server-only` guard in ./admin.
 */
export function supabaseServiceRoleKey(): string {
  // Prefer the current secret key; fall back to the legacy service_role JWT.
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    throw new Error(
      "SUPABASE_SECRET_KEY is not set. Trusted ingestion cannot run without it.",
    );
  }
  return key;
}
