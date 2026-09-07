"use client";

import { useActionState } from "react";
import { loadDemoUsage, type DemoIngestState } from "@/app/dashboard/actions";

interface DemoIngestButtonProps {
  label?: string;
}

export function DemoIngestButton({ label = "Load demo usage" }: DemoIngestButtonProps) {
  const [state, action, pending] = useActionState<DemoIngestState, FormData>(
    async () => loadDemoUsage(),
    {},
  );

  return (
    <form action={action} className="flex flex-wrap items-center gap-3">
      <button
        type="submit"
        disabled={pending}
        className="rounded-md border border-[var(--border-strong)] px-3 py-1.5 text-xs transition-colors hover:border-[var(--verified)] disabled:opacity-50"
      >
        {pending ? "Ingesting…" : label}
      </button>
      {state.message && <span className="text-xs text-[var(--verified)]">{state.message}</span>}
      {state.error && <span className="text-xs text-[var(--warn)]">{state.error}</span>}
    </form>
  );
}
