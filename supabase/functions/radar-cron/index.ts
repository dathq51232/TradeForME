// POST /functions/v1/radar-cron — market radar (arbitrage, pumps, new listings), called each minute by pg_cron.
// See ../_shared/radar.ts. TELEGRAM_BOT_TOKEN (optional Edge Function secret) enables Telegram.
import { createClient } from "npm:@supabase/supabase-js@2";
import { route } from "../_shared/ea.ts";
import { radarCron } from "../_shared/radar.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

Deno.serve(route((req) => radarCron(req, { db, fetch, telegramToken: Deno.env.get("TELEGRAM_BOT_TOKEN") })));
