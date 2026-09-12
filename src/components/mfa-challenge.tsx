"use client";

import { useCallback, useEffect, useState } from "react";
import { createBrowserSupabase } from "@/lib/supabase/client";
import { isCompleteCode, normaliseCode, verifyErrorMessage } from "@/lib/auth/mfa";
import { safeRedirectPath } from "@/lib/auth/routing";

/**
 * The second step of signing in.
 *
 * Reached only by a session that has passed a password and owes a factor. It
 * is deliberately a page and not a modal: a person can close a modal and be
 * left in a half-signed-in state with no way forward, and the way out of this
 * screen has to be either a code or signing out.
 */
export function MfaChallenge({ next }: { next?: string }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [factorId, setFactorId] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const supabase = createBrowserSupabase();
      if (!supabase) return;
      const { data } = await supabase.auth.mfa.listFactors();
      const totp = data?.totp?.find((factor) => factor.status === "verified") ?? data?.totp?.[0];
      if (totp) setFactorId(totp.id);
    })();
  }, []);

  const submit = useCallback(async () => {
    const supabase = createBrowserSupabase();
    if (!supabase || !factorId || !isCompleteCode(code)) return;
    setBusy(true);
    setError(null);

    const challenge = await supabase.auth.mfa.challenge({ factorId });
    if (challenge.error) {
      setBusy(false);
      setError(verifyErrorMessage(challenge.error.message));
      return;
    }

    const verified = await supabase.auth.mfa.verify({
      factorId,
      challengeId: challenge.data.id,
      code,
    });

    if (verified.error) {
      setBusy(false);
      setCode("");
      setError(verifyErrorMessage(verified.error.message));
      return;
    }

    // The cookie now carries aal2. A full navigation, not router.push, so the
    // middleware re-reads the session rather than serving a cached decision.
    window.location.assign(safeRedirectPath(next));
  }, [code, factorId, next]);

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label className="flex flex-col gap-1.5">
        <span className="text-[10px] uppercase tracking-[0.12em] text-[var(--faint)]">
          Code from your authenticator app
        </span>
        <input
          autoFocus
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="000000"
          value={code}
          onChange={(e) => {
            const next = normaliseCode(e.target.value);
            setCode(next);
            setError(null);
          }}
          className="tnum w-48 rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-xl tracking-[0.3em]"
        />
      </label>

      {error && <p className="text-[11px] leading-relaxed text-[var(--warn)]">{error}</p>}

      <button
        type="submit"
        className="w-fit rounded-md border border-[var(--border-strong)] px-3 py-1.5 text-xs hover:border-[var(--verified)]"
        disabled={busy || !isCompleteCode(code) || !factorId}
      >
        {busy ? "Checking…" : "Continue"}
      </button>

      <p className="text-[11px] leading-relaxed text-[var(--faint)]">
        The code changes every 30 seconds. If it is refused repeatedly, check that your phone&apos;s
        clock is set automatically: a clock a minute out will reject every code.
      </p>
    </form>
  );
}
