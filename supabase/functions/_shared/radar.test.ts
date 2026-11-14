// radar-cron: the scanners with fake exchange APIs, and the whole run against the real migrations (PGlite).
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { openDb, rpcAdapter } from "../../tests/pglite.mjs";
import { route, type Db } from "./ea.ts";
import { radarCron, arbitrage, usdRates, fill, withDepth, pumpMetrics, diffListings, parse, type Ticker, type Rates } from "./radar.ts";

const ONE: Rates = { USD: 1, USDT: 1, USDC: 1, source: { USDT: "assumed", USDC: "assumed" } };
const row = (native: string, base: string, quote: string, bid: number, ask: number, vol = 1e7): Ticker =>
  ({ native, base, quote, bid, ask, last: (bid + ask) / 2, vol });
const snap = (rows: Ticker[], at = Date.now()) => ({ at, rows });

test("arbitrage buys the lowest ask and sells the highest bid, gross before fees", () => {
  const [r] = arbitrage({
    BINANCE: snap([row("BTCUSDT", "BTC", "USDT", 100, 100.1)]),
    OKX: snap([row("BTC-USDT", "BTC", "USDT", 102, 102.1)]),
    GATE: snap([row("BTC_USDT", "BTC", "USDT", 101, 101.1)]),
  }, { rates: ONE });
  assert.deepEqual([r.base, r.buy.ex, r.sell.ex, r.suspect], ["BTC", "BINANCE", "OKX", false]);
  assert.ok(Math.abs(r.gross - (102 / 100.1 - 1) * 100) < 1e-9);
});

test("USDT is priced in USD from the market, so a USDT/USD gap is not an opportunity", () => {
  const s = {
    KRAKEN: snap([row("USDTUSD", "USDT", "USD", 0.998, 0.998), row("ETHUSD", "ETH", "USD", 2994, 2994.5)]),
    BINANCE: snap([row("ETHUSDT", "ETH", "USDT", 2999, 3000)]),
  };
  const rates = usdRates(s);
  assert.deepEqual([rates.USDT, rates.source.USDT], [0.998, "market"]);
  assert.equal(arbitrage(s, { rates }).length, 0);
  assert.equal(arbitrage(s, { rates: ONE }).length, 1);
});

test("an odd price gets a separate, flagged row; stale, thin, stable and leveraged markets are skipped", () => {
  const rows = arbitrage({
    BINANCE: snap([row("AIUSDT", "AI", "USDT", 1.0, 1.001), row("USDCUSDT", "USDC", "USDT", 0.99, 0.991), row("BTCUPUSDT", "BTCUP", "USDT", 1, 1.01)]),
    OKX: snap([row("AI-USDT", "AI", "USDT", 1.002, 1.003)]),
    GATE: snap([row("AI_USDT", "AI", "USDT", 0.2, 0.201), row("USDC_USDT", "USDC", "USDT", 1.01, 1.02), row("BTCUP_USDT", "BTCUP", "USDT", 1.05, 1.06)]),
    KUCOIN: snap([row("AI-USDT", "AI", "USDT", 1.2, 1.21)], Date.now() - 10 * 60_000),
    BYBIT: snap([row("AIUSDT", "AI", "USDT", 1.3, 1.31, 50)]),
  }, { rates: ONE });
  assert.equal(rows.length, 2);
  const [clean, odd] = [rows.find((r) => !r.suspect)!, rows.find((r) => r.suspect)!];
  assert.deepEqual([clean.buy.ex, clean.sell.ex, clean.suspects], ["BINANCE", "OKX", ["GATE"]]);
  assert.deepEqual([odd.buy.ex, odd.sell.ex], ["GATE", "OKX"]);
  // two exchanges, no median to speak of: a 400% gap is flagged on its own
  const two = arbitrage({ BINANCE: snap([row("AIUSDT", "AI", "USDT", 1, 1.001)]), GATE: snap([row("AI_USDT", "AI", "USDT", 0.2, 0.201)]) }, { rates: ONE });
  assert.deepEqual(two.map((r) => r.suspect), [true]);
});

test("walking the order books gives the gross gap for each trade size", async () => {
  const f = async (url: string) => url.includes("binance")
    ? Response.json({ bids: [], asks: [["100", "1"], ["101", "1000"]] })
    : Response.json({ data: [{ bids: [["103", "0.5"], ["102", "1000"]], asks: [] }] });
  const rows = arbitrage({ BINANCE: snap([row("BTCUSDT", "BTC", "USDT", 99, 100)]), OKX: snap([row("BTC-USDT", "BTC", "USDT", 103, 104)]) }, { rates: ONE });
  await withDepth(f, rows, ONE);
  // $201 would buy 1 at 100 and 1 at 101; at $100 it's 1 coin at 100, sold at 103 (0.5) and 102 (0.5)
  const d = rows[0].depth!;
  assert.ok(Math.abs(d[100].gross - (102.5 / 100 - 1) * 100) < 1e-9);
  assert.equal(d[100].full, true);
  assert.equal(d[10000].full, true);
  assert.ok(d[10000].gross < d[100].gross, "a bigger trade walks deeper into both books");
  const thin = fill([[100, 1]], 500, "quote");
  assert.deepEqual([thin.full, thin.qty], [false, 1]);
});

// 1-minute bars: flat for 160 minutes, then `tail` closes with quote volume `v` and `buy` share bought at the ask.
function klines(tail: number[], v = 50000, buy = 0.8) {
  const out: unknown[][] = [];
  let t = 0, p = 1;
  const push = (o: number, c: number, qv: number, tb: number) => {
    out.push([t, String(o), String(Math.max(o, c) * 1.001), String(Math.min(o, c) * 0.999), String(c), "0", t + 59999, String(qv), String(qv / 100), "0", String(qv * tb), "0"]);
    t += 60000;
  };
  for (let i = 0; i < 160; i++) push(1, 1, 5000, 0.5);
  for (const c of tail) { push(p, c, v, buy); p = c; }
  return out;
}

test("pump metrics: pumping, topping out, dumping, volume only, quiet", () => {
  const up = pumpMetrics(klines([1.02, 1.04, 1.06, 1.08, 1.1, 1.12, 1.14, 1.16, 1.18, 1.2]))!;
  assert.equal(up.stage, "pumping");
  assert.ok(up.volRatio > 9 && up.volRatio < 11 && up.score >= 70, JSON.stringify(up));
  assert.equal(pumpMetrics(klines([1.05, 1.1, 1.15, 1.2, 1.18, 1.16, 1.15], 50000, 0.45))!.stage, "topping");
  assert.equal(pumpMetrics(klines([1.1, 1.2, 1.3, 1.25, 1.18, 1.12, 1.08], 50000, 0.3))!.stage, "dumping");
  assert.equal(pumpMetrics(klines([1, 1, 1, 1, 1], 80000))!.stage, "volume");
  const quiet = pumpMetrics(klines([1, 1, 1, 1, 1], 5000))!;
  assert.equal(quiet.stage, null);
  assert.ok(quiet.score < 25);
});

test("listings: the first list seeds, new pairs and openings are reported, a half-empty list is ignored", () => {
  const a = [{ native: "BTCUSDT", base: "BTC", quote: "USDT", status: "trading" as const }];
  const seed = diffListings(undefined, a);
  assert.deepEqual([seed.seeded, seed.events.length], [true, 0]);
  const d1 = diffListings(seed.known, [...a, { native: "NEWUSDT", base: "NEW", quote: "USDT", status: "pre" }]);
  assert.deepEqual(d1.events.map((e) => [e.kind, e.native]), [["new", "NEWUSDT"]]);
  const d2 = diffListings(d1.known, [...a, { native: "NEWUSDT", base: "NEW", quote: "USDT", status: "trading" }]);
  assert.deepEqual(d2.events.map((e) => [e.kind, e.native]), [["opened", "NEWUSDT"]]);
  const many = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`C${i}USDT`, "trading"]));
  assert.equal(diffListings(many, a).skipped, true);
});

test("exchange parsers name pairs the same way everywhere", () => {
  const kr = parse.krakenInstruments({ result: { XXBTZUSD: { altname: "XBTUSD", wsname: "XBT/USD", status: "online" }, OLD: { altname: "O", wsname: "O/USD", status: "delisted" } } });
  assert.deepEqual(kr, [{ native: "XBTUSD", key: "XXBTZUSD", base: "BTC", quote: "USD", status: "trading" }]);
  const kt = parse.krakenTickers({ result: { XXBTZUSD: { a: ["101"], b: ["100"], c: ["100.5"], v: ["5", "10"], p: ["100", "100"] } } }, kr);
  assert.deepEqual(kt[0], { native: "XBTUSD", base: "BTC", quote: "USD", bid: 100, ask: 101, last: 100.5, vol: 1000 });
  assert.deepEqual(parse.binanceTickers([{ symbol: "SOLUSDT", bidPrice: "1", askPrice: "2", lastPrice: "1.5", quoteVolume: "9", count: 5, priceChangePercent: "3" }, { symbol: "OLDUSDT", count: 0 }, { symbol: "ETHBTC", count: 9 }]),
    [{ native: "SOLUSDT", base: "SOL", quote: "USDT", bid: 1, ask: 2, last: 1.5, vol: 9, change: 3 }]);
  assert.equal(parse.gateInstruments([{ id: "N_USDT", base: "N", quote: "USDT", trade_status: "untradable", buy_start: 2e9 }], 1.7e12)[0].status, "pre");
  assert.equal(parse.okxInstruments({ data: [{ instId: "A-USDT", baseCcy: "A", quoteCcy: "USDT", state: "preopen" }] })[0].status, "pre");
  assert.equal(parse.bybitInstruments({ result: { list: [{ symbol: "AUSDT", baseCoin: "A", quoteCoin: "USDT", status: "PreLaunch" }] } })[0].status, "pre");
});

// ---------- the whole run, against the migrations ----------
let pg: Awaited<ReturnType<typeof openDb>>;
let db: Db;
let secret: string;
const ALICE = "00000000-0000-0000-0000-00000000000a";
const BOB = "00000000-0000-0000-0000-00000000000b";
const telegram: { chat_id: string; text: string }[] = [];
let okxPairs = [{ instId: "SOL-USDT", baseCcy: "SOL", quoteCcy: "USDT", state: "live" }];

const fakeFetch = async (url: string, init?: RequestInit) => {
  const u = new URL(url);
  const at = `${u.host}${u.pathname}`;
  if (at.includes("telegram")) { telegram.push(JSON.parse(String(init?.body))); return Response.json({ ok: true }); }
  if (at.endsWith("/api/v3/ticker/24hr")) return Response.json([{ symbol: "SOLUSDT", bidPrice: "100", askPrice: "100.1", lastPrice: "100", quoteVolume: "1e8", count: 9, priceChangePercent: "1" }]);
  if (at.endsWith("/api/v3/exchangeInfo")) return Response.json({ symbols: [{ symbol: "SOLUSDT", baseAsset: "SOL", quoteAsset: "USDT", status: "TRADING" }] });
  if (at.endsWith("/api/v3/depth")) return Response.json({ bids: [["100", "1000"]], asks: [["100.1", "1000"]] });
  if (at.endsWith("/api/v3/klines")) return Response.json([]);
  if (at.endsWith("/api/v5/market/tickers")) return Response.json({ data: [{ instId: "SOL-USDT", bidPx: "103", askPx: "103.1", last: "103", volCcy24h: "1e8" }] });
  if (at.endsWith("/api/v5/public/instruments")) return Response.json({ data: okxPairs });
  if (at.endsWith("/api/v5/market/books")) return Response.json({ data: [{ bids: [["103", "1000"]], asks: [["103.1", "1000"]] }] });
  if (u.host === "api.bybit.com") return new Response("blocked", { status: 403 });
  return new Response("not found", { status: 404 });
};
const run = async (s = secret) => {
  const res = await route((r) => radarCron(r, { db, fetch: fakeFetch, telegramToken: "t" }))(
    new Request("http://edge/radar-cron", { method: "POST", headers: { "x-qt-cron": s }, body: "{}" }));
  return { status: res.status, body: await res.json() };
};
const forceListingCheck = () => pg.exec(`update private.radar_state set value = '0' where key = 'listingsAt'`);

before(async () => {
  pg = await openDb();
  db = rpcAdapter(pg);
  await pg.exec(`insert into auth.users (id, email) values ('${ALICE}', 'a@x.test'), ('${BOB}', 'b@x.test');
    update public.profiles set telegram_chat_id = '42' where id = '${ALICE}';
    insert into public.radar_settings (user_id, alerts_on, arb_alert) values ('${ALICE}', true, 2), ('${BOB}', false, 0);`);
  secret = ((await pg.query("select secret from private.cron_secret")).rows[0] as { secret: string }).secret;
});

test("refuses calls without the cron secret", async () => {
  assert.equal((await run("0".repeat(64))).status, 401);
});

test("a run stores the scan, notes blocked exchanges, and alerts users who asked for it", async () => {
  const r = await run();
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.arbitrage, 1);
  assert.match(String(r.body.exchanges.BYBIT), /403/);
  const s = (await pg.query("select arbitrage, status from public.radar_snapshot")).rows[0] as { arbitrage: { base: string; depth: Record<string, { gross: number }> }[]; status: Record<string, { ok: boolean }> };
  assert.equal(s.arbitrage[0].base, "SOL");
  assert.ok(Math.abs(s.arbitrage[0].depth["1000"].gross - (103 / 100.1 - 1) * 100) < 1e-6);
  assert.equal(s.status.OKX.ok, true);
  // 2.9% gross - 0.2% fees >= Alice's 2%; Bob has alerts off
  const notes = (await pg.query("select user_id, title from public.notifications where link = '/radar'")).rows as { user_id: string; title: string }[];
  assert.deepEqual(notes.map((n) => n.user_id), [ALICE]);
  assert.match(notes[0].title, /SOL/);
  assert.equal(telegram.length, 1);
  assert.equal(telegram[0].chat_id, "42");
});

test("the same gap does not alert again within 30 minutes", async () => {
  await run();
  assert.equal(((await pg.query("select count(*)::int as n from public.notifications where link = '/radar'")).rows[0] as { n: number }).n, 1);
});

test("a pair that appears after the first list is a new listing, with where else it trades", async () => {
  okxPairs = [...okxPairs, { instId: "NEW-USDT", baseCcy: "NEW", quoteCcy: "USDT", state: "preopen" }];
  await forceListingCheck();
  const r = await run();
  assert.equal(r.body.listings, 1);
  const l = (await pg.query("select exchange, base, kind, status from public.radar_listings")).rows;
  assert.deepEqual(l, [{ exchange: "OKX", base: "NEW", kind: "new", status: "pre" }]);
  const note = (await pg.query("select title, body from public.notifications where title like 'Niêm yết%'")).rows[0] as { title: string; body: string };
  assert.match(note.title, /NEW\/USDT trên OKX/);
  assert.match(note.body, /chưa mở giao dịch/);
});

test("signed-in users read the radar; only the owner sees their settings", async () => {
  await pg.exec(`set role authenticated; select set_config('request.jwt.claims', '{"sub":"${BOB}"}', false);`);
  try {
    assert.equal((await pg.query("select count(*)::int as n from public.radar_snapshot")).rows[0].n, 1);
    assert.equal((await pg.query("select count(*)::int as n from public.radar_settings")).rows[0].n, 1, "Bob sees only his own row");
    await assert.rejects(pg.query("update public.radar_snapshot set pumps = '[]'"));
    await assert.rejects(pg.query("select public.radar_state_get()"));
  } finally {
    await pg.exec("reset role");
  }
});
