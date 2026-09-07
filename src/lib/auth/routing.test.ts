import { describe, expect, it } from "vitest";
import { routeDecision, safeRedirectPath } from "./routing";

describe("routeDecision", () => {
  it("redirects an unauthenticated visitor away from the dashboard", () => {
    expect(routeDecision("/dashboard", false)).toEqual({
      kind: "redirect",
      to: "/login",
      withNext: "/dashboard",
    });
    expect(routeDecision("/dashboard/settings", false)).toEqual({
      kind: "redirect",
      to: "/login",
      withNext: "/dashboard/settings",
    });
  });

  it("lets an unauthenticated visitor see public pages", () => {
    for (const path of ["/", "/login", "/sign-up"]) {
      expect(routeDecision(path, false)).toEqual({ kind: "allow" });
    }
  });

  it("lets an authenticated user into the dashboard", () => {
    expect(routeDecision("/dashboard", true)).toEqual({ kind: "allow" });
  });

  it("sends an authenticated user away from the auth pages", () => {
    expect(routeDecision("/login", true)).toEqual({ kind: "redirect", to: "/dashboard" });
    expect(routeDecision("/sign-up", true)).toEqual({ kind: "redirect", to: "/dashboard" });
  });

  it("does not treat a lookalike prefix as protected", () => {
    expect(routeDecision("/dashboards-public", false)).toEqual({ kind: "allow" });
  });
});

describe("safeRedirectPath", () => {
  it("keeps same-origin paths", () => {
    expect(safeRedirectPath("/dashboard")).toBe("/dashboard");
  });

  it("rejects open redirects", () => {
    expect(safeRedirectPath("//evil.example.com")).toBe("/dashboard");
    expect(safeRedirectPath("https://evil.example.com")).toBe("/dashboard");
    expect(safeRedirectPath(null)).toBe("/dashboard");
    expect(safeRedirectPath(42)).toBe("/dashboard");
  });
});
