"use client";

import { useEffect } from "react";
import { reportClientError } from "@/lib/live/diagnostics";

/**
 * Route-segment error boundary for /dashboard (M16B.1). Replaces Next's
 * generic "This page couldn't load" with a recovery UI that keeps the person
 * oriented, logs safe metadata, and offers a soft retry and a full reload.
 */
export default function DashboardError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    reportClientError("dashboard-route", error);
  }, [error]);

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-12 sm:px-6">
      <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-[var(--warn)]">Dashboard hit an error</p>
      <h1 className="mt-2 text-xl tracking-tight">Your mining data is safe.</h1>
      <p className="mt-3 text-sm leading-relaxed text-[var(--muted)]">
        Every balance, proof and epoch is persisted and signed on the server; nothing here is lost. The page failed to render in the browser.
        {error.digest ? ` Reference: ${error.digest}.` : ""}
      </p>
      <div className="mt-5 flex flex-wrap gap-2">
        <button type="button" onClick={() => reset()} className="rounded-md bg-[var(--foreground)] px-4 py-2 text-xs font-medium text-[var(--background)] hover:opacity-90">
          Retry
        </button>
        <a href="/dashboard" className="rounded-md border border-[var(--border)] px-4 py-2 text-xs text-[var(--muted)] hover:border-[var(--border-strong)] hover:text-[var(--foreground)]">
          Reload the dashboard
        </a>
      </div>
    </main>
  );
}
