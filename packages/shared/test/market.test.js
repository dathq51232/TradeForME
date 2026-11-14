import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SYMBOLS, DEFAULT_WATCHLIST, TF_IDS, parseBinance, parseCoinbase, parseYahoo, parseBrokerRows, quoteFromDaily, dedupeBars,
} from "../src/market.js";

test("every symbol has a source and the watchlist only names known symbols", () => {
  for (const [id, s] of Object.entries(SYMBOLS)) assert.ok(s.binance || s.yahoo, id + " needs a data source");
  for (const id of DEFAULT_WATCHLIST) assert.ok(SYMBOLS[id], id);
  assert.ok(TF_IDS.includes("1D") && TF_IDS.includes("4h"));
});

test("Binance klines parse to numbers in seconds", () => {
  const [b] = parseBinance([[1700000000000, "1.5", "2", "1", "1.8", "10.5", 0]]);
  assert.deepEqual(b, { time: 1700000000, open: 1.5, high: 2, low: 1, close: 1.8, volume: 10.5 });
});

test("Coinbase candles are reordered and mapped", () => {
  const bars = parseCoinbase([[120, 1, 4, 2, 3, 9], [60, 1, 2, 1.5, 1.8, 5]]);
  assert.deepEqual(bars.map((b) => b.time), [60, 120]);
  assert.deepEqual(bars[1], { time: 120, open: 2, high: 4, low: 1, close: 3, volume: 9 });
});

test("Yahoo skips empty rows and pins daily bars to the exchange date", () => {
  const j = { chart: { result: [{ meta: { gmtoffset: -14400 }, timestamp: [1700020800, 1700107200, 1700193600],
    indicators: { quote: [{ open: [1, null, 3], high: [2, null, 4], low: [0.5, null, 2], close: [1.5, null, 3.5], volume: [10, null, null] }] } }] } };
  const bars = parseYahoo(j, true);
  assert.equal(bars.length, 2);
  assert.equal(bars[0].time % 86400, 0);
  assert.equal(bars[1].volume, 0);
  assert.throws(() => parseYahoo({ chart: { error: { description: "No data found" } } }, false), /No data found/);
});

test("broker rows, dedupe and daily quote", () => {
  const bars = parseBrokerRows([{ ts: "2026-11-13T10:01:00Z", o: "1", h: "2", l: "0.5", c: "1.5", v: "3" },
    { ts: "2026-11-13T10:00:00Z", o: "1", h: "1", l: "1", c: "1", v: "0" }]);
  assert.equal(bars[0].time, Date.parse("2026-11-13T10:00:00Z") / 1000);
  assert.equal(dedupeBars([{ time: 1, close: 1 }, { time: 1, close: 2 }])[0].close, 2);
  const q = quoteFromDaily([{ time: 0, open: 100, close: 100 }, { time: 86400, open: 100, close: 102 }]);
  assert.equal(q.price, 102);
  assert.equal(Number(q.changePct.toFixed(2)), 2);
  assert.equal(quoteFromDaily([]), null);
});

test("broker symbols map to chart symbols", async () => {
  const { chartSymbol, tfSeconds } = await import("../src/market.js");
  const cases = { XAUUSDm: "XAUUSD", "GOLD.pro": "XAUUSD", "#USOIL": "WTI", "XTIUSD.cash": "WTI", UKOIL: "BRENT", BTCUSDT: "BTCUSD",
    "ETHUSD.r": "ETHUSD", USDX: "DXY", XAGUSD: "XAGUSD", EURUSD: null, XAUUSDJPYXX: null, "": null };
  for (const [broker, id] of Object.entries(cases)) assert.equal(chartSymbol(broker), id, broker);
  assert.equal(tfSeconds("4h"), 14400);
});
