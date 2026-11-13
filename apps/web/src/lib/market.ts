import "server-only";
import {
  SYMBOLS, BINANCE_NATIVE, binanceInterval, parseBinance, COINBASE_NATIVE, parseCoinbase,
  YAHOO_NATIVE, parseYahoo, parseBrokerRows,
} from "@qt/shared/market";
import { nativeBase, parseTf, resample, isIntraday } from "@qt/core/series";
import { createClient } from "@supabase/supabase-js";
import { supabaseEnv } from "@/lib/supabase/env";

export type Bar = { time: number; open: number; high: number; low: number; close: number; volume: number };
export type BarsResult = {
  symbol: string; tf: string; bars: Bar[];
  source: string;          // shown under the chart
  realtime: boolean;       // false = delayed or proxy data; never labelled LIVE (design §5.2)
  note?: string;
};

const UA = { "User-Agent": "Mozilla/5.0 (compatible; QuantTerminalCloud/1.0)", Accept: "application/json" };

async function getJson(url: string, timeoutMs = 8000) {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
  if (!res.ok) throw Object.assign(new Error(`${new URL(url).host} ${res.status}`), { status: res.status });
  return res.json();
}

const finish = (bars: Bar[], base: string, tf: string, limit: number) =>
  (base === tf ? bars : resample(bars, tf)).slice(-limit);

// api.binance.com answers 451 from US cloud regions; the market-data mirror does not.
const BINANCE_HOSTS = ["https://data-api.binance.vision", "https://api.binance.com"];

async function binance(ticker: string, tf: string, limit: number): Promise<Bar[]> {
  const base = nativeBase(tf, BINANCE_NATIVE);
  if (!base) throw new Error(`Binance: no ${tf}`);
  const ratio = Math.max(1, Math.round(parseTf(tf).seconds / parseTf(base).seconds));
  const want = Math.min(limit * ratio + ratio, 5000);
  let lastErr: unknown;
  for (const host of BINANCE_HOSTS) {
    try {
      let out: Bar[] = [];
      let end: number | null = null;
      while (out.length < want) {
        const n = Math.min(1000, want - out.length);
        const rows = await getJson(`${host}/api/v3/klines?symbol=${ticker}&interval=${binanceInterval(base)}&limit=${n}${end ? `&endTime=${end}` : ""}`);
        if (!rows.length) break;
        out = parseBinance(rows).concat(out);
        end = rows[0][0] - 1;
        if (rows.length < n) break;
      }
      return finish(out, base, tf, limit);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

async function coinbase(product: string, tf: string, limit: number): Promise<Bar[]> {
  const base = nativeBase(tf, Object.keys(COINBASE_NATIVE));
  if (!base) throw new Error(`Coinbase: no ${tf}`);
  const rows = await getJson(`https://api.exchange.coinbase.com/products/${product}/candles?granularity=${COINBASE_NATIVE[base]}`);
  return finish(parseCoinbase(rows), base, tf, limit);
}

async function yahoo(sym: string, tf: string, limit: number): Promise<Bar[]> {
  const base = nativeBase(tf, Object.keys(YAHOO_NATIVE));
  if (!base) throw new Error(`Yahoo: no ${tf}`);
  const [interval, range] = YAHOO_NATIVE[base];
  const j = await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=${interval}&range=${range}&includePrePost=false`);
  return finish(parseYahoo(j, !isIntraday(base)), base, tf, limit);
}

/** Broker M1 bars pushed by the master EA. Used when they are fresh (last bar < 5 min) and the timeframe is intraday. */
async function broker(symbol: string, tf: string, limit: number): Promise<Bar[] | null> {
  if (!isIntraday(tf) || parseTf(tf).seconds > 14400) return null;
  const { url, key } = supabaseEnv();
  const db = createClient(url, key, { auth: { persistSession: false } });
  const minutes = Math.min(limit * (parseTf(tf).seconds / 60), 20_000);
  const { data, error } = await db.from("bars_m1").select("ts, o, h, l, c, v")
    .eq("symbol", symbol).order("ts", { ascending: false }).limit(minutes);
  if (error || !data?.length) return null;
  const bars = parseBrokerRows(data);
  if (Date.now() / 1000 - bars[bars.length - 1].time > 300) return null;
  return finish(bars, "1m", tf, limit);
}

/** Bars for a supported symbol, trying the best source first. */
export async function getBars(symbol: string, tf: string, limit: number): Promise<BarsResult> {
  const info = SYMBOLS[symbol];
  if (!info) throw Object.assign(new Error(`Unknown symbol ${symbol}`), { status: 400 });
  const errors: string[] = [];

  if (info.broker) {
    const b = await broker(symbol, tf, limit).catch(() => null);
    if (b?.length) return { symbol, tf, bars: b, source: "Giá broker (EA master)", realtime: true };
  }
  if (info.binance) {
    try {
      return { symbol, tf, bars: await binance(info.binance, tf, limit), source: `Binance ${info.binance}`, realtime: true };
    } catch (e) { errors.push(String((e as Error).message)); }
  }
  if (info.coinbase) {
    try {
      return { symbol, tf, bars: await coinbase(info.coinbase, tf, limit), source: `Coinbase ${info.coinbase}`, realtime: true };
    } catch (e) { errors.push(String((e as Error).message)); }
  }
  if (info.yahoo) {
    try {
      return {
        symbol, tf, bars: await yahoo(info.yahoo, tf, limit), source: `Yahoo ${info.yahoo}`, realtime: false,
        note: `${info.proxy ?? info.yahoo}: giá tham khảo, có thể trễ và lệch so với giá broker.`,
      };
    } catch (e) { errors.push(String((e as Error).message)); }
  }
  throw Object.assign(new Error(`Không lấy được dữ liệu ${symbol}: ${errors.join("; ")}`), { status: 502 });
}
