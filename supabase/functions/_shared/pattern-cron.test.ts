// pattern-cron on real BTCUSDT 15m bars (packages/core/test/fixtures), against the real migrations (PGlite),
// with fake Binance and Telegram endpoints.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openDb, rpcAdapter } from "../../tests/pglite.mjs";
import { route, type Db } from "./ea.ts";
import { patternCron, patternEvents, justClosed, type Bar } from "./pattern-cron.ts";
import { candlestickPatterns } from "./vendor/patterns.js";

const raw = JSON.parse(readFileSync(new URL("../../../packages/core/test/fixtures/btcusdt-15m-2026-11-14.json", import.meta.url), "utf8")) as unknown[][];
const bars: Bar[] = raw.map((k) => ({ time: Number(k[0]) / 1000, open: +String(k[1]), high: +String(k[2]), low: +String(k[3]), close: +String(k[4]), volume: +String(k[5]) }));
const STEP = 900;

// the newest bar that closes with a candlestick pattern the alerts report
const K = (() => {
  for (let k = bars.length - 2; k > 200; k--) {
    const c = (candlestickPatterns(bars.slice(0, k + 1)) as { i: number; bias: number; kind: string }[]).find((x) => x.i === k);
    if (c && c.bias !== 0 && !c.kind.endsWith("Marubozu")) return k;
  }
  throw new Error("no candlestick pattern in the fixture");
})();
const closeOfK = bars[K].time + STEP; // the moment bar K closes (and K+1 starts forming)

test("only closed candles count, and a timeframe is checked right after its candle closes", () => {
  assert.equal(justClosed("15m", closeOfK + 30), true);
  assert.equal(justClosed("15m", closeOfK + 300), false);
  assert.equal(justClosed("1h", 7200 + 60), true);
  // K+1 is still forming at closeOfK + 30: it must not be read
  const ev = patternEvents("BTCUSD", "15m", bars.slice(0, K + 2), closeOfK + 30);
  const candle = ev.find((e) => e.type === "candle");
  assert.ok(candle, JSON.stringify(ev.map((e) => e.title)));
  assert.ok(candle.key.endsWith(`|${bars[K].time}`), "the candle that just closed, not the one forming");
  assert.match(candle.title, /^BTCUSD M15: nến /);
  assert.match(candle.body, /không phải khuyến nghị/);
});

test("a small wedge breaking out is reported on the candle that broke it", () => {
  // patterns.test.js: the fixture's wedge is broken at 01:45 UTC on 14/11/2026
  const t = Date.parse("2026-11-14T01:45:00Z") / 1000;
  const upTo = bars.filter((b) => b.time <= t);
  const ev = patternEvents("BTCUSD", "15m", upTo, t + STEP + 10);
  const w = ev.find((e) => e.type === "wedge");
  assert.ok(w, JSON.stringify(ev.map((e) => e.title)));
  assert.match(w.title, /Nêm nhỏ giảm \(tiếp diễn\) (đã phá|sẵn sàng)/);
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
  if (url.includes("/api/v3/klines")) { klineCalls++; return Response.json(raw.slice(0, K + 2)); }
  return new Response("not found", { status: 404 });
};
const run = async (nowSec: number) => {
  const res = await route((r) => patternCron(r, { db, fetch: fakeFetch, telegramToken: "t", now: () => nowSec * 1000 }))(
    new Request("http://edge/pattern-cron", { method: "POST", headers: { "x-qt-cron": secret }, body: "{}" }));
  return { status: res.status, body: await res.json() };
};
const notes = async (user: string) => (await pg.query("select title from public.notifications where user_id = $1 and link like '/charts%'", [user])).rows as { title: string }[];

before(async () => {
  pg = await openDb();
  db = rpcAdapter(pg);
  await pg.exec(`insert into auth.users (id, email) values ('${ALICE}', 'a@x.test'), ('${BOB}', 'b@x.test');
    update public.profiles set telegram_chat_id = '42' where id = '${ALICE}';
    insert into public.pattern_alert_settings (user_id, enabled, symbols, timeframes, candles) values
      ('${ALICE}', true, '{BTCUSD}', '{15m}', true),
      ('${BOB}', true, '{XAUUSD}', '{15m}', true);`);
  secret = ((await pg.query("select secret from private.cron_secret")).rows[0] as { secret: string }).secret;
});

test("refuses calls without the cron secret", async () => {
  const res = await route((r) => patternCron(r, { db, fetch: fakeFetch }))(
    new Request("http://edge/pattern-cron", { method: "POST", headers: { "x-qt-cron": "0".repeat(64) }, body: "{}" }));
  assert.equal(res.status, 401);
});

test("between candle closes nothing is fetched", async () => {
  const r = await run(closeOfK + 300);
  assert.equal(r.status, 200);
  assert.equal(r.body.jobs, 0);
  assert.equal(klineCalls, 0);
});

test("right after a close: followers of that symbol and timeframe get the in-app note and Telegram, once", async () => {
  const r = await run(closeOfK + 30);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.events >= 1);
  // Bob's XAUUSD has no fake source here: its error is reported and the other jobs still run
  assert.deepEqual(r.body.errors.filter((e: string) => !e.startsWith("XAUUSD")), []);
  const a = await notes(ALICE);
  assert.ok(a.some((n) => /^BTCUSD M15: nến /.test(n.title)), JSON.stringify(a));
  assert.equal((await notes(BOB)).length, 0, "Bob follows XAUUSD only");
  assert.ok(telegram.length >= 1 && telegram.every((m) => m.chat_id === "42" && m.text.startsWith("📐 BTCUSD M15")));
  const before = a.length, sent = telegram.length;
  await run(closeOfK + 90); // the next minute, same closed candle
  assert.equal((await notes(ALICE)).length, before, "each event goes to a user once");
  assert.equal(telegram.length, sent);
});

test("a kind of event the user switched off is not sent", async () => {
  await pg.exec(`update public.pattern_alert_settings set formed = false, breakout = false, wedges = false, candles = false where user_id = '${ALICE}';
    delete from private.pattern_sent;`);
  const before = (await notes(ALICE)).length;
  await run(closeOfK + 30);
  assert.equal((await notes(ALICE)).length, before);
});
