"use client";

import Link from "next/link";
import { useActionState } from "react";
import type { AuthFormState } from "@/app/auth/actions";

interface AuthFormProps {
  action: (state: AuthFormState, formData: FormData) => Promise<AuthFormState>;
  title: string;
  submitLabel: string;
  next?: string;
  /** Something to say before the reader has done anything, e.g. after a
      confirmation link sent them here. */
  notice?: string;
  footer: { prompt: string; href: string; linkLabel: string };
}

export function AuthForm({ action, title, submitLabel, next, notice, footer }: AuthFormProps) {
  const [state, formAction, pending] = useActionState<AuthFormState, FormData>(action, { notice });

  return (
    <div className="mx-auto w-full max-w-sm px-6 py-16">
      <Link href="/" className="tnum text-sm font-medium tracking-[0.3em]">
        USAGE
      </Link>
      <h1 className="mt-8 text-xl font-medium tracking-tight">{title}</h1>

      <form action={formAction} className="mt-6 space-y-4">
        {next && <input type="hidden" name="next" value={next} />}

        <label className="block">
          <span className="text-[10px] font-medium uppercase tracking-[0.16em] text-[var(--faint)]">
            Email
          </span>
          <input
            name="email"
            type="email"
            autoComplete="email"
            required
            className="mt-1.5 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm outline-none focus:border-[var(--border-strong)]"
          />
        </label>

        <label className="block">
          <span className="text-[10px] font-medium uppercase tracking-[0.16em] text-[var(--faint)]">
            Password
          </span>
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            required
            minLength={6}
            className="mt-1.5 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm outline-none focus:border-[var(--border-strong)]"
          />
        </label>

        {state.error && (
          <p className="rounded-md border border-[color-mix(in_srgb,var(--warn)_30%,transparent)] bg-[color-mix(in_srgb,var(--warn)_7%,transparent)] px-3 py-2 text-xs text-[var(--warn)]">
            {state.error}
          </p>
        )}

        {/* "Check your email" was shown in the same orange box as a failure,
            so the one moment sign-up goes right looked like it had gone
            wrong. */}
        {state.notice && (
          <p className="rounded-md border border-[color-mix(in_srgb,var(--verified)_30%,transparent)] bg-[color-mix(in_srgb,var(--verified)_7%,transparent)] px-3 py-2 text-xs leading-relaxed text-[var(--verified)]">
            {state.notice}
          </p>
        )}

        <button
          type="submit"
          disabled={pending}
          className="w-full rounded-md bg-[var(--foreground)] px-4 py-2.5 text-sm font-medium text-[var(--background)] transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {pending ? "Working…" : submitLabel}
        </button>
      </form>

      <p className="mt-6 text-xs text-[var(--muted)]">
        {footer.prompt}{" "}
        <Link href={footer.href} className="text-[var(--foreground)] underline underline-offset-4">
          {footer.linkLabel}
        </Link>
      </p>
    </div>
  );
}
