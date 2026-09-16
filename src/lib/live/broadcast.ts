import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { miningTopic, type MiningEvent } from "./events";
import type { LocalTrackingEvent } from "./local-tracking";

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

/**
 * Local tracking hints (M17B), on the same private per-user topic -- the only
 * one the 0021 policy authorises -- under their own event name.
 *
 * Best-effort in every direction: no events means no channel is opened; a
 * failure to create the channel, to send, or to clean up is swallowed. The
 * caller runs this after the upload response is built, so it can neither fail
 * nor delay an upload. It performs no database write.
 */
export async function broadcastLocalTracking(
  admin: Pick<SupabaseClient<Database>, "channel" | "removeChannel">,
  userId: string,
  events: readonly LocalTrackingEvent[],
): Promise<{ sent: number; failed: number; skipped: boolean }> {
  if (events.length === 0) return { sent: 0, failed: 0, skipped: true };
  let sent = 0;
  let failed = 0;
  let channel: ReturnType<SupabaseClient<Database>["channel"]> | null = null;
  try {
    channel = admin.channel(miningTopic(userId), { config: { private: true } });
    for (const event of events) {
      try {
        const result = await channel.httpSend(event.name, event as unknown as Record<string, unknown>);
        if (result && typeof result === "object" && "success" in result && result.success === false) failed += 1;
        else sent += 1;
      } catch {
        failed += 1;
      }
    }
  } catch {
    failed = events.length - sent;
  } finally {
    try {
      if (channel) await admin.removeChannel(channel);
    } catch {
      // nothing to clean
    }
  }
  return { sent, failed, skipped: false };
}

/** Per-request event sequencing, kept on the server for the request's lifetime. */
export class MiningEventSequencer {
  private seq = 0;
  constructor(private readonly admin: SupabaseClient<Database> | null, private readonly userId: string, private base: { requestId: string; route: string; provider: string; model: string | null }) {}

  /** The route is known only after the gateway resolves; later events carry it. */
  setRoute(route: string, provider: string): void {
    this.base = { ...this.base, route, provider };
  }

  emit<E extends MiningEvent>(event: Omit<E, keyof import("./events").MiningEventBase> & { name: E["name"] }): void {
    if (!this.admin) return;
    const full = { ...this.base, ...event, seq: this.seq++, at: Date.now() } as unknown as MiningEvent;
    void broadcastMiningEvent(this.admin, this.userId, full);
  }
}
