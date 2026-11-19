// POST /radar-cron — market radar, called every minute by pg_cron (through pg_net) with header x-qt-cron.
// Three scanners over the free public APIs of seven crypto exchanges (and the perpetuals of five of them):
//   1. Arbitrage: a coin's best ask on one exchange against its best bid on another, in USD, plus what the
//      gap is worth after walking both order books for $100, $1,000 and $10,000. Fees are left to the
//      reader (each user sets theirs), so rows carry the gross figure.
//   2. Pumps: Binance USDT pairs whose price and volume jump together, scored 0-100 and staged from
//      1-minute bars. Prices from earlier runs (radar_state) pick the candidates.
//   3. Listings: every 2 minutes, each exchange's pair list against the one stored last time.
//   4. Perpetuals: which coins have a USDT perpetual where (to hedge a spot gap during a transfer), and the gap
//      between one coin's perpetuals on two exchanges, with funding (both legs on margin, nothing to transfer).
// Results go to radar_snapshot / radar_listings for the /radar page; radar_notify() turns them into
// notifications for the users who switched alerts on, and returns the Telegram messages to send.
// Read-only market data: nothing here places an order. Runtime-neutral (Web APIs only), like market-cron.
import { HttpError, json, type Db } from "./ea.ts";

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
export type RadarDeps = { db: Db; fetch: Fetch; telegramToken?: string; now?: () => number };

export type Ticker = { native: string; base: string; quote: string; bid: number; ask: number; last: number; vol: number; change?: number };
export type Instrument = { native: string; base: string; quote: string; status: "trading" | "pre" | "halt"; key?: string; opensAt?: number };
type Book = { bids: [number, number][]; asks: [number, number][] };
type Snapshot = { at: number; rows: Ticker[] };
export type Rates = { USD: number; USDT: number; USDC: number; source: { USDT: string; USDC: string } };

export const SIZES = [100, 1000, 10000];
const LISTINGS_EVERY_MS = 2 * 60_000;
const TIMEOUT_MS = 8000;

// ---------- names ----------
const ALIAS: Record<string, string> = { XBT: "BTC", XDG: "DOGE" };
export const canon = (b: unknown) => { const s = String(b ?? "").toUpperCase(); return ALIAS[s] ?? s; };
const QUOTES = ["USDT", "USDC", "USD"];
const STABLE = new Set(["USDT", "USDC", "USD", "DAI", "FDUSD", "TUSD", "BUSD", "USDE", "PYUSD", "USDD", "EUR", "GBP", "EURC",
  "RLUSD", "USDS", "BFUSD", "XUSD", "USDQ", "GUSD", "USDP", "FRAX", "LUSD", "UST", "USTC", "PAXG", "XAUT"]);
const DOLLARISH = /^USD|USD[0-9A-Z]?$/; // RWUSD, USD1, ...: dollar-pegged tokens keep appearing
const LEVERAGED = /^.{2,}(UP|DOWN|BULL|BEAR|[235]L|[235]S)$/; // BTCUP, ETH3L: a multiple of the coin, not the coin
export const usable = (base: string, quote: string) =>
  QUOTES.includes(quote) && !STABLE.has(base) && !DOLLARISH.test(base) && !LEVERAGED.test(base);

const n = (x: unknown) => (x === "" || x == null ? NaN : Number(x));
const split = (s: string, sep: string) => { const [b, q] = String(s).split(sep); return { base: canon(b), quote: canon(q) }; };
/** "BTCUSDT" -> BTC/USDT for the quotes the radar compares; anything else -> null. */
const bySuffix = (s: string) => {
  for (const q of ["USDT", "USDC"]) if (s.endsWith(q) && s.length > q.length) return { base: canon(s.slice(0, -q.length)), quote: q };
  return null;
};
export const median = (xs: number[]) => {
  const a = [...xs].sort((x, y) => x - y);
  if (!a.length) return NaN;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

// ---------- parsers (exchange JSON -> the shapes above) ----------
type Raw = Record<string, unknown>;
const arr = (x: unknown) => (Array.isArray(x) ? (x as Raw[]) : []);
export const parse = {
  binanceTickers: (j: unknown): Ticker[] => arr(j).flatMap((r) => {
    const s = bySuffix(String(r.symbol));
    if (!s || !(Number(r.count) > 0)) return []; // count 0: not trading in the last 24h
    return [{ native: String(r.symbol), ...s, bid: n(r.bidPrice), ask: n(r.askPrice), last: n(r.lastPrice), vol: n(r.quoteVolume), change: n(r.priceChangePercent) }];
  }),
  binanceInstruments: (j: Raw): Instrument[] => arr(j.symbols).map((s) => ({
    native: String(s.symbol), base: canon(s.baseAsset), quote: canon(s.quoteAsset),
    status: s.status === "TRADING" ? "trading" : s.status === "PRE_TRADING" ? "pre" : "halt",
  })),
  okxTickers: (j: Raw): Ticker[] => arr(j.data).map((r) => ({
    native: String(r.instId), ...split(String(r.instId), "-"), bid: n(r.bidPx), ask: n(r.askPx), last: n(r.last), vol: n(r.volCcy24h),
  })),
  okxInstruments: (j: Raw): Instrument[] => arr(j.data).map((s) => ({
    native: String(s.instId), base: canon(s.baseCcy), quote: canon(s.quoteCcy),
    status: s.state === "live" ? "trading" : s.state === "preopen" ? "pre" : "halt",
    ...(Number(s.listTime) > 0 ? { opensAt: Number(s.listTime) } : {}),
  })),
  bybitTickers: (j: Raw): Ticker[] => arr((j.result as Raw)?.list).flatMap((r) => {
    const s = bySuffix(String(r.symbol));
    return s ? [{ native: String(r.symbol), ...s, bid: n(r.bid1Price), ask: n(r.ask1Price), last: n(r.lastPrice), vol: n(r.turnover24h) }] : [];
  }),
  bybitInstruments: (j: Raw): Instrument[] => arr((j.result as Raw)?.list).map((s) => ({
    native: String(s.symbol), base: canon(s.baseCoin), quote: canon(s.quoteCoin),
    status: s.status === "Trading" ? "trading" : s.status === "PreLaunch" ? "pre" : "halt",
  })),
  // Kraken keys tickers by its own names (XXBTZUSD); the altname (XBTUSD) is what its order book takes.
  krakenInstruments: (j: Raw): Instrument[] => Object.entries((j.result ?? {}) as Record<string, Raw>)
    .filter(([, p]) => p.wsname && p.status !== "delisted")
    .map(([key, p]) => ({ native: String(p.altname), key, ...split(String(p.wsname), "/"),
      status: !p.status || p.status === "online" ? "trading" : "halt" } as Instrument)),
  krakenTickers: (j: Raw, pairs: Instrument[]): Ticker[] => {
    const byKey = new Map(pairs.map((p) => [p.key, p]));
    return Object.entries((j.result ?? {}) as Record<string, Raw>).flatMap(([key, r]) => {
      const s = byKey.get(key);
      if (!s) return [];
      const v = (k: string, i: number) => n((r[k] as unknown[])?.[i]);
      return [{ native: s.native, base: s.base, quote: s.quote, bid: v("b", 0), ask: v("a", 0), last: v("c", 0), vol: v("v", 1) * v("p", 1) }];
    });
  },
  kucoinTickers: (j: Raw): Ticker[] => arr((j.data as Raw)?.ticker).map((r) => ({
    native: String(r.symbol), ...split(String(r.symbol), "-"), bid: n(r.buy), ask: n(r.sell), last: n(r.last), vol: n(r.volValue),
  })),
  kucoinInstruments: (j: Raw): Instrument[] => arr(j.data).map((s) => ({
    native: String(s.symbol), base: canon(s.baseCurrency), quote: canon(s.quoteCurrency), status: s.enableTrading ? "trading" : "halt",
  })),
  gateTickers: (j: unknown): Ticker[] => arr(j).map((r) => ({
    native: String(r.currency_pair), ...split(String(r.currency_pair), "_"),
    bid: n(r.highest_bid), ask: n(r.lowest_ask), last: n(r.last), vol: n(r.quote_volume),
  })),
  gateInstruments: (j: unknown, now = Date.now()): Instrument[] => arr(j).map((s) => {
    const opens = Number(s.buy_start) * 1000;
    return { native: String(s.id), base: canon(s.base), quote: canon(s.quote),
      status: s.trade_status === "tradable" ? "trading" : opens > now ? "pre" : "halt", ...(opens > now ? { opensAt: opens } : {}) };
  }),
  coinbaseInstruments: (j: unknown): Instrument[] => arr(j).map((s) => ({
    native: String(s.id), base: canon(s.base_currency), quote: canon(s.quote_currency),
    status: s.status === "online" && !s.trading_disabled ? (s.auction_mode ? "pre" : "trading") : "halt",
  })),
  levels: (rows: unknown): [number, number][] =>
    (Array.isArray(rows) ? (rows as unknown[][]) : []).map((r) => [n(r?.[0]), n(r?.[1])] as [number, number]).filter(([p, q]) => p > 0 && q > 0),
};

// ---------- exchanges ----------
class Upstream extends Error {
  status: number;
  constructor(message: string, status = 0) { super(message); this.status = status; }
}
async function getJson(f: Fetch, url: string): Promise<Raw> {
  const host = new URL(url).host;
  let r: Response;
  try {
    r = await f(url, { headers: { "user-agent": "Mozilla/5.0", accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    throw new Upstream(`${host} không truy cập được (${(e as Error).name === "TimeoutError" ? "quá thời gian" : (e as Error).message})`);
  }
  if (!r.ok) throw new Upstream(`${host} trả về HTTP ${r.status}`, r.status);
  return (await r.json()) as Raw;
}
// api.binance.com answers 451 from US regions; the market-data mirror does not. (Not binance.us: a separate exchange.)
const BINANCE = ["https://data-api.binance.vision", "https://api.binance.com"];
async function binance(f: Fetch, path: string) {
  let last: unknown;
  for (const h of BINANCE) {
    try { return await getJson(f, h + path); } catch (e) { last = e; if ((e as Upstream).status === 400) throw e; }
  }
  throw last;
}

type Exchange = {
  tickers(f: Fetch, ctx: Ctx): Promise<Ticker[]>;
  instruments(f: Fetch): Promise<Instrument[]>;
  book(f: Fetch, native: string): Promise<Book>;
};
type Ctx = { kraken?: Instrument[]; coinbase?: Instrument[]; coinbaseWanted?: string[] };
const book = (bids: unknown, asks: unknown): Book => ({ bids: parse.levels(bids), asks: parse.levels(asks) });
const q = encodeURIComponent;

export const EX: Record<string, Exchange> = {
  BINANCE: {
    tickers: async (f) => parse.binanceTickers(await binance(f, "/api/v3/ticker/24hr")),
    instruments: async (f) => parse.binanceInstruments(await binance(f, "/api/v3/exchangeInfo")),
    book: async (f, s) => { const j = await binance(f, `/api/v3/depth?symbol=${q(s)}&limit=100`); return book(j.bids, j.asks); },
  },
  OKX: {
    tickers: async (f) => parse.okxTickers(await getJson(f, "https://www.okx.com/api/v5/market/tickers?instType=SPOT")),
    instruments: async (f) => parse.okxInstruments(await getJson(f, "https://www.okx.com/api/v5/public/instruments?instType=SPOT")),
    book: async (f, s) => { const d = arr((await getJson(f, `https://www.okx.com/api/v5/market/books?instId=${q(s)}&sz=100`)).data)[0] ?? {}; return book(d.bids, d.asks); },
  },
  BYBIT: {
    tickers: async (f) => parse.bybitTickers(await getJson(f, "https://api.bybit.com/v5/market/tickers?category=spot")),
    instruments: async (f) => parse.bybitInstruments(await getJson(f, "https://api.bybit.com/v5/market/instruments-info?category=spot")),
    book: async (f, s) => { const r = ((await getJson(f, `https://api.bybit.com/v5/market/orderbook?category=spot&symbol=${q(s)}&limit=200`)).result ?? {}) as Raw; return book(r.b, r.a); },
  },
  KRAKEN: {
    tickers: async (f, ctx) => {
      ctx.kraken ??= await EX.KRAKEN.instruments(f);
      return parse.krakenTickers(await getJson(f, "https://api.kraken.com/0/public/Ticker"), ctx.kraken);
    },
    instruments: async (f) => parse.krakenInstruments(await getJson(f, "https://api.kraken.com/0/public/AssetPairs")),
    book: async (f, s) => { const r = (Object.values((await getJson(f, `https://api.kraken.com/0/public/Depth?pair=${q(s)}&count=100`)).result ?? {})[0] ?? {}) as Raw; return book(r.bids, r.asks); },
  },
  KUCOIN: {
    tickers: async (f) => parse.kucoinTickers(await getJson(f, "https://api.kucoin.com/api/v1/market/allTickers")),
    instruments: async (f) => parse.kucoinInstruments(await getJson(f, "https://api.kucoin.com/api/v2/symbols")),
    book: async (f, s) => { const d = ((await getJson(f, `https://api.kucoin.com/api/v1/market/orderbook/level2_100?symbol=${q(s)}`)).data ?? {}) as Raw; return book(d.bids, d.asks); },
  },
  GATE: {
    tickers: async (f) => parse.gateTickers(await getJson(f, "https://api.gateio.ws/api/v4/spot/tickers")),
    instruments: async (f) => parse.gateInstruments(await getJson(f, "https://api.gateio.ws/api/v4/spot/currency_pairs")),
    book: async (f, s) => { const d = await getJson(f, `https://api.gateio.ws/api/v4/spot/order_book?currency_pair=${q(s)}&limit=100`); return book(d.bids, d.asks); },
  },
  // No all-pairs ticker: asked about the most traded coins on the other exchanges (and USDT/USDC, for their USD price).
  COINBASE: {
    tickers: async (f, ctx) => {
      ctx.coinbase ??= await EX.COINBASE.instruments(f);
      const names = new Map(ctx.coinbase.map((s) => [s.native, s]));
      const ids = (ctx.coinbaseWanted ?? []).filter((id) => names.get(id)?.status === "trading");
      const rows = await mapLimit(ids, 4, async (id) => {
        try {
          const r = await getJson(f, `https://api.exchange.coinbase.com/products/${q(id)}/ticker`);
          const s = names.get(id)!;
          return [{ native: id, base: s.base, quote: s.quote, bid: n(r.bid), ask: n(r.ask), last: n(r.price), vol: n(r.volume) * n(r.price) }];
        } catch { return []; }
      });
      return rows.flat();
    },
    instruments: async (f) => parse.coinbaseInstruments(await getJson(f, "https://api.exchange.coinbase.com/products")),
    book: async (f, s) => { const j = await getJson(f, `https://api.exchange.coinbase.com/products/${q(s)}/book?level=2`); return book(arr(j.bids).slice(0, 200), arr(j.asks).slice(0, 200)); },
  },
};
export const EXCHANGES = Object.keys(EX);

export async function mapLimit<T, R>(items: T[], k: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(k, items.length) }, async () => {
    while (i < items.length) { const j = i++; out[j] = await fn(items[j], j); }
  }));
  return out;
}

// ---------- perpetual futures ----------
// USDT-margined perpetuals on the exchanges with free bulk APIs. Two uses:
//   - which exchanges list a perpetual for a coin: a spot gap can then be hedged (buy spot, short the perpetual)
//     while the coins move between exchanges, so the price can't run away during the transfer;
//   - perpetual against perpetual on two exchanges: both legs on margin, nothing to transfer. Funding is paid every
//     few hours by the long side to the short side (or back when negative), so it is shown per 8 hours.
export type Perp = {
  ex: string; native: string; base: string; bid: number; ask: number; volUsd: number;
  /** % per funding period, null when the exchange did not say */ funding: number | null;
  intervalH: number; nextFunding: number | null;
};
export const PERP_EXCHANGES = ["BINANCE", "BYBIT", "OKX", "GATE", "KUCOIN"];

/** "1000PEPE" on one exchange is PEPE in lots of 1000 on another: the coin and the factor its price is divided by. */
export function perpBase(raw: string) {
  const b = canon(raw);
  const m = /^(1000000|100000|10000|1000|1M)([A-Z].*)$/.exec(b);
  if (!m) return { base: b, mult: 1 };
  return { base: canon(m[2]), mult: m[1] === "1M" ? 1e6 : Number(m[1]) };
}
const perp = (ex: string, native: string, rawBase: string, bid: number, ask: number, volUsd: number, funding: number | null, intervalH: number, nextFunding: number | null): Perp[] => {
  const { base, mult } = perpBase(rawBase);
  if (!usable(base, "USDT") || !(bid > 0 && ask >= bid)) return [];
  return [{ ex, native, base, bid: bid / mult, ask: ask / mult, volUsd, funding, intervalH: intervalH > 0 ? intervalH : 8, nextFunding: nextFunding && nextFunding > 0 ? nextFunding : null }];
};
const pct = (x: unknown) => (x === "" || x == null || !Number.isFinite(Number(x)) ? null : Number(x) * 100);

export const parsePerp = {
  /** bookTicker + premiumIndex + 24hr ticker + fundingInfo (only the symbols whose interval is not 8 h) */
  binance: (books: unknown, premium: unknown, day: unknown, info: unknown): Perp[] => {
    const prem = new Map(arr(premium).map((r) => [String(r.symbol), r]));
    const vol = new Map(arr(day).map((r) => [String(r.symbol), n(r.quoteVolume)]));
    const hours = new Map(arr(info).map((r) => [String(r.symbol), n(r.fundingIntervalHours)]));
    return arr(books).flatMap((r) => {
      const sym = String(r.symbol);
      if (!sym.endsWith("USDT")) return []; // dated contracts end in _YYMMDD
      const p = prem.get(sym);
      return perp("BINANCE", sym, sym.slice(0, -4), n(r.bidPrice), n(r.askPrice), vol.get(sym) ?? 0, pct(p?.lastFundingRate), hours.get(sym) ?? 8, n(p?.nextFundingTime));
    });
  },
  bybit: (j: Raw): Perp[] => arr((j.result as Raw)?.list).flatMap((r) => {
    const sym = String(r.symbol);
    if (!sym.endsWith("USDT")) return [];
    return perp("BYBIT", sym, sym.slice(0, -4), n(r.bid1Price), n(r.ask1Price), n(r.turnover24h), pct(r.fundingRate), n(r.fundingIntervalHour), n(r.nextFundingTime));
  }),
  /** SWAP tickers (volume in coins) + funding-rate?instId=ANY (period = next - this funding time) */
  okx: (tickers: Raw, funding: Raw): Perp[] => {
    const fr = new Map(arr(funding.data).map((r) => [String(r.instId), r]));
    return arr(tickers.data).flatMap((r) => {
      const id = String(r.instId);
      const m = /^(.+)-USDT-SWAP$/.exec(id);
      if (!m) return [];
      const f = fr.get(id);
      const hours = f ? (n(f.nextFundingTime) - n(f.fundingTime)) / 3_600_000 : 8;
      return perp("OKX", id, m[1], n(r.bidPx), n(r.askPx), n(r.volCcy24h) * n(r.last), pct(f?.fundingRate), Number.isFinite(hours) ? hours : 8, n(f?.fundingTime));
    });
  },
  gate: (j: unknown): Perp[] => arr(j).flatMap((r) => {
    const m = /^(.+)_USDT$/.exec(String(r.contract));
    if (!m) return [];
    return perp("GATE", String(r.contract), m[1], n(r.highest_bid), n(r.lowest_ask), n(r.volume_24h_quote), pct(r.funding_rate), 8, null);
  }),
  /** active contracts (funding, period, turnover) + all tickers (best bid / ask) */
  kucoin: (contracts: Raw, tickers: Raw): Perp[] => {
    const tk = new Map(arr(tickers.data).map((r) => [String(r.symbol), r]));
    return arr(contracts.data).flatMap((c) => {
      const sym = String(c.symbol);
      if (c.quoteCurrency !== "USDT" || !sym.endsWith("USDTM")) return [];
      const t = tk.get(sym);
      return perp("KUCOIN", sym, String(c.baseCurrency), n(t?.bestBidPrice), n(t?.bestAskPrice), n(c.turnoverOf24h),
        pct(c.fundingFeeRate), n(c.fundingRateGranularity) / 3_600_000, n(c.nextFundingRateDateTime));
    });
  },
};

const PERP_FETCH: Record<string, (f: Fetch) => Promise<Perp[]>> = {
  BINANCE: async (f) => {
    const h = "https://fapi.binance.com/fapi/v1";
    const [books, premium, day, info] = await Promise.all([
      getJson(f, `${h}/ticker/bookTicker`), getJson(f, `${h}/premiumIndex`), getJson(f, `${h}/ticker/24hr`),
      getJson(f, `${h}/fundingInfo`).catch(() => []),
    ]);
    return parsePerp.binance(books, premium, day, info);
  },
  BYBIT: async (f) => parsePerp.bybit(await getJson(f, "https://api.bybit.com/v5/market/tickers?category=linear")),
  OKX: async (f) => {
    const [t, fr] = await Promise.all([
      getJson(f, "https://www.okx.com/api/v5/market/tickers?instType=SWAP"),
      getJson(f, "https://www.okx.com/api/v5/public/funding-rate?instId=ANY").catch(() => ({} as Raw)),
    ]);
    return parsePerp.okx(t, fr);
  },
  GATE: async (f) => parsePerp.gate(await getJson(f, "https://api.gateio.ws/api/v4/futures/usdt/tickers")),
  KUCOIN: async (f) => {
    const [c, t] = await Promise.all([
      getJson(f, "https://api-futures.kucoin.com/api/v1/contracts/active"),
      getJson(f, "https://api-futures.kucoin.com/api/v1/allTickers"),
    ]);
    return parsePerp.kucoin(c, t);
  },
};

export type PerpLeg = { ex: string; native: string; price: number; volUsd: number; funding: number | null; funding8h: number | null; intervalH: number; nextFunding: number | null };
export type PerpRow = {
  base: string; long: PerpLeg; short: PerpLeg; gross: number; volUsd: number; exchanges: number;
  /** funding the trade earns per 8 h, in %: received on the short leg minus paid on the long leg (null if unknown) */
  funding8h: number | null; suspect: boolean;
};

/**
 * Perpetual against perpetual: per coin, go long where the ask is lowest and short where the bid is highest
 * (gross %, before fees). Prices more than 15% off the coin's median, or a gap over 10%, are flagged "suspect"
 * (a different token under the same ticker, a contract being delisted) and kept apart, as for spot.
 */
export function perpArbitrage(perps: Perp[], { minVol = 100_000 } = {}): PerpRow[] {
  const byBase = new Map<string, Perp[]>();
  for (const p of perps) if (p.volUsd >= minVol) byBase.set(p.base, [...(byBase.get(p.base) ?? []), p]);
  const leg = (p: Perp, side: "bid" | "ask"): PerpLeg => ({
    ex: p.ex, native: p.native, price: p[side], volUsd: p.volUsd, funding: p.funding,
    funding8h: p.funding == null ? null : (p.funding * 8) / p.intervalH, intervalH: p.intervalH, nextFunding: p.nextFunding,
  });
  const best = (pool: Perp[]) => {
    let top: { l: Perp; s: Perp; gross: number } | null = null;
    for (const l of pool) for (const s of pool) {
      if (l.ex === s.ex) continue;
      const gross = (s.bid / l.ask - 1) * 100;
      if (!top || gross > top.gross) top = { l, s, gross };
    }
    return top;
  };
  const out: PerpRow[] = [];
  for (const [base, rows] of byBase) {
    if (new Set(rows.map((r) => r.ex)).size < 2) continue;
    const mid = median(rows.map((r) => (r.bid + r.ask) / 2));
    const odd = new Set(rows.filter((r) => Math.abs((r.bid + r.ask) / 2 / mid - 1) > 0.15));
    let pool = rows.filter((r) => !odd.has(r));
    let t = best(pool);
    if (t && t.gross > 10) { odd.add(t.l); odd.add(t.s); pool = pool.filter((r) => !odd.has(r)); t = best(pool); }
    const push = (x: NonNullable<typeof t>, suspect: boolean) => {
      const l = leg(x.l, "ask"), s = leg(x.s, "bid");
      out.push({
        base, long: l, short: s, gross: x.gross, volUsd: Math.min(x.l.volUsd, x.s.volUsd), exchanges: rows.length, suspect,
        funding8h: l.funding8h == null || s.funding8h == null ? null : s.funding8h - l.funding8h,
      });
    };
    if (t) push(t, false);
    const all = odd.size ? best(rows) : null;
    if (all && (odd.has(all.l) || odd.has(all.s))) push(all, true);
  }
  return out.sort((a, b) => b.gross - a.gross);
}

/**
 * Gate's tickers carry the funding rate but not its period (1, 4 or 8 h), and its full contract list is over a
 * megabyte: the period is read per contract, only for the Gate legs of the top rows, and funding8h redone.
 */
async function gateIntervals(f: Fetch, rows: PerpRow[]) {
  const legs = rows.flatMap((r) => [r.long, r.short]).filter((l) => l.ex === "GATE");
  const names = [...new Set(legs.map((l) => l.native))];
  const hours = new Map<string, { h: number; next: number | null }>();
  await mapLimit(names, 6, async (name) => {
    try {
      const c = await getJson(f, `https://api.gateio.ws/api/v4/futures/usdt/contracts/${q(name)}`);
      const h = n(c.funding_interval) / 3600;
      if (h > 0) hours.set(name, { h, next: n(c.funding_next_apply) > 0 ? n(c.funding_next_apply) * 1000 : null });
    } catch { /* keep 8 h */ }
  });
  for (const l of legs) {
    const g = hours.get(l.native);
    if (!g) continue;
    l.intervalH = g.h; l.nextFunding = g.next;
    l.funding8h = l.funding == null ? null : (l.funding * 8) / g.h;
  }
  for (const r of rows) r.funding8h = r.long.funding8h == null || r.short.funding8h == null ? null : r.short.funding8h - r.long.funding8h;
}

/** All perpetuals, which exchanges list each coin, and the perpetual gaps. An exchange that fails is noted, not fatal. */
export async function scanPerps(f: Fetch, minVol = 100_000) {
  const status: Record<string, { ok: boolean; contracts?: number; error?: string }> = {};
  const all: Perp[] = [];
  await Promise.all(PERP_EXCHANGES.map(async (ex) => {
    try {
      const rows = await PERP_FETCH[ex](f);
      all.push(...rows);
      status[ex] = { ok: true, contracts: rows.length };
    } catch (e) {
      status[ex] = { ok: false, error: (e as Error).message };
    }
  }));
  const coins: Record<string, string[]> = {};
  for (const p of all) if (!(coins[p.base] ??= []).includes(p.ex)) coins[p.base].push(p.ex);
  for (const k of Object.keys(coins)) coins[k].sort();
  const rows = perpArbitrage(all, { minVol }).slice(0, 300);
  await gateIntervals(f, rows.slice(0, 60));
  return { arbitrage: rows, coins, status };
}

// ---------- arbitrage ----------
// USDT and USDC aren't exactly a dollar: their USD price comes from the exchanges that quote them in USD.
// Without it a coin in USDT on one side and USD on the other is off by that gap, which looks like a trade and isn't.
export function usdRates(snaps: Record<string, Snapshot>): Rates {
  const pick = (base: string) => {
    const mids: number[] = [];
    for (const s of Object.values(snaps)) for (const r of s.rows)
      if (r.base === base && r.quote === "USD" && r.bid > 0 && r.ask >= r.bid) mids.push((r.bid + r.ask) / 2);
    return mids.length ? { rate: median(mids), from: "market" } : { rate: 1, from: "assumed" };
  };
  const t = pick("USDT"), c = pick("USDC");
  return { USD: 1, USDT: t.rate, USDC: c.rate, source: { USDT: t.from, USDC: c.from } };
}

type Leg = { ex: string; native: string; quote: string; price: number; volUsd: number };
export type ArbRow = {
  base: string; buy: Leg; sell: Leg; gross: number; volUsd: number; exchanges: number; age: number;
  suspect: boolean; suspects: string[]; depth?: Record<string, { gross: number; full: boolean; filledUsd: number }>; depthError?: string;
  /** exchanges listing a USDT perpetual of the coin, to hedge while the coins move between exchanges */
  futures?: string[];
};
type Quote = { ex: string; native: string; quote: string; bid: number; ask: number; volUsd: number; age: number; suspect?: boolean };

/**
 * One row per coin: buy at the lowest ask, sell at the highest bid, on two different exchanges (gross %, before
 * fees). A price far from the coin's median across exchanges is "suspect" (often another token with the same
 * ticker, or a market whose deposits are closed); so is any gap over 10%. A coin with a suspect best gets a second,
 * flagged row, so the page can show or hide them.
 */
export function arbitrage(snaps: Record<string, Snapshot>, { now = Date.now(), minVol = 100_000, rates = usdRates(snaps), staleMs = 3 * 60_000 } = {}) {
  const coins = new Map<string, Quote[]>();
  for (const [ex, s] of Object.entries(snaps)) {
    if (now - s.at > staleMs) continue;
    for (const r of s.rows) {
      if (!usable(r.base, r.quote) || !(r.bid > 0 && r.ask >= r.bid)) continue;
      const rate = rates[r.quote as "USD" | "USDT" | "USDC"];
      const volUsd = r.vol * rate;
      if (!(volUsd >= minVol)) continue;
      const list = coins.get(r.base) ?? [];
      list.push({ ex, native: r.native, quote: r.quote, bid: r.bid * rate, ask: r.ask * rate, volUsd, age: now - s.at });
      coins.set(r.base, list);
    }
  }
  const best = (pool: Quote[]) => {
    let top: { buy: Quote; sell: Quote; gross: number } | null = null;
    for (const b of pool) for (const s of pool) {
      if (b.ex === s.ex) continue;
      const gross = (s.bid / b.ask - 1) * 100;
      if (!top || gross > top.gross) top = { buy: b, sell: s, gross };
    }
    return top;
  };
  const leg = (r: Quote, side: "bid" | "ask"): Leg => ({ ex: r.ex, native: r.native, quote: r.quote, price: r[side], volUsd: r.volUsd });
  const out: ArbRow[] = [];
  for (const [base, rows] of coins) {
    if (new Set(rows.map((r) => r.ex)).size < 2) continue;
    const mid = median(rows.map((r) => (r.bid + r.ask) / 2));
    for (const r of rows) r.suspect = Math.abs((r.bid + r.ask) / 2 / mid - 1) > 0.15;
    let clean = rows.filter((r) => !r.suspect);
    let t = best(clean);
    // With two or three exchanges a median can't single out the odd one, so a gap this wide counts on its own.
    if (t && t.gross > 10) { t.buy.suspect = t.sell.suspect = true; clean = clean.filter((r) => !r.suspect); t = best(clean); }
    const suspects = rows.filter((r) => r.suspect).map((r) => r.ex);
    const push = (x: NonNullable<typeof t>, suspect: boolean) => out.push({
      base, buy: leg(x.buy, "ask"), sell: leg(x.sell, "bid"), gross: x.gross, volUsd: Math.min(x.buy.volUsd, x.sell.volUsd),
      exchanges: rows.length, age: Math.max(x.buy.age, x.sell.age), suspect, suspects,
    });
    if (t && t.gross > 0) push(t, false);
    const all = suspects.length ? best(rows) : null;
    if (all && all.gross > 0 && (all.buy.suspect || all.sell.suspect)) push(all, true);
  }
  return out.sort((a, b) => b.gross - a.gross);
}

/** Walk one side of a book: spend `amount` of quote currency on the asks (by "quote"), or sell `amount` coins into the bids. */
export function fill(levels: [number, number][], amount: number, by: "quote" | "base") {
  let left = amount, qty = 0, cost = 0;
  for (const [p, size] of levels) {
    const take = by === "quote" ? Math.min(size, left / p) : Math.min(size, left);
    qty += take; cost += take * p;
    left -= by === "quote" ? take * p : take;
    if (left <= amount * 1e-9) return { qty, cost, avg: cost / qty, full: true };
  }
  return { qty, cost, avg: qty ? cost / qty : NaN, full: false };
}

/** Slippage for the best rows: the gross gap once both books are walked for each size in USD. */
export async function withDepth(f: Fetch, rows: ArbRow[], rates: Rates, top = 20) {
  const books = new Map<string, Promise<Book>>();
  const get = (ex: string, native: string) => {
    const k = `${ex}:${native}`;
    if (!books.has(k)) books.set(k, EX[ex].book(f, native));
    return books.get(k)!;
  };
  const r = rates as unknown as Record<string, number>;
  await mapLimit(rows.slice(0, top), 6, async (row) => {
    try {
      const [b, s] = await Promise.all([get(row.buy.ex, row.buy.native), get(row.sell.ex, row.sell.native)]);
      row.depth = {};
      for (const size of SIZES) {
        const bought = fill(b.asks, size / r[row.buy.quote], "quote");
        const sold = fill(s.bids, bought.qty, "base");
        row.depth[size] = {
          gross: ((sold.avg * r[row.sell.quote]) / (bought.avg * r[row.buy.quote]) - 1) * 100,
          full: bought.full && sold.full,
          filledUsd: bought.cost * r[row.buy.quote],
        };
      }
    } catch (e) {
      row.depthError = (e as Error).message;
    }
  });
  return rows;
}

// ---------- pumps ----------
/** Binance 1m kline rows: [openTime, o, h, l, c, baseVol, closeTime, quoteVol, trades, takerBuyBase, takerBuyQuote, _]. */
export function pumpMetrics(k: unknown[][]) {
  if (!Array.isArray(k) || k.length < 40) return null;
  const col = (i: number) => k.map((r) => Number(r[i]));
  const o = col(1), h = col(2), c = col(4), qv = col(7), tr = col(8), tb = col(10);
  const L = k.length - 1, last = c[L];
  const chg = (m: number) => (L - m >= 0 ? (last / c[L - m] - 1) * 100 : NaN);
  const sum = (a: number[], m: number) => a.slice(-m).reduce((x, y) => x + y, 0);
  const cut = k.length > 30 ? k.length - 15 : k.length - 5;
  const qvBase = median(qv.slice(0, cut)) || 1e-9, trBase = median(tr.slice(0, cut)) || 1e-9;
  const vol5 = sum(qv, 5);
  const volRatio = vol5 / (qvBase * 5), tradesRatio = sum(tr, 5) / (trBase * 5), takerBuy = vol5 ? sum(tb, 5) / vol5 : 0.5;
  const peak = Math.max(...h.slice(-30));
  const fromPeak = (last / peak - 1) * 100;
  const wick = (i: number) => (h[i] - Math.max(o[i], c[i])) / Math.max(h[i] - Math.min(o[i], c[i]), 1e-12);
  const upperWick = Math.max(wick(L), wick(L - 1), wick(L - 2));
  const chg5m = chg(5), chg15m = chg(15), chg60m = chg(60);
  const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, Number.isFinite(x) ? x : 0));
  const run = Math.max(chg15m, Number.isFinite(chg60m) ? chg60m : -Infinity, (peak / Math.min(...c.slice(-60)) - 1) * 100);
  const score = Math.round(
    clamp(Math.log2(volRatio) * 12, 0, 40) + clamp(Math.max(chg5m, chg15m * 0.6) * 3, 0, 30) +
    clamp((takerBuy - 0.5) * 80, 0, 15) + clamp(Math.log2(tradesRatio) * 5, 0, 15));
  let stage: "pumping" | "topping" | "dumping" | "volume" | null = null;
  if (run >= 3) {
    if (fromPeak <= -8 && chg5m < 0) stage = "dumping";
    else if (fromPeak <= -3 || (upperWick > 0.6 && takerBuy < 0.5)) stage = "topping";
    else if (chg15m >= 2 || (chg5m >= 1 && volRatio >= 2)) stage = "pumping";
  } else if (volRatio >= 3) stage = "volume"; // volume without a price move yet
  return { price: last, chg5m, chg15m, chg60m, volRatio, tradesRatio, takerBuy, fromPeak, upperWick, vol5mUsd: vol5, score, stage };
}
export type Pump = NonNullable<ReturnType<typeof pumpMetrics>> & { base: string; native: string; vol24hUsd: number; funding: number | null; thin: boolean };

type History = Record<string, [number, number][]>; // Binance symbol -> [time, price] from earlier runs, last 20 minutes

/** Two stages, so the scan stays cheap: prices from earlier runs find what moved; 1-minute bars then measure it. */
export async function scanPumps(f: Fetch, rows: Ticker[], history: History, prev: string[], { now, minVol, usdt }: { now: number; minVol: number; usdt: number }) {
  const next: History = {};
  const liquid = rows.filter((r) => r.quote === "USDT" && usable(r.base, r.quote) && r.vol * usdt >= minVol);
  for (const r of liquid) next[r.native] = [...(history[r.native] ?? []).filter(([t]) => now - t <= 20 * 60_000), [now, r.last]];
  const moved = liquid
    .map((r) => { const lo = Math.min(...next[r.native].map(([, p]) => p)); return { r, move: (r.last / lo - 1) * 100 }; })
    .filter((x) => x.move >= 1.5).sort((a, b) => b.move - a.move).slice(0, 25).map((x) => x.r);
  // Just deployed: no history yet, so start from the biggest 24h movers.
  const warm = Object.values(history).some((a) => a.length > 3);
  const extra = warm ? [] : [...liquid].sort((a, b) => (b.change ?? 0) - (a.change ?? 0)).slice(0, 15);
  const keep = liquid.filter((r) => prev.includes(r.native));
  const pick = [...new Map([...moved, ...extra, ...keep].map((r) => [r.native, r])).values()].slice(0, 35);
  let funding = new Map<string, number>();
  try {
    const j = arr(await getJson(f, "https://fapi.binance.com/fapi/v1/premiumIndex"));
    funding = new Map(j.map((x) => [String(x.symbol), Number(x.lastFundingRate) * 100]));
  } catch { /* futures API blocked from this region: no funding column */ }
  const found = await mapLimit(pick, 6, async (r): Promise<Pump | null> => {
    try {
      const k = (await binance(f, `/api/v3/klines?symbol=${r.native}&interval=1m&limit=180`)) as unknown as unknown[][];
      const m = pumpMetrics(k);
      if (!m || (m.score < 25 && !m.stage)) return null;
      if (Math.abs(m.price - 1) < 0.02 && Math.abs(m.chg60m) < 0.5) return null; // pegged to $1: flows, not pumps
      const vol24hUsd = r.vol * usdt;
      return { base: r.base, native: r.native, vol24hUsd, funding: funding.get(r.native) ?? null, thin: vol24hUsd < minVol * 5, ...m };
    } catch { return null; }
  });
  return { pumps: found.filter((x): x is Pump => x !== null).sort((a, b) => b.score - a.score), history: next };
}

// ---------- listings ----------
/** What changed since the stored list. The first list only seeds; a list under half the stored size is an API hiccup. */
export function diffListings(known: Record<string, string> | undefined, rows: Instrument[]) {
  if (!known) return { seeded: true, skipped: false, events: [] as (Instrument & { kind: string })[], known: Object.fromEntries(rows.map((r) => [r.native, r.status])) };
  if (rows.length < Object.keys(known).length * 0.5) return { seeded: false, skipped: true, events: [], known };
  const events: (Instrument & { kind: string })[] = [];
  const next = { ...known };
  for (const r of rows) {
    const was = known[r.native];
    if (was === undefined) events.push({ kind: "new", ...r });
    else if (was === "pre" && r.status === "trading") events.push({ kind: "opened", ...r });
    next[r.native] = r.status;
  }
  return { seeded: false, skipped: false, events, known: next };
}

// ---------- the run ----------
type State = { history?: History; known?: Record<string, Record<string, string>>; listingsAt?: number; pumpSymbols?: string[] };

async function rpc(db: Db, fn: string, args: Record<string, unknown> = {}) {
  const { data, error } = await db.rpc(fn, args);
  if (error) throw new HttpError(500, "DB_ERROR", `${fn}: ${error.message}`);
  return data;
}

/** One scan: tickers from every exchange, arbitrage with depth, pumps, and (when due) listings. */
export async function scan(f: Fetch, state: State, now = Date.now(), minVol = 100_000) {
  const ctx: Ctx = {};
  const snaps: Record<string, Snapshot> = {};
  const status: Record<string, { ok: boolean; pairs?: number; error?: string }> = {};
  const fetchEx = async (ex: string) => {
    try {
      const rows = (await EX[ex].tickers(f, ctx)).filter((r) => r.bid > 0 || r.last > 0);
      snaps[ex] = { at: Date.now(), rows };
      status[ex] = { ok: true, pairs: rows.length };
    } catch (e) {
      status[ex] = { ok: false, error: (e as Error).message };
    }
  };
  const perpsP = scanPerps(f, minVol);
  await Promise.all(EXCHANGES.filter((x) => x !== "COINBASE").map(fetchEx));
  let rates = usdRates(snaps);
  const vol = new Map<string, number>();
  for (const s of Object.values(snaps)) for (const r of s.rows)
    if (usable(r.base, r.quote)) vol.set(r.base, (vol.get(r.base) ?? 0) + r.vol * rates[r.quote as "USDT"]);
  try {
    ctx.coinbase = await EX.COINBASE.instruments(f);
    const usd = new Map<string, string>();
    for (const s of ctx.coinbase) if (s.status === "trading" && (s.quote === "USD" || (s.quote === "USDC" && !usd.has(s.base)))) usd.set(s.base, s.native);
    ctx.coinbaseWanted = [...[...vol.entries()].filter(([b]) => usd.has(b)).sort((a, b) => b[1] - a[1]).slice(0, 30).map(([b]) => usd.get(b)!), "USDT-USD", "USDC-USD"];
  } catch { /* fetchEx records the error */ }
  await fetchEx("COINBASE");
  rates = usdRates(snaps);

  const arb = await withDepth(f, arbitrage(snaps, { now: Date.now(), minVol, rates }).slice(0, 300), rates);
  const perps = await perpsP;
  for (const r of arb) r.futures = perps.coins[r.base] ?? [];
  const binanceOk = snaps.BINANCE?.rows ?? [];
  const p = binanceOk.length
    ? await scanPumps(f, binanceOk, state.history ?? {}, state.pumpSymbols ?? [], { now, minVol, usdt: rates.USDT })
    : { pumps: [] as Pump[], history: state.history ?? {} };

  const next: State = { ...state, history: p.history, pumpSymbols: p.pumps.filter((x) => x.stage).map((x) => x.native) };
  const listings: Record<string, unknown>[] = [];
  if (!state.listingsAt || now - state.listingsAt >= LISTINGS_EVERY_MS) {
    const lists: Record<string, Instrument[]> = {};
    await Promise.all(EXCHANGES.map(async (ex) => {
      try {
        lists[ex] = ex === "KRAKEN" && ctx.kraken ? ctx.kraken : ex === "COINBASE" && ctx.coinbase ? ctx.coinbase : await EX[ex].instruments(f);
      } catch (e) { status[ex] = { ...(status[ex] ?? { ok: false }), error: status[ex]?.error ?? `danh sách cặp: ${(e as Error).message}` }; }
    }));
    const known = { ...(state.known ?? {}) };
    const tradingOn = (base: string, except: string) =>
      EXCHANGES.filter((ex) => ex !== except && (lists[ex] ?? []).some((r) => r.base === base && r.status === "trading"));
    for (const [ex, rows] of Object.entries(lists)) {
      const d = diffListings(known[ex], rows);
      known[ex] = d.known;
      for (const e of d.events) listings.push({
        exchange: ex, native: e.native, base: e.base, quote: e.quote, kind: e.kind, status: e.status,
        opens_at: e.opensAt ? new Date(e.opensAt).toISOString() : null, elsewhere: tradingOn(e.base, ex),
      });
    }
    next.known = known;
    next.listingsAt = now;
  }
  const futures = { arbitrage: perps.arbitrage, status: perps.status, coins: Object.keys(perps.coins).length };
  return { snapshot: { arbitrage: arb, pumps: p.pumps, status, rates, futures }, listings, state: next };
}

/** Candidates for alerts; radar_notify() applies each user's thresholds, fees and a 30-minute cooldown. */
export function alertEvents(snapshot: { arbitrage: ArbRow[]; pumps: Pump[] }, listings: Record<string, unknown>[]) {
  const ev: Record<string, unknown>[] = [];
  for (const r of snapshot.arbitrage.slice(0, 30)) {
    const d = r.depth?.[1000];
    if (r.suspect || !d?.full || d.gross <= 0) continue;
    ev.push({ type: "arbitrage", key: `arb:${r.base}:${r.buy.ex}:${r.sell.ex}`, base: r.base, buy: r.buy.ex, sell: r.sell.ex,
      gross: Number(d.gross.toFixed(3)), vol: Math.round(r.volUsd) });
  }
  for (const p of snapshot.pumps)
    if (p.stage === "pumping" && p.score >= 40)
      ev.push({ type: "pump", key: `pump:${p.native}`, base: p.base, score: p.score, chg15m: Number(p.chg15m.toFixed(1)),
        vol_ratio: Number(p.volRatio.toFixed(1)), vol: Math.round(p.vol24hUsd) });
  for (const l of listings)
    ev.push({ type: "listing", key: `list:${l.exchange}:${l.native}:${l.kind}`, ...l });
  return ev;
}

export async function radarCron(req: Request, deps: RadarDeps) {
  if (req.method !== "POST") throw new HttpError(405, "METHOD_NOT_ALLOWED");
  const secret = req.headers.get("x-qt-cron") ?? "";
  if (!/^[0-9a-f]{64}$/.test(secret) || !(await rpc(deps.db, "cron_secret_ok", { p_secret: secret }))) {
    throw new HttpError(401, "CRON_SECRET_INVALID");
  }
  const now = deps.now?.() ?? Date.now();
  const state = ((await rpc(deps.db, "radar_state_get")) ?? {}) as State;
  const { snapshot, listings, state: next } = await scan(deps.fetch, state, now);
  await rpc(deps.db, "radar_save", { p_snapshot: snapshot, p_state: next, p_listings: listings });
  const messages = ((await rpc(deps.db, "radar_notify", { p_events: alertEvents(snapshot, listings) })) ?? []) as { chat_id: string; text: string }[];
  let sent = 0;
  if (deps.telegramToken) {
    for (const m of messages) {
      try {
        const r = await deps.fetch(`https://api.telegram.org/bot${deps.telegramToken}/sendMessage`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: m.chat_id, text: m.text }),
        });
        if (r.ok) sent++;
      } catch { /* the in-app notification is already stored */ }
    }
  }
  return json(200, {
    exchanges: Object.fromEntries(Object.entries(snapshot.status).map(([k, v]) => [k, v.ok ? v.pairs : v.error])),
    arbitrage: snapshot.arbitrage.length, futures: snapshot.futures.arbitrage.length, pumps: snapshot.pumps.length, listings: listings.length,
    telegram: messages.length, sent,
  });
}
