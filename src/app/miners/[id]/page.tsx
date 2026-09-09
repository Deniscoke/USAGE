import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AppNav, PrivacyNote } from "@/components/product";
import { Panel } from "@/components/ui";
import { ActivityFeed, DeviceStatus, TodayFigures, ToolTable } from "@/components/miner-device";
import { RevokeDeviceButton } from "@/components/pair-device";
import { createServerSupabase } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { loadDeviceViews } from "@/lib/miner/device-view";

export const dynamic = "force-dynamic";

/**
 * One device: what it maps, what USAGE reads from each app, and where each
 * app's usage can sit on the verification ladder.
 *
 * Everything on this page is derived server-side. The device contributed the
 * facts a device may contribute -- it exists, it saw these apps, the user
 * opted these in -- and nothing else.
 */
export default async function DevicePage({ params }: { params: Promise<{ id: string }> }) {
  if (!isSupabaseConfigured()) redirect("/");
  const supabase = await createServerSupabase();
  if (!supabase) redirect("/");

  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { id } = await params;
  if (!user) redirect(`/login?next=/miners/${id}`);

  const [view] = await loadDeviceViews(supabase, user.id, { deviceId: id });
  if (!view) notFound();

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 sm:px-6">
      <AppNav email={user.email} />

      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[10px] uppercase tracking-[0.16em] text-[var(--faint)]">USAGE Miner</p>
          <h1 className="mt-1 text-2xl font-medium tracking-tight">{view.device.name}</h1>
          <p className="tnum mt-1 text-[11px] text-[var(--faint)]">
            {view.device.os ?? view.device.platform} · version {view.device.app_version}
            {view.attested ? " · device key registered" : " · no device key yet"}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <DeviceStatus view={view} />
          {!view.revoked && <RevokeDeviceButton deviceId={view.device.id} />}
        </div>
      </div>

      <div className="space-y-3">
        <Panel title="Today" hint="Three numbers, on purpose">
          <TodayFigures view={view} />
          <p className="mt-3 text-[10px] leading-relaxed text-[var(--faint)]">
            Tracked is what your apps reported to USAGE Miner. Verified is what USAGE could confirm
            with a record of its own. Reward-eligible is what the current policy admits to mining —
            free compute and anything only your device vouches for stay at zero.
          </p>
        </Panel>

        <Panel title="AI apps on this device" hint="From the server's registry, not the device">
          <ToolTable tools={view.tools} />
        </Panel>

        <Panel title="Activity today">
          <ActivityFeed view={view} />
          <p className="mt-3 text-[10px] leading-relaxed text-[var(--faint)]">
            A TRACKED line can later become VERIFIED if its request id exactly matches a record USAGE
            trusts. That upgrades the same compute&apos;s provenance; it never creates a second reward.
          </p>
        </Panel>
      </div>

      <div className="mt-6 space-y-3">
        <PrivacyNote />
        <Link href="/miners" className="inline-block text-xs text-[var(--routed)] hover:underline">
          ← My miners
        </Link>
      </div>
    </main>
  );
}
