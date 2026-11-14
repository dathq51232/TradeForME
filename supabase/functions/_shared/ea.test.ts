// End-to-end tests of the EA API: real handlers, real migrations (PGlite), signed requests.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { openDb, rpcAdapter } from "../../tests/pglite.mjs";
import { REQUIRED as SHARED_REQUIRED, EVENT_TYPES as SHARED_TYPES, TASK_STATUSES as SHARED_STATUSES } from "../../../packages/shared/src/copytrade.js";
import {
  ack, bars, heartbeat, hmacHex, ingest, pull, eventProblems, versionLess, route,
  REQUIRED, EVENT_TYPES, TASK_STATUSES, type Db,
} from "./ea.ts";

type Creds = { id: string; token: string; secret: string };
let pg: Awaited<ReturnType<typeof openDb>>;
let db: Db;
let master: Creds, receiver: Creds;

async function asUser(uid: string, sql: string, params: unknown[] = []) {
  await pg.exec(`set role authenticated; select set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', false);`);
  try { return await pg.query(sql, params); } finally { await pg.exec("reset role;"); }
}

async function signed(path: string, creds: Creds, body: unknown, opts: { ts?: number; secret?: string; token?: string } = {}) {
  const text = JSON.stringify(body);
  const ts = String(opts.ts ?? Date.now());
  return new Request("http://edge" + path, {
    method: "POST", body: text,
    headers: { "x-qt-token": opts.token ?? creds.token, "x-qt-timestamp": ts, "x-qt-signature": await hmacHex(opts.secret ?? creds.secret, ts + "\n" + text) },
  });
}
const call = async (h: (r: Request) => Promise<Response>, r: Request) => {
  const res = await route(h)(r);
  return { status: res.status, body: await res.json() };
};

const ALICE = "00000000-0000-0000-0000-00000000000a";
const BOB = "00000000-0000-0000-0000-00000000000b";

before(async () => {
  pg = await openDb();
  db = rpcAdapter(pg);
  await pg.exec(`insert into auth.users (id, email) values ('${ALICE}', 'a@x.test'), ('${BOB}', 'b@x.test');`);
  const m = (await asUser(ALICE, "select * from public.create_mt5_account('master', 'M', 'Srv', 1)")).rows[0] as Record<string, string>;
  const r = (await asUser(BOB, "select * from public.create_mt5_account('receiver', 'R', 'Srv', 2)")).rows[0] as Record<string, string>;
  master = { id: m.account_id, token: m.ea_token, secret: m.hmac_secret };
  receiver = { id: r.account_id, token: r.ea_token, secret: r.hmac_secret };
  await asUser(ALICE, "insert into public.copy_links (master_id, receiver_id, enabled) values ($1, $2, true)", [master.id, receiver.id]);
  const g = (await pg.query("select id from public.copy_groups")).rows[0] as { id: string };
  await asUser(ALICE, "select public.copy_group_control($1, 'start')", [g.id]);
});

test("validation lists match packages/shared", () => {
  assert.deepEqual(REQUIRED, SHARED_REQUIRED);
  assert.deepEqual(EVENT_TYPES, SHARED_TYPES);
  assert.deepEqual(TASK_STATUSES, SHARED_STATUSES);
  assert.ok(versionLess("1.2.10", "1.10.0") && !versionLess("1.0.0", "1.0.0"));
});

test("authentication: good request, bad signature, clock skew, unknown token, wrong method", async () => {
  const hb = { balance: 1000, equity: 1000, trade_allowed: true, ea_version: "1.0.0" };
  assert.equal((await call((r) => heartbeat(r, db), await signed("/hb", master, hb))).status, 200);
  const bad = await call((r) => heartbeat(r, db), await signed("/hb", master, hb, { secret: "x".repeat(64) }));
  assert.deepEqual([bad.status, bad.body.error], [401, "SIGNATURE_INVALID"]);
  const old = await call((r) => heartbeat(r, db), await signed("/hb", master, hb, { ts: Date.now() - 120_000 }));
  assert.deepEqual([old.status, old.body.error], [401, "CLOCK_SKEW"]);
  const unknown = await call((r) => heartbeat(r, db), await signed("/hb", master, hb, { token: "a".repeat(64) }));
  assert.deepEqual([unknown.status, unknown.body.error], [401, "TOKEN_INVALID"]);
  const get = await call((r) => heartbeat(r, db), new Request("http://edge/hb"));
  assert.equal(get.status, 405);
});

test("heartbeat refuses outdated EAs with 426 and stores live state", async () => {
  const res = await call((r) => heartbeat(r, db), await signed("/hb", receiver, { ea_version: "0.9.0", equity: 5000, trade_allowed: true }));
  assert.deepEqual([res.status, res.body.error], [426, "EA_OUTDATED"]);
  const row = (await pg.query("select status, equity from public.mt5_accounts where id = $1", [receiver.id])).rows[0] as Record<string, unknown>;
  assert.equal(row.status, "online");
});

test("heartbeat fills login/server once, then refuses another account, the wrong EA and a skewed clock", async () => {
  const n = (await asUser(BOB, "select * from public.create_mt5_account('receiver', 'Auto', null, null)")).rows[0] as Record<string, string>;
  const auto = { id: n.account_id, token: n.ea_token, secret: n.hmac_secret };
  const row = async () => (await pg.query("select login, server, broker, ea_kind, selftest, first_seen_at, last_error from public.mt5_accounts where id = $1", [auto.id])).rows[0] as Record<string, unknown>;
  const hb = { ea_version: "1.1.0", trade_allowed: true, login: 777, server: "Demo-MT5", broker: "Demo Ltd", ea_kind: "receiver", selftest: "ok", terminal_build: 5000 };

  assert.equal((await call((r) => heartbeat(r, db), await signed("/hb", auto, hb))).status, 200);
  let x = await row();
  assert.deepEqual([String(x.login), x.server, x.broker, x.ea_kind, x.selftest, x.first_seen_at != null], ["777", "Demo-MT5", "Demo Ltd", "receiver", "ok", true]);

  const other = await call((r) => heartbeat(r, db), await signed("/hb", auto, { ...hb, login: 888 }));
  assert.deepEqual([other.status, other.body.error], [409, "ACCOUNT_MISMATCH"]);
  assert.match(String((await row()).last_error), /777.*888/);

  const wrongEa = await call((r) => heartbeat(r, db), await signed("/hb", auto, { ...hb, ea_kind: "master" }));
  assert.deepEqual([wrongEa.status, wrongEa.body.error], [409, "WRONG_EA"]);

  const taken = (await asUser(BOB, "select * from public.create_mt5_account('receiver', 'Dup', null, null)")).rows[0] as Record<string, string>;
  const dup = await call((r) => heartbeat(r, db), await signed("/hb", { id: taken.account_id, token: taken.ea_token, secret: taken.hmac_secret }, hb));
  assert.deepEqual([dup.status, dup.body.error], [409, "ACCOUNT_IN_USE"]);
  // same owner: the message names the entry that holds the account, by name, role and short ID
  assert.match(String(dup.body.message), new RegExp(`"Auto" \\(Receiver, ID ${auto.id.slice(0, 8)}…\\)`));
  // another owner's entry is not named
  const stranger = (await asUser(ALICE, "select * from public.create_mt5_account('receiver', 'Other', null, null)")).rows[0] as Record<string, string>;
  const foreign = await call((r) => heartbeat(r, db), await signed("/hb", { id: stranger.account_id, token: stranger.ea_token, secret: stranger.hmac_secret }, hb));
  assert.equal(foreign.body.error, "ACCOUNT_IN_USE");
  assert.match(String(foreign.body.message), /người dùng khác/);
  assert.doesNotMatch(String(foreign.body.message), /Auto/);

  const skew = await call((r) => heartbeat(r, db), await signed("/hb", auto, hb, { ts: Date.now() + 300_000 }));
  assert.deepEqual([skew.status, skew.body.error], [401, "CLOCK_SKEW"]);
  x = await row();
  assert.match(String(x.last_error), /Đồng hồ/);
});

test("ingest: masters only, validated, idempotent", async () => {
  const e = { event_uid: "1-DEAL-9", type: "OPEN", master_ticket: 9, symbol: "XAUUSD", side: "BUY", volume: 0.5, price: 2650, master_equity: 10000, ts_ms: Date.now() };
  const asReceiver = await call((r) => ingest(r, db), await signed("/ingest", receiver, { events: [e] }));
  assert.deepEqual([asReceiver.status, asReceiver.body.error], [403, "WRONG_ROLE"]);
  const invalid = await call((r) => ingest(r, db), await signed("/ingest", master, { events: [{ ...e, volume: undefined }] }));
  assert.equal(invalid.status, 400);
  assert.deepEqual(invalid.body.problems[0].p, ["volume required"]);
  const ok = await call((r) => ingest(r, db), await signed("/ingest", master, { events: [e] }));
  assert.equal(ok.status, 200);
  assert.equal(ok.body.accepted[0].seq, 1);
  const again = await call((r) => ingest(r, db), await signed("/ingest", master, { events: [e] }));
  assert.deepEqual([again.body.accepted[0].seq, again.body.accepted[0].duplicate], [1, true]);
});

test("pull: new cursor starts now; known cursor gets events, settings and group state", async () => {
  const fresh = await call((r) => pull(r, db), await signed("/pull", receiver, { cursors: {}, wait_s: 0 }));
  assert.equal(fresh.status, 200);
  assert.equal(fresh.body.events.length, 0);
  assert.equal(fresh.body.cursors[master.id], 1);
  const got = await call((r) => pull(r, db), await signed("/pull", receiver, { cursors: { [master.id]: 0 }, wait_s: 0 }));
  assert.equal(got.body.events.length, 1);
  assert.equal(got.body.events[0].payload.symbol, "XAUUSD");
  assert.equal(got.body.events[0].skip_reason, null);
  assert.equal(got.body.links[0].group_state, "running");
  assert.equal(got.body.links[0].settings.lot_mode, "equity_ratio");
});

test("pull long-polls until the wait runs out when there is nothing new", async () => {
  let slept = 0;
  const started = Date.now();
  const res = await route((r) => pull(r, db, Date.now(), async (ms) => { slept += ms; await new Promise((x) => setTimeout(x, 50)); }))(
    await signed("/pull", receiver, { cursors: { [master.id]: 1 }, wait_s: 1 }));
  assert.equal(res.status, 200);
  assert.ok(slept >= 1000 || Date.now() - started >= 1000, "it waited");
});

test("ack stores results; bars accepted from the master only", async () => {
  const res = await call((r) => ack(r, db), await signed("/ack", receiver, { results: [
    { master_id: master.id, seq: 1, master_ticket: 9, status: "executed", action: "OPEN", symbol: "XAUUSD", volume: 0.25, receiver_ticket: 77 },
  ] }));
  assert.deepEqual([res.status, res.body.stored], [200, 1]);
  const badAck = await call((r) => ack(r, db), await signed("/ack", receiver, { results: [{ master_id: master.id, seq: 1, status: "done" }] }));
  assert.equal(badAck.status, 400);
  const t = Math.floor(Date.now() / 60_000) * 60 - 60;
  const b = await call((r) => bars(r, db), await signed("/bars", master, { bars: [{ symbol: "XAUUSD", t, o: 1, h: 2, l: 0.5, c: 1.5, v: 3 }] }));
  assert.deepEqual([b.status, b.body.stored], [200, 1]);
  const rb = await call((r) => bars(r, db), await signed("/bars", receiver, { bars: [{ symbol: "XAUUSD", t, o: 1, h: 1, l: 1, c: 1 }] }));
  assert.equal(rb.status, 403);
});

test("a disabled account is refused everywhere", async () => {
  await pg.query("update public.mt5_accounts set disabled = true where id = $1", [receiver.id]);
  const res = await call((r) => pull(r, db), await signed("/pull", receiver, { cursors: {}, wait_s: 0 }));
  assert.deepEqual([res.status, res.body.error], [403, "ACCOUNT_DISABLED"]);
  await pg.query("update public.mt5_accounts set disabled = false where id = $1", [receiver.id]);
});

test("event validation catches each problem", () => {
  assert.deepEqual(eventProblems({ event_uid: "x", type: "NOPE" }), ["event_uid", "type"]);
  assert.deepEqual(eventProblems({ event_uid: "abc", type: "PARTIAL_CLOSE", master_ticket: 1, volume: 1, volume_before: 1, ts_ms: 1 }),
    ["volume must be below volume_before"]);
  assert.deepEqual(eventProblems({ event_uid: "abc", type: "KILL", ts_ms: 1 }), []);
});
