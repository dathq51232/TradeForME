// In-memory Postgres (PGlite) with a minimal stand-in for Supabase's auth schema and roles, so the
// migrations, RLS and RPCs can be tested without Docker. CI also runs them on the real Supabase image.
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SUPABASE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

export async function openDb({ seed = true } = {}) {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth; create schema extensions;
    create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}',
      created_at timestamptz default now(), last_sign_in_at timestamptz, banned_until timestamptz);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid $$;
    grant usage on schema public, auth, extensions to anon, authenticated, service_role;
    grant execute on function auth.uid() to anon, authenticated;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
  `);
  const dir = join(SUPABASE_DIR, "migrations");
  for (const f of readdirSync(dir).sort()) await db.exec(readFileSync(join(dir, f), "utf8"));
  if (seed) await db.exec(readFileSync(join(SUPABASE_DIR, "seed.sql"), "utf8"));
  return db;
}

/**
 * A `db.rpc(fn, args)` like supabase-js, backed by PGlite (as the service role, which bypasses RLS).
 * Set-returning functions give an array of rows; scalar functions give their value.
 */
export function rpcAdapter(db) {
  return {
    async rpc(fn, args) {
      const keys = Object.keys(args);
      const values = keys.map((k) => (args[k] !== null && typeof args[k] === "object" ? JSON.stringify(args[k]) : args[k]));
      const sql = `select * from public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")})`;
      try {
        const res = await db.query(sql, values);
        const scalar = res.fields.length === 1 && res.fields[0].name === fn;
        return { data: scalar ? res.rows[0]?.[fn] ?? null : res.rows, error: null };
      } catch (e) {
        return { data: null, error: { message: e.message, code: e.code } };
      }
    },
  };
}

// `node supabase/tests/pglite.mjs` runs the SQL smoke test.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const db = await openDb();
  const res = await db.exec(readFileSync(join(SUPABASE_DIR, "tests", "smoke.sql"), "utf8"));
  const ok = res.flatMap((r) => r.rows).find((r) => r.result);
  console.log(ok ? ok.result : "smoke: no result row");
  if (!ok) process.exit(1);
}
