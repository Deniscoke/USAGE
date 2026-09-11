import Link from "next/link";
import { redirect } from "next/navigation";
import { AppNav, PrivacyNote } from "@/components/product";
import { Panel } from "@/components/ui";
import { DeviceCard } from "@/components/miner-device";
import { createServerSupabase } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { MINER_VERSION } from "@/lib/miner/release";
import { loadDeviceViews } from "@/lib/miner/device-view";

export const dynamic = "force-dynamic";

export default async function MinersPage() {
  if (!isSupabaseConfigured()) redirect("/");

  const supabase = await createServerSupabase();
  if (!supabase) redirect("/");

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/miners");

  // Reads run as the user, so RLS decides what comes back.
  const devices = await loadDeviceViews(supabase, user.id);

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 sm:px-6">
      <AppNav email={user.email} />

      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-medium tracking-tight">My miners</h1>
          <p className="mt-2 text-sm leading-relaxed text-[var(--muted)]">
            Computers that meter the AI apps you chose. USAGE maps supported AI usage automatically;
            we measure compute metadata, not conversations. Verified compute can earn USAGE.
          </p>
        </div>
        <Link
          href="/download"
          className="rounded-md bg-[var(--foreground)] px-4 py-2 text-xs font-medium text-[var(--background)]"
        >
          Install USAGE Miner
        </Link>
      </div>

      {devices.length === 0 ? (
        <Panel title="No devices yet">
          <p className="text-xs leading-relaxed text-[var(--muted)]">
            Install USAGE Miner on the computer where you use AI. Sign in through your browser,
            choose which AI apps it may meter, and use them normally. Usage appears here.
          </p>
          <Link
            href="/download"
            className="mt-4 inline-block rounded-md bg-[var(--foreground)] px-4 py-2 text-xs font-medium text-[var(--background)]"
          >
            Install USAGE Miner {MINER_VERSION}
          </Link>
        </Panel>
      ) : (
        <ul className="space-y-3">
          {devices.map((view) => (
            <DeviceCard key={view.device.id} view={view} />
          ))}
        </ul>
      )}

      <div className="mt-6">
        <PrivacyNote />
      </div>
    </main>
  );
}
