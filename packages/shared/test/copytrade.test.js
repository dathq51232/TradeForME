import { test } from "node:test";
import assert from "node:assert/strict";
import { CopyEvent, IngestBody, CopyLinkSettings, computeLot, mapSymbol, partialCloseVolume, isStale } from "../src/copytrade.js";

const vol = { min: 0.01, max: 100, step: 0.01 };
const open = {
  event_uid: "1-DEAL-9", type: "OPEN", master_ticket: 9, symbol: "XAUUSD", side: "BUY", volume: 0.5,
  price: 2650.35, sl: 2640, tp: 2670, master_balance: 10000, master_equity: 10120.5, ts_ms: 1794567890123,
};

test("valid OPEN parses; OPEN without volume is rejected", () => {
  assert.equal(CopyEvent.parse(open).symbol, "XAUUSD");
  const { volume, ...noVol } = open;
  assert.equal(CopyEvent.safeParse(noVol).success, false);
});

test("PARTIAL_CLOSE needs volume below volume_before", () => {
  const base = { event_uid: "1-DEAL-10", type: "PARTIAL_CLOSE", master_ticket: 9, ts_ms: 1 };
  assert.ok(CopyEvent.safeParse({ ...base, volume: 0.2, volume_before: 0.5 }).success);
  assert.equal(CopyEvent.safeParse({ ...base, volume: 0.5, volume_before: 0.5 }).success, false);
});

test("ingest body needs 1..100 events", () => {
  assert.equal(IngestBody.safeParse({ events: [] }).success, false);
  assert.ok(IngestBody.safeParse({ events: [open] }).success);
});

test("link settings default to disabled, equity_ratio", () => {
  const s = CopyLinkSettings.parse({});
  assert.equal(s.enabled, false);
  assert.equal(s.lot_mode, "equity_ratio");
  assert.equal(s.max_signal_age_s, 10);
});

test("equity_ratio scales by equity and rounds down to step", () => {
  assert.deepEqual(computeLot({ mode: "equity_ratio", value: 1, masterLot: 0.5, masterEquity: 10000, receiverEquity: 3333, volume: vol }), { lot: 0.16 });
  assert.deepEqual(computeLot({ mode: "equity_ratio", value: 2, masterLot: 1, masterEquity: 10000, receiverEquity: 10000, volume: vol }), { lot: 2 });
});

test("lot is capped by max_lot and skipped below min unless min_lot", () => {
  assert.deepEqual(computeLot({ mode: "multiplier", value: 10, masterLot: 1, volume: vol, maxLot: 3 }), { lot: 3 });
  const tiny = { mode: "equity_ratio", value: 1, masterLot: 0.01, masterEquity: 10000, receiverEquity: 500, volume: vol };
  assert.deepEqual(computeLot(tiny), { skip: "BELOW_MIN_LOT" });
  assert.deepEqual(computeLot({ ...tiny, belowMin: "min_lot" }), { lot: 0.01 });
});

test("contract size difference between brokers is applied", () => {
  // master gold = 100 oz/lot, receiver gold = 1 oz/lot -> 100x the lots
  const r = computeLot({ mode: "multiplier", value: 1, masterLot: 0.1, masterContractSize: 100, receiverContractSize: 1, volume: { min: 1, max: 1000, step: 1 } });
  assert.deepEqual(r, { lot: 10 });
});

test("risk_percent sizes from stop distance and needs a stop", () => {
  // equity 10k, risk 1% = $100; SL 10.00 away, tick 0.01 worth $1/lot -> $1000 per lot -> 0.1 lot
  const base = { mode: "risk_percent", value: 1, masterLot: 1, receiverEquity: 10000, tickSize: 0.01, tickValue: 1, volume: vol };
  assert.deepEqual(computeLot({ ...base, slDistance: 10 }), { lot: 0.1 });
  assert.deepEqual(computeLot(base), { skip: "NO_STOP_LOSS" });
});

test("symbol mapping: explicit map, suffix guess, case-insensitive, unknown", () => {
  assert.equal(mapSymbol("XAUUSD", { XAUUSD: "GOLD" }, ["GOLD"]), "GOLD");
  assert.equal(mapSymbol("XAUUSD", {}, ["EURUSDm", "XAUUSDm"]), "XAUUSDm");
  assert.equal(mapSymbol("XAUUSD.r", {}, ["XAUUSD#"]), "XAUUSD#");
  assert.equal(mapSymbol("btcusd", {}, ["BTCUSD"]), "BTCUSD");
  assert.equal(mapSymbol("USOIL", {}, ["XAUUSD"]), null);
});

test("partial close keeps the master's fraction and never leaves dust", () => {
  assert.equal(partialCloseVolume({ masterClosed: 0.25, masterBefore: 0.5, receiverVolume: 0.3, step: 0.01, min: 0.01 }), 0.15);
  assert.equal(partialCloseVolume({ masterClosed: 0.9, masterBefore: 1, receiverVolume: 0.05, step: 0.01, min: 0.01 }), 0.05);
});

test("stale opens are refused but closes always apply", () => {
  assert.equal(isStale({ type: "OPEN", ts_ms: 1 }, 11_001, 10), true);
  assert.equal(isStale({ type: "OPEN", ts_ms: 1 }, 9_001, 10), false);
  assert.equal(isStale({ type: "CLOSE", ts_ms: 1 }, 999_000, 10), false);
});
