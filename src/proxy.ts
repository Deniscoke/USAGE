import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { supabasePublicEnv } from "@/lib/supabase/env";
import { routeDecision } from "@/lib/auth/routing";
import { mfaRouteDecision, mfaState } from "@/lib/auth/mfa";

/**
 * Refreshes the Supabase session cookie on every request and gates protected
 * routes. Gating also happens in the page itself and, decisively, in the
 * database via RLS -- this layer is UX, not the security boundary.
 *
 * `proxy.ts` is the Next 16 name for what used to be `middleware.ts`.
 */
export async function proxy(request: NextRequest) {
  const env = supabasePublicEnv();
  const response = NextResponse.next({ request });
  const { pathname } = request.nextUrl;

  if (!env) {
    // Without Supabase there is no session to protect; the dashboard renders a
    // setup state instead.
    return response;
  }

  const supabase = createServerClient(env.url, env.anonKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(cookiesToSet) {
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // getUser() revalidates the token with Supabase; never trust getSession() here.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const decision = routeDecision(pathname, Boolean(user));
  if (decision.kind === "redirect") return redirectTo(request, decision.to, decision.withNext);

  // A session that has passed a password but still owes a second factor is
  // sent to enter it, rather than being refused. Somebody who left a tab open
  // overnight is not an attacker, and treating them like one teaches people to
  // switch the protection off.
  if (user) {
    const mfa = await mfaDecision(supabase, pathname);
    if (mfa?.kind === "redirect") return redirectTo(request, mfa.to, mfa.withNext);
  }

  return response;
}

function redirectTo(request: NextRequest, to: string, withNext?: string): NextResponse {
  const url = request.nextUrl.clone();
  url.pathname = to;
  url.search = "";
  if (withNext) url.searchParams.set("next", withNext);
  return NextResponse.redirect(url);
}

/**
 * The assurance level of this session, read from the token it already carries.
 *
 * Returns null on any failure. A second factor that cannot be checked must not
 * become a locked door: the pages behind this still check for themselves, and
 * RLS is the boundary that actually holds.
 */
async function mfaDecision(
  supabase: ReturnType<typeof createServerClient>,
  pathname: string,
): Promise<ReturnType<typeof mfaRouteDecision> | null> {
  try {
    const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (error) return null;
    return mfaRouteDecision(pathname, mfaState(data));
  } catch {
    return null;
  }
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
