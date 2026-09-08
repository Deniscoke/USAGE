/**
 * Route gating rules, kept pure so they can be tested without a running
 * Supabase or a Next request. The middleware applies these; RLS enforces them.
 */

export const PROTECTED_PREFIXES = ["/dashboard", "/onboarding", "/settings", "/proofs"] as const;
export const AUTH_ROUTES = ["/login", "/sign-up"] as const;

export type RouteDecision =
  | { kind: "allow" }
  | { kind: "redirect"; to: string; withNext?: string };

export function routeDecision(pathname: string, isAuthenticated: boolean): RouteDecision {
  const isProtected = PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );

  if (!isAuthenticated && isProtected) {
    return { kind: "redirect", to: "/login", withNext: pathname };
  }
  if (isAuthenticated && (AUTH_ROUTES as readonly string[]).includes(pathname)) {
    return { kind: "redirect", to: "/dashboard" };
  }
  return { kind: "allow" };
}

/** Same-origin guard for `?next=`: an open redirect here would be a real hole. */
export function safeRedirectPath(value: unknown, fallback = "/dashboard"): string {
  if (typeof value !== "string") return fallback;
  return value.startsWith("/") && !value.startsWith("//") ? value : fallback;
}
