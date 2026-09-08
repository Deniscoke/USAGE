import Link from "next/link";
import { redirect } from "next/navigation";
import { AppNav, PrivacyNote } from "@/components/product";
import { RevokeDeviceButton } from "@/components/pair-device";
import { Panel } from "@/components/ui";
import { createServerSupabase } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { MINER_VERSION } from "@/lib/miner/release";
import type { MinerDeviceRow } from "@/lib/supabase/database.types";

export const dynamic = "force-dynamic";

const TOOL_LABELS: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
};

/** Online means it checked in recently. Heartbeats are about once a minute. */
function isOnline(lastSeenAt: string | null): boolean {
  if (!lastSeenAt) return false;
  return Date.now() - new Date(lastSeenAt).getTime() < 5 * 60 * 1000;
}

export default async function MinersPage() {
  if (!isSupabaseConfigured()) redirect("/");

  const supabase = await createServerSupabase();
  if (!supabase) redirect("/");

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/miners");

  // Reads run as the user, so RLS decides what comes back.
  const { data } = await supabase
    .from("miner_devices")
    .select("*")
    .order("created_at", { ascending: false });
  const devices = (data ?? []) as MinerDeviceRow[];

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 sm:px-6">
      <AppNav email={user.email} />

      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-medium tracking-tight">My miners</h1>
          <p className="mt-2 text-sm leading-relaxed text-[var(--muted)]">
            Devices that route your AI tools through USAGE so their compute can be verified.
          </p>
        </div>
        <Link
          href="/miners/install"
          className="rounded-md bg-[var(--foreground)] px-4 py-2 text-xs font-medium text-[var(--background)]"
        >
          Install USAGE Miner
        </Link>
      </div>

      {devices.length === 0 ? (
        <Panel title="No devices yet">
          <p className="text-xs leading-relaxed text-[var(--muted)]">
            Install USAGE Miner on the machine where you use AI. It signs in through your browser,
            so there is no key to copy, finds your AI tools, and routes them through USAGE.
          </p>
          <Link
            href="/miners/install"
            className="mt-4 inline-block rounded-md bg-[var(--foreground)] px-4 py-2 text-xs font-medium text-[var(--background)]"
          >
            Install USAGE Miner {MINER_VERSION}
          </Link>
        </Panel>
      ) : (
        <ul className="space-y-3">
          {devices.map((device) => {
            const revoked = device.revoked_at !== null;
            const online = !revoked && isOnline(device.last_seen_at);
            return (
              <li
                key={device.id}
                className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm">{device.name}</p>
                    <p className="tnum mt-0.5 text-[11px] text-[var(--faint)]">
                      {device.platform} · USAGE Miner {device.app_version}
                      {device.last_seen_at
                        ? ` · last seen ${device.last_seen_at.slice(0, 16).replace("T", " ")}`
                        : " · never connected"}
                    </p>
                    <p className="mt-1.5 text-[11px] text-[var(--muted)]">
                      {device.enabled_tools.length > 0
                        ? `${device.enabled_tools
                            .map((tool) => TOOL_LABELS[tool] ?? tool)
                            .join(", ")} enabled`
                        : "No tools enabled yet"}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <span
                      className="text-[10px] uppercase tracking-[0.1em]"
                      style={{
                        color: revoked
                          ? "var(--reported)"
                          : online
                            ? "var(--verified)"
                            : "var(--faint)",
                      }}
                    >
                      {revoked ? "Revoked" : online ? "Online" : "Offline"}
                    </span>
                    {!revoked && <RevokeDeviceButton deviceId={device.id} />}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div className="mt-6">
        <PrivacyNote />
      </div>
    </main>
  );
}
