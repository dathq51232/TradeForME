import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { isSupabaseConfigured, supabaseEnv } from "./env";

/** Routes that need a signed-in user. */
export const PROTECTED = ["/dashboard", "/accounts", "/copy", "/charts", "/admin"];

/** Refreshes the Supabase session cookie on every request and guards protected routes. */
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });
  if (!isSupabaseConfigured()) return response;

  const { url, key } = supabaseEnv();
  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(toSet) {
        for (const { name, value } of toSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of toSet) response.cookies.set(name, value, options);
      },
    },
  });

  // getClaims() verifies the JWT; do not trust getSession() on the server.
  const { data } = await supabase.auth.getClaims();
  const signedIn = Boolean(data?.claims?.sub);
  const path = request.nextUrl.pathname;

  if (!signedIn && PROTECTED.some((p) => path === p || path.startsWith(p + "/"))) {
    const to = request.nextUrl.clone();
    to.pathname = "/login";
    to.search = `?next=${encodeURIComponent(path)}`;
    return NextResponse.redirect(to);
  }
  return response;
}
