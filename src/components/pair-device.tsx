"use client";

import { useActionState } from "react";
import Link from "next/link";
import {
  approveMinerDevice,
  denyMinerDevice,
  revokeMinerDevice,
  type DeviceActionState,
  type PairActionState,
} from "@/app/actions/miner-devices";

const EMPTY: PairActionState = {};
const EMPTY_DEVICE: DeviceActionState = {};

/**
 * Approving a device.
 *
 * The user sees what they are about to authorize -- which machine, which
 * platform, which version -- before they approve it, because "allow this thing
 * you cannot see" is not consent.
 */
export function PairDeviceForm({
  code,
  device,
}: {
  code: string;
  device: { deviceName: string; platform: string; appVersion: string } | null;
}) {
  const [state, action, pending] = useActionState(approveMinerDevice, EMPTY);
  const [denyState, denyAction, denying] = useActionState(denyMinerDevice, EMPTY);

  if (state.message) {
    return (
      <div className="rounded-lg border border-[color-mix(in_srgb,var(--verified)_35%,transparent)] bg-[color-mix(in_srgb,var(--verified)_7%,transparent)] p-5">
        <p className="text-sm text-[var(--verified)]">{state.message}</p>
        <p className="mt-2 text-xs text-[var(--muted)]">
          You can close this tab. {state.deviceName ?? "The device"} will connect on its own.
        </p>
        <Link
          href="/miners"
          className="mt-4 inline-block rounded-md bg-[var(--foreground)] px-4 py-2 text-xs font-medium text-[var(--background)]"
        >
          See my devices
        </Link>
      </div>
    );
  }

  if (denyState.message) {
    return (
      <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5">
        <p className="text-sm text-[var(--muted)]">{denyState.message}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {device && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
          <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--muted)]">
            Approving
          </p>
          <p className="mt-2 text-sm">{device.deviceName}</p>
          <p className="tnum mt-0.5 text-[11px] text-[var(--faint)]">
            {device.platform} · USAGE Miner {device.appVersion}
          </p>
        </div>
      )}

      <form action={action} className="space-y-3">
        <label className="block space-y-1.5">
          <span className="block text-xs text-[var(--muted)]">Code shown by USAGE Miner</span>
          <input
            name="code"
            defaultValue={code}
            required
            autoComplete="off"
            placeholder="ABCD-2345"
            className="tnum w-full rounded-md border border-[var(--border-strong)] bg-[var(--surface-2)] px-3 py-2.5 text-sm tracking-[0.2em] outline-none focus:border-[var(--verified)]"
          />
        </label>

        <button
          type="submit"
          disabled={pending}
          className="w-full rounded-md bg-[var(--foreground)] px-4 py-2.5 text-xs font-medium text-[var(--background)] transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {pending ? "Approving…" : "Approve this device"}
        </button>
        {state.error && <p className="text-[11px] text-[var(--warn)]">{state.error}</p>}
      </form>

      <form action={denyAction}>
        <input type="hidden" name="code" value={code} />
        <button
          type="submit"
          disabled={denying}
          className="text-[11px] text-[var(--muted)] hover:text-[var(--warn)] disabled:opacity-40"
        >
          {denying ? "Rejecting…" : "I did not start this — reject it"}
        </button>
      </form>

      <p className="text-[11px] leading-relaxed text-[var(--faint)]">
        Approving lets this device route your AI requests through USAGE so they can be verified. It
        does not let the device report usage, costs or rewards — those are only ever measured by
        USAGE itself.
      </p>
    </div>
  );
}

export function RevokeDeviceButton({ deviceId }: { deviceId: string }) {
  const [state, action, pending] = useActionState(revokeMinerDevice, EMPTY_DEVICE);

  if (state.message) {
    return (
      <span className="text-[10px] uppercase tracking-[0.1em] text-[var(--reported)]">Revoked</span>
    );
  }

  return (
    <form action={action} className="shrink-0">
      <input type="hidden" name="deviceId" value={deviceId} />
      <button
        type="submit"
        disabled={pending}
        className="rounded-md border border-[var(--border)] px-2.5 py-1 text-[10px] uppercase tracking-[0.1em] text-[var(--muted)] transition-colors hover:border-[var(--warn)] hover:text-[var(--warn)] disabled:opacity-40"
      >
        {pending ? "Revoking…" : "Revoke"}
      </button>
      {state.error && <p className="mt-1 text-[10px] text-[var(--warn)]">{state.error}</p>}
    </form>
  );
}
