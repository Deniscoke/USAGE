import type { MiningEventName, MiningState } from "./events";

/**
 * Transport and repaint policy for the live card, kept out of React so it
 * can be tested as plain logic:
 *
 *   - the 1 s repaint is LOCAL and runs only while a request is live and the
 *     tab is visible; it never touches the network;
 *   - when Realtime is disconnected the card polls the authenticated summary
 *     every `fallbackIntervalMs` (5 s) while visible, and stops the moment
 *     Realtime is back; it never polls every second;
 *   - an authoritative outcome event, or the tab becoming visible again,
 *     triggers exactly one summary refetch so the totals reconcile even if an
 *     event was missed.
 */
export type RealtimeStatus = "unknown" | "connected" | "disconnected";

export class LiveController {
  private realtime: RealtimeStatus = "unknown";
  private visible = true;

  constructor(private readonly options: { fallbackIntervalMs: number }) {}

  setRealtime(status: RealtimeStatus): void {
    this.realtime = status;
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
  }

  /** 0 = do not poll. */
  pollIntervalMs(): number {
    return this.realtime === "disconnected" && this.visible ? this.options.fallbackIntervalMs : 0;
  }

  /** 0 = do not repaint on a timer. */
  tickIntervalMs(state: MiningState): number {
    if (!this.visible) return 0;
    return state === "MINING_LIVE" || state === "VERIFYING" ? 1000 : 0;
  }

  banner(): string | null {
    return this.realtime === "disconnected" ? "LIVE UPDATES RECONNECTING" : null;
  }

  shouldRefetchAfter(event: MiningEventName): boolean {
    return event === "mining.request.verified" || event === "mining.request.held" || event === "mining.request.ineligible" || event === "mining.request.failed";
  }

  /** Called when the tab becomes visible again: one refetch, then resume. */
  onVisibilityRestored(): boolean {
    this.visible = true;
    return true;
  }
}
