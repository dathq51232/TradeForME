import "server-only";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

/** Supabase client + verified user id for a protected page or server action. */
export async function requireUser(next = "/dashboard") {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const userId = data?.claims?.sub;
  if (!userId) redirect(`/login?next=${encodeURIComponent(next)}`);
  return { supabase, userId };
}

/** Message passed back to a page through ?msg= / ?error= after a server action. */
export const withMsg = (path: string, key: "msg" | "error", text: string) =>
  `${path}${path.includes("?") ? "&" : "?"}${key}=${encodeURIComponent(text)}`;

/** Wall-clock time for this request (heartbeat age, "x minutes ago"). Pages using it are dynamic anyway. */
export function requestTime() {
  return Date.now();
}
