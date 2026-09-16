import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LOCAL_TRACKING_EVENT_KEYS,
  LOCAL_TRACKING_EVENT_NAME,
  MAX_LOCAL_TRACKING_EVENTS_PER_UPLOAD,
  buildLocalTrackingEvents,
  parseLocalTrackingEvent,
  type StoredLocalObservation,
} from "./local-tracking";
import { broadcastLocalTracking } from "./broadcast";
import { MINING_EVENT_NAMES, miningTopic } from "./events";
import { RELEASE_GRACE_MS, acquireUserChannel, resetUserChannels, statusFromRealtime, type ChannelLike, type RealtimeClientLike } from "./user-channel";

/**
 * M17B -- the live "tracked" hint. It says what was tracked and nothing it
 * could be paid for; it is skipped when there is nothing to say; and it can
 * fail in every way without failing anything else.
 */

function stored(over: Partial<StoredLocalObservation> = {}): StoredLocalObservation {
  return {
    tool: "claude-code",
    model: "claude-opus-5",
    inputTokens: 2,
    outputTokens: 18,
    cacheReadTokens: 28_726,
    cacheWriteTokens: null,
    reasoningTokens: null,
    occurredAt: "2026-09-17T10:00:00.000Z",
    correlationStatus: "none",
    ...over,
  };
}

const ECONOMIC = /reward|eligib|claim|point|economic|score|mining|earn|cost|price|proof|verif|status|funding|epoch|compute|id$|session|device|user|request_?id/i;

describe("event shape", () => {
  it("has a closed key set with no economic, identity or status field", () => {
    const [event] = buildLocalTrackingEvents([stored()]);
    expect(Object.keys(event).sort()).toEqual([...LOCAL_TRACKING_EVENT_KEYS].sort());
    for (const key of Object.keys(event)) expect(key, key).not.toMatch(ECONOMIC);
    expect(event.name).toBe("tracking.local.observed");
    expect(event.name).not.toMatch(/mining/);
    expect((MINING_EVENT_NAMES as readonly string[]).includes(event.name)).toBe(false);
  });

  it("groups by tool and model, sums known deltas and keeps unknown as null", () => {
    const events = buildLocalTrackingEvents([
      stored(),
      stored({ inputTokens: 3, cacheWriteTokens: null, occurredAt: "2026-09-17T10:00:05.000Z" }),
      stored({ tool: "codex", model: null, inputTokens: 100, outputTokens: 10, cacheReadTokens: null, reasoningTokens: 4 }),
    ]);
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      name: LOCAL_TRACKING_EVENT_NAME,
      tool: "claude-code",
      model: "claude-opus-5",
      inputTokens: 5,
      outputTokens: 36,
      cacheReadTokens: 57_452,
      cacheWriteTokens: null,
      reasoningTokens: null,
      requests: 2,
      occurredAt: "2026-09-17T10:00:05.000Z",
    });
    expect(events[1]).toMatchObject({ tool: "codex", model: null, cacheReadTokens: null, reasoningTokens: 4, requests: 1 });
  });

  it("leaves matched observations out: that compute is the verified lane's", () => {
    expect(buildLocalTrackingEvents([stored({ correlationStatus: "matched" })])).toEqual([]);
    expect(buildLocalTrackingEvents([stored({ correlationStatus: "conflict" })])).toHaveLength(1);
  });

  it("is bounded per upload", () => {
    const many = Array.from({ length: 20 }, (_, i) => stored({ model: `model-${i}` }));
    expect(buildLocalTrackingEvents(many)).toHaveLength(MAX_LOCAL_TRACKING_EVENTS_PER_UPLOAD);
  });

  it("the browser rebuilds the event from known keys and drops anything smuggled", () => {
    const [event] = buildLocalTrackingEvents([stored()]);
    const parsed = parseLocalTrackingEvent({ ...event, rewardPoints: 100, eligibleComputeMicros: 5, requestId: "req_1" });
    expect(parsed).toEqual(event);
    expect(Object.keys(parsed!)).not.toContain("rewardPoints");
  });

  it("the browser refuses anything that is not this event", () => {
    const [event] = buildLocalTrackingEvents([stored()]);
    expect(parseLocalTrackingEvent(null)).toBeNull();
    expect(parseLocalTrackingEvent({ ...event, name: "mining.request.verified" })).toBeNull();
    expect(parseLocalTrackingEvent({ ...event, inputTokens: -1 })).toBeNull();
    expect(parseLocalTrackingEvent({ ...event, inputTokens: "5" })).toBeNull();
    expect(parseLocalTrackingEvent({ ...event, requests: 0 })).toBeNull();
    expect(parseLocalTrackingEvent({ ...event, occurredAt: "yesterday" })).toBeNull();
  });
});

describe("broadcast", () => {
  function fakeAdmin(behaviour: { channelThrows?: boolean; sendRejects?: boolean; removeRejects?: boolean } = {}) {
    const sent: Array<{ topic: string; event: string; payload: unknown }> = [];
    const removed: unknown[] = [];
    const channelSpy = vi.fn((topic: string) => {
      if (behaviour.channelThrows) throw new Error("no realtime");
      return {
        httpSend: vi.fn(async (event: string, payload: unknown) => {
          if (behaviour.sendRejects) throw new Error("503");
          sent.push({ topic, event, payload });
          return { success: true };
        }),
      };
    });
    const admin = {
      channel: channelSpy,
      removeChannel: vi.fn(async (c: unknown) => {
        removed.push(c);
        if (behaviour.removeRejects) throw new Error("gone");
        return "ok";
      }),
    };
    return { admin: admin as never, sent, removed, channelSpy };
  }

  it("is skipped entirely when there is nothing to say: no channel, no request", async () => {
    const { admin, channelSpy } = fakeAdmin();
    await expect(broadcastLocalTracking(admin, "u1", [])).resolves.toEqual({ sent: 0, failed: 0, skipped: true });
    expect(channelSpy).not.toHaveBeenCalled();
  });

  it("sends on the user's own private topic under the tracking event name, and cleans up", async () => {
    const { admin, sent, removed, channelSpy } = fakeAdmin();
    const events = buildLocalTrackingEvents([stored(), stored({ tool: "codex", model: null })]);
    await expect(broadcastLocalTracking(admin, "u1", events)).resolves.toEqual({ sent: 2, failed: 0, skipped: false });
    expect(channelSpy).toHaveBeenCalledWith(miningTopic("u1"), { config: { private: true } });
    expect(sent.map((s) => [s.topic, s.event])).toEqual([
      ["mining:u1", "tracking.local.observed"],
      ["mining:u1", "tracking.local.observed"],
    ]);
    expect(removed).toHaveLength(1);
  });

  it("never throws when the channel cannot be created, a send fails, or cleanup fails", async () => {
    const events = buildLocalTrackingEvents([stored()]);
    await expect(broadcastLocalTracking(fakeAdmin({ channelThrows: true }).admin, "u1", events)).resolves.toEqual({ sent: 0, failed: 1, skipped: false });
    await expect(broadcastLocalTracking(fakeAdmin({ sendRejects: true }).admin, "u1", events)).resolves.toEqual({ sent: 0, failed: 1, skipped: false });
    await expect(broadcastLocalTracking(fakeAdmin({ removeRejects: true }).admin, "u1", events)).resolves.toEqual({ sent: 1, failed: 0, skipped: false });
  });
});

describe("shared user channel", () => {
  afterEach(() => resetUserChannels());

  function fakeClient() {
    const bindings = new Map<string, (message: { payload?: unknown }) => void>();
    let statusCallback: ((status: string) => void) | null = null;
    const channel: ChannelLike = {
      on: vi.fn((_type, filter, cb) => {
        bindings.set(filter.event, cb);
        return channel;
      }),
      subscribe: vi.fn((cb) => {
        statusCallback = cb;
        return channel;
      }),
    };
    const client = { channel: vi.fn(() => channel), removeChannel: vi.fn(async () => "ok") };
    return {
      client: client as unknown as RealtimeClientLike & typeof client,
      channel,
      emit: (event: string, payload: unknown) => bindings.get(event)?.({ payload }),
      status: (s: string) => statusCallback?.(s),
    };
  }

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("two widgets share one channel, one subscribe, and each gets only its events", async () => {
    const f = fakeClient();
    const mining = vi.fn();
    const local = vi.fn();
    const statuses: string[] = [];
    const releaseMining = acquireUserChannel(f.client, "u1", { events: { "mining.request.started": mining }, onStatus: (s) => statuses.push(`m:${s}`) });
    const releaseLocal = acquireUserChannel(f.client, "u1", { events: { "tracking.local.observed": local }, onStatus: (s) => statuses.push(`l:${s}`) });
    expect(f.client.channel).toHaveBeenCalledTimes(1);
    expect(f.channel.subscribe).toHaveBeenCalledTimes(1);

    f.status("SUBSCRIBED");
    f.emit("tracking.local.observed", { x: 1 });
    f.emit("mining.request.started", { y: 2 });
    expect(local).toHaveBeenCalledWith({ x: 1 });
    expect(mining).toHaveBeenCalledWith({ y: 2 });
    expect(local).toHaveBeenCalledTimes(1);
    expect(mining).toHaveBeenCalledTimes(1);
    expect(statuses).toEqual(["m:connected", "l:connected"]);

    vi.useFakeTimers();
    try {
      releaseMining();
      releaseLocal();
      releaseLocal();
      // A grace period first, so a remount re-joins instead of racing a closing channel.
      expect(f.client.removeChannel).not.toHaveBeenCalled();
      vi.advanceTimersByTime(RELEASE_GRACE_MS);
      expect(f.client.removeChannel).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a remount within the grace period reuses the joined channel", () => {
    vi.useFakeTimers();
    try {
      const f = fakeClient();
      const release = acquireUserChannel(f.client, "u1", { events: {} });
      release();
      vi.advanceTimersByTime(RELEASE_GRACE_MS - 1);
      const again = acquireUserChannel(f.client, "u1", { events: {} });
      vi.advanceTimersByTime(RELEASE_GRACE_MS * 2);
      expect(f.client.channel).toHaveBeenCalledTimes(1);
      expect(f.channel.subscribe).toHaveBeenCalledTimes(1);
      expect(f.client.removeChannel).not.toHaveBeenCalled();
      again();
      vi.advanceTimersByTime(RELEASE_GRACE_MS);
      expect(f.client.removeChannel).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a late joiner is told the current status", async () => {
    const f = fakeClient();
    const release = acquireUserChannel(f.client, "u1", { events: {} });
    f.status("SUBSCRIBED");
    const late: string[] = [];
    const releaseLate = acquireUserChannel(f.client, "u1", { events: {}, onStatus: (s) => late.push(s) });
    await flush();
    expect(late).toEqual(["connected"]);
    release();
    releaseLate();
  });

  it("a listener that throws does not stop the others", () => {
    const f = fakeClient();
    const ok = vi.fn();
    acquireUserChannel(f.client, "u1", { events: { "tracking.local.observed": () => { throw new Error("bad"); } } });
    acquireUserChannel(f.client, "u1", { events: { "tracking.local.observed": ok } });
    f.emit("tracking.local.observed", {});
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it("no client or a throwing client becomes 'disconnected', never an exception", async () => {
    const statuses: string[] = [];
    expect(() => acquireUserChannel(null, "u1", { events: {}, onStatus: (s) => statuses.push(s) })()).not.toThrow();
    const broken = { channel: () => { throw new Error("socket"); }, removeChannel: () => undefined } as unknown as RealtimeClientLike;
    expect(() => acquireUserChannel(broken, "u1", { events: {}, onStatus: (s) => statuses.push(s) })()).not.toThrow();
    await flush();
    expect(statuses).toEqual(["disconnected", "disconnected"]);
    expect(statusFromRealtime("TIMED_OUT")).toBe("disconnected");
    expect(statusFromRealtime("JOINING")).toBe("unknown");
  });
});
