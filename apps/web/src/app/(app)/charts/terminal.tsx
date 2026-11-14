"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SYMBOLS, TIMEFRAMES, quoteFromDaily, binanceInterval, tfSeconds } from "@qt/shared/market";
import { INDICATORS, BY_ID, defaults } from "@qt/core/indicators";
import { createClient } from "@/lib/supabase/client";
import { PriceChart, type ActiveIndicator, type Bar, type PriceLineSpec, type TimedMarker, type Tool } from "./price-chart";
import { SHAPE_LABEL, type ChartEvent, type Shape, type ShapeKind } from "./chart-overlay";
import type { TradesResponse } from "@/app/api/trades/route";
import type { CalendarEvent } from "@/app/api/calendar/route";

export type Overlays = { trades: boolean; events: boolean };
export type LayoutState = { symbol: string; tf: string; indicators: ActiveIndicator[]; overlays: Overlays };
export type SymbolDrawings = { id: string; hlines: number[]; shapes: Shape[] };
export type PriceAlert = { id: string; symbol: string; price: number; op: "above" | "below" };
type Initial = {
  layout: LayoutState; layoutId: string | null;
  watchlist: string[]; watchlistId: string | null;
  drawings: Record<string, SymbolDrawings>;
  alerts: PriceAlert[];
};
type BarsResponse = { bars: Bar[]; source: string; realtime: boolean; note?: string; error?: string };

// Indicators that need anchors or draw boxes/profiles are left out of the menu.
const SKIP = new Set(["vpvr", "svp", "avwap", "markov", "zigzag", "pivots", "pivotshl"]);
const MENU = INDICATORS.filter((d) => !SKIP.has(d.id) && (d.outputs?.length ?? 0) > 0);
const QUICK = ["ema", "sma", "bb", "vwap", "supertrend", "rsi", "macd", "atr", "volume"];
const TOOLS: { id: Exclude<Tool, null>; icon: string; label: string; hint: string }[] = [
  { id: "hline", icon: "―", label: "Đường ngang", hint: "click 1 lần" },
  { id: "trend", icon: "╱", label: "Xu hướng", hint: "click 2 điểm" },
  { id: "ray", icon: "↗", label: "Tia", hint: "click 2 điểm, kéo dài sang phải" },
  { id: "rect", icon: "▭", label: "Vùng", hint: "click 2 góc" },
  { id: "fib", icon: "𝑓", label: "Fibonacci", hint: "click đáy rồi đỉnh (hoặc ngược lại)" },
];
const COLORS = { up: "#00c087", down: "#f45b69", muted: "#8292a8", accent: "#4f8cff" };
const uid = () => Math.random().toString(36).slice(2, 9);
const fmt = (v: number, d: number) => v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
async function fetchJson<T>(url: string, fallback: T): Promise<T> {
  try {
    const r = await fetch(url);
    return r.ok ? ((await r.json()) as T) : fallback;
  } catch { return fallback; }
}
async function fetchBars(symbol: string, tf: string, limit: number): Promise<BarsResponse> {
  try {
    const r = await fetch(`/api/bars?symbol=${symbol}&tf=${tf}&limit=${limit}`);
    const j: BarsResponse = await r.json();
    return r.ok ? j : { bars: [], source: "", realtime: false, error: j.error ?? `HTTP ${r.status}` };
  } catch (e) {
    return { bars: [], source: "", realtime: false, error: (e as Error).message };
  }
}
const paramText = (ind: ActiveIndicator) =>
  Object.entries(ind.params).filter(([, v]) => typeof v === "number").map(([, v]) => v).join(", ");
const countdown = (ms: number) => {
  const m = Math.max(0, Math.floor(ms / 60_000));
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  return d ? `${d}n ${h}g` : h ? `${h}g ${mm}p` : `${mm}p`;
};
const NO_TRADES: TradesResponse = { trades: [], positions: [] };

export function ChartTerminal({ initial, signedIn }: { initial: Initial; signedIn: boolean }) {
  const [symbol, setSymbol] = useState(initial.layout.symbol);
  const [tf, setTf] = useState(initial.layout.tf);
  const [indicators, setIndicators] = useState<ActiveIndicator[]>(initial.layout.indicators);
  const [overlays, setOverlays] = useState<Overlays>(initial.layout.overlays);
  const [watchlist, setWatchlist] = useState(initial.watchlist);
  const [drawings, setDrawings] = useState(initial.drawings);
  const [alerts, setAlerts] = useState(initial.alerts);
  const [data, setData] = useState<BarsResponse | null>(null);
  const [loadedKey, setLoadedKey] = useState("");
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [tool, setTool] = useState<Tool>(null);
  const [menu, setMenu] = useState(false);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [quotes, setQuotes] = useState<Record<string, ReturnType<typeof quoteFromDaily>>>({});
  const [saveState, setSaveState] = useState<"" | "saving" | "saved" | "error">("");
  const [trades, setTrades] = useState<TradesResponse>(NO_TRADES);
  const [calendar, setCalendar] = useState<CalendarEvent[]>([]);
  const [clock, setClock] = useState(0);
  const [notice, setNotice] = useState("");
  const info = SYMBOLS[symbol];
  const supabase = useMemo(() => (signedIn ? createClient() : null), [signedIn]);
  const ids = useRef({ layout: initial.layoutId, watchlist: initial.watchlistId });

  // ---------- bars: load, then keep fresh ----------
  const tfInfo = TIMEFRAMES.find((t) => t.tf === tf) ?? TIMEFRAMES[3];
  const key = `${symbol}:${tf}`;
  const loading = loadedKey !== key;
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

  // Crypto: Binance kline stream in the browser (no server cost). Others: poll the cached API.
  useEffect(() => {
    if (!data?.source.startsWith("Binance") || !info.binance) {
      let cancel = () => {};
      const t = setInterval(() => { cancel = load(true); }, 30_000);
      return () => { clearInterval(t); cancel(); };
    }
    const ws = new WebSocket(`wss://data-stream.binance.vision/ws/${info.binance.toLowerCase()}@kline_${binanceInterval(tf)}`);
    let pending: Bar | null = null;
    ws.onmessage = (ev) => {
      const k = JSON.parse(ev.data).k;
      if (k) pending = { time: k.t / 1000, open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v };
    };
    // apply at most once a second: indicators are recomputed on every update
    const t = setInterval(() => {
      if (!pending) return;
      const bar = pending; pending = null;
      setData((d) => {
        if (!d || !d.bars.length) return d;
        const last = d.bars[d.bars.length - 1];
        if (bar.time < last.time) return d;
        const bars = bar.time === last.time ? [...d.bars.slice(0, -1), bar] : [...d.bars.slice(1), bar];
        return { ...d, bars };
      });
      setUpdatedAt(Date.now());
    }, 1000);
    return () => { clearInterval(t); ws.close(); };
  }, [data?.source, info.binance, tf, load]);

  // ---------- copy-trade activity and economic calendar for this symbol ----------
  useEffect(() => {
    if (!signedIn) return;
    let alive = true;
    const run = () => fetchJson(`/api/trades?symbol=${symbol}&days=14`, NO_TRADES).then((r) => { if (alive) setTrades(r); });
    run();
    const t = setInterval(run, 30_000);
    return () => { alive = false; clearInterval(t); };
  }, [symbol, signedIn]);
  useEffect(() => {
    let alive = true;
    const run = () => fetchJson<{ events: CalendarEvent[] }>(`/api/calendar?symbol=${symbol}`, { events: [] }).then((r) => { if (alive) setCalendar(r.events); });
    run();
    const t = setInterval(run, 10 * 60_000);
    return () => { alive = false; clearInterval(t); };
  }, [symbol]);
  useEffect(() => {
    const tick = () => setClock(Date.now());
    const t = setInterval(tick, 15_000);
    const first = setTimeout(tick, 0);
    return () => { clearInterval(t); clearTimeout(first); };
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setTool(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ---------- watchlist quotes ----------
  useEffect(() => {
    let alive = true;
    const run = () => Promise.all(watchlist.map(async (s) => {
      try {
        const r = await fetch(`/api/bars?symbol=${s}&tf=1D&limit=2`);
        const j: BarsResponse = await r.json();
        return [s, r.ok ? quoteFromDaily(j.bars) : null] as const;
      } catch { return [s, null] as const; }
    })).then((rows) => { if (alive) setQuotes(Object.fromEntries(rows)); });
    run();
    const t = setInterval(run, 60_000);
    return () => { alive = false; clearInterval(t); };
  }, [watchlist]);

  // ---------- persistence (signed-in users; RLS keeps rows per user) ----------
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) { firstRender.current = false; return; }
    if (!supabase) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      setSaveState("saving");
      const state = { symbol, tf, indicators, overlays };
      const { data: auth } = await supabase.auth.getUser();
      if (!auth.user) return setSaveState("error");
      const res = ids.current.layout
        ? await supabase.from("layouts").update({ state, updated_at: new Date().toISOString() }).eq("id", ids.current.layout)
        : await supabase.from("layouts").insert({ user_id: auth.user.id, name: "default", state }).select("id").single();
      if (!ids.current.layout && res.data && "id" in res.data) ids.current.layout = res.data.id as string;
      setSaveState(res.error ? "error" : "saved");
    }, 800);
  }, [symbol, tf, indicators, overlays, supabase]);

  const saveWatchlist = async (list: string[]) => {
    setWatchlist(list);
    if (!supabase) return;
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) return;
    if (ids.current.watchlist) await supabase.from("watchlists").update({ symbols: list }).eq("id", ids.current.watchlist);
    else {
      const { data: row } = await supabase.from("watchlists").insert({ user_id: auth.user.id, name: "Mặc định", symbols: list }).select("id").single();
      if (row) ids.current.watchlist = row.id;
    }
  };

  // ---------- drawings: horizontal lines and shapes, one row per symbol ----------
  const mine = drawings[symbol];
  const hlinePrices = useMemo(() => mine?.hlines ?? [], [mine]);
  const shapes = useMemo(() => mine?.shapes ?? [], [mine]);
  const saveDrawing = async (next: { hlines: number[]; shapes: Shape[] }) => {
    const current = drawings[symbol];
    setDrawings((d) => ({ ...d, [symbol]: { id: current?.id ?? "", ...next } }));
    if (!supabase) return;
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) return;
    const payload = { data: next, updated_at: new Date().toISOString() };
    if (current?.id) await supabase.from("drawings").update(payload).eq("id", current.id);
    else {
      const { data: row } = await supabase.from("drawings").insert({ user_id: auth.user.id, symbol, ...payload }).select("id").single();
      if (row) setDrawings((d) => ({ ...d, [symbol]: { id: row.id, ...next } }));
    }
  };
  const addLine = (price: number) => {
    const p = Number(price.toFixed(info.digits));
    void saveDrawing({ hlines: [...hlinePrices, p].sort((a, b) => b - a), shapes });
    setTool(null);
  };
  const addShape = (s: Shape) => {
    const round = (x: number) => Number(x.toFixed(info.digits));
    void saveDrawing({ hlines: hlinePrices, shapes: [...shapes, { ...s, a: { ...s.a, p: round(s.a.p) }, b: { ...s.b, p: round(s.b.p) } }] });
    setTool(null);
  };

  // ---------- price alerts on horizontal lines (checked by the server every minute) ----------
  const alertAt = (price: number) => alerts.find((a) => a.symbol === symbol && Math.abs(a.price - price) < 1e-9);
  const removeLine = async (price: number) => {
    const a = alertAt(price);
    if (a && supabase) { await supabase.from("alerts").delete().eq("id", a.id); setAlerts((xs) => xs.filter((x) => x.id !== a.id)); }
    void saveDrawing({ hlines: hlinePrices.filter((x) => x !== price), shapes });
  };
  const toggleAlert = async (price: number) => {
    if (!supabase) return setNotice("Đăng nhập để đặt cảnh báo.");
    const a = alertAt(price);
    if (a) {
      await supabase.from("alerts").delete().eq("id", a.id);
      setAlerts((xs) => xs.filter((x) => x.id !== a.id));
      return setNotice("");
    }
    const cur = data?.bars[data.bars.length - 1]?.close;
    if (!cur) return;
    const op = price >= cur ? "above" : "below";
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) return;
    const { data: row, error } = await supabase.from("alerts").insert({
      user_id: auth.user.id, symbol, name: `Đường giá ${fmt(price, info.digits)}`,
      rule: { kind: "price", op, price }, last_price: cur, channels: ["web", "telegram"],
    }).select("id").single();
    if (error || !row) return setNotice(`Không đặt được cảnh báo: ${error?.message ?? ""}`);
    setAlerts((xs) => [...xs, { id: row.id, symbol, price, op }]);
    setNotice(`🔔 Sẽ báo khi ${symbol} ${op === "above" ? "vượt lên" : "xuống dưới"} ${fmt(price, info.digits)} (kiểm tra mỗi phút, báo một lần).`);
  };

  // ---------- indicators ----------
  const addIndicator = (id: string) => {
    setIndicators((xs) => [...xs, { uid: uid(), id, params: defaults(id) }]);
    setMenu(false); setQuery("");
  };
  const setParam = (u: string, key: string, value: unknown) =>
    setIndicators((xs) => xs.map((x) => (x.uid === u ? { ...x, params: { ...x.params, [key]: value } } : x)));

  // ---------- what the chart draws ----------
  const hlines = useMemo(() => hlinePrices.map((price) => ({
    price, alert: alerts.some((a) => a.symbol === symbol && Math.abs(a.price - price) < 1e-9),
  })), [hlinePrices, alerts, symbol]);
  const tradeMarkers = useMemo<TimedMarker[]>(() => !overlays.trades ? [] : trades.trades.flatMap((t): TimedMarker[] => {
    if (t.kind === "open") {
      const c = t.copied;
      const copy = c ? ` · copy ${c.done}/${c.total}${c.latencyMs != null ? ` ${c.latencyMs}ms` : ""}${c.failed ? ` ✗${c.failed}` : ""}` : "";
      const buy = t.side === "BUY";
      return [{ time: t.time, position: buy ? "belowBar" : "aboveBar", shape: buy ? "arrowUp" : "arrowDown",
        color: c?.failed ? COLORS.down : buy ? COLORS.up : COLORS.down, text: `${t.side} ${t.volume ?? ""}${copy}` }];
    }
    if (t.kind === "close") return [{ time: t.time, position: "aboveBar", shape: "circle", color: COLORS.muted, text: `Đóng #${t.ticket}` }];
    if (t.kind === "partial") return [{ time: t.time, position: "aboveBar", shape: "circle", color: COLORS.muted, text: `Đóng ${t.volume} #${t.ticket}` }];
    return [{ time: t.time, position: "inBar", shape: "square", color: COLORS.accent, text: "SL/TP" }];
  }), [trades.trades, overlays.trades]);
  const tradeLines = useMemo<PriceLineSpec[]>(() => !overlays.trades ? [] : trades.positions.flatMap((p) => [
    { price: p.price, color: p.side === "BUY" ? COLORS.up : COLORS.down, title: `${p.master} ${p.side} ${p.volume}`, dashed: true },
    ...(p.sl ? [{ price: p.sl, color: COLORS.down, title: `SL #${p.ticket}` }] : []),
    ...(p.tp ? [{ price: p.tp, color: COLORS.up, title: `TP #${p.ticket}` }] : []),
  ]), [trades.positions, overlays.trades]);
  const events = useMemo<ChartEvent[]>(() => !overlays.events ? [] : calendar.map((e) => ({ time: e.time, title: e.title, country: e.country, impact: e.impact })), [calendar, overlays.events]);
  const nextHigh = clock ? calendar.find((e) => e.impact === "high" && e.time * 1000 > clock) : undefined;
  const recent = clock ? calendar.filter((e) => e.time * 1000 <= clock && e.time * 1000 > clock - 6 * 3600_000 && e.impact === "high") : [];

  const bars = data?.bars ?? [];
  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  const chg = last && prev ? ((last.close - prev.close) / prev.close) * 100 : null;
  const filtered = MENU.filter((d) => !query || d.name.toLowerCase().includes(query.toLowerCase()) || d.id.includes(query.toLowerCase()));
  const notInList = Object.keys(SYMBOLS).filter((s) => !watchlist.includes(s));
  const activeTool = TOOLS.find((t) => t.id === tool);

  return (
    <div className="-m-4 flex min-h-[calc(100vh-7rem)] flex-col lg:-m-6 lg:flex-row">
      {/* Watchlist */}
      <aside className="border-b border-border bg-panel lg:w-60 lg:border-b-0 lg:border-r">
        <div className="flex items-center justify-between px-3 py-2 text-xs text-muted">
          <span>Watchlist</span>
          {notInList.length > 0 && (
            <select aria-label="Thêm symbol" value="" onChange={(e) => e.target.value && saveWatchlist([...watchlist, e.target.value])} className="w-24 py-0.5 text-xs">
              <option value="">+ Thêm</option>
              {notInList.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          )}
        </div>
        <ul className="flex overflow-x-auto lg:block">
          {watchlist.map((s) => {
            const q = quotes[s];
            const active = s === symbol;
            return (
              <li key={s} className="group relative shrink-0">
                <button onClick={() => { setSymbol(s); setTool(null); }}
                  className={`flex w-44 items-center justify-between gap-2 px-3 py-2 text-left text-sm lg:w-full ${active ? "bg-accent/15" : "hover:bg-panel-2"}`}>
                  <span>
                    <span className="block font-medium">{s}</span>
                    <span className="block text-xs text-muted">{SYMBOLS[s]?.name}</span>
                  </span>
                  <span className="text-right font-mono text-xs">
                    <span className="block">{q ? fmt(q.price, SYMBOLS[s].digits) : "…"}</span>
                    {q && <span className={q.changePct >= 0 ? "text-up" : "text-down"}>{q.changePct >= 0 ? "+" : ""}{q.changePct.toFixed(2)}%</span>}
                  </span>
                </button>
                {watchlist.length > 1 && (
                  <button onClick={() => saveWatchlist(watchlist.filter((x) => x !== s))} title="Bỏ khỏi watchlist"
                    className="absolute right-0 top-0 hidden px-1 text-xs text-muted hover:text-down group-hover:block">×</button>
                )}
              </li>
            );
          })}
        </ul>
      </aside>

      {/* Chart area */}
      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
          <div className="mr-2">
            <span className="text-base font-semibold">{symbol}</span>
            {last && (
              <span className="ml-2 font-mono text-sm">
                {fmt(last.close, info.digits)}{" "}
                {chg != null && <span className={chg >= 0 ? "text-up" : "text-down"}>{chg >= 0 ? "+" : ""}{chg.toFixed(2)}%</span>}
              </span>
            )}
          </div>
          <div className="flex rounded-md border border-border">
            {TIMEFRAMES.map((t) => (
              <button key={t.tf} onClick={() => setTf(t.tf)}
                className={`px-2 py-1 text-xs ${t.tf === tf ? "bg-accent text-white" : "text-muted hover:text-foreground"}`}>{t.label}</button>
            ))}
          </div>
          <div className="relative">
            <button onClick={() => setMenu((m) => !m)} className="rounded-md border border-border px-2 py-1 text-xs hover:bg-panel-2">ƒx Chỉ báo</button>
            {menu && (
              <div className="absolute left-0 z-20 mt-1 w-72 rounded-md border border-border bg-panel p-2 shadow-xl">
                <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Tìm chỉ báo…" className="mb-2 w-full" />
                {!query && (
                  <div className="mb-2 flex flex-wrap gap-1">
                    {QUICK.map((id) => (
                      <button key={id} onClick={() => addIndicator(id)} className="rounded bg-panel-2 px-1.5 py-0.5 text-xs hover:bg-accent/20">{id.toUpperCase()}</button>
                    ))}
                  </div>
                )}
                <ul className="max-h-72 overflow-y-auto text-sm">
                  {filtered.map((d) => (
                    <li key={d.id}>
                      <button onClick={() => addIndicator(d.id)} className="flex w-full justify-between rounded px-2 py-1 text-left hover:bg-panel-2">
                        <span>{d.name}</span><span className="text-xs text-muted">{d.overlay ? "trên giá" : "pane riêng"}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
          <div className="flex rounded-md border border-border" role="group" aria-label="Công cụ vẽ">
            {TOOLS.map((t) => (
              <button key={t.id} onClick={() => setTool((x) => (x === t.id ? null : t.id))} title={`${t.label}: ${t.hint}`}
                className={`px-2 py-1 text-xs ${tool === t.id ? "bg-warn/20 text-warn" : "text-muted hover:text-foreground"}`}>{t.icon}</button>
            ))}
          </div>
          <div className="flex rounded-md border border-border text-xs">
            {signedIn && (
              <button onClick={() => setOverlays((o) => ({ ...o, trades: !o.trades }))} title="Lệnh của Master và kết quả copy"
                className={`px-2 py-1 ${overlays.trades ? "text-foreground" : "text-muted line-through"}`}>⇅ Lệnh copy</button>
            )}
            <button onClick={() => setOverlays((o) => ({ ...o, events: !o.events }))} title="Tin kinh tế ảnh hưởng mạnh/trung bình"
              className={`px-2 py-1 ${overlays.events ? "text-foreground" : "text-muted line-through"}`}>📅 Tin</button>
          </div>
          {nextHigh && clock > 0 && (
            <span className={`rounded border px-1.5 py-0.5 text-xs ${nextHigh.time * 1000 - clock < 3600_000 ? "border-down/50 text-down" : "border-border text-muted"}`}
              title={`Dự báo ${nextHigh.forecast ?? "—"} · Trước ${nextHigh.previous ?? "—"}`}>
              ⏱ {nextHigh.country} {nextHigh.title} · còn {countdown(nextHigh.time * 1000 - clock)}
            </span>
          )}
          <span className="ml-auto text-xs text-muted">
            {!signedIn ? "Đăng nhập để lưu layout" : saveState === "saving" ? "Đang lưu…" : saveState === "saved" ? "Đã lưu" : saveState === "error" ? "Lưu lỗi" : ""}
          </span>
        </div>

        {/* active indicators, drawings, alerts */}
        {(indicators.length > 0 || hlines.length > 0 || shapes.length > 0 || activeTool || notice || recent.length > 0) && (
          <div className="flex flex-wrap gap-1.5 border-b border-border px-3 py-1.5 text-xs">
            {activeTool && (
              <span className="rounded border border-warn/50 bg-warn/10 px-1.5 py-0.5 text-warn">
                {activeTool.label}: {activeTool.hint} · Esc để huỷ
              </span>
            )}
            {indicators.map((ind) => {
              const def = BY_ID[ind.id];
              const editable = (def?.inputs ?? []).filter((i) => ["int", "float", "select", "source"].includes(i.type));
              return (
                <span key={ind.uid} className="relative inline-flex items-center gap-1 rounded border border-border bg-panel-2 px-1.5 py-0.5">
                  <button onClick={() => setEditing(editing === ind.uid ? null : ind.uid)} title="Sửa tham số">
                    {def?.name.replace(/\s*\(.*\)$/, "") ?? ind.id}{paramText(ind) && <span className="text-muted"> ({paramText(ind)})</span>}
                  </button>
                  <button onClick={() => setIndicators((xs) => xs.filter((x) => x.uid !== ind.uid))} className="text-muted hover:text-down" title="Xoá">×</button>
                  {editing === ind.uid && editable.length > 0 && (
                    <div className="absolute left-0 top-full z-20 mt-1 grid w-56 gap-2 rounded-md border border-border bg-panel p-2 shadow-xl">
                      {editable.map((inp) => (
                        <label key={inp.key} className="grid gap-0.5">
                          <span className="text-muted">{inp.label}</span>
                          {inp.type === "select" || inp.type === "source" ? (
                            <select value={String(ind.params[inp.key])} onChange={(e) => setParam(ind.uid, inp.key, e.target.value)}>
                              {(inp.options ?? ["close", "open", "high", "low", "hl2", "hlc3", "ohlc4"]).map((o) => <option key={o}>{o}</option>)}
                            </select>
                          ) : (
                            <input type="number" step={inp.type === "int" ? 1 : "any"} min={inp.min} max={inp.max}
                              defaultValue={String(ind.params[inp.key])}
                              onBlur={(e) => { const v = Number(e.target.value); if (Number.isFinite(v)) setParam(ind.uid, inp.key, inp.type === "int" ? Math.round(v) : v); }} />
                          )}
                        </label>
                      ))}
                      <button onClick={() => setEditing(null)} className="rounded bg-accent px-2 py-1 text-white">Xong</button>
                    </div>
                  )}
                </span>
              );
            })}
            {hlines.map((h) => (
              <span key={h.price} className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 ${h.alert ? "border-accent/50 text-accent" : "border-warn/40 text-warn"}`}>
                ― {fmt(h.price, info.digits)}
                <button onClick={() => toggleAlert(h.price)} title={h.alert ? "Tắt cảnh báo" : "Báo khi giá chạm đường này"}
                  className={h.alert ? "" : "opacity-50 hover:opacity-100"}>🔔</button>
                <button onClick={() => removeLine(h.price)} className="hover:text-down" title="Xoá đường">×</button>
              </span>
            ))}
            {shapes.map((s) => (
              <span key={s.id} className="inline-flex items-center gap-1 rounded border border-accent/40 px-1.5 py-0.5 text-accent">
                {TOOLS.find((t) => t.id === s.kind)?.icon} {SHAPE_LABEL[s.kind as ShapeKind]}
                <button onClick={() => saveDrawing({ hlines: hlinePrices, shapes: shapes.filter((x) => x.id !== s.id) })} className="hover:text-down" title="Xoá">×</button>
              </span>
            ))}
            {recent.map((e) => (
              <span key={`${e.country}${e.title}${e.time}`} className="rounded border border-down/40 px-1.5 py-0.5 text-down" title="Tin mạnh trong 6 giờ qua">
                📰 {e.country} {e.title}: thực tế {e.actual ?? "—"} / dự báo {e.forecast ?? "—"}
              </span>
            ))}
            {notice && <span className="text-muted">{notice}</span>}
          </div>
        )}

        <div className="relative h-[65vh] min-h-[420px] lg:h-auto lg:flex-1">
          <PriceChart bars={bars} digits={info.digits} barSeconds={tfSeconds(tf)} indicators={indicators}
            hlines={hlines} shapes={shapes} events={events} tradeMarkers={tradeMarkers} tradeLines={tradeLines}
            tool={tool} onAddLine={addLine} onAddShape={addShape} viewKey={key} />
          {loading && <div className="absolute inset-0 grid place-items-center bg-background/60 text-sm text-muted">Đang tải {symbol}…</div>}
          {!loading && data?.error && (
            <div className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-down">{data.error}</div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border px-3 py-1.5 text-xs text-muted">
          {data?.source && (
            <span className={`rounded border px-1.5 py-0.5 ${data.realtime ? "border-up/40 text-up" : "border-warn/40 text-warn"}`}>
              {data.realtime ? "● Realtime" : "▲ Trễ / tham khảo"}
            </span>
          )}
          {data?.source && <span>Nguồn: {data.source}</span>}
          {updatedAt && <span>Cập nhật {new Date(updatedAt).toLocaleTimeString("vi-VN")}</span>}
          {data?.note && <span className="text-warn">{data.note}</span>}
          {overlays.trades && signedIn && (trades.trades.length > 0 || trades.positions.length > 0) && (
            <span>Lệnh copy 14 ngày: {trades.trades.filter((t) => t.kind === "open").length} lệnh mở · {trades.positions.length} vị thế đang mở</span>
          )}
          {info.broker && !data?.source.startsWith("Giá broker") && <span>Khi EA master gửi nến M1, biểu đồ chuyển sang giá broker.</span>}
        </div>
      </section>
    </div>
  );
}
