import { describe, expect, it } from "vitest";
import { connectionHeadline, type ProviderStatusView } from "./status-view";

/**
 * The sentence a person reads before anything else.
 *
 * Written after the owner looked at his own providers page and asked why
 * OpenAI "cannot be used" and why Anthropic "will not show". Both cards were
 * already correct: OpenAI routes perfectly and is merely held, Anthropic had
 * been disconnected weeks earlier. Thirteen uppercase codes had said so, and
 * none of them had said it.
 */

function view(overrides: Partial<ProviderStatusView> = {}): ProviderStatusView {
  return {
    connection: { state: "active", label: "Connected" },
    credential: "valid",
    models: { discovered: 129, priced: 2 },
    routing: "available",
    usageEvidence: "routed_proof",
    pricing: "available",
    funding: { class: "paid_account", label: "Paid", basis: null },
    economicSource: "metered_paid",
    mining: { outcome: "eligible", label: "Mining eligible", reason: "The provider states this account has purchased credit." },
    privacy: null,
    ...overrides,
  };
}

describe("connectionHeadline", () => {
  it("says a working, earning connection earns", () => {
    const h = connectionHeadline(view());
    expect(h.tone).toBe("earning");
    expect(h.title).toMatch(/earns/i);
  });

  it("never lets 'held' read as broken", () => {
    // OpenAI: connected, routable, priced, proven — and held, because an API
    // key says nothing about who paid for the account behind it.
    const h = connectionHeadline(
      view({
        funding: { class: "unknown", label: "Unknown", basis: null },
        economicSource: "unknown",
        mining: { outcome: "held", label: "Mining held", reason: "USAGE cannot yet establish the funding source." },
      }),
    );
    expect(h.tone).toBe("working");
    expect(h.title).toMatch(/^Working/);
    expect(h.title).toMatch(/does not earn/i);
    expect(h.detail).toBe("USAGE cannot yet establish the funding source.");
    // The words that would make a correct state look like a fault.
    expect(`${h.title} ${h.detail}`).not.toMatch(/error|broken|failed|unsupported/i);
  });

  it("says a disconnected connection was disconnected, and how to revive it", () => {
    // Anthropic: revoked on 2026-09-08, never validated. The card said
    // DISCONNECTED and left the reader to guess whether it had broken.
    const h = connectionHeadline(view({ connection: { state: "revoked", label: "Disconnected" } }));
    expect(h.tone).toBe("disconnected");
    expect(h.detail).toMatch(/reconnect/i);
    expect(h.detail).toMatch(/history stays/i);
  });

  it("tells a refused key apart from a connection nobody finished", () => {
    const rejected = connectionHeadline(view({ credential: "rejected", connection: { state: "invalid_credentials", label: "Invalid credentials" } }));
    expect(rejected.title).toMatch(/refused/i);

    const unfinished = connectionHeadline(view({ connection: { state: "validating", label: "Saved — validation incomplete" }, credential: "unverified" }));
    expect(unfinished.title).toMatch(/never finished/i);
  });

  it("says nothing can be measured when nothing can be routed", () => {
    const h = connectionHeadline(view({ routing: "unsupported" }));
    expect(h.tone).toBe("blocked");
    expect(h.detail).toMatch(/cannot route/i);
  });

  it("keeps 'connected' and 'earning' as separate words in every state", () => {
    const states: ProviderStatusView[] = [
      view(),
      view({ mining: { outcome: "held", label: "held", reason: "r" } }),
      view({ mining: { outcome: "ineligible", label: "no", reason: "Free inference never earns." } }),
      view({ connection: { state: "revoked", label: "Disconnected" } }),
    ];
    for (const v of states) {
      const h = connectionHeadline(v);
      expect(h.title.length).toBeGreaterThan(0);
      expect(h.detail.length).toBeGreaterThan(0);
    }
  });
});
