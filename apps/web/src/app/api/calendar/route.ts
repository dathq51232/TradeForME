import { NextResponse, type NextRequest } from "next/server";
import { SYMBOLS } from "@qt/shared/market";
import { createClient } from "@/lib/supabase/server";

// GET /api/calendar?symbol=XAUUSD — medium/high-impact economic releases from 14 days ago to 8 days ahead
// that usually move this market. Reads econ_events (kept up to date by the Edge Function market-cron);
// until that has run, reads the weekly public feed directly.

export type CalendarEvent = {
  time: number; title: string; country: string; impact: "high" | "medium";
  forecast: string | null; previous: string | null; actual: string | null;
};

// Same rule as supabase/functions/_shared/market-cron.ts: USD releases move every charted market.
const MOVES: Record<string, string[]> = {
  USD: Object.keys(SYMBOLS), CNY: ["WTI", "BRENT", "XAUUSD"], EUR: ["DXY"], JPY: ["DXY"], GBP: ["DXY"],
};
const FEED = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";

async function fromFeed(): Promise<CalendarEvent[]> {
  const r = await fetch(FEED, { next: { revalidate: 1800 } });
  if (!r.ok) return [];
  const rows = (await r.json()) as { title?: string; country?: string; date?: string; impact?: string; forecast?: string; previous?: string; actual?: string }[];
  return rows.flatMap((e) => {
    const t = Date.parse(e.date ?? "");
    if (!e.title || !e.country || !Number.isFinite(t) || (e.impact !== "High" && e.impact !== "Medium")) return [];
    return [{ time: t / 1000, title: e.title, country: e.country, impact: e.impact === "High" ? "high" : "medium",
      forecast: e.forecast || null, previous: e.previous || null, actual: e.actual || null } as CalendarEvent];
  });
}

export async function GET(req: NextRequest) {
  const symbol = (req.nextUrl.searchParams.get("symbol") ?? "").toUpperCase();
  if (!SYMBOLS[symbol]) return NextResponse.json({ error: "symbol" }, { status: 400 });
  const now = Date.now();
  const supabase = await createClient();
  const { data } = await supabase.from("econ_events")
    .select("country, title, scheduled_at, importance, forecast_text, previous_text, actual_text")
    .gte("scheduled_at", new Date(now - 14 * 86_400_000).toISOString())
    .lte("scheduled_at", new Date(now + 8 * 86_400_000).toISOString())
    .gte("importance", 2).order("scheduled_at").limit(500);
  let events: CalendarEvent[] = (data ?? []).map((e) => ({
    time: Date.parse(e.scheduled_at) / 1000, title: e.title, country: e.country, impact: e.importance === 3 ? "high" : "medium",
    forecast: e.forecast_text, previous: e.previous_text, actual: e.actual_text,
  }));
  if (!events.length) {
    try { events = await fromFeed(); } catch { events = []; }
  }
  events = events.filter((e) => MOVES[e.country]?.includes(symbol));
  return NextResponse.json({ events }, { headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=1800" } });
}
