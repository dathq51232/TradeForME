// POST /market-cron — called every minute by pg_cron (through pg_net) with header x-qt-cron.
//  1. Price alerts: fetch the last price of every symbol with an armed alert, let check_alerts() fire the
//     ones whose level was crossed, then send the Telegram messages it returns.
//  2. Economic calendar: every 30 minutes, copy the weekly public calendar into econ_events.
// Runtime-neutral (Web APIs only) so the Node test suite runs the same code as the Edge Function.
import { HttpError, json, type Db } from "./ea.ts";
import { fetchSpotUsdFactor } from "./vendor/market.js";

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
export type CronDeps = { db: Db; fetch: Fetch; telegramToken?: string };

// Same public sources as the chart (packages/shared/src/market.js); broker M1 bars win inside check_alerts.
// Gold, silver and oil: the Binance TradFi perpetual (realtime) first, converted from USDT to spot USD like the chart
// (fetchSpotUsdFactor), Yahoo's delayed futures when fapi is unreachable.
export const PRICE_SOURCES: Record<string, { binance?: string; futures?: string; yahoo?: string }> = {
  XAUUSD: { futures: "XAUUSDT", yahoo: "GC=F" }, XAGUSD: { futures: "XAGUSDT", yahoo: "SI=F" },
  WTI: { futures: "CLUSDT", yahoo: "CL=F" }, BRENT: { futures: "BZUSDT", yahoo: "BZ=F" }, DXY: { yahoo: "DX-Y.NYB" },
  BTCUSD: { binance: "BTCUSDT" }, ETHUSD: { binance: "ETHUSDT" },
};
export const CALENDAR_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";
const IMPORTANCE: Record<string, number> = { Low: 1, Medium: 2, High: 3 };
// Which charted markets a release usually moves (used to filter the chart's event markers).
const ASSETS: Record<string, string[]> = {
  USD: ["XAUUSD", "XAGUSD", "BTCUSD", "ETHUSD", "WTI", "BRENT", "DXY"],
  CNY: ["WTI", "BRENT", "XAUUSD"], EUR: ["DXY"], JPY: ["DXY"], GBP: ["DXY"],
};

/** "0.3%" -> 0.3, "215K" -> 215, "-1.2B" -> -1.2, "" -> null (the text is kept separately). */
export function leadingNumber(text: unknown): number | null {
  const m = /-?\d+(?:\.\d+)?/.exec(String(text ?? "").replace(/,/g, ""));
  return m ? Number(m[0]) : null;
}

type FfRow = { title?: string; country?: string; date?: string; impact?: string; forecast?: string; previous?: string; actual?: string };
/** Weekly calendar feed -> rows for upsert_econ_events (holidays and malformed rows dropped). */
export function parseCalendar(rows: unknown) {
  if (!Array.isArray(rows)) return [];
  return (rows as FfRow[]).flatMap((r) => {
    const t = Date.parse(r.date ?? "");
    const importance = IMPORTANCE[r.impact ?? ""];
    if (!r.title || !r.country || !Number.isFinite(t) || !importance) return [];
    return [{
      country: r.country, title: r.title, scheduled_at: new Date(t).toISOString(), importance,
      forecast_text: r.forecast || null, previous_text: r.previous || null, actual_text: r.actual || null,
      forecast: leadingNumber(r.forecast), previous: leadingNumber(r.previous), actual: leadingNumber(r.actual),
      assets: ASSETS[r.country] ?? [],
    }];
  });
}

export async function lastPrice(f: Fetch, symbol: string): Promise<number | null> {
  const s = PRICE_SOURCES[symbol];
  try {
    if (s?.binance) {
      const r = await f(`https://data-api.binance.vision/api/v3/ticker/price?symbol=${s.binance}`);
      const p = Number((await r.json())?.price);
      return r.ok && p > 0 ? p : null;
    }
    if (s?.futures) {
      try {
        const [r, factor] = await Promise.all([
          f(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${s.futures}`),
          fetchSpotUsdFactor(f, s.futures),
        ]);
        const p = r.ok ? Number((await r.json())?.price) : NaN;
        if (p > 0) return factor ? p * factor : p;
      } catch { /* blocked from this region: Yahoo below */ }
    }
    if (s?.yahoo) {
      const r = await f(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s.yahoo)}?interval=1m&range=1d`,
        { headers: { "user-agent": "Mozilla/5.0" } });
      const p = Number((await r.json())?.chart?.result?.[0]?.meta?.regularMarketPrice);
      return r.ok && p > 0 ? p : null;
    }
  } catch { /* one source down must not stop the others */ }
  return null;
}

async function rpc(db: Db, fn: string, args: Record<string, unknown> = {}) {
  const { data, error } = await db.rpc(fn, args);
  if (error) throw new HttpError(500, "DB_ERROR", `${fn}: ${error.message}`);
  return data;
}

export async function marketCron(req: Request, deps: CronDeps) {
  if (req.method !== "POST") throw new HttpError(405, "METHOD_NOT_ALLOWED");
  const secret = req.headers.get("x-qt-cron") ?? "";
  if (!/^[0-9a-f]{64}$/.test(secret) || !(await rpc(deps.db, "cron_secret_ok", { p_secret: secret }))) {
    throw new HttpError(401, "CRON_SECRET_INVALID");
  }
  const out: Record<string, unknown> = {};

  // 1. alerts
  const symbols = ((await rpc(deps.db, "alert_symbols")) as string[] | null) ?? [];
  const prices: Record<string, number> = {};
  await Promise.all(symbols.map(async (s) => { const p = await lastPrice(deps.fetch, s); if (p != null) prices[s] = p; }));
  const messages = ((await rpc(deps.db, "check_alerts", { p_prices: prices })) as { chat_id: string; text: string }[] | null) ?? [];
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
  out.alerts = { symbols: symbols.length, priced: Object.keys(prices).length, telegram: messages.length, sent };

  // 2. calendar
  if (await rpc(deps.db, "calendar_due")) {
    try {
      const r = await deps.fetch(CALENDAR_URL);
      const rows = parseCalendar(r.ok ? await r.json() : []);
      out.calendar = rows.length ? await rpc(deps.db, "upsert_econ_events", { p: rows }) : 0;
    } catch (e) {
      out.calendar = `error: ${(e as Error).message}`;
    }
  }
  return json(200, out);
}
