import { NextResponse, type NextRequest } from "next/server";
import { SYMBOLS, chartSymbol } from "@qt/shared/market";
import { createClient } from "@/lib/supabase/server";

// GET /api/trades?symbol=XAUUSD&days=7 — the signed-in user's copy-trade activity on one chart symbol:
// master opens/closes/SL-TP changes, how each was copied, and the master's open positions (latest snapshot).
// RLS limits rows to masters the user owns or receives from.

export type ChartTrade = {
  time: number; kind: "open" | "close" | "partial" | "modify"; master: string; ticket: number;
  side?: "BUY" | "SELL"; price?: number; volume?: number; sl?: number; tp?: number;
  copied?: { done: number; total: number; failed: number; latencyMs: number | null };
};
export type ChartPosition = { master: string; ticket: number; side: "BUY" | "SELL"; volume: number; price: number; sl?: number; tp?: number };
export type TradesResponse = { trades: ChartTrade[]; positions: ChartPosition[] };

type Payload = { symbol?: string; side?: "BUY" | "SELL"; price?: number; volume?: number; sl?: number; tp?: number; master_ticket?: number; ts_ms?: number; positions?: Payload[] };
const KIND: Record<string, ChartTrade["kind"]> = { OPEN: "open", CLOSE: "close", PARTIAL_CLOSE: "partial", MODIFY: "modify" };

export async function GET(req: NextRequest) {
  const symbol = (req.nextUrl.searchParams.get("symbol") ?? "").toUpperCase();
  const days = Math.min(Math.max(Number(req.nextUrl.searchParams.get("days")) || 7, 1), 60);
  if (!SYMBOLS[symbol]) return NextResponse.json({ error: "symbol" }, { status: 400 });
  const empty: TradesResponse = { trades: [], positions: [] };
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  if (!claims?.claims?.sub) return NextResponse.json(empty);

  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const { data: events, error } = await supabase.from("ct_events")
    .select("master_id, seq, type, payload, master_ts, received_at")
    .in("type", ["OPEN", "CLOSE", "PARTIAL_CLOSE", "MODIFY", "SNAPSHOT"])
    .gte("received_at", since).order("received_at").limit(3000);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!events?.length) return NextResponse.json(empty);

  const masterIds = [...new Set(events.map((e) => e.master_id as string))];
  const [{ data: accounts }, { data: execs }] = await Promise.all([
    supabase.from("mt5_accounts").select("id, label").in("id", masterIds),
    supabase.from("ct_executions").select("master_id, seq, status, latency_ms").in("master_id", masterIds).gte("created_at", since).limit(10000),
  ]);
  const label = new Map((accounts ?? []).map((a) => [a.id as string, a.label as string]));
  const byEvent = new Map<string, { done: number; total: number; failed: number; lat: number[] }>();
  for (const x of execs ?? []) {
    const k = `${x.master_id}:${x.seq}`;
    const c = byEvent.get(k) ?? { done: 0, total: 0, failed: 0, lat: [] };
    c.total++;
    if (x.status === "done") { c.done++; if (typeof x.latency_ms === "number") c.lat.push(x.latency_ms); }
    if (x.status === "failed") c.failed++;
    byEvent.set(k, c);
  }

  const trades: ChartTrade[] = [];
  const lastSnapshot = new Map<string, Payload[]>();
  for (const e of events) {
    const p = (e.payload ?? {}) as Payload;
    const master = label.get(e.master_id) ?? "Master";
    if (e.type === "SNAPSHOT") { lastSnapshot.set(e.master_id, Array.isArray(p.positions) ? p.positions : []); continue; }
    if (chartSymbol(p.symbol) !== symbol) continue;
    const ms = p.ts_ms ?? Date.parse(e.master_ts ?? e.received_at);
    const c = byEvent.get(`${e.master_id}:${e.seq}`);
    trades.push({
      time: Math.floor(ms / 1000), kind: KIND[e.type], master, ticket: Number(p.master_ticket ?? 0),
      side: p.side, price: p.price, volume: p.volume, sl: p.sl, tp: p.tp,
      ...(c ? { copied: { done: c.done, total: c.total, failed: c.failed, latencyMs: c.lat.length ? Math.round(c.lat.reduce((a, b) => a + b, 0) / c.lat.length) : null } } : {}),
    });
  }
  const positions: ChartPosition[] = [];
  for (const [id, list] of lastSnapshot) {
    for (const p of list) {
      if (chartSymbol(p.symbol) !== symbol || !p.side || p.price == null) continue;
      positions.push({ master: label.get(id) ?? "Master", ticket: Number(p.master_ticket ?? 0), side: p.side, volume: Number(p.volume ?? 0), price: p.price, sl: p.sl, tp: p.tp });
    }
  }
  return NextResponse.json({ trades, positions } satisfies TradesResponse, { headers: { "Cache-Control": "private, no-store" } });
}
