// POST /functions/v1/pattern-cron — chart pattern alerts (formed, breakout, small wedges, candlestick patterns) on
// closed candles, called each minute by pg_cron. See ../_shared/pattern-cron.ts. TELEGRAM_BOT_TOKEN (optional Edge
// Function secret) enables Telegram.
import { createClient } from "npm:@supabase/supabase-js@2";
import { route } from "../_shared/ea.ts";
import { patternCron } from "../_shared/pattern-cron.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

Deno.serve(route((req) => patternCron(req, { db, fetch, telegramToken: Deno.env.get("TELEGRAM_BOT_TOKEN") })));
