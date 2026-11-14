// POST /functions/v1/market-cron — price alerts and calendar sync, called each minute by pg_cron.
// See ../_shared/market-cron.ts. TELEGRAM_BOT_TOKEN (optional Edge Function secret) enables Telegram.
import { createClient } from "npm:@supabase/supabase-js@2";
import { route } from "../_shared/ea.ts";
import { marketCron } from "../_shared/market-cron.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

Deno.serve(route((req) => marketCron(req, { db, fetch, telegramToken: Deno.env.get("TELEGRAM_BOT_TOKEN") })));
