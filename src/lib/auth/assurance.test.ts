import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { sessionSatisfiesSecondFactor } from "./assurance";

/**
 * The second factor is enforced where money is spent and connections change,
 * not only on the pages in front of them.
 */

function session(levels: { currentLevel: string | null; nextLevel: string | null } | "error" | "throws") {
  return {
    auth: {
      mfa: {
        getAuthenticatorAssuranceLevel: async () => {
          if (levels === "throws") throw new Error("network");
          if (levels === "error") return { data: null, error: { message: "bad session" } };
          return { data: levels, error: null };
        },
      },
    },
  } as unknown as Parameters<typeof sessionSatisfiesSecondFactor>[0];
}

describe("sessionSatisfiesSecondFactor", () => {
  it("lets an account with no factor through on its password, exactly as before", async () => {
    expect(await sessionSatisfiesSecondFactor(session({ currentLevel: "aal1", nextLevel: "aal1" }))).toBe(true);
  });

  it("lets a session that passed its factor through", async () => {
    expect(await sessionSatisfiesSecondFactor(session({ currentLevel: "aal2", nextLevel: "aal2" }))).toBe(true);
  });

  it("stops a stolen password on an account that has a factor", async () => {
    expect(await sessionSatisfiesSecondFactor(session({ currentLevel: "aal1", nextLevel: "aal2" }))).toBe(false);
  });

  it("fails closed when the level cannot be read", async () => {
    expect(await sessionSatisfiesSecondFactor(session("error"))).toBe(false);
    expect(await sessionSatisfiesSecondFactor(session("throws"))).toBe(false);
  });
});
