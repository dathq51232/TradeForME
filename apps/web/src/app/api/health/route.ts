import { connection } from "next/server";
import { isSupabaseConfigured } from "@/lib/supabase/env";

export async function GET() {
  await connection();
  return Response.json({
    ok: true,
    supabase: isSupabaseConfigured() ? "configured" : "missing-env",
    commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "local",
    time: new Date().toISOString(),
  });
}
