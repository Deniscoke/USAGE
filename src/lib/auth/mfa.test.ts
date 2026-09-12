import { describe, expect, it } from "vitest";
import {
  MFA_VERIFY_PATH,
  isCompleteCode,
  mfaRouteDecision,
  mfaState,
  normaliseCode,
  verifyErrorMessage,
} from "./mfa";

describe("mfaState", () => {
  it("reads the four combinations the way Supabase defines them", () => {
    expect(mfaState({ currentLevel: "aal1", nextLevel: "aal1" })).toEqual({ kind: "not_enrolled" });
    expect(mfaState({ currentLevel: "aal1", nextLevel: "aal2" })).toEqual({ kind: "challenge_required" });
    expect(mfaState({ currentLevel: "aal2", nextLevel: "aal2" })).toEqual({ kind: "verified" });
    expect(mfaState({ currentLevel: "aal2", nextLevel: "aal1" })).toEqual({ kind: "stale" });
  });

  it("treats a missing claim as the lower level, never as verified", () => {
    // A JWT with no aal claim is aal1 by definition, and an error that left us
    // with nothing must not be read as "this session passed".
    expect(mfaState(null)).toEqual({ kind: "not_enrolled" });
    expect(mfaState({ currentLevel: null, nextLevel: null })).toEqual({ kind: "not_enrolled" });
    expect(mfaState({ currentLevel: null, nextLevel: "aal2" })).toEqual({ kind: "challenge_required" });
  });
});

describe("mfaRouteDecision", () => {
  const owed = { kind: "challenge_required" } as const;
  const done = { kind: "verified" } as const;
  const none = { kind: "not_enrolled" } as const;

  it("sends a session that owes a factor to the verification screen", () => {
    expect(mfaRouteDecision("/dashboard", owed)).toEqual({
      kind: "redirect",
      to: MFA_VERIFY_PATH,
      withNext: "/dashboard",
    });
    expect(mfaRouteDecision("/wallet", owed)).toEqual({
      kind: "redirect",
      to: MFA_VERIFY_PATH,
      withNext: "/wallet",
    });
  });

  it("lets that session reach the screen it is being sent to", () => {
    expect(mfaRouteDecision(MFA_VERIFY_PATH, owed)).toEqual({ kind: "allow" });
  });

  it("always leaves a way out for somebody who cannot pass the challenge", () => {
    // A lost phone must not mean a locked account with no sign-out button.
    expect(mfaRouteDecision("/auth/sign-out", owed)).toEqual({ kind: "allow" });
    expect(mfaRouteDecision("/login", owed)).toEqual({ kind: "allow" });
  });

  it("does not strand anyone on a verification screen with nothing to verify", () => {
    expect(mfaRouteDecision(MFA_VERIFY_PATH, none)).toEqual({ kind: "redirect", to: "/dashboard" });
    expect(mfaRouteDecision(MFA_VERIFY_PATH, done)).toEqual({ kind: "redirect", to: "/dashboard" });
  });

  it("stays out of the way once the factor is passed", () => {
    expect(mfaRouteDecision("/dashboard", done)).toEqual({ kind: "allow" });
    expect(mfaRouteDecision("/dashboard", none)).toEqual({ kind: "allow" });
  });

  it("leaves the public pages public", () => {
    // Being bounced off the marketing homepage because a tab went stale is
    // not security, it is a broken website.
    expect(mfaRouteDecision("/", owed)).toEqual({ kind: "allow" });
    expect(mfaRouteDecision("/download", owed)).toEqual({ kind: "allow" });
    expect(mfaRouteDecision("/providers/openai", owed)).toEqual({ kind: "allow" });
  });

  it("does not redirect an API call, which cannot follow one usefully", () => {
    expect(mfaRouteDecision("/api/chat", owed)).toEqual({ kind: "allow" });
    expect(mfaRouteDecision("/api/chat/completions", owed)).toEqual({ kind: "allow" });
  });

  it("does not mistake a lookalike path for an open one", () => {
    // "/loginary" is not "/login", but it is not protected either, so it is
    // allowed for the second reason rather than the first.
    expect(mfaRouteDecision("/loginary", owed)).toEqual({ kind: "allow" });
    // "/settingsx" is likewise not "/settings".
    expect(mfaRouteDecision("/settingsx", owed)).toEqual({ kind: "allow" });
    // But a real protected child is caught.
    expect(mfaRouteDecision("/settings/security", owed)).toEqual({
      kind: "redirect",
      to: MFA_VERIFY_PATH,
      withNext: "/settings/security",
    });
  });
});

describe("verifyErrorMessage", () => {
  it("explains a rejected code instead of repeating the provider's words", () => {
    const message = verifyErrorMessage("Invalid TOTP code entered");
    expect(message).toContain("30 seconds");
    expect(message).toContain("clock");
  });

  it("names the wait when the attempt was rate limited", () => {
    expect(verifyErrorMessage("Rate limit exceeded")).toContain("Wait a minute");
  });

  it("falls back to the provider's message rather than inventing one", () => {
    expect(verifyErrorMessage("Factor not found")).toBe("Factor not found");
    expect(verifyErrorMessage(null)).toBe("The code could not be checked. Try again.");
  });
});

describe("normaliseCode", () => {
  it("keeps the digits and drops what an authenticator app never produces", () => {
    expect(normaliseCode("123 456")).toBe("123456");
    expect(normaliseCode("12-34-56")).toBe("123456");
    expect(normaliseCode("abc123456789")).toBe("123456");
  });

  it("knows when a code is finished", () => {
    expect(isCompleteCode("123456")).toBe(true);
    expect(isCompleteCode("12345")).toBe(false);
    expect(isCompleteCode("")).toBe(false);
  });
});
