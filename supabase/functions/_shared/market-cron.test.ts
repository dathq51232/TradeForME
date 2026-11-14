// market-cron against the real migrations (PGlite), with fake price, calendar and Telegram endpoints.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { openDb, rpcAdapter } from "../../tests/pglite.mjs";
import { route, type Db } from "./ea.ts";
import { marketCron, parseCalendar, leadingNumber } from "./market-cron.ts";

let pg: Awaited<ReturnType<typeof openDb>>;
let db: Db;
let secret: string;
const ALICE = "00000000-0000-0000-0000-00000000000a";
let price = { BTCUSDT: 100, GC: 2600 };
const telegram: { chat_id: string; text: string }[] = [];
let calendarCalls = 0;

const fakeFetch = async (url: string, init?: RequestInit) => {
  if (url.includes("binance")) return Response.json({ price: String(price.BTCUSDT) });
  if (url.includes("yahoo")) return Response.json({ chart: { result: [{ meta: { regularMarketPrice: price.GC } }] } });
  if (url.includes("telegram")) { telegram.push(JSON.parse(String(init?.body))); return Response.json({ ok: true }); }
  if (url.includes("faireconomy")) {
    calendarCalls++;
    return Response.json([
      { title: "CPI m/m", country: "USD", date: "2026-11-10T08:30:00-05:00", impact: "High", forecast: "0.3%", previous: "0.6%" },
      { title: "Bank Holiday", country: "JPY", date: "2026-11-11T00:00:00-05:00", impact: "Holiday", forecast: "", previous: "" },
    ]);
  }
  return new Response("not found", { status: 404 });
};
const run = async (s = secret) => {
  const res = await route((r) => marketCron(r, { db, fetch: fakeFetch, telegramToken: "t" }))(
    new Request("http://edge/market-cron", { method: "POST", headers: { "x-qt-cron": s }, body: "{}" }));
  return { status: res.status, body: await res.json() };
};

before(async () => {
  pg = await openDb();
  db = rpcAdapter(pg);
  await pg.exec(`insert into auth.users (id, email) values ('${ALICE}', 'a@x.test');
    update public.profiles set telegram_chat_id = '42' where id = '${ALICE}';`);
  secret = ((await pg.query("select secret from private.cron_secret")).rows[0] as { secret: string }).secret;
  await pg.query(`insert into public.alerts (user_id, symbol, rule, last_price) values
    ($1, 'BTCUSD', '{"kind":"price","op":"above","price":110}', 100),
    ($1, 'XAUUSD', '{"kind":"price","op":"below","price":2550}', null)`, [ALICE]);
});

test("helpers", () => {
  assert.deepEqual([leadingNumber("0.3%"), leadingNumber("215K"), leadingNumber("-1,200.5M"), leadingNumber("")], [0.3, 215, -1200.5, null]);
  const rows = parseCalendar([{ title: "NFP", country: "USD", date: "2026-11-06T08:30:00-05:00", impact: "High", forecast: "120K" }, { impact: "Holiday" }]);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].scheduled_at, rows[0].importance, rows[0].forecast, rows[0].forecast_text], ["2026-11-06T13:30:00.000Z", 3, 120, "120K"]);
});

test("refuses calls without the cron secret", async () => {
  assert.deepEqual((await run("0".repeat(64))).status, 401);
  assert.deepEqual((await run("nope")).status, 401);
});

test("first run: no cross yet, remembers prices, syncs the calendar once", async () => {
  const r = await run();
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.alerts, { symbols: 2, priced: 2, telegram: 0, sent: 0 });
  assert.equal(r.body.calendar, 1);
  const ev = (await pg.query("select title, importance, forecast, forecast_text, assets from public.econ_events")).rows[0] as Record<string, unknown>;
  assert.deepEqual([ev.title, ev.importance, Number(ev.forecast), ev.forecast_text], ["CPI m/m", 3, 0.3, "0.3%"]);
  const gold = (await pg.query("select last_price from public.alerts where symbol = 'XAUUSD'")).rows[0] as { last_price: string };
  assert.equal(Number(gold.last_price), 2600);
  await run();
  assert.equal(calendarCalls, 1, "calendar is refreshed at most every 30 minutes");
});

test("a crossed level fires once: notification, Telegram, disarmed", async () => {
  price = { BTCUSDT: 111, GC: 2600 };
  const r = await run();
  assert.equal(r.body.alerts.sent, 1);
  assert.equal(telegram[0].chat_id, "42");
  assert.match(telegram[0].text, /BTCUSD vượt lên 110/);
  const a = (await pg.query("select active, fired_price from public.alerts where symbol = 'BTCUSD'")).rows[0] as Record<string, unknown>;
  assert.deepEqual([a.active, Number(a.fired_price)], [false, 111]);
  const n = (await pg.query("select title, link from public.notifications where user_id = $1", [ALICE])).rows as Record<string, unknown>[];
  assert.equal(n.length, 1);
  assert.equal(n[0].link, "/charts?symbol=BTCUSD");
  price = { BTCUSDT: 90, GC: 2600 };
  await run();
  price = { BTCUSDT: 120, GC: 2600 };
  assert.equal((await run()).body.alerts.sent, 0, "a fired alert stays off");
});

test("broker M1 bars win over the public price", async () => {
  await pg.query("insert into public.bars_m1 (symbol, ts, o, h, l, c, source) values ('XAUUSD', now(), 2540, 2545, 2535, 2540, 'broker')");
  const r = await run();
  assert.equal(r.body.alerts.sent, 1);
  assert.match(telegram[telegram.length - 1].text, /XAUUSD xuống dưới 2550 \(giá 2540/);
});
