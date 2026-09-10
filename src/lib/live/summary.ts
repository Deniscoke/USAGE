import type { DashboardData } from "@/lib/pipeline/dashboard";
import type { DeviceView } from "@/lib/miner/device-view";

/**
 * The authoritative mining summary the live card renders and reconciles to.
 * Every number here comes from persisted rows through the same builder the
 * server-rendered dashboard uses; nothing is estimated except the open
 * epoch's preview, which is labelled as such.
 */
export interface MiningSummary {
  generatedAt: string;
  miner: { online: boolean; lastSeenAt: string | null; devices: number };
  route: {
    /** An economically eligible route exists (a connection whose mining outcome is eligible). */
    eligible: boolean;
    /** Connected routes, eligible or not. */
    connected: number;
    label: string | null;
  };
  lastProofAt: string | null;
  today: { computeMicros: number; inputTokens: number; cachedInputTokens: number; outputTokens: number; requests: number };
  scoring: { version: string; totalPoints: number };
  epoch: {
    id: string;
    state: string;
    userScore: number;
    networkShare: number;
    networkParticipants: number;
    /** Open epoch only. Null when the epoch is settled or finalizing. */
    estimatedPoints: number | null;
    /** Persisted allocation for a settled epoch; null while open. */
    settledPoints: number | null;
    label: string;
    protocolVersion: string;
    emissionAlgorithm: string;
    scheduledPoints: number;
  };
  protocol: { headline: string; scoringLabel: string; emissionLabel: string };
  settledPoints: number;
}

export function buildMiningSummary(view: DashboardData, devices: readonly DeviceView[], now: Date): MiningSummary {
  const online = devices.filter((d) => d.online && !d.revoked);
  const lastSeen = devices.map((d) => d.device.last_seen_at).filter((x): x is string => Boolean(x)).sort().at(-1) ?? null;
  const eligible = view.connections.filter((c) => c.eligibleRoute);
  const connected = view.connections.filter((c) => c.status === "active");
  return {
    generatedAt: now.toISOString(),
    miner: { online: online.length > 0, lastSeenAt: lastSeen, devices: devices.filter((d) => !d.revoked).length },
    route: { eligible: eligible.length > 0, connected: connected.length, label: eligible[0]?.label ?? connected[0]?.label ?? null },
    lastProofAt: view.mining.lastProofAt,
    today: {
      computeMicros: view.protocolComputeMicros,
      inputTokens: view.today.inputTokens,
      cachedInputTokens: view.today.cachedInputTokens,
      outputTokens: view.today.outputTokens,
      requests: view.today.requests,
    },
    scoring: { version: view.scoring.version, totalPoints: view.scoring.totalPoints },
    epoch: {
      id: view.epoch.definition.id,
      state: view.epoch.state,
      userScore: view.epoch.userScore,
      networkShare: view.epoch.networkShare,
      networkParticipants: view.epoch.networkParticipants,
      estimatedPoints: view.epoch.state === "open" ? view.epoch.estimatedPoints : null,
      settledPoints: view.epoch.settledPoints,
      label: view.epoch.label,
      protocolVersion: view.epoch.definition.protocolVersion ?? view.protocol.version,
      emissionAlgorithm: view.protocol.status.current.emissionAlgorithm,
      scheduledPoints: view.protocol.emissionPoints,
    },
    protocol: { headline: view.protocol.status.headline, scoringLabel: view.protocol.status.scoringLabel, emissionLabel: view.protocol.status.emissionLabel },
    settledPoints: view.settledPoints,
  };
}
