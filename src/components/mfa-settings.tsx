"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createBrowserSupabase } from "@/lib/supabase/client";
import { isCompleteCode, normaliseCode, verifyErrorMessage } from "@/lib/auth/mfa";

/**
 * Turning two-factor authentication on and off.
 *
 * Enrolling is three calls: enroll gives a QR code and a secret, challenge
 * opens a window for a code, verify closes it. A factor only becomes active
 * once a code from it has been accepted, so a half-finished setup can never
 * lock somebody out of their own account.
 *
 * Two things are said out loud on this screen rather than buried: verifying
 * signs out every other session, and there are no recovery codes. Both are
 * true of Supabase Auth, both surprise people, and the second one is the
 * difference between an inconvenience and a lost account.
 */

interface Factor {
  id: string;
  friendlyName: string | null;
  status: string;
}

/**
 * Only verified factors count. An unverified one is an abandoned half-setup,
 * and listing it would claim a protection that is not switched on.
 */
function verifiedFactors(totp: { id: string; friendly_name?: string | null; status: string }[] | undefined): Factor[] {
  return (totp ?? [])
    .filter((factor) => factor.status === "verified")
    .map((factor) => ({ id: factor.id, friendlyName: factor.friendly_name ?? null, status: factor.status }));
}

type Stage =
  | { kind: "loading" }
  | { kind: "unavailable" }
  | { kind: "list"; factors: Factor[] }
  | { kind: "enrolling"; factorId: string; qr: string; secret: string }
  | { kind: "removing"; factor: Factor };

export function MfaSettings() {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>({ kind: "loading" });
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [secretShown, setSecretShown] = useState(false);

  const refresh = useCallback(async () => {
    const supabase = createBrowserSupabase();
    if (!supabase) {
      setStage({ kind: "unavailable" });
      return;
    }
    const { data, error: listError } = await supabase.auth.mfa.listFactors();
    if (listError) {
      setStage({ kind: "unavailable" });
      return;
    }
    setStage({ kind: "list", factors: verifiedFactors(data.totp) });
  }, []);

  // The first read happens inside an async callback, after an await, rather
  // than synchronously in the effect body: this is subscribing to an external
  // system, not deriving state React already has.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const supabase = createBrowserSupabase();
      if (!supabase) {
        if (!cancelled) setStage({ kind: "unavailable" });
        return;
      }
      const { data, error: listError } = await supabase.auth.mfa.listFactors();
      if (cancelled) return;
      if (listError) {
        setStage({ kind: "unavailable" });
        return;
      }
      setStage({ kind: "list", factors: verifiedFactors(data.totp) });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const startEnrolment = async () => {
    const supabase = createBrowserSupabase();
    if (!supabase) return;
    setBusy(true);
    setError(null);
    setCode("");
    setSecretShown(false);

    const { data, error: enrollError } = await supabase.auth.mfa.enroll({
      factorType: "totp",
      friendlyName: `Authenticator ${new Date().toISOString().slice(0, 10)}`,
    });
    setBusy(false);

    if (enrollError || !data) {
      setError(enrollError?.message ?? "The setup could not be started.");
      return;
    }
    setStage({ kind: "enrolling", factorId: data.id, qr: data.totp.qr_code, secret: data.totp.secret });
  };

  const cancelEnrolment = async (factorId: string) => {
    const supabase = createBrowserSupabase();
    // Drop the unverified factor rather than leaving it behind, or the account
    // collects dead half-enrolments nobody can explain later.
    if (supabase) await supabase.auth.mfa.unenroll({ factorId }).catch(() => undefined);
    setError(null);
    setCode("");
    await refresh();
  };

  const confirmEnrolment = async (factorId: string) => {
    const supabase = createBrowserSupabase();
    if (!supabase || !isCompleteCode(code)) return;
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
    setBusy(false);

    if (verified.error) {
      setError(verifyErrorMessage(verified.error.message));
      return;
    }

    setCode("");
    await refresh();
    // The session is now aal2; the server needs to see that.
    router.refresh();
  };

  const removeFactor = async (factor: Factor) => {
    const supabase = createBrowserSupabase();
    if (!supabase) return;
    setBusy(true);
    setError(null);

    const { error: removeError } = await supabase.auth.mfa.unenroll({ factorId: factor.id });
    if (removeError) {
      setBusy(false);
      setError(removeError.message);
      return;
    }

    // Without this the token keeps claiming aal2 until it next refreshes, and
    // the page would show a protection that is already gone.
    await supabase.auth.refreshSession();
    setBusy(false);
    await refresh();
    router.refresh();
  };

  if (stage.kind === "loading") {
    return <p className="text-xs text-[var(--faint)]">Checking…</p>;
  }

  if (stage.kind === "unavailable") {
    return (
      <p className="text-xs text-[var(--muted)]">
        Two-factor authentication is unavailable right now. Reload the page, and if it persists the
        sign-in service is not reachable from here.
      </p>
    );
  }

  if (stage.kind === "enrolling") {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-[12px] leading-relaxed text-[var(--muted)]">
          Scan this with an authenticator app. Google Authenticator, 1Password, Bitwarden, Aegis and
          Apple&apos;s Passwords all work. Then type the six digits it shows.
        </p>

        {/* Supabase returns the QR as an SVG data URL. */}
        <div className="w-fit rounded-lg border border-[var(--border)] bg-white p-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={stage.qr} alt="Two-factor setup QR code" width={180} height={180} />
        </div>

        <div>
          <button type="button" className="chat-link text-[11px]" onClick={() => setSecretShown((v) => !v)}>
            {secretShown ? "Hide the setup key" : "Cannot scan? Show the setup key"}
          </button>
          {secretShown && (
            <code className="tnum mt-2 block w-fit rounded-md border border-[var(--border)] px-2.5 py-1 text-[12px] tracking-[0.08em]">
              {stage.secret}
            </code>
          )}
        </div>

        <label className="flex flex-col gap-1.5">
          <span className="text-[10px] uppercase tracking-[0.12em] text-[var(--faint)]">Code from the app</span>
          <input
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="000000"
            value={code}
            onChange={(e) => setCode(normaliseCode(e.target.value))}
            className="tnum w-40 rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-lg tracking-[0.3em]"
          />
        </label>

        {error && <p className="text-[11px] leading-relaxed text-[var(--warn)]">{error}</p>}

        <p className="text-[11px] leading-relaxed text-[var(--faint)]">
          Turning this on signs out every other session, including your phone. And there are no
          recovery codes: if you lose the authenticator you lose the account, so add a second app on
          a different device, or keep the setup key somewhere safe.
        </p>

        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            className="rounded-md border border-[var(--border-strong)] px-3 py-1.5 text-xs hover:border-[var(--verified)]"
            onClick={() => void confirmEnrolment(stage.factorId)}
            disabled={busy || !isCompleteCode(code)}
          >
            {busy ? "Checking…" : "Turn on"}
          </button>
          <button
            type="button"
            className="rounded-md border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--muted)]"
            onClick={() => void cancelEnrolment(stage.factorId)}
            disabled={busy}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (stage.kind === "removing") {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-[12px] leading-relaxed text-[var(--muted)]">
          Turn off two-factor authentication? Your account goes back to being protected by its
          password alone.
        </p>
        {error && <p className="text-[11px] text-[var(--warn)]">{error}</p>}
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            className="rounded-md border border-[var(--warn)] px-3 py-1.5 text-xs text-[var(--warn)]"
            onClick={() => void removeFactor(stage.factor)}
            disabled={busy}
          >
            {busy ? "Removing…" : "Turn off"}
          </button>
          <button
            type="button"
            className="rounded-md border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--muted)]"
            onClick={() => void refresh()}
            disabled={busy}
          >
            Keep it on
          </button>
        </div>
      </div>
    );
  }

  const active = stage.factors.length > 0;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-[12px] leading-relaxed text-[var(--muted)]">
        {active
          ? "Two-factor authentication is on. Signing in asks for a code from your authenticator app as well as your password."
          : "Right now your password is the only thing between anyone and this account, including its wallet and its providers. An authenticator app adds a six-digit code that changes every 30 seconds."}
      </p>

      {error && <p className="text-[11px] text-[var(--warn)]">{error}</p>}

      {active ? (
        <ul className="flex flex-col gap-2">
          {stage.factors.map((factor) => (
            <li
              key={factor.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-[var(--border)] px-3 py-2"
            >
              <span className="text-xs">{factor.friendlyName ?? "Authenticator app"}</span>
              <button
                type="button"
                className="chat-link text-[11px]"
                onClick={() => setStage({ kind: "removing", factor })}
              >
                Turn off
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div>
          <button
            type="button"
            className="rounded-md border border-[var(--border-strong)] px-3 py-1.5 text-xs hover:border-[var(--verified)]"
            onClick={() => void startEnrolment()}
            disabled={busy}
          >
            {busy ? "Starting…" : "Turn on two-factor"}
          </button>
        </div>
      )}
    </div>
  );
}
