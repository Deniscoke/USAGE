import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { supabasePublicEnv } from "@/lib/supabase/env";
import { routeDecision } from "@/lib/auth/routing";

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
  if (decision.kind === "redirect") {
    const url = request.nextUrl.clone();
    url.pathname = decision.to;
    url.search = "";
    if (decision.withNext) url.searchParams.set("next", decision.withNext);
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
