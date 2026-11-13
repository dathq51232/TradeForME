import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CopyEvent, IngestBody, CopyLinkSettings, computeLot, mapSymbol, partialCloseVolume, isStale,
  deliverySkipReason, filterReason, riskPreCheck,
} from "../src/copytrade.js";

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

test("balance_ratio scales by balance (design 7.4)", () => {
  assert.deepEqual(computeLot({ mode: "balance_ratio", value: 1, masterLot: 0.5, masterBalance: 10000, receiverBalance: 5000, volume: vol }), { lot: 0.25 });
  assert.deepEqual(computeLot({ mode: "balance_ratio", value: 1, masterLot: 0.5, volume: vol }), { skip: "BALANCE_UNKNOWN" });
});

test("design 7.4 example: multipliers 0.5x, 1x, 0.2x on a 0.50 lot master", () => {
  const lots = [0.5, 1, 0.2].map((k) => computeLot({ mode: "multiplier", value: k, masterLot: 0.5, volume: vol }).lot);
  assert.deepEqual(lots, [0.25, 0.5, 0.1]);
});

test("link min_lot is a floor: skip by default, raise with min_lot policy", () => {
  const a = { mode: "multiplier", value: 0.1, masterLot: 0.5, volume: vol, minLot: 0.1 };
  assert.deepEqual(computeLot(a), { skip: "BELOW_MIN_LOT" });
  assert.deepEqual(computeLot({ ...a, belowMin: "min_lot" }), { lot: 0.1 });
});

test("delivery by group state matches ct_pull", () => {
  assert.equal(deliverySkipReason("OPEN", "running", true), null);
  assert.equal(deliverySkipReason("OPEN", "paused", true), "group_paused");
  assert.equal(deliverySkipReason("CLOSE", "paused", true), null);
  assert.equal(deliverySkipReason("CLOSE", "emergency", true), "group_emergency");
  assert.equal(deliverySkipReason("KILL", "emergency", false), null);
  assert.equal(deliverySkipReason("OPEN", "running", false), "receiver_disabled");
  assert.equal(deliverySkipReason("OPEN", "running", true, true), "group_paused");
});

test("receiver filters", () => {
  const s = CopyLinkSettings.parse({ enabled: true });
  assert.equal(filterReason(open, s), null);
  assert.equal(filterReason(open, { ...s, copy_buy: false }), "BUY_DISABLED");
  assert.equal(filterReason(open, { ...s, copy_buy: false, reverse: true }), null, "reversed BUY becomes SELL");
  assert.equal(filterReason(open, s, ["BTCUSD"]), "SYMBOL_NOT_ALLOWED");
  assert.equal(filterReason({ type: "PENDING_PLACE", symbol: "XAUUSD", side: "BUY_LIMIT" }, s), "PENDING_DISABLED");
  assert.equal(filterReason({ type: "PARTIAL_CLOSE" }, { ...s, copy_partial_close: false }), "PARTIAL_CLOSE_DISABLED");
  assert.equal(filterReason({ type: "MODIFY" }, { ...s, copy_sl_tp: false }), "MODIFY_DISABLED");
});

test("risk pre-check: each limit, and the configured action", () => {
  const settings = CopyLinkSettings.parse({
    enabled: true, max_spread_points: 30, max_open_positions: 3, max_exposure_lots: 1,
    max_daily_loss_pct: 5, max_drawdown_pct: 10, max_margin_usage_pct: 50, risk_action: "pause_receiver",
  });
  const ok = { settings, online: true, tradeAllowed: true, lot: 0.2, spreadPoints: 20, openPositions: 1, openLots: 0.3,
    dayStartEquity: 10000, peakEquity: 10500, equity: 9900, margin: 1000, freeMarginAfter: 8000 };
  assert.deepEqual(riskPreCheck(ok), { ok: true });
  assert.deepEqual(riskPreCheck({ ...ok, online: false }), { ok: false, rule: "RECEIVER_OFFLINE", action: "reject" });
  assert.equal(riskPreCheck({ ...ok, spreadPoints: 31 }).rule, "SPREAD_TOO_HIGH");
  assert.equal(riskPreCheck({ ...ok, openPositions: 3 }).rule, "MAX_OPEN_POSITIONS");
  assert.equal(riskPreCheck({ ...ok, openLots: 0.9 }).rule, "MAX_EXPOSURE");
  assert.equal(riskPreCheck({ ...ok, equity: 9500 }).rule, "MAX_DAILY_LOSS");
  assert.equal(riskPreCheck({ ...ok, peakEquity: 10500, dayStartEquity: 9400, equity: 9400 }).rule, "MAX_DRAWDOWN");
  assert.equal(riskPreCheck({ ...ok, margin: 6000 }).rule, "MAX_MARGIN_USAGE");
  assert.equal(riskPreCheck({ ...ok, freeMarginAfter: -1 }).rule, "INSUFFICIENT_MARGIN");
  assert.equal(riskPreCheck({ ...ok, spreadPoints: 31 }).action, "pause_receiver");
});
