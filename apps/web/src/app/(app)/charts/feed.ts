"use client";
// Bars for one chart: the first load, the live candle (Binance websocket) or polling, shared by the main chart
// and the side chart. Also the higher-timeframe candles drawn behind a lower-timeframe chart.
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  SYMBOLS, TIMEFRAMES, binanceInterval, tfSeconds, parseBinance, usesFutures, scaleBars, fetchSpotUsdFactor,
  BINANCE_SPOT_STREAM, BINANCE_FUTURES_HOST, BINANCE_FUTURES_STREAM,
} from "@qt/shared/market";
import { bucketStart } from "@qt/core/series";
import { createLiveBar, withLive } from "./live-bar";
import type { Bar } from "./price-chart";
import type { HtfDraw } from "./chart-overlay";

export type BarsResponse = { bars: Bar[]; source: string; realtime: boolean; factor?: number; note?: string; error?: string };

/** Perpetual klines straight from Binance in the browser (CORS open): used when the server could not reach fapi
 * (it answers 451 from US cloud regions) and only had Yahoo's delayed prices. */
async function fetchFuturesBars(ticker: string, tf: string, limit: number): Promise<BarsResponse | null> {
  try {
    const r = await fetch(`${BINANCE_FUTURES_HOST}/fapi/v1/klines?symbol=${ticker}&interval=${binanceInterval(tf)}&limit=${Math.min(limit, 1500)}`);
    if (!r.ok) return null;
    const [bars, factor] = await Promise.all([parseBinance(await r.json()), fetchSpotUsdFactor(fetch, ticker)]);
    return bars.length ? {
      bars: scaleBars(bars, factor), source: `Binance Futures ${ticker}`, realtime: true, factor: factor ?? 1,
      note: factor
        ? `${ticker} quy đổi về USD giao ngay (bỏ chênh hợp đồng vĩnh cửu và tỷ giá USDT): còn lệch broker khoảng spread.`
        : `${ticker}: giá USDT của hợp đồng vĩnh cửu, chưa quy đổi được về USD: có thể lệch broker vài giá.`,
    } : null;
  } catch { return null; }
}
export async function fetchBars(symbol: string, tf: string, limit: number): Promise<BarsResponse> {
  let res: BarsResponse;
  try {
    const r = await fetch(`/api/bars?symbol=${symbol}&tf=${tf}&limit=${limit}`);
    const j: BarsResponse = await r.json();
    res = r.ok ? j : { bars: [], source: "", realtime: false, error: j.error ?? `HTTP ${r.status}` };
  } catch (e) {
    res = { bars: [], source: "", realtime: false, error: (e as Error).message };
  }
  const info = SYMBOLS[symbol];
  if (!res.realtime && info?.futures && usesFutures(info, tf)) return (await fetchFuturesBars(info.futures, tf, limit)) ?? res;
  return res;
}
/** Websocket for the live candle: Binance spot or futures, whichever the bars came from; null = poll the API. */
function streamUrl(source: string | undefined, tf: string) {
  const m = /^Binance (Futures )?([A-Z0-9]+)/.exec(source ?? "");
  if (!m) return null;
  return `${m[1] ? BINANCE_FUTURES_STREAM : BINANCE_SPOT_STREAM}${m[2].toLowerCase()}@kline_${binanceInterval(tf)}`;
}
/**
 * A websocket that comes back by itself: Binance drops connections after 24 h and on network blips. Reconnects with
 * a growing delay (1 s up to 30 s), also when no message came for `staleMs` (a socket that is open but silent).
 * Returns the close function.
 */
export function liveSocket(url: string, onMessage: (data: unknown) => void, staleMs = 60_000) {
  let ws: WebSocket | null = null;
  let closed = false;
  let delay = 1000;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let lastMsg = Date.now();
  const open = () => {
    if (closed) return;
    lastMsg = Date.now();
    ws = new WebSocket(url);
    ws.onmessage = (ev) => {
      lastMsg = Date.now();
      delay = 1000;
      try { onMessage(JSON.parse(ev.data)); } catch { /* not JSON: ignore */ }
    };
    ws.onclose = () => {
      if (closed) return;
      retry = setTimeout(open, delay);
      delay = Math.min(delay * 2, 30_000);
    };
  };
  const watchdog = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN && Date.now() - lastMsg > staleMs) ws.close();
  }, 10_000);
  open();
  return () => { closed = true; clearTimeout(retry); clearInterval(watchdog); ws?.close(); };
}

/**
 * Bars of `symbol` at `tf`, kept fresh. The forming candle goes to the `live` store (only its subscribers
 * re-render, see live-bar.ts); `data` changes on a load and when a new candle opens.
 * `usdFactors`: live perpetual -> spot USD multipliers, so gold from the USDT perpetual shows in USD.
 */
export function useBarsFeed(symbol: string, tf: string, usdFactors: RefObject<Record<string, number>>) {
  const [data, setData] = useState<BarsResponse | null>(null);
  const [loadedKey, setLoadedKey] = useState("");
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const tfInfo = TIMEFRAMES.find((t) => t.tf === tf) ?? TIMEFRAMES.find((t) => t.tf === "1h")!;
  const key = `${symbol}:${tf}`;
  const load = useCallback((quiet = false) => {
    let alive = true;
    fetchBars(symbol, tf, tfInfo.bars).then((res) => {
      if (!alive || (quiet && res.error)) return;
      setData(res);
      setUpdatedAt(Date.now());
      setLoadedKey(`${symbol}:${tf}`);
    });
    return () => { alive = false; };
  }, [symbol, tf, tfInfo.bars]);
  useEffect(() => load(), [load]);

  const [live] = useState(createLiveBar);
  const dataRef = useRef(data);
  useEffect(() => { dataRef.current = data; }, [data]);

  // Binance spot (crypto) and futures (gold, silver, oil intraday): kline stream in the browser, no server cost.
  // Others (broker bars, Yahoo): poll the cached API; broker bars arrive every minute, so a little faster.
  const stream = streamUrl(data?.source, tf);
  const step = tfSeconds(tf);
  const streamFut = /^Binance Futures ([A-Z0-9]+)/.exec(data?.source ?? "")?.[1];
  const streamFactor = data?.factor;
  const pollMs = data?.source.startsWith("Giá broker") ? 10_000 : 30_000;
  useEffect(() => {
    if (!stream) {
      let cancel = () => {};
      const t = setInterval(() => { cancel = load(true); }, pollMs);
      return () => { clearInterval(t); cancel(); };
    }
    let pending: Bar | null = null;
    let reloadedAt = 0;
    const close = liveSocket(stream, (msg) => {
      const k = (msg as { k?: { t: number; o: string; h: string; l: string; c: string; v: string } }).k;
      if (!k) return;
      const f = (streamFut && usdFactors.current[streamFut]) || streamFactor || 1;
      pending = { time: k.t / 1000, open: +k.o * f, high: +k.h * f, low: +k.l * f, close: +k.c * f, volume: +k.v };
    });
    // apply at most twice a second: indicators are recomputed on every update. The forming candle goes to the live
    // store; page state changes only when a new candle opens.
    const t = setInterval(() => {
      if (!pending) return;
      const bar = pending; pending = null;
      const d = dataRef.current;
      const last = d?.bars[d.bars.length - 1];
      if (!last || bar.time < last.time) return;
      if (bar.time === last.time) { live.set(stream, bar); return; }
      // candles missed while the socket was down: fetch the bars again instead of leaving a hole
      if (bar.time > last.time + step) {
        if (Date.now() - reloadedAt > 30_000) { reloadedAt = Date.now(); cancelLoad = load(true); }
        return;
      }
      // a new candle: the one that closed keeps its last streamed values
      const closed = live.get();
      setData((d) => {
        if (!d || !d.bars.length) return d;
        const bs = withLive(d.bars, stream, closed);
        const l = bs[bs.length - 1];
        if (bar.time < l.time) return d;
        return { ...d, bars: bar.time === l.time ? [...bs.slice(0, -1), bar] : [...bs.slice(1), bar] };
      });
      setUpdatedAt(Date.now());
    }, 500);
    let cancelLoad = () => {};
    return () => { clearInterval(t); close(); cancelLoad(); };
  }, [stream, pollMs, load, step, streamFut, streamFactor, live, usdFactors]);

  return { data, loading: loadedKey !== key, updatedAt, live, stream, streamKey: stream ?? "", step, tfInfo, key };
}

// ---------- higher-timeframe candles ----------
export type HtfCandle = HtfDraw["candles"][number];

/** Timeframes larger than `tf`, the ones its chart can show behind its own candles. */
export const largerTimeframes = (tf: string) => TIMEFRAMES.filter((t) => tfSeconds(t.tf) > tfSeconds(tf));
/** The next larger timeframe that holds several candles of `tf` (5m -> 1H, 1H -> 1D), for the "Tự động" choice. */
export function autoHtf(tf: string) {
  const s = tfSeconds(tf);
  return largerTimeframes(tf).find((t) => tfSeconds(t.tf) >= s * 4)?.tf ?? null;
}

/**
 * Higher-timeframe bars of `symbol`, refreshed every minute; null while off. How many: enough to cover the
 * lower-timeframe chart (`tf` bars back), at least a few.
 */
export function useHtfBars(symbol: string, tf: string, htf: string | null): Bar[] | null {
  const [got, setGot] = useState<{ key: string; bars: Bar[] } | null>(null);
  const key = htf ? `${symbol}:${htf}` : "";
  useEffect(() => {
    if (!htf) return;
    const lowBars = TIMEFRAMES.find((t) => t.tf === tf)?.bars ?? 600;
    const limit = Math.min(500, Math.max(10, Math.ceil((lowBars * tfSeconds(tf)) / tfSeconds(htf)) + 2));
    let alive = true;
    const run = () => fetchBars(symbol, htf, limit).then((r) => { if (alive && !r.error) setGot({ key: `${symbol}:${htf}`, bars: r.bars }); });
    run();
    const t = setInterval(run, 60_000);
    return () => { alive = false; clearInterval(t); };
  }, [symbol, tf, htf]);
  return useMemo(() => (got && got.key === key ? got.bars : null), [got, key]);
}

/**
 * The higher-timeframe candles over the span of the chart's `bars`: the fetched ones, with the newest updated (or
 * a new one started) from the chart's own bars, so the big candle moves with the live price.
 */
export function htfCandles(htf: Bar[], bars: Bar[], htfTf: string): HtfCandle[] {
  if (!htf.length || !bars.length) return [];
  const sec = tfSeconds(htfTf);
  const first = bars[0].time;
  const out: Bar[] = htf.filter((c) => c.time + sec > first).map((c) => ({ ...c }));
  const lastStart = out.length ? out[out.length - 1].time : -Infinity;
  // only the chart's bars from the newest fetched big candle on
  let i = bars.length - 1;
  while (i > 0 && bars[i - 1].time >= lastStart) i--;
  for (; i < bars.length; i++) {
    const b = bars[i];
    if (b.time < lastStart) continue;
    const start = bucketStart(b.time, htfTf);
    const cur = out[out.length - 1];
    if (cur && cur.time === start) {
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.close = b.close;
    } else if (!cur || start > cur.time) {
      out.push({ time: start, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume });
    }
  }
  return out.map((c, k) => ({ ...c, end: Math.min(out[k + 1]?.time ?? Infinity, c.time + sec) }));
}
