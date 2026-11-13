// POST /functions/v1/ct-pull — see ../_shared/ea.ts for the request signing and payload.
import { createClient } from "npm:@supabase/supabase-js@2";
import { pull, route } from "../_shared/ea.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

Deno.serve(route((req) => pull(req, db)));
