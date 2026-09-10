import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { miningTopic, type MiningEvent } from "./events";

/**
 * Server → browser live events over Supabase Realtime Broadcast (M16B).
 *
 * Sent with the service-role client over the REST broadcast endpoint
 * (`httpSend`), so a serverless invocation needs no socket. The channel is
 * PRIVATE: the RLS policy on `realtime.messages` (migration 0021_realtime_mining_channel) lets a
 * browser subscribe only to `mining:<its own auth.uid()>`. The service role
 * publishes; it never subscribes from a browser and its key never leaves
 * the server.
 *
 * Fire-and-forget by design: a failed broadcast must never fail, delay or
 * reorder the gateway response or the economic write. The database remains
 * the source of truth; the dashboard reconciles from it after any event.
 */
export async function broadcastMiningEvent(admin: SupabaseClient<Database>, userId: string, event: MiningEvent): Promise<void> {
  try {
    const channel = admin.channel(miningTopic(userId), { config: { private: true } });
    await channel.httpSend(event.name, event as unknown as Record<string, unknown>);
    await admin.removeChannel(channel);
  } catch {
    // Ephemeral by contract. Nothing economic depends on delivery.
  }
}

/** Per-request event sequencing, kept on the server for the request's lifetime. */
export class MiningEventSequencer {
  private seq = 0;
  constructor(private readonly admin: SupabaseClient<Database> | null, private readonly userId: string, private readonly base: { requestId: string; route: string; provider: string; model: string | null }) {}

  emit<E extends MiningEvent>(event: Omit<E, keyof import("./events").MiningEventBase> & { name: E["name"] }): void {
    if (!this.admin) return;
    const full = { ...this.base, ...event, seq: this.seq++, at: Date.now() } as unknown as MiningEvent;
    void broadcastMiningEvent(this.admin, this.userId, full);
  }
}
