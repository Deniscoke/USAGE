import { describe, expect, it } from "vitest";

/**
 * The rule the confirmation link is built under.
 *
 * A confirmation or reset link built from the Host header is the classic
 * account-takeover path: poison the header, receive somebody else's link. The
 * first draft of `confirmationRedirect()` in src/app/auth/actions.ts did
 * exactly that, and a security review caught it before anybody used it.
 *
 * The host pattern lives here so the exactness of it is tested rather than
 * assumed. `startsWith("localhost")` — what the first draft used — accepts
 * `localhost.attacker.example`, which is a real domain somebody else can own.
 */

/** Must stay identical to the expression in src/app/auth/actions.ts. */
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/;

describe("which host may build a confirmation link", () => {
  it("accepts a real local development host", () => {
    for (const host of ["localhost", "localhost:3000", "127.0.0.1", "127.0.0.1:3000", "[::1]", "[::1]:3000"]) {
      expect(LOCAL_HOST.test(host), host).toBe(true);
    }
  });

  it("rejects a domain that merely begins with localhost", () => {
    // Registrable, ownable, and accepted by the first draft.
    for (const host of [
      "localhost.attacker.example",
      "localhost-attacker.example",
      "127.0.0.1.attacker.example",
      "evil.com",
      "usage-ten.vercel.app.attacker.example",
    ]) {
      expect(LOCAL_HOST.test(host), host).toBe(false);
    }
  });

  it("rejects anything smuggled after the host", () => {
    for (const host of ["localhost:3000/../evil", "localhost@evil.example", "localhost:3000 evil.example", ""]) {
      expect(LOCAL_HOST.test(host), host).toBe(false);
    }
  });
});
