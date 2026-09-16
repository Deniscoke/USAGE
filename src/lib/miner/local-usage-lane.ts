/**
 * The subscription / local usage lane (M17A).
 *
 * Usage a device observes on its own -- Claude Code on a Claude Max login,
 * Codex on a ChatGPT login, Gemini CLI on a Google account -- reaches USAGE
 * only as local telemetry. It is shown to its owner and used in analytics. It
 * is never Economic Compute: no source, verification level or client field can
 * lift it into mining, network share, a reward estimate or a claim.
 *
 * One definition, so every surface that shows this lane says the same thing
 * and none of them can call it verified.
 */
export const LOCAL_USAGE_LANE = {
  source: "local_telemetry",
  verification: "local_only",
  economicAuthority: "none",
  reward: 0,
  claimable: false,
  /** The word the UI uses. Never "verified", never "mining". */
  label: "Tracked",
  title: "Local subscription usage",
  explanation:
    "USAGE can measure this usage on your PC, but it cannot independently verify the subscription billing, so it does not earn Usage Points.",
} as const;
