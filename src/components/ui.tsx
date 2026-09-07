import type { ReactNode } from "react";
import type { VerificationType } from "@/lib/domain/types";

export const VERIFICATION_META: Record<
  VerificationType,
  { label: string; color: string; weight: string; blurb: string }
> = {
  verified: {
    label: "Verified",
    color: "var(--verified)",
    weight: "1.0",
    blurb: "From an authoritative provider usage or billing API.",
  },
  routed: {
    label: "Routed",
    color: "var(--routed)",
    weight: "1.0",
    blurb: "Observed directly by USAGE-operated infrastructure.",
  },
  reported: {
    label: "Reported",
    color: "var(--reported)",
    weight: "0.0",
    blurb: "Self-reported by a client or import. Shown, but not rewarded.",
  },
};

export function Panel({
  title,
  hint,
  action,
  children,
  className = "",
}: {
  title?: string;
  hint?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-lg border border-[var(--border)] bg-[var(--surface)] ${className}`}
    >
      {title && (
        <header className="flex items-baseline justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
          <div>
            <h2 className="text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--muted)]">
              {title}
            </h2>
            {hint && <p className="mt-1 text-xs text-[var(--faint)]">{hint}</p>}
          </div>
          {action}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Stat({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: string;
}) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-3.5">
      <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-[var(--faint)]">
        {label}
      </p>
      <p
        className="tnum mt-2 text-2xl leading-none tracking-tight"
        style={accent ? { color: accent } : undefined}
      >
        {value}
      </p>
      {sub && <p className="mt-2 text-xs text-[var(--muted)]">{sub}</p>}
    </div>
  );
}

export function VerificationBadge({ type }: { type: VerificationType }) {
  const meta = VERIFICATION_META[type];
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-sm border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.1em]"
      style={{ color: meta.color, borderColor: `color-mix(in srgb, ${meta.color} 35%, transparent)` }}
      title={meta.blurb}
    >
      <span className="size-1.5 rounded-full" style={{ background: meta.color }} />
      {meta.label}
    </span>
  );
}

export function DemoBanner() {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-[color-mix(in_srgb,var(--warn)_30%,transparent)] bg-[color-mix(in_srgb,var(--warn)_7%,transparent)] px-4 py-2.5 text-xs text-[var(--warn)]">
      <span className="font-medium uppercase tracking-[0.14em]">Demo data</span>
      <span className="text-[var(--muted)]">
        Deterministic synthetic usage from three simulated adapters. No provider account is connected.
      </span>
    </div>
  );
}

export function FixtureBanner() {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--border-strong)] bg-[var(--surface-2)] px-4 py-2.5 text-xs">
      <span className="font-medium uppercase tracking-[0.14em] text-[var(--reported)]">Fixture</span>
      <span className="text-[var(--muted)]">
        Gateway evidence replayed from a captured payload. USAGE did not observe these requests, so
        they count as Reported and earn nothing.
      </span>
    </div>
  );
}

export function LiveRoutedBanner() {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-[color-mix(in_srgb,var(--routed)_35%,transparent)] bg-[color-mix(in_srgb,var(--routed)_8%,transparent)] px-4 py-2.5 text-xs">
      <span className="font-medium uppercase tracking-[0.14em] text-[var(--routed)]">
        Routed proof
      </span>
      <span className="text-[var(--muted)]">
        Real AI requests observed by USAGE infrastructure through the Vercel AI Gateway.
      </span>
    </div>
  );
}

export function Bar({
  fraction,
  color,
  label,
  value,
}: {
  fraction: number;
  color: string;
  label: ReactNode;
  value: string;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="truncate text-[var(--foreground)]">{label}</span>
        <span className="tnum shrink-0 text-[var(--muted)]">{value}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-[var(--surface-2)]">
        <div
          className="h-full rounded-full"
          style={{ width: `${Math.max(fraction * 100, 1)}%`, background: color }}
        />
      </div>
    </div>
  );
}
