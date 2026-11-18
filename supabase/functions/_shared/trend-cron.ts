// Long-term trend alerts, run by pattern-cron right after each daily candle closes (00:00 UTC).
// Reads the daily closes of every symbol a user follows (table trend_alert_settings) with the shared trend rules
// (vendor/trend.js = packages/core/src/trend.js, the same code as the chart's trend panel), turns what changed on the
// candle that closed into events, and lets trend_notify() deliver each to its followers once.
import { HttpError, type Db } from "./ea.ts";
import { trendChanges, trendSummary, TREND_LABEL } from "./vendor/trend.js";
import { SYMBOLS } from "./vendor/market.js";
import type { Bar } from "./pattern-cron.ts";

export type TrendEvent = { type: "trend" | "cross" | "ema200" | "weekly"; symbol: string; key: string; title: string; body: string };
type Change = { type: "trend" | "cross" | "ema200"; id: string; dir: number; state?: keyof typeof TREND_LABEL };
type Summary = { state: keyof typeof TREND_LABEL; label: string; since: number; close: number; emaFast: number; emaSlow: number;
  distPct: number; slopePct: number | null; high52: number; low52: number; time: number };

export const DAY = 86400;
export const TREND_BARS = 600; // EMA200 needs 200 closes to start, and a few hundred more to settle

const date = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
const pct = (v: number | null) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`);

/** Events for the daily candle that closed last before `now` (the forming one is dropped). */
export function trendEvents(symbol: string, all: Bar[], now: number): TrendEvent[] {
  const bars = all.filter((b) => b.time + DAY <= now);
  const s = trendSummary(bars) as Summary | null;
  if (!s) return [];
  const digits = (SYMBOLS as Record<string, { digits: number }>)[symbol]?.digits ?? 2;
  const px = (v: number) => v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const levels = `Giá ${px(s.close)} · EMA50 ${px(s.emaFast)} · EMA200 ${px(s.emaSlow)} (giá ${pct(s.distPct)} so với EMA200).`;
  const tail = ` Nến ngày ${date(s.time)}. Chỉ để tham khảo, không phải khuyến nghị.`;
  const out: TrendEvent[] = [];
  const ev = (type: TrendEvent["type"], id: string, title: string, body: string) =>
    out.push({ type, symbol, key: `trend|${symbol}|${id}|${s.time}`, title: `${symbol} D1: ${title}`, body: body + tail });

  // the last bar must be recent: a market closed for the weekend keeps reporting its Friday bar, deduped by key
  if (s.time + 4 * DAY < now) return [];
  for (const c of trendChanges(bars) as Change[]) {
    if (c.type === "trend") ev("trend", c.id, `trend dài hạn chuyển sang ${TREND_LABEL[c.state!]}`, levels);
    else if (c.type === "cross") ev("cross", c.id, c.dir > 0 ? "Golden cross (EMA50 cắt lên EMA200)" : "Death cross (EMA50 cắt xuống EMA200)", levels);
    else ev("ema200", c.id, c.dir > 0 ? "giá đóng cửa vượt lên EMA200" : "giá đóng cửa thủng xuống EMA200", levels);
  }
  // Monday's run: where the long-term trend stands
  if (new Date(now * 1000).getUTCDay() === 1) {
    out.push({
      type: "weekly", symbol, key: `trend|${symbol}|weekly|${date(now)}`,
      title: `${symbol}: trend dài hạn tuần này — ${s.label}`,
      body: `${s.label} từ ${date(s.since)}. ${levels} EMA200 20 phiên ${pct(s.slopePct)}. Vùng 52 tuần ${px(s.low52)} – ${px(s.high52)}.` + tail,
    });
  }
  return out;
}

async function rpc(db: Db, fn: string, args: Record<string, unknown> = {}) {
  const { data, error } = await db.rpc(fn, args);
  if (error) throw new HttpError(500, "DB_ERROR", `${fn}: ${error.message}`);
  return data;
}

/** One run: followed symbols -> daily bars -> events -> notifications. Returns the Telegram messages to send. */
export async function trendRun(db: Db, bars: (symbol: string) => Promise<Bar[]>, now: number) {
  const symbols = (((await rpc(db, "trend_jobs")) ?? []) as string[]).filter((s) => s in SYMBOLS);
  const events: TrendEvent[] = [];
  const errors: string[] = [];
  await Promise.all(symbols.map(async (s) => {
    try { events.push(...trendEvents(s, await bars(s), now)); } catch (e) { errors.push(`${s} 1D: ${(e as Error).message}`); }
  }));
  const messages = (events.length ? ((await rpc(db, "trend_notify", { p_events: events })) ?? []) : []) as { chat_id: string; text: string }[];
  return { symbols: symbols.length, events: events.length, messages, errors };
}
