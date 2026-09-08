import { redirect } from "next/navigation";
import { AppNav } from "@/components/product";
import { PairDeviceForm } from "@/components/pair-device";
import { createServerSupabase } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { createPairingStore } from "@/lib/miner/pairing";

export const dynamic = "force-dynamic";

/**
 * Approve a device.
 *
 * Reached from the miner, which opens this URL with the code already filled in.
 * Sign-in is required, and the signed-in user is the one the device becomes
 * bound to: the device has no say in whose account it joins.
 */
export default async function PairPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string }>;
}) {
  const { code = "" } = await searchParams;
  if (!isSupabaseConfigured()) redirect("/");

  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = (await supabase?.auth.getUser()) ?? { data: { user: null } };
  if (!user) {
    redirect(`/login?next=${encodeURIComponent(`/pair${code ? `?code=${code}` : ""}`)}`);
  }

  // Shown so the user knows what they are authorizing. A missing request is not
  // an error here: they may simply be about to type the code.
  const device = code ? await createPairingStore(createAdminSupabase()).lookup(code) : null;

  return (
    <main className="mx-auto w-full max-w-md flex-1 px-4 py-8 sm:px-6">
      <AppNav email={user.email} />

      <h1 className="text-2xl font-medium tracking-tight">Connect a device</h1>
      <p className="mt-2 mb-6 text-sm leading-relaxed text-[var(--muted)]">
        USAGE Miner is asking to connect to your account.
      </p>

      <PairDeviceForm
        code={device?.userCode ?? code}
        device={
          device
            ? {
                deviceName: device.deviceName,
                platform: device.platform,
                appVersion: device.appVersion,
              }
            : null
        }
      />
    </main>
  );
}
