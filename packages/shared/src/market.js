// Market-data contract for the chart (docs/THIET-KE-HE-THONG.md §4.1): which symbols exist, where their
// bars come from, and the pure parsers for each provider. Network calls live in apps/web.

/**
 * Supported chart symbols. Gold, silver and oil prefer broker M1 bars pushed by the master EA (table bars_m1);
 * without them, intraday charts use Binance's TradFi perpetuals (`futures`: realtime, 24/7, they track the spot
 * price), and daily/weekly charts the public COMEX/NYMEX futures from Yahoo (about 10 minutes late, but years of history).
 */
export const SYMBOLS = {
  XAUUSD: { name: "Vàng / USD", group: "Kim loại", digits: 2, yahoo: "GC=F", proxy: "Vàng tương lai COMEX (GC=F)", futures: "XAUUSDT", broker: true },
  XAGUSD: { name: "Bạc / USD", group: "Kim loại", digits: 3, yahoo: "SI=F", proxy: "Bạc tương lai COMEX (SI=F)", futures: "XAGUSDT", broker: true },
  BTCUSD: { name: "Bitcoin / USD", group: "Crypto", digits: 2, binance: "BTCUSDT", coinbase: "BTC-USD" },
  ETHUSD: { name: "Ethereum / USD", group: "Crypto", digits: 2, binance: "ETHUSDT", coinbase: "ETH-USD" },
  WTI: { name: "Dầu WTI", group: "Năng lượng", digits: 2, yahoo: "CL=F", proxy: "Dầu WTI tương lai NYMEX (CL=F)", futures: "CLUSDT", broker: true },
  BRENT: { name: "Dầu Brent", group: "Năng lượng", digits: 2, yahoo: "BZ=F", proxy: "Dầu Brent tương lai ICE (BZ=F)", futures: "BZUSDT", broker: true },
  DXY: { name: "Chỉ số USD", group: "Vĩ mô", digits: 3, yahoo: "DX-Y.NYB", proxy: "US Dollar Index (DX-Y.NYB)" },
};

export const DEFAULT_WATCHLIST = ["XAUUSD", "BTCUSD", "WTI", "BRENT", "XAGUSD", "ETHUSD", "DXY"];

/** Timeframes offered in the UI, and how many bars each loads by default. */
export const TIMEFRAMES = [
  { tf: "1m", label: "1m", bars: 720 },
  { tf: "5m", label: "5m", bars: 600 },
  { tf: "15m", label: "15m", bars: 600 },
  { tf: "30m", label: "30m", bars: 600 },
  { tf: "1h", label: "1H", bars: 720 },
  { tf: "4h", label: "4H", bars: 500 },
  { tf: "1D", label: "1D", bars: 750 },
  { tf: "1W", label: "1W", bars: 520 },
];
export const TF_IDS = TIMEFRAMES.map((t) => t.tf);

/** Cache lifetime for a bars response, by timeframe (seconds). Short: the last candle is the live price. */
export const cacheSeconds = (tf) => ({ "1m": 5, "5m": 10, "15m": 15, "30m": 15, "1h": 20, "4h": 30 })[tf] ?? 60;

// ---------- Binance ----------
export const BINANCE_NATIVE = ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "8h", "12h", "1D", "3D", "1W", "1M"];
export const binanceInterval = (tf) => ({ "1D": "1d", "3D": "3d", "1W": "1w" })[tf] || tf;

/** Binance /api/v3/klines rows -> bars. */
export const parseBinance = (rows) =>
  rows.map((k) => ({ time: k[0] / 1000, open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }));

// Spot market data mirror (api.binance.com answers 451 from US cloud regions; this host does not).
export const BINANCE_SPOT_HOST = "https://data-api.binance.vision";
export const BINANCE_SPOT_STREAM = "wss://data-stream.binance.vision/ws/";

// ---------- Binance USDⓈ-M futures: TradFi perpetuals for gold, silver, WTI and Brent ----------
// Same kline format as spot. Realtime and open 24/7, but only since late 2025 (XAUUSDT) / 2026 (XAG, CL, BZ), so
// they serve intraday charts; daily and weekly charts keep the years of history from Yahoo.
export const BINANCE_FUTURES_HOST = "https://fapi.binance.com";
// market streams (klines) are served under /market; the bare /ws path accepts the connection but sends nothing
export const BINANCE_FUTURES_STREAM = "wss://fstream.binance.com/market/ws/";
export const FUTURES_MAX_TF_SECONDS = 14400;

// ---------- perpetual in USDT -> spot in USD, the way an MT5 broker quotes XAUUSD ----------
// A perpetual trades a little above or below its spot index (index/mark strips that premium), and in USDT, which
// is not exactly a dollar: USDC/USDT stands in for USD/USDT (USDC is held at one dollar). Gold at 3,760: about
// 2.5 of premium plus 3.5 of USDT. What is left against a broker is its own quote and spread (MT5 charts the bid).
export const USD_PROXY_TICKER = "USDCUSDT";

/** Multiplier from the perpetual's price to spot USD; null when an input is missing or out of range. */
export function spotUsdFactor(mark, index, usdcUsdt) {
  const f = Number(index) / Number(mark) / Number(usdcUsdt);
  return Number.isFinite(f) && f > 0.95 && f < 1.05 ? f : null;
}

/** Bars with open/high/low/close times the factor (volume unchanged). */
export const scaleBars = (bars, f) =>
  !f || f === 1 ? bars : bars.map((b) => ({ ...b, open: b.open * f, high: b.high * f, low: b.low * f, close: b.close * f }));

/** Current factor for a perpetual from Binance's REST API, through the caller's fetch; null when unreachable. */
export async function fetchSpotUsdFactor(fetchFn, ticker) {
  try {
    const [p, u] = await Promise.all([
      fetchFn(`${BINANCE_FUTURES_HOST}/fapi/v1/premiumIndex?symbol=${ticker}`).then((r) => (r.ok ? r.json() : null)),
      fetchFn(`${BINANCE_SPOT_HOST}/api/v3/ticker/price?symbol=${USD_PROXY_TICKER}`).then((r) => (r.ok ? r.json() : null)),
    ]);
    return spotUsdFactor(p?.markPrice, p?.indexPrice, u?.price);
  } catch {
    return null;
  }
}

/** True when the perpetual is the source for this symbol and timeframe (intraday up to 4h). */
export const usesFutures = (info, tf) => Boolean(info?.futures) && tfSeconds(tf) <= FUTURES_MAX_TF_SECONDS;

/**
 * Binance 24h ticker (spot or futures) -> watchlist quote. The change is over the last 24 hours.
 * Takes the REST answer (/ticker/24hr) or a `<symbol>@ticker` stream event (c, p, P, E).
 */
export function quoteFromTicker(j) {
  const stream = j?.e === "24hrTicker";
  const price = Number(stream ? j.c : j?.lastPrice);
  if (!(price > 0)) return null;
  return {
    price,
    change: Number(stream ? j.p : j.priceChange) || 0,
    changePct: Number(stream ? j.P : j.priceChangePercent) || 0,
    time: Math.floor(Number(stream ? j.E : j.closeTime) / 1000) || 0,
  };
}

/** Websocket URL of the 24h ticker stream for a Binance-priced symbol (spot first, else the perpetual); null = none. */
export function tickerStreamUrl(info) {
  if (info?.binance) return `${BINANCE_SPOT_STREAM}${info.binance.toLowerCase()}@ticker`;
  if (info?.futures) return `${BINANCE_FUTURES_STREAM}${info.futures.toLowerCase()}@ticker`;
  return null;
}

// ---------- Coinbase (fallback for crypto) ----------
export const COINBASE_NATIVE = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "6h": 21600, "1D": 86400 };

/** Coinbase candles [time, low, high, open, close, volume], newest first -> bars ascending. */
export const parseCoinbase = (rows) =>
  rows.map((r) => ({ time: r[0], open: r[3], high: r[2], low: r[1], close: r[4], volume: r[5] })).sort((a, b) => a.time - b.time);

// ---------- Yahoo (delayed futures for gold, silver, oil, DXY; daily history) ----------
export const YAHOO_NATIVE = { "1m": ["1m", "7d"], "5m": ["5m", "60d"], "15m": ["15m", "60d"], "1h": ["60m", "730d"], "1D": ["1d", "10y"], "1W": ["1wk", "max"] };

/** Yahoo v8 chart JSON -> bars. Daily bars are pinned to UTC midnight of the exchange date. */
export function parseYahoo(j, daily) {
  const r = j?.chart?.result?.[0];
  if (!r) throw new Error(j?.chart?.error?.description || "Yahoo returned no data");
  const q = r.indicators?.quote?.[0] || {};
  const off = r.meta?.gmtoffset || 0;
  const out = [];
  (r.timestamp || []).forEach((t, i) => {
    if (q.close?.[i] == null || q.open?.[i] == null) return;
    const time = daily ? Math.floor((t + off) / 86400) * 86400 : t;
    out.push({ time, open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume?.[i] || 0 });
  });
  return dedupeBars(out);
}

/** Sorted, one bar per time (the later row wins). */
export function dedupeBars(bars) {
  const m = new Map();
  for (const b of bars) m.set(b.time, b);
  return [...m.values()].sort((a, b) => a.time - b.time);
}

/** Rows of table bars_m1 -> bars. */
export const parseBrokerRows = (rows) =>
  rows.map((r) => ({ time: Date.parse(r.ts) / 1000, open: +r.o, high: +r.h, low: +r.l, close: +r.c, volume: +r.v }))
    .sort((a, b) => a.time - b.time);

/** Last price and change vs the previous daily close, for the watchlist. */
export function quoteFromDaily(bars) {
  if (!bars.length) return null;
  const last = bars[bars.length - 1];
  const prev = bars.length > 1 ? bars[bars.length - 2].close : last.open;
  return { price: last.close, change: last.close - prev, changePct: prev ? ((last.close - prev) / prev) * 100 : 0, time: last.time };
}

// ---------- broker symbols -> chart symbols ----------
// Brokers name the same market differently (XAUUSDm, GOLD.pro, #USOIL, XTIUSD.cash). Longest alias first,
// and only a short suffix may follow it, so "BTCUSDT" and "XTIUSD.cash" map but a longer name such as "XAUUSDJPYXX" does not.
const ALIASES = [
  ["XAUUSD", "XAUUSD"], ["GOLD", "XAUUSD"], ["XAGUSD", "XAGUSD"], ["SILVER", "XAGUSD"],
  ["XTIUSD", "WTI"], ["USOIL", "WTI"], ["WTICRUDE", "WTI"], ["CRUDEOIL", "WTI"], ["WTI", "WTI"],
  ["XBRUSD", "BRENT"], ["UKOIL", "BRENT"], ["BRENT", "BRENT"],
  ["BTCUSD", "BTCUSD"], ["XBTUSD", "BTCUSD"], ["ETHUSD", "ETHUSD"],
  ["USDX", "DXY"], ["DXY", "DXY"], ["USDINDEX", "DXY"],
].sort((a, b) => b[0].length - a[0].length);

/** Chart symbol for a broker symbol, or null when it is not one of the charted markets. */
export function chartSymbol(brokerSymbol) {
  const s = String(brokerSymbol ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  for (const [alias, id] of ALIASES) if (s.startsWith(alias) && s.length - alias.length <= 4) return id;
  return null;
}

/** Bar length in seconds for a timeframe id. */
export const tfSeconds = (tf) => ({ "1m": 60, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "4h": 14400, "1D": 86400, "1W": 604800 })[tf] ?? 3600;
