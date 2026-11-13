// Copy-trade contract between the MT5 EAs and the Edge Functions (docs/THIET-KE-HE-THONG.md §6, §8).
// The receiver EA re-implements computeLot / mapSymbol in MQL5; these are the reference versions
// the tests pin down, so both sides must agree with them.
import { z } from "zod";

export const EVENT_TYPES = [
  "OPEN", "CLOSE", "PARTIAL_CLOSE", "MODIFY",
  "PENDING_PLACE", "PENDING_MODIFY", "PENDING_DELETE", "SNAPSHOT", "KILL",
];
export const LOT_MODES = ["fixed", "multiplier", "equity_ratio", "risk_percent"];

const ticket = z.number().int().nonnegative();
const price = z.number().nonnegative();

export const SnapshotPosition = z.object({
  master_ticket: ticket,
  symbol: z.string().min(1).max(32),
  side: z.enum(["BUY", "SELL"]),
  volume: z.number().positive(),
  price,
  sl: price.optional(),
  tp: price.optional(),
});

const REQUIRED = {
  OPEN: ["master_ticket", "symbol", "side", "volume", "price", "master_equity"],
  CLOSE: ["master_ticket"],
  PARTIAL_CLOSE: ["master_ticket", "volume", "volume_before"],
  MODIFY: ["master_ticket"],
  PENDING_PLACE: ["master_ticket", "symbol", "side", "volume", "price"],
  PENDING_MODIFY: ["master_ticket"],
  PENDING_DELETE: ["master_ticket"],
  SNAPSHOT: ["positions"],
  KILL: [],
};

/** One event as the master EA posts it to /ct-ingest. */
export const CopyEvent = z
  .object({
    event_uid: z.string().min(3).max(96),
    type: z.enum(EVENT_TYPES),
    master_ticket: ticket.optional(),
    symbol: z.string().min(1).max(32).optional(),
    side: z.enum(["BUY", "SELL", "BUY_LIMIT", "SELL_LIMIT", "BUY_STOP", "SELL_STOP"]).optional(),
    volume: z.number().positive().optional(),
    /** For PARTIAL_CLOSE: master volume before the partial close, so receivers close the same fraction. */
    volume_before: z.number().positive().optional(),
    price: price.optional(),
    sl: price.optional(),
    tp: price.optional(),
    master_balance: z.number().optional(),
    master_equity: z.number().optional(),
    positions: z.array(SnapshotPosition).max(500).optional(),
    close_all: z.boolean().optional(),
    ts_ms: z.number().int().positive(),
  })
  .superRefine((e, ctx) => {
    for (const k of REQUIRED[e.type]) {
      if (e[k] === undefined) ctx.addIssue({ code: "custom", path: [k], message: k + " is required for " + e.type });
    }
    if (e.type === "PARTIAL_CLOSE" && e.volume !== undefined && e.volume_before !== undefined && e.volume >= e.volume_before) {
      ctx.addIssue({ code: "custom", path: ["volume"], message: "partial close volume must be below volume_before" });
    }
  });

export const IngestBody = z.object({ events: z.array(CopyEvent).min(1).max(100) });

/** Per-receiver copy settings (mirrors table copy_links). */
export const CopyLinkSettings = z.object({
  enabled: z.boolean().default(false),
  lot_mode: z.enum(LOT_MODES).default("equity_ratio"),
  lot_value: z.number().positive().default(1),
  symbol_map: z.record(z.string(), z.string()).default({}),
  allowed_symbols: z.array(z.string()).nullable().default(null),
  reverse: z.boolean().default(false),
  copy_sl_tp: z.boolean().default(true),
  copy_pending: z.boolean().default(false),
  max_lot: z.number().positive().nullable().default(null),
  max_open_positions: z.number().int().positive().nullable().default(null),
  max_daily_loss_pct: z.number().positive().max(100).nullable().default(null),
  max_slippage_points: z.number().int().nonnegative().default(50),
  max_signal_age_s: z.number().int().positive().default(10),
  catch_up: z.boolean().default(false),
});

function decimalsOf(step) {
  const s = String(step);
  if (s.includes("e-")) return Number(s.split("e-")[1]);
  return (s.split(".")[1] || "").length;
}

/**
 * Receiver lot size for a master OPEN.
 * @param {object} a
 * @param {"fixed"|"multiplier"|"equity_ratio"|"risk_percent"} a.mode
 * @param {number} a.value          fixed lot, multiplier k, or risk % (per mode)
 * @param {number} a.masterLot
 * @param {number} [a.masterEquity]
 * @param {number} [a.receiverEquity]
 * @param {number} [a.masterContractSize]   e.g. 100 for 100 oz gold
 * @param {number} [a.receiverContractSize]
 * @param {number} [a.slDistance]   |entry - sl| in price, for risk_percent
 * @param {number} [a.tickSize]     receiver symbol, for risk_percent
 * @param {number} [a.tickValue]    receiver symbol, account currency per tick per lot
 * @param {{min:number,max:number,step:number}} a.volume  receiver symbol volume limits
 * @param {number|null} [a.maxLot]
 * @param {"skip"|"min_lot"} [a.belowMin]
 * @returns {{lot:number}|{skip:string}}
 */
export function computeLot(a) {
  const { mode, value, masterLot, volume } = a;
  const contractAdj = a.masterContractSize && a.receiverContractSize ? a.masterContractSize / a.receiverContractSize : 1;
  let raw;
  if (mode === "fixed") raw = value;
  else if (mode === "multiplier") raw = masterLot * value * contractAdj;
  else if (mode === "equity_ratio") {
    if (!(a.masterEquity > 0) || !(a.receiverEquity > 0)) return { skip: "EQUITY_UNKNOWN" };
    raw = masterLot * (a.receiverEquity / a.masterEquity) * value * contractAdj;
  } else if (mode === "risk_percent") {
    if (!(a.slDistance > 0)) return { skip: "NO_STOP_LOSS" };
    if (!(a.receiverEquity > 0) || !(a.tickSize > 0) || !(a.tickValue > 0)) return { skip: "SYMBOL_INFO_MISSING" };
    const lossPerLot = (a.slDistance / a.tickSize) * a.tickValue;
    raw = (a.receiverEquity * value) / 100 / lossPerLot;
  } else return { skip: "BAD_LOT_MODE" };

  if (!Number.isFinite(raw) || raw <= 0) return { skip: "BAD_LOT" };
  const cap = Math.min(volume.max, a.maxLot ?? Infinity);
  const d = decimalsOf(volume.step);
  // round down to the volume step: never trade more than asked
  let lot = Math.floor(raw / volume.step + 1e-9) * volume.step;
  lot = Number(Math.min(lot, cap).toFixed(d));
  if (lot < volume.min) {
    if ((a.belowMin ?? "skip") === "min_lot" && volume.min <= cap) return { lot: volume.min };
    return { skip: "BELOW_MIN_LOT" };
  }
  return { lot };
}

const SUFFIXES = ["", "m", ".m", ".r", "#", ".pro", "pro", ".a", "-ecn", ".ecn", "+", ".cash", "_i"];

/**
 * Receiver symbol for a master symbol: explicit map first, then exact name, then common broker suffixes.
 * @param {string} masterSymbol
 * @param {Record<string,string>} map
 * @param {string[]} receiverSymbols  symbols available on the receiver terminal
 * @returns {string|null}
 */
export function mapSymbol(masterSymbol, map, receiverSymbols) {
  if (map && map[masterSymbol]) return map[masterSymbol];
  const set = new Set(receiverSymbols);
  const base = masterSymbol.replace(/(\.[a-z]+|[#+]|m|pro|_i|-ecn)$/i, "");
  for (const root of [masterSymbol, base]) for (const s of SUFFIXES) if (set.has(root + s)) return root + s;
  const lower = new Map(receiverSymbols.map((s) => [s.toLowerCase(), s]));
  return lower.get(masterSymbol.toLowerCase()) ?? lower.get(base.toLowerCase()) ?? null;
}

/** Volume to close on the receiver for a master partial close: same fraction, rounded to step. */
export function partialCloseVolume({ masterClosed, masterBefore, receiverVolume, step, min }) {
  const frac = masterClosed / masterBefore;
  const d = decimalsOf(step);
  let v = Number((Math.round((receiverVolume * frac) / step) * step).toFixed(d));
  if (v < min) v = 0;
  if (receiverVolume - v < min) v = receiverVolume; // remainder would be untradeable: close all
  return v;
}

/** Whether an event is too old to open a new position (closes are always applied). */
export function isStale(event, nowMs, maxAgeS) {
  if (["CLOSE", "PARTIAL_CLOSE", "KILL", "MODIFY", "PENDING_DELETE"].includes(event.type)) return false;
  return nowMs - event.ts_ms > maxAgeS * 1000;
}
