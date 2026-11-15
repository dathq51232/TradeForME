// User management RPCs (migration 20261115000009_admin_users.sql) against the real migrations, in PGlite.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { openDb } from "../../tests/pglite.mjs";

let pg: Awaited<ReturnType<typeof openDb>>;
const ADMIN = "00000000-0000-0000-0000-0000000000a1";
const BOB = "00000000-0000-0000-0000-0000000000b2";
const CAROL = "00000000-0000-0000-0000-0000000000c3";

/** Runs `sql` as a signed-in user (RLS and grants apply), then goes back to the superuser. */
async function as<T = Record<string, unknown>>(user: string, sql: string, params: unknown[] = []) {
  await pg.exec(`set role authenticated; select set_config('request.jwt.claims', '{"sub":"${user}","role":"authenticated"}', false);`);
  try {
    return (await pg.query(sql, params)).rows as T[];
  } finally {
    await pg.exec("reset role; select set_config('request.jwt.claims', '', false);");
  }
}
const roleOf = async (id: string) => ((await pg.query("select role from public.profiles where id = $1", [id])).rows[0] as { role: string }).role;

before(async () => {
  pg = await openDb();
  // list a test address as admin (the migration lists the real one by its hash only)
  const hash = createHash("sha256").update("boss@example.test").digest("hex");
  await pg.query("insert into private.admin_emails values ($1)", [hash]);
  await pg.exec(`insert into auth.users (id, email) values
    ('${ADMIN}', 'Boss@Example.test'), ('${BOB}', 'bob@example.test'), ('${CAROL}', 'carol@example.test');`);
});

test("a listed email becomes admin when it signs up; everyone else is a user", async () => {
  assert.equal(await roleOf(ADMIN), "admin", "matched case-insensitively");
  assert.equal(await roleOf(BOB), "user");
  const listed = (await pg.query("select count(*)::int as n from private.admin_emails")).rows[0] as { n: number };
  assert.equal(listed.n, 2, "the migration's own entry plus the test one");
});

test("only admins can list users, and the list carries no secrets", async () => {
  await assert.rejects(as(BOB, "select * from public.admin_list_users()"), /Chỉ admin/);
  const rows = await as<{ id: string; email: string; role: string; locked: boolean }>(ADMIN, "select * from public.admin_list_users()");
  assert.equal(rows.length, 3);
  assert.deepEqual(Object.keys(rows[0]).sort(), ["created_at", "email", "full_name", "id", "last_sign_in_at", "locked", "mt5_accounts", "radar_alerts", "role", "telegram"]);
  await assert.rejects(as(BOB, "select * from private.admin_emails"), /permission denied/);
});

test("roles: an admin promotes and demotes others, never themselves; users cannot change roles", async () => {
  await as(ADMIN, "select public.admin_set_role($1, 'manager')", [BOB]);
  assert.equal(await roleOf(BOB), "manager");
  await assert.rejects(as(ADMIN, "select public.admin_set_role($1, 'user')", [ADMIN]), /tự hạ quyền/);
  await assert.rejects(as(ADMIN, "select public.admin_set_role($1, 'owner')", [BOB]), /không hợp lệ/);
  await assert.rejects(as(BOB, "select public.admin_set_role($1, 'admin')", [BOB]), /Chỉ admin/, "a manager is not an admin");
  await as(ADMIN, "select public.admin_set_role($1, 'user')", [BOB]);
  const log = (await pg.query("select action, target, detail from public.audit_log where action = 'admin.set_role' order by id")).rows;
  assert.deepEqual(log.map((r) => (r as { detail: { to: string } }).detail.to), ["manager", "user"]);
});

test("locking bans sign-in and unlocking lifts it; admins cannot be locked until demoted", async () => {
  await as(ADMIN, "select public.admin_set_locked($1, true)", [BOB]);
  const banned = (await pg.query("select banned_until from auth.users where id = $1", [BOB])).rows[0] as { banned_until: unknown };
  assert.ok(banned.banned_until, "banned");
  const listed = await as<{ id: string; locked: boolean }>(ADMIN, "select id, locked from public.admin_list_users()");
  assert.equal(listed.find((r) => r.id === BOB)?.locked, true);
  await as(ADMIN, "select public.admin_set_locked($1, false)", [BOB]);
  assert.equal(((await pg.query("select banned_until from auth.users where id = $1", [BOB])).rows[0] as { banned_until: unknown }).banned_until, null);
  await assert.rejects(as(ADMIN, "select public.admin_set_locked($1, true)", [ADMIN]), /tự khoá/);
  await as(ADMIN, "select public.admin_set_role($1, 'admin')", [CAROL]);
  await assert.rejects(as(ADMIN, "select public.admin_set_locked($1, true)", [CAROL]), /Hạ quyền admin/);
  await as(ADMIN, "select public.admin_set_role($1, 'user')", [CAROL]);
});

test("deleting needs the user's email typed back, and removes their data", async () => {
  await pg.query("insert into public.radar_settings (user_id, alerts_on) values ($1, true)", [CAROL]);
  await assert.rejects(as(ADMIN, "select public.admin_delete_user($1, 'wrong@example.test')", [CAROL]), /không khớp/);
  await assert.rejects(as(ADMIN, "select public.admin_delete_user($1, $2)", [ADMIN, "boss@example.test"]), /tự xoá/);
  await as(ADMIN, "select public.admin_delete_user($1, ' CAROL@example.test ')", [CAROL]);
  assert.equal((await pg.query("select count(*)::int as n from auth.users where id = $1", [CAROL])).rows[0].n, 0);
  assert.equal((await pg.query("select count(*)::int as n from public.radar_settings where user_id = $1", [CAROL])).rows[0].n, 0);
  assert.equal((await pg.query("select count(*)::int as n from public.audit_log where action = 'admin.delete_user'")).rows[0].n, 1);
});
