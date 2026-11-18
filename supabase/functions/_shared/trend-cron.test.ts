// Long-term trend alerts on real BTC daily bars (packages/core/test/fixtures), run through pattern-cron against the
// real migrations (PGlite), with fake Binance and Telegram endpoints.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openDb, rpcAdapter } from "../../tests/pglite.mjs";
import { route, type Db } from "./ea.ts";
import { patternCron, type Bar } from "./pattern-cron.ts";
import { trendEvents, DAY } from "./trend-cron.ts";
import { trendChanges } from "./vendor/trend.js";

const bars = JSON.parse(readFileSync(new URL("../../../packages/core/test/fixtures/btc-1d.json", import.meta.url), "utf8")) as Bar[];
const klines = bars.map((b) => [b.time * 1000, String(b.open), String(b.high), String(b.low), String(b.close), String(b.volume), b.time * 1000 + DAY * 1000 - 1]);

// the newest bar of the fixture with a golden or death cross
const K = (() => {
  for (let k = bars.length - 1; k > 210; k--) if ((trendChanges(bars.slice(0, k + 1)) as { type: string }[]).some((c) => c.type === "cross")) return k;
  throw new Error("no cross in the fixture");
})();
const closeOfK = bars[K].time + DAY; // 00:00 UTC the day after bar K

test("the candle that closed is read, not the one forming, and each event is labelled", () => {
  const ev = trendEvents("BTCUSD", bars.slice(0, K + 2), closeOfK + 30); // K+1 is still forming
  const cross = ev.find((e) => e.type === "cross");
  assert.ok(cross, JSON.stringify(ev.map((e) => e.title)));
  assert.ok(cross.key.endsWith(`|${bars[K].time}`));
  assert.match(cross.title, /^BTCUSD D1: (Golden|Death) cross/);
  assert.match(cross.body, /EMA200 .*không phải khuyến nghị/);
});

test("Monday's run adds the weekly summary; other days do not", () => {
  const monday = (() => { let t = closeOfK; while (new Date(t * 1000).getUTCDay() !== 1) t += DAY; return t; })();
  const upTo = bars.filter((b) => b.time + DAY <= monday);
  const w = trendEvents("BTCUSD", upTo, monday + 30).find((e) => e.type === "weekly");
  assert.ok(w);
  assert.match(w.title, /^BTCUSD: trend dài hạn tuần này — /);
  assert.ok(!trendEvents("BTCUSD", upTo, monday + DAY + 30).some((e) => e.type === "weekly"));
});

test("a market whose last bar is old reports nothing", () => {
  assert.deepEqual(trendEvents("BTCUSD", bars.slice(0, K + 1), closeOfK + 10 * DAY), []);
});

// ---------- the whole run ----------
let pg: Awaited<ReturnType<typeof openDb>>;
let db: Db;
let secret: string;
const ALICE = "00000000-0000-0000-0000-00000000000a";
const BOB = "00000000-0000-0000-0000-00000000000b";
const telegram: { chat_id: string; text: string }[] = [];
let klineCalls = 0;
const fakeFetch = async (url: string, init?: RequestInit) => {
  if (url.includes("telegram")) { telegram.push(JSON.parse(String(init?.body))); return Response.json({ ok: true }); }
  if (url.includes("/api/v3/klines") && url.includes("interval=1d")) { klineCalls++; return Response.json(klines.slice(0, K + 2)); }
  return new Response("not found", { status: 404 });
};
const run = async (nowSec: number) => {
  const res = await route((r) => patternCron(r, { db, fetch: fakeFetch, telegramToken: "t", now: () => nowSec * 1000 }))(
    new Request("http://edge/pattern-cron", { method: "POST", headers: { "x-qt-cron": secret }, body: "{}" }));
  return { status: res.status, body: await res.json() };
};
const notes = async (user: string) => (await pg.query("select title from public.notifications where user_id = $1 and title like '%D1:%'", [user])).rows as { title: string }[];

before(async () => {
  pg = await openDb();
  db = rpcAdapter(pg);
  await pg.exec(`insert into auth.users (id, email) values ('${ALICE}', 'a@x.test'), ('${BOB}', 'b@x.test');
    update public.profiles set telegram_chat_id = '42' where id = '${ALICE}';
    insert into public.trend_alert_settings (user_id, enabled, symbols) values
      ('${ALICE}', true, '{BTCUSD}'),
      ('${BOB}', true, '{XAUUSD}');`);
  secret = ((await pg.query("select secret from private.cron_secret")).rows[0] as { secret: string }).secret;
});

test("away from the daily close the trend is not read", async () => {
  const r = await run(closeOfK + 3600);
  assert.equal(r.status, 200);
  assert.equal(r.body.trend, undefined);
  assert.equal(klineCalls, 0);
});

test("right after the daily close: followers get the note and Telegram, once", async () => {
  const r = await run(closeOfK + 30);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.trend.symbols, 2);
  assert.ok(r.body.trend.events >= 1);
  // Bob's XAUUSD has no fake source here: its error is reported and BTC still runs
  assert.deepEqual(r.body.errors.filter((e: string) => !e.startsWith("XAUUSD")), []);
  const a = await notes(ALICE);
  assert.ok(a.some((n) => /^BTCUSD D1: (Golden|Death) cross/.test(n.title)), JSON.stringify(a));
  assert.equal((await notes(BOB)).length, 0, "Bob follows XAUUSD only");
  assert.ok(telegram.length >= 1 && telegram.every((m) => m.chat_id === "42" && m.text.startsWith("📈 BTCUSD")));
  const before = a.length, sent = telegram.length;
  await run(closeOfK + 90);
  assert.equal((await notes(ALICE)).length, before, "each event goes to a user once");
  assert.equal(telegram.length, sent);
});

test("a kind of event the user switched off is not sent", async () => {
  await pg.exec(`update public.trend_alert_settings set trend_change = false, crosses = false, ema200 = false where user_id = '${ALICE}';
    delete from private.pattern_sent;`);
  const before = (await notes(ALICE)).length;
  await run(closeOfK + 30);
  assert.equal((await notes(ALICE)).length, before);
});
