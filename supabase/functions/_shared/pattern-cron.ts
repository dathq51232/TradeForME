// POST /pattern-cron — called every minute by pg_cron (through pg_net) with header x-qt-cron.
// For each (symbol, timeframe) a user follows, right after a candle of that timeframe closes: read the closed
// bars with the chart's own pattern recognition (vendor/patterns.js, the same code as the web app), turn what just
// happened into events (pattern formed, pattern breakout, small wedge ready / broken, candlestick pattern on the
// candle that closed), and let pattern_notify() deliver each to its followers once; then send the Telegram messages
// it returns. Right after the daily close it also runs the long-term trend alerts (trend-cron.ts).
// Runtime-neutral (Web APIs only) so the Node test suite runs the same code as the Edge Function.
import { HttpError, json, type Db } from "./ea.ts";
import { trendRun, TREND_BARS } from "./trend-cron.ts";
import { candlestickPatterns, chartPatterns, microWedges } from "./vendor/patterns.js";
import {
  SYMBOLS, BINANCE_NATIVE, binanceInterval, parseBinance, YAHOO_NATIVE, parseYahoo, parseBrokerRows, tfSeconds,
  BINANCE_SPOT_HOST, BINANCE_FUTURES_HOST, usesFutures,
} from "./vendor/market.js";
import { isIntraday, nativeBase, parseTf, resample } from "./vendor/series.js";

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
export type PatternDeps = { db: Db; fetch: Fetch; telegramToken?: string; now?: () => number };
export type Bar = { time: number; open: number; high: number; low: number; close: number; volume: number };
export type PatternEvent = { type: "formed" | "breakout" | "wedge" | "candle"; symbol: string; tf: string; key: string; title: string; body: string };
type SymbolInfo = { digits: number; binance?: string; futures?: string; yahoo?: string; broker?: boolean };

export const TFS = ["5m", "15m", "1h", "4h", "1D"];
const TF_LABEL: Record<string, string> = { "5m": "M5", "15m": "M15", "1h": "H1", "4h": "H4", "1D": "D1" };
const BARS = 400; // enough history for pivots, ATR and the wedge's impulse
const STATUS: Record<string, string> = { breakoutUp: "đã phá lên", breakoutDown: "đã phá xuống" };

async function rpc(db: Db, fn: string, args: Record<string, unknown> = {}) {
  const { data, error } = await db.rpc(fn, args);
  if (error) throw new HttpError(500, "DB_ERROR", `${fn}: ${error.message}`);
  return data;
}
async function getJson(f: Fetch, url: string, headers: Record<string, string> = {}) {
  const r = await f(url, { headers: { "user-agent": "Mozilla/5.0", accept: "application/json", ...headers }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`${new URL(url).host} ${r.status}`);
  return r.json();
}

/** The chart's sources, in the chart's order: broker M1 bars when fresh, then Binance spot, Binance futures
 * (gold, silver, oil up to H4), then Yahoo. `count` bars at most. */
export async function getBars(f: Fetch, db: Db, symbol: string, tf: string, now: number, count = BARS): Promise<Bar[]> {
  const info = (SYMBOLS as Record<string, SymbolInfo>)[symbol];
  if (!info) throw new Error(`unknown symbol ${symbol}`);
  const done = (bars: Bar[], base: string) => (base === tf ? bars : (resample(bars, tf) as Bar[])).slice(-count);
  if (info.broker && isIntraday(tf) && parseTf(tf).seconds <= 14400) {
    const rows = (await rpc(db, "broker_bars_m1", { p_symbol: symbol, p_limit: Math.min(count * (parseTf(tf).seconds / 60), 20000) })) as unknown[] | null;
    const bars = rows?.length ? (parseBrokerRows(rows) as Bar[]) : [];
    if (bars.length && now - bars[bars.length - 1].time <= 300) return done(bars, "1m");
  }
  const binance = async (hosts: string[], path: string, ticker: string, page: number) => {
    const base = nativeBase(tf, BINANCE_NATIVE) as string;
    const ratio = Math.max(1, Math.round(parseTf(tf).seconds / parseTf(base).seconds));
    for (const host of hosts) {
      try {
        const rows = await getJson(f, `${host}${path}?symbol=${ticker}&interval=${binanceInterval(base)}&limit=${Math.min(page, count * ratio + ratio)}`);
        return done(parseBinance(rows) as Bar[], base);
      } catch { /* next host */ }
    }
    return null;
  };
  if (info.binance) {
    const b = await binance([BINANCE_SPOT_HOST, "https://api.binance.com"], "/api/v3/klines", info.binance, 1000);
    if (b) return b;
  }
  if (info.futures && usesFutures(info, tf)) {
    const b = await binance([BINANCE_FUTURES_HOST], "/fapi/v1/klines", info.futures, 1500); // 451 from some regions: Yahoo next
    if (b) return b;
  }
  if (info.yahoo) {
    const base = nativeBase(tf, Object.keys(YAHOO_NATIVE)) as string;
    const [interval, range] = (YAHOO_NATIVE as Record<string, [string, string]>)[base];
    const j = await getJson(f, `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(info.yahoo)}?interval=${interval}&range=${range}&includePrePost=false`);
    return done(parseYahoo(j, !isIntraday(base)) as Bar[], base);
  }
  throw new Error(`no source for ${symbol}`);
}

/** True in the first two minutes after a candle of `tf` closes (the cron runs every minute; events dedupe). */
export const justClosed = (tf: string, now: number) => now % tfSeconds(tf) < 120;

/** What just happened on the newest closed candles of `bars` (the candle still forming is dropped first). */
export function patternEvents(symbol: string, tf: string, all: Bar[], now: number): PatternEvent[] {
  const step = tfSeconds(tf);
  const bars = all.filter((b) => b.time + step <= now);
  if (bars.length < 60) return [];
  const last = bars[bars.length - 1];
  const recent = (t: number) => t >= last.time - 2 * step;
  const digits = (SYMBOLS as Record<string, SymbolInfo>)[symbol]?.digits ?? 2;
  const px = (v: number | null | undefined) => (v == null ? "—" : v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits }));
  const head = `${symbol} ${TF_LABEL[tf] ?? tf}`;
  const at = new Date(last.time * 1000).toISOString().slice(0, 16).replace("T", " ");
  const out: PatternEvent[] = [];
  const ev = (type: PatternEvent["type"], id: string, title: string, body: string) =>
    out.push({ type, symbol, tf, key: `${symbol}|${tf}|${id}`, title: `${head}: ${title}`, body: `${body} Nến đóng ${at} UTC. Chỉ để tham khảo, không phải khuyến nghị.` });

  for (const p of chartPatterns(bars, { depth: 5, max: 6 }) as { kind: string; name: string; status: string; start: number; end: number; target: number | null }[]) {
    if (!recent(p.end)) continue;
    if (p.status === "forming") ev("formed", `${p.kind}|${p.start}|formed`, `${p.name} đã hình thành`, `Giá ${px(last.close)}; chờ giá đóng cửa phá qua đường biên.`);
    else if (STATUS[p.status]) ev("breakout", `${p.kind}|${p.start}|${p.status}`, `${p.name} ${STATUS[p.status]}`,
      `Giá ${px(last.close)}${p.target != null ? `, mục tiêu ${px(p.target)}` : ""}.`);
  }
  for (const w of microWedges(bars, { max: 3 }) as { kind: string; name: string; stage: string; score: number; start: number; end: number; entry: number | null; stop: number | null; target: number | null }[]) {
    if (!recent(w.end) || (w.stage !== "ready" && w.stage !== "broken")) continue;
    ev("wedge", `${w.kind}|${w.start}|${w.stage}`, w.stage === "ready" ? `${w.name} sẵn sàng phá (${w.score} điểm)` : `${w.name} đã phá`,
      w.entry != null ? `Vào ${px(w.entry)}, SL ${px(w.stop)}, mục tiêu ${px(w.target)}.` : `Giá ${px(last.close)}.`);
  }
  for (const c of candlestickPatterns(bars) as { kind: string; name: string; bias: number; i: number; time: number }[]) {
    if (c.i !== bars.length - 1 || c.bias === 0 || c.kind.endsWith("Marubozu")) continue;
    ev("candle", `${c.kind}|${c.time}`, `nến ${c.name} (${c.bias > 0 ? "tăng" : "giảm"})`, `Đóng cửa ${px(last.close)}.`);
  }
  return out;
}

export async function patternCron(req: Request, deps: PatternDeps) {
  if (req.method !== "POST") throw new HttpError(405, "METHOD_NOT_ALLOWED");
  const secret = req.headers.get("x-qt-cron") ?? "";
  if (!/^[0-9a-f]{64}$/.test(secret) || !(await rpc(deps.db, "cron_secret_ok", { p_secret: secret }))) {
    throw new HttpError(401, "CRON_SECRET_INVALID");
  }
  const now = Math.floor((deps.now?.() ?? Date.now()) / 1000);
  const jobs = (((await rpc(deps.db, "pattern_jobs")) ?? []) as { symbol: string; tf: string }[])
    .filter((j) => TFS.includes(j.tf) && j.symbol in SYMBOLS && justClosed(j.tf, now));
  const events: PatternEvent[] = [];
  const errors: string[] = [];
  await Promise.all(jobs.map(async (j) => {
    try {
      events.push(...patternEvents(j.symbol, j.tf, await getBars(deps.fetch, deps.db, j.symbol, j.tf, now), now));
    } catch (e) {
      errors.push(`${j.symbol} ${j.tf}: ${(e as Error).message}`);
    }
  }));
  const messages = (events.length ? ((await rpc(deps.db, "pattern_notify", { p_events: events })) ?? []) : []) as { chat_id: string; text: string }[];
  const out: Record<string, unknown> = { jobs: jobs.length, events: events.length };

  // long-term trend, once the daily candle has closed
  if (justClosed("1D", now)) {
    const t = await trendRun(deps.db, (s) => getBars(deps.fetch, deps.db, s, "1D", now, TREND_BARS), now);
    messages.push(...t.messages);
    errors.push(...t.errors);
    out.trend = { symbols: t.symbols, events: t.events, telegram: t.messages.length };
  }

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
  return json(200, { ...out, telegram: messages.length, sent, errors });
}
