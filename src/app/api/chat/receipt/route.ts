import type { NextRequest } from "next/server";
import { signedInUserId } from "@/lib/chat/auth";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { isSupabaseConfigured } from "@/lib/supabase/env";

/**
 * What USAGE recorded for one reply.
 *
 * The stream tells the browser what the provider said; this tells it what
 * USAGE persisted, which is the only thing that counts. Read from the
 * database after ingestion has landed, scoped to the signed-in user, so a
 * receipt for a generation that is not yours reads as not found.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GENERATION_ID = /^[A-Za-z0-9][A-Za-z0-9_:.-]{3,127}$/;

export async function GET(request: NextRequest): Promise<Response> {
  const userId = await signedInUserId();
  if (!userId) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (!isSupabaseConfigured()) return Response.json({ error: "not_configured" }, { status: 503 });

  const generation = request.nextUrl.searchParams.get("generation") ?? "";
  if (!GENERATION_ID.test(generation)) return Response.json({ error: "bad_generation" }, { status: 400 });

  const { data } = await createAdminSupabase()
    .from("usage_events")
    .select("reward_status, reward_reason, verification_status, input_tokens, output_tokens, actual_cost_micros, epoch_id, model")
    .eq("user_id", userId)
    .like("external_reference", `%${generation}`)
    .order("occurred_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!data) return Response.json({ found: false }, { headers: { "cache-control": "no-store" } });

  const row = data as {
    reward_status: string | null;
    reward_reason: string | null;
    verification_status: string | null;
    input_tokens: number | null;
    output_tokens: number | null;
    actual_cost_micros: number | null;
    epoch_id: string | null;
    model: string | null;
  };

  return Response.json(
    {
      found: true,
      rewardStatus: row.reward_status,
      rewardReason: row.reward_reason,
      verificationStatus: row.verification_status,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      costMicros: row.actual_cost_micros,
      epochId: row.epoch_id,
      model: row.model,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
