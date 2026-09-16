import { MINING_EVENT_NAMES, miningTopic } from "./events";
import type { RealtimeStatus } from "./controller";
import { LOCAL_TRACKING_EVENT_NAME } from "./local-tracking";

/**
 * One private Realtime channel per user, shared by every live widget on the
 * page (M17B).
 *
 * Why this exists: supabase-js hands back the SAME channel object for the
 * same topic, and a second `subscribe()` on a joined channel never calls its
 * callback, while `removeChannel` from one widget tears the channel down for
 * the other. The live mining card and the local tracking strip both listen on
 * `mining:<uid>` (the only topic migration 0021 authorises), so they share
 * one channel here: bound once to every known event name, subscribed once,
 * reference-counted, removed when the last listener leaves.
 *
 * Framework-free, and every failure becomes a "disconnected" status rather
 * than a throw, so a transport problem cannot unmount a page.
 */

export const USER_CHANNEL_EVENT_NAMES = [...MINING_EVENT_NAMES, LOCAL_TRACKING_EVENT_NAME] as const;
export type UserChannelEventName = (typeof USER_CHANNEL_EVENT_NAMES)[number];

export interface ChannelLike {
  on(type: "broadcast", filter: { event: string }, callback: (message: { payload?: unknown }) => void): unknown;
  subscribe(callback: (status: string) => void): unknown;
}

export interface RealtimeClientLike {
  channel(topic: string, options: { config: { private: boolean } }): ChannelLike;
  removeChannel(channel: ChannelLike): unknown;
}

export interface UserChannelListener {
  events: Partial<Record<UserChannelEventName, (payload: unknown) => void>>;
  onStatus?: (status: RealtimeStatus) => void;
}

interface Entry {
  client: RealtimeClientLike;
  channel: ChannelLike;
  listeners: Set<UserChannelListener>;
  status: RealtimeStatus;
  teardown: ReturnType<typeof setTimeout> | null;
}

const entries = new Map<string, Entry>();

export function statusFromRealtime(status: string): RealtimeStatus {
  if (status === "SUBSCRIBED") return "connected";
  if (status === "CLOSED" || status === "CHANNEL_ERROR" || status === "TIMED_OUT") return "disconnected";
  return "unknown";
}

function later(fn: () => void): void {
  // Deferred so a status never lands synchronously inside a React effect.
  Promise.resolve().then(fn).catch(() => undefined);
}

function notifyStatus(listener: UserChannelListener, status: RealtimeStatus): void {
  try {
    listener.onStatus?.(status);
  } catch {
    // a listener's own error is its own
  }
}

/**
 * Join (or share) the user's private channel. Returns a release function;
 * calling it more than once is harmless.
 */
export function acquireUserChannel(client: RealtimeClientLike | null, userId: string, listener: UserChannelListener): () => void {
  if (!client) {
    later(() => notifyStatus(listener, "disconnected"));
    return () => undefined;
  }
  const topic = miningTopic(userId);
  let entry = entries.get(topic);

  if (!entry || entry.client !== client) {
    try {
      const channel = client.channel(topic, { config: { private: true } });
      const created: Entry = { client, channel, listeners: new Set(), status: "unknown", teardown: null };
      for (const name of USER_CHANNEL_EVENT_NAMES) {
        channel.on("broadcast", { event: name }, (message) => {
          for (const l of [...created.listeners]) {
            try {
              l.events[name]?.(message?.payload);
            } catch {
              // a malformed event is ignored by that listener only
            }
          }
        });
      }
      entries.set(topic, created);
      entry = created;
      channel.subscribe((raw) => {
        created.status = statusFromRealtime(raw);
        for (const l of [...created.listeners]) notifyStatus(l, created.status);
      });
    } catch {
      entries.delete(topic);
      later(() => notifyStatus(listener, "disconnected"));
      return () => undefined;
    }
  }

  const joined = entry;
  if (joined.teardown) {
    clearTimeout(joined.teardown);
    joined.teardown = null;
  }
  joined.listeners.add(listener);
  if (joined.status !== "unknown") {
    const status = joined.status;
    later(() => {
      if (joined.listeners.has(listener)) notifyStatus(listener, status);
    });
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    joined.listeners.delete(listener);
    if (joined.listeners.size > 0) return;
    // A short grace before leaving: a remount (React Strict Mode, or moving
    // between two pages that both show a live strip) re-joins the same
    // channel instead of racing a half-closed one supabase-js would hand back.
    if (joined.teardown) clearTimeout(joined.teardown);
    joined.teardown = setTimeout(() => {
      joined.teardown = null;
      if (joined.listeners.size > 0) return;
      if (entries.get(topic) === joined) entries.delete(topic);
      try {
        Promise.resolve(joined.client.removeChannel(joined.channel)).catch(() => undefined);
      } catch {
        // nothing to clean
      }
    }, RELEASE_GRACE_MS);
  };
}

/** How long an unused channel stays joined in case a widget remounts. */
export const RELEASE_GRACE_MS = 1_500;

/** Test seam: forget every shared channel. */
export function resetUserChannels(): void {
  for (const entry of entries.values()) if (entry.teardown) clearTimeout(entry.teardown);
  entries.clear();
}
