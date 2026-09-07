"use server";

import { revalidatePath } from "next/cache";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { createServerSupabase } from "@/lib/supabase/server";
import { createSupabaseIngestStore } from "@/lib/db/supabase-store";
import { ingestDemoUsage } from "@/lib/db/ingest";
import { HISTORY_DAYS } from "@/lib/pipeline/dashboard";

/**
 * Development-only demo ingestion.
 *
 * Three guards, because this writes VERIFIED usage:
 *   1. disabled in production unless USAGE_ALLOW_DEMO_INGEST is explicitly set;
 *   2. requires an authenticated session;
 *   3. ingests for the *session's own* user id -- there is no user parameter,
 *      so it cannot be aimed at another account.
 *
 * It runs the real adapters through the real pipeline. It never writes
 * precomputed totals.
 */
export interface DemoIngestState {
  error?: string;
  message?: string;
}

function demoIngestEnabled(): boolean {
  return process.env.NODE_ENV !== "production" || process.env.USAGE_ALLOW_DEMO_INGEST === "true";
}

export async function loadDemoUsage(): Promise<DemoIngestState> {
  if (!demoIngestEnabled()) {
    return { error: "Demo ingestion is disabled in this environment." };
  }

  const supabase = await createServerSupabase();
  if (!supabase) return { error: "Supabase is not configured." };

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in." };

  try {
    const store = createSupabaseIngestStore(createAdminSupabase());
    const summary = await ingestDemoUsage(store, { userId: user.id, historyDays: HISTORY_DAYS });
    revalidatePath("/dashboard");
    return {
      message: `Ingested ${summary.inserted} new events (${summary.duplicates} already stored) across ${summary.daysRecomputed} days.`,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Ingestion failed." };
  }
}
