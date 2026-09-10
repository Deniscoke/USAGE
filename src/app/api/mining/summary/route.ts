import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { loadDashboardSnapshot } from "@/lib/db/usage-repository";
import { buildDashboardView, dashboardSinceDay } from "@/lib/pipeline/dashboard";
import { loadDeviceViews } from "@/lib/miner/device-view";
import { buildMiningSummary } from "@/lib/live/summary";

export const dynamic = "force-dynamic";

/**
 * The one authenticated summary the live dashboard refetches after an
 * authoritative event (and, when Realtime is down, every few seconds while
 * the tab is visible). Runs as the signed-in user under RLS; returns safe
 * aggregates only. Never prompts, credentials, or other users' data.
 */
export async function GET(): Promise<Response> {
  if (!isSupabaseConfigured()) return NextResponse.json({ error: "not_configured" }, { status: 503 });
  const supabase = await createServerSupabase();
  if (!supabase) return NextResponse.json({ error: "not_configured" }, { status: 503 });
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const now = new Date();
  const [snapshot, devices] = await Promise.all([
    loadDashboardSnapshot(supabase, user.id, dashboardSinceDay(now)),
    loadDeviceViews(supabase, user.id),
  ]);
  const view = buildDashboardView({ ...snapshot, now });
  return NextResponse.json(buildMiningSummary(view, devices, now), {
    headers: { "cache-control": "private, no-store" },
  });
}
