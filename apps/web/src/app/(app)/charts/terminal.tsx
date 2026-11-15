"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SYMBOLS, TIMEFRAMES, quoteFromDaily, binanceInterval, tfSeconds } from "@qt/shared/market";
import { INDICATORS, BY_ID, defaults } from "@qt/core/indicators";
import { createClient } from "@/lib/supabase/client";
import { PanelToggle } from "@/components/panel-toggle";
import { PatternAlertsButton } from "./pattern-alerts";
import { PriceChart, type ActiveIndicator, type Bar, type ChartHandle, type ChartStyle, type ChartType, type PriceLineSpec, type ScaleMode, type TimedMarker, type Tool } from "./price-chart";
import { CHART_TEMPLATES, NO_AUTO, SHAPE_LABEL, SHAPE_POINTS, bgFamily, isTemplate, type AutoDraw, type ChartEvent, type Shape } from "./chart-overlay";
import { candlestickPatterns, chartPatterns, closeLevels, microWedges, periodCloses, sessionsBetween, sessionStatus } from "@qt/core/patterns";
import type { TradesResponse } from "@/app/api/trades/route";
import type { CalendarEvent } from "@/app/api/calendar/route";

export type Overlays = { trades: boolean; events: boolean };
export type ChartView = { type: ChartType; scale: ScaleMode; magnet: boolean; style: ChartStyle };
/** Automatic chart reading: which layers are on, and pivot strength (bars each side) for chart patterns. */
export type AutoSettings = { chart: boolean; wedges: boolean; candles: boolean; levels: boolean; periods: boolean; sessions: boolean; depth: number };
export type LayoutState = { symbol: string; tf: string; indicators: ActiveIndicator[]; overlays: Overlays; view: ChartView; auto: AutoSettings };
export type SymbolDrawings = { id: string; hlines: number[]; shapes: Shape[] };
export type PriceAlert = { id: string; symbol: string; price: number; op: "above" | "below" };
type Initial = {
  layout: LayoutState; layoutId: string | null;
  watchlist: string[]; watchlistId: string | null;
  drawings: Record<string, SymbolDrawings>;
  alerts: PriceAlert[];
};
type BarsResponse = { bars: Bar[]; source: string; realtime: boolean; note?: string; error?: string };

const NO_INDICATORS: ActiveIndicator[] = [];
// Indicators that need anchors or draw boxes/profiles are left out of the menu.
const SKIP = new Set(["vpvr", "svp", "avwap", "markov", "zigzag", "pivots", "pivotshl"]);
const MENU = INDICATORS.filter((d) => !SKIP.has(d.id) && (d.outputs?.length ?? 0) > 0);
const QUICK = ["ema", "sma", "bb", "vwap", "supertrend", "rsi", "macd", "atr", "volume"];
// Our own glyphs and wording; tools are grouped as lines, shapes, measuring and notes.
const TOOLS: { id: Exclude<Tool, null>; icon: string; label: string; hint: string; group: number }[] = [
  { id: "hline", icon: "―", label: "Đường ngang (đặt được cảnh báo)", hint: "click 1 lần", group: 0 },
  { id: "hray", icon: "→", label: "Tia ngang", hint: "click 1 lần, kéo dài sang phải", group: 0 },
  { id: "vline", icon: "│", label: "Đường dọc", hint: "click 1 lần", group: 0 },
  { id: "trend", icon: "╱", label: "Đường xu hướng", hint: "click 2 điểm", group: 0 },
  { id: "ray", icon: "↗", label: "Tia", hint: "click 2 điểm, kéo dài theo hướng", group: 0 },
  { id: "channel", icon: "▱", label: "Kênh song song", hint: "click 2 điểm cho cạnh đầu, điểm thứ 3 cho độ rộng", group: 1 },
  { id: "rect", icon: "▭", label: "Vùng chữ nhật", hint: "click 2 góc", group: 1 },
  { id: "fib", icon: "𝑓", label: "Fibonacci thoái lui", hint: "click đáy rồi đỉnh (hoặc ngược lại)", group: 1 },
  { id: "measure", icon: "⇕", label: "Đo giá và thời gian", hint: "click điểm đầu và điểm cuối", group: 2 },
  { id: "position", icon: "⚖", label: "Vị thế: vào lệnh, dừng lỗ, chốt lời", hint: "click giá vào, rồi dừng lỗ, rồi chốt lời", group: 2 },
  { id: "text", icon: "T", label: "Ghi chú", hint: "click vị trí rồi nhập nội dung", group: 2 },
];
const CHART_TYPES: { id: ChartType; label: string }[] = [
  { id: "candles", label: "Nến" }, { id: "hollow", label: "Nến rỗng" }, { id: "heikin", label: "Heikin Ashi" },
  { id: "bars", label: "Thanh OHLC" }, { id: "line", label: "Đường" }, { id: "area", label: "Vùng" },
];
const RANGES: { label: string; seconds: number | null }[] = [
  { label: "1N", seconds: 86400 }, { label: "5N", seconds: 5 * 86400 }, { label: "1T", seconds: 30 * 86400 },
  { label: "3T", seconds: 90 * 86400 }, { label: "6T", seconds: 180 * 86400 }, { label: "1Năm", seconds: 365 * 86400 },
  { label: "Tất cả", seconds: null },
];
const HISTORY = 50;
const CANDLE_PRESETS = [
  { label: "Xanh / Đỏ", up: "#00c087", down: "#f45b69" },
  { label: "Trắng / Đen", up: "#ffffff", down: "#000000" },
  { label: "Xanh dương / Cam", up: "#4f8cff", down: "#f5a142" },
  { label: "Xám / Đen", up: "#9aa4b2", down: "#000000" },
];
const AUTO_LAYERS: { key: Exclude<keyof AutoSettings, "depth">; label: string; hint: string }[] = [
  { key: "chart", label: "Mô hình giá", hint: "Tam giác tăng/giảm/cân, tam giác mở rộng (tam giác ngược), nêm, hai đỉnh/hai đáy, vai đầu vai" },
  { key: "wedges", label: "Nêm nhỏ tiếp diễn (báo sớm)", hint: "Sau một nhịp mạnh, giá hồi trong nêm hẹp dần; chấm điểm 0–100 (key level/EMA21, khối lượng, biên độ, RSI) và báo Sẵn sàng trước khi phá" },
  { key: "candles", label: "Mô hình nến", hint: "Búa, sao băng, nhấn chìm, harami, sao mai/sao hôm, ba chàng lính/ba con quạ, nhíp, marubozu…" },
  { key: "levels", label: "Key level theo giá đóng cửa", hint: "Vùng giá nến hay đóng cửa và đảo chiều; nét đậm hơn = mạnh hơn" },
  { key: "periods", label: "Giá đóng cửa ngày/tuần/tháng trước", hint: "Theo lịch UTC" },
  { key: "sessions", label: "Phiên Sydney/Tokyo/London/New York", hint: "Khung cao-thấp của từng phiên (khung ≤ 1H) và giờ mở/đóng phiên" },
];
const DEPTHS = [{ v: 3, label: "Nhạy" }, { v: 5, label: "Vừa" }, { v: 8, label: "Chặt" }];
const STATUS_VI: Record<string, string> = { forming: "đang hình thành", ready: "sẵn sàng phá", breakoutUp: "đã phá lên", breakoutDown: "đã phá xuống", failed: "thất bại", expired: "hết hiệu lực" };

/** Session boxes over the loaded bars: each session's high and low (sessions with no bars are skipped). */
function sessionBoxes(bars: Bar[], step: number): AutoDraw["sessions"] {
  if (!bars.length) return [];
  const to = bars[bars.length - 1].time + step;
  return sessionsBetween(bars[0].time, to).flatMap((s) => {
    let high = -Infinity, low = Infinity;
    for (const b of bars) if (b.time >= s.start && b.time < s.end) { high = Math.max(high, b.high); low = Math.min(low, b.low); }
    return high > low ? [{ name: s.name, color: s.color, start: s.start, end: Math.min(s.end, to), high, low }] : [];
  });
}
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
  const [view, setView] = useState<ChartView>(initial.layout.view);
  const [auto, setAuto] = useState<AutoSettings>(initial.layout.auto);
  const [autoMenu, setAutoMenu] = useState(false);
  const [styleMenu, setStyleMenu] = useState(false);
  const setStyle = (patch: Partial<ChartStyle>) => setView((v) => ({ ...v, style: { ...v.style, ...patch } }));
  const [selected, setSelected] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  // indicators (and pattern drawings) taken off the chart without removing them; remembered on this browser
  const [indHidden, setIndHidden] = useState(false);
  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- read once after mount: storage is not there on the server
      if (window.localStorage.getItem("qt-ind-hidden") === "1") setIndHidden(true);
    } catch { /* storage blocked: start shown */ }
  }, []);
  const toggleIndHidden = () => setIndHidden((h) => {
    try { window.localStorage.setItem("qt-ind-hidden", h ? "0" : "1"); } catch { /* storage blocked: this visit only */ }
    return !h;
  });
  // signal texts (pattern names, "Mục tiêu", candle names, "Vol ×2.9"…) off the chart, arrows and dots kept; remembered on this browser
  const [textHidden, setTextHidden] = useState(false);
  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- read once after mount: storage is not there on the server
      if (window.localStorage.getItem("qt-pattern-text-hidden") === "1") setTextHidden(true);
    } catch { /* storage blocked: start shown */ }
  }, []);
  const toggleTextHidden = () => setTextHidden((h) => {
    try { window.localStorage.setItem("qt-pattern-text-hidden", h ? "0" : "1"); } catch { /* storage blocked: this visit only */ }
    return !h;
  });
  const chartApi = useRef<ChartHandle>(null);
  const shell = useRef<HTMLElement>(null);
  const history = useRef<Record<string, { hlines: number[]; shapes: Shape[] }[]>>({});
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
      const state = { symbol, tf, indicators, overlays, view, auto };
      const { data: auth } = await supabase.auth.getUser();
      if (!auth.user) return setSaveState("error");
      const res = ids.current.layout
        ? await supabase.from("layouts").update({ state, updated_at: new Date().toISOString() }).eq("id", ids.current.layout)
        : await supabase.from("layouts").insert({ user_id: auth.user.id, name: "default", state }).select("id").single();
      if (!ids.current.layout && res.data && "id" in res.data) ids.current.layout = res.data.id as string;
      setSaveState(res.error ? "error" : "saved");
    }, 800);
  }, [symbol, tf, indicators, overlays, view, auto, supabase]);

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
  const alertAt = (price: number) => alerts.find((a) => a.symbol === symbol && Math.abs(a.price - price) < 1e-9);
  const mine = drawings[symbol];
  const hlinePrices = useMemo(() => mine?.hlines ?? [], [mine]);
  const shapes = useMemo(() => mine?.shapes ?? [], [mine]);
  const saveDrawing = async (next: { hlines: number[]; shapes: Shape[] }, undoable = true) => {
    const current = drawings[symbol];
    if (undoable) {
      const h = (history.current[symbol] ??= []);
      h.push({ hlines: current?.hlines ?? [], shapes: current?.shapes ?? [] });
      if (h.length > HISTORY) h.shift();
    }
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
    const r = (pt: { t: number; p: number }) => ({ t: pt.t, p: Number(pt.p.toFixed(info.digits)) });
    void saveDrawing({ hlines: hlinePrices, shapes: [...shapes, { ...s, a: r(s.a), b: r(s.b), ...(s.c ? { c: r(s.c) } : {}) }] });
    setTool(null);
  };
  const removeShape = (id: string) => {
    void saveDrawing({ hlines: hlinePrices, shapes: shapes.filter((x) => x.id !== id) });
    setSelected(null);
  };
  /** A drawing was moved or resized on the chart (undo with Ctrl+Z). */
  const changeShape = (s: Shape) => {
    const r = (pt: { t: number; p: number }) => ({ t: pt.t, p: Number(pt.p.toFixed(info.digits)) });
    const next = { ...s, a: r(s.a), b: r(s.b), ...(s.c ? { c: r(s.c) } : {}) };
    void saveDrawing({ hlines: hlinePrices, shapes: shapes.map((x) => (x.id === s.id ? next : x)) });
  };
  /** Undo the last change to this symbol's drawings. Lines with an armed alert are kept (their alert lives on). */
  const undo = () => {
    const prevState = history.current[symbol]?.pop();
    if (!prevState) return setNotice("Không còn gì để hoàn tác.");
    const armed = hlinePrices.filter((p) => alertAt(p));
    void saveDrawing({ hlines: [...new Set([...prevState.hlines, ...armed])].sort((a, b) => b - a), shapes: prevState.shapes }, false);
    setSelected(null);
  };
  const clearAll = () => {
    if (!shapes.length && !hlinePrices.length) return;
    if (!window.confirm(`Xoá toàn bộ hình vẽ của ${symbol}? Các đường đang có cảnh báo được giữ lại. Có thể hoàn tác bằng Ctrl+Z.`)) return;
    void saveDrawing({ hlines: hlinePrices.filter((p) => alertAt(p)), shapes: [] });
    setSelected(null);
  };

  // keyboard: Esc cancels, Delete removes the selected shape, Ctrl+Z undoes
  const keys = useRef({ undo, removeShape, selected });
  useEffect(() => { keys.current = { undo, removeShape, selected }; });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
      if (e.key === "Escape") { setTool(null); setSelected(null); }
      else if ((e.key === "Delete" || e.key === "Backspace") && keys.current.selected) { e.preventDefault(); keys.current.removeShape(keys.current.selected); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); keys.current.undo(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ---------- snapshot and full screen ----------
  const screenshot = () => {
    const shot = chartApi.current?.screenshot();
    if (!shot) return;
    const out = document.createElement("canvas");
    out.width = shot.width; out.height = shot.height;
    const ctx = out.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(shot, 0, 0);
    const scale = shot.width / Math.max(1, shot.clientWidth || shot.width);
    ctx.font = `${Math.round(12 * (scale || 1))}px system-ui, sans-serif`;
    ctx.fillStyle = "rgba(201,212,227,0.9)";
    ctx.fillText(`${symbol} · ${tfInfo.label} · ${new Date().toLocaleString("vi-VN")}`, 8, shot.height - 10);
    out.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${symbol}_${tf}_${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }, "image/png");
  };
  const fullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void shell.current?.requestFullscreen?.();
  };

  // ---------- price alerts on horizontal lines (checked by the server every minute) ----------
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

  // ---------- automatic chart reading (all in the browser, on the loaded bars) ----------
  const rawBars = data?.bars;
  const step = tfSeconds(tf);
  const found = useMemo(() => {
    const bs = rawBars ?? [];
    const periodLen = { day: 86400, week: 7 * 86400, month: 28 * 86400 };
    return {
      patterns: auto.chart && bs.length ? chartPatterns(bs, { depth: auto.depth, max: 6 }) : [],
      wedges: auto.wedges && bs.length ? microWedges(bs, { max: 3 }) : [],
      // markers only on the latest bars, and without marubozu (a strong bar, not a reversal), to keep the chart readable
      candles: auto.candles && bs.length ? candlestickPatterns(bs).filter((c) => c.i >= bs.length - 80 && !c.kind.endsWith("Marubozu")) : [],
      levels: auto.levels && bs.length ? closeLevels(bs, { max: 6 }) : [],
      periods: auto.periods && bs.length ? periodCloses(bs).filter((p) => step < periodLen[p.period]) : [],
      sessions: auto.sessions && step <= 3600 ? sessionBoxes(bs, step) : [],
    };
  }, [rawBars, auto, step]);
  const autoDraw = useMemo<AutoDraw>(() => {
    if (!found.patterns.length && !found.wedges.length && !found.levels.length && !found.periods.length && !found.sessions.length) return NO_AUTO;
    return {
      // the three newest patterns that still matter; older ones stay listed only while they are recent
      patterns: [
        ...found.wedges.filter((w) => w.stage !== "expired").slice(0, 3).map((w) => ({ ...w, name: `${w.name} ${w.score}đ` })),
        ...found.patterns.filter((p) => p.status !== "expired").slice(0, 3),
      ],
      levels: [
        ...found.levels.map((l) => ({
          price: l.price, from: l.first, color: l.side === "support" ? COLORS.up : COLORS.down, width: 0.5 + l.strength * 0.5, dashed: false,
          label: `Key ${fmt(l.price, info.digits)} · ${l.swings} lần`,
        })),
        ...found.periods.map((p) => ({ price: p.price, from: p.time, color: COLORS.muted, width: 1, dashed: true, label: `${p.label} ${fmt(p.price, info.digits)}` })),
      ],
      sessions: found.sessions,
    };
  }, [found, info.digits]);
  const chartMarkers = useMemo<TimedMarker[]>(() => [
    ...tradeMarkers,
    // candlestick-pattern labels belong to pattern recognition: "Ẩn tất cả" takes them off too
    ...(indHidden ? [] : found.candles).map((c): TimedMarker => ({
      time: c.time, position: c.bias < 0 ? "aboveBar" : "belowBar", shape: c.bias > 0 ? "arrowUp" : c.bias < 0 ? "arrowDown" : "circle",
      color: c.bias > 0 ? COLORS.up : c.bias < 0 ? COLORS.down : COLORS.muted, text: c.name, signal: true,
    })),
  ], [tradeMarkers, found.candles, indHidden]);
  const liveCandle = found.candles.filter((c) => c.i >= bars.length - 3).at(-1);
  const sessionNow = auto.sessions && clock ? sessionStatus(Math.floor(clock / 1000)) : null;
  const patternChips = found.patterns.filter((p) => p.status !== "expired").slice(0, 4);
  const wedgeChips = found.wedges.filter((w) => w.stage !== "expired").slice(0, 3);
  // báo khi nêm nhỏ mới nhất chuyển sang Sẵn sàng / Đã phá (mỗi trạng thái báo một lần)
  const wedgeSeen = useRef(new Set<string>());
  const liveWedge = found.wedges[0];
  const liveKey = liveWedge && (liveWedge.stage === "ready" || liveWedge.stage === "broken") && rawBars?.length
    && liveWedge.end >= rawBars[rawBars.length - 1].time - 3 * step ? `${symbol}${liveWedge.kind}${liveWedge.start}${liveWedge.stage}` : "";
  useEffect(() => {
    if (!liveKey || !liveWedge || wedgeSeen.current.has(liveKey)) return;
    const first = wedgeSeen.current.size === 0 && !document.hasFocus();
    wedgeSeen.current.add(liveKey);
    const text = liveWedge.stage === "ready"
      ? `${liveWedge.name} sẵn sàng phá (${liveWedge.score} điểm)`
      : `${liveWedge.name} đã phá${liveWedge.entry != null ? ` tại ${fmt(liveWedge.entry, info.digits)}` : ""}`;
    setNotice(`🔔 ${symbol}: ${text}`);
    if (!first && typeof Notification !== "undefined" && Notification.permission === "granted") new Notification(`${symbol} · ${text}`);
  }, [liveKey, liveWedge, symbol, info.digits]);

  return (
    <div className="-m-4 flex min-h-[calc(100vh-7rem)] flex-col lg:-m-6 lg:flex-row">
      {/* Watchlist: on the right on wide screens (on top on phones); collapses to a thin strip */}
      <aside className="order-first border-b border-border bg-panel lg:order-last lg:w-60 lg:shrink-0 lg:border-b-0 lg:border-l wl-collapsed:lg:w-10">
        <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted wl-collapsed:lg:justify-center wl-collapsed:lg:px-0">
          <PanelToggle panel="wl" title="Thu gọn / mở rộng watchlist"
            className="rounded px-2 py-1 text-sm leading-none hover:bg-panel-2 hover:text-foreground">
            <span aria-hidden className="wl-collapsed:hidden"><span className="lg:hidden">▴</span><span className="hidden lg:inline">»</span></span>
            <span aria-hidden className="wl-expanded:hidden"><span className="lg:hidden">▾</span><span className="hidden lg:inline">«</span></span>
          </PanelToggle>
          <span className="wl-collapsed:lg:hidden">Watchlist</span>
          {notInList.length > 0 && (
            <select aria-label="Thêm symbol" value="" onChange={(e) => e.target.value && saveWatchlist([...watchlist, e.target.value])} className="ml-auto w-24 py-0.5 text-xs wl-collapsed:hidden">
              <option value="">+ Thêm</option>
              {notInList.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          )}
        </div>
        <ul className="flex overflow-x-auto lg:block wl-collapsed:hidden">
          {watchlist.map((s) => {
            const q = quotes[s];
            const active = s === symbol;
            return (
              <li key={s} className="group relative shrink-0">
                <button onClick={() => { setSymbol(s); setTool(null); setSelected(null); }}
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
      <section ref={shell} className="flex min-w-0 flex-1 flex-col bg-background">
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
          <select aria-label="Kiểu biểu đồ" value={view.type} onChange={(e) => setView((v) => ({ ...v, type: e.target.value as ChartType }))} className="py-0.5 text-xs">
            {CHART_TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
          <div className="flex rounded-md border border-border" role="group" aria-label="Công cụ vẽ">
            {TOOLS.map((t, k) => (
              <button key={t.id} onClick={() => { setSelected(null); setTool((x) => (x === t.id ? null : t.id)); }} title={`${t.label}: ${t.hint}`}
                className={`px-2 py-1 text-xs ${k > 0 && TOOLS[k - 1].group !== t.group ? "border-l border-border" : ""} ${tool === t.id ? "bg-warn/20 text-warn" : "text-muted hover:text-foreground"}`}>{t.icon}</button>
            ))}
          </div>
          <div className="flex rounded-md border border-border text-xs" role="group" aria-label="Quản lý hình vẽ">
            <button onClick={() => setView((v) => ({ ...v, magnet: !v.magnet }))} title="Nam châm: điểm vẽ bám vào giá mở/cao/thấp/đóng của nến gần nhất"
              className={`px-2 py-1 ${view.magnet ? "bg-accent/20 text-accent" : "text-muted hover:text-foreground"}`}>🧲</button>
            <button onClick={() => setHidden((h) => !h)} title={hidden ? "Hiện hình vẽ" : "Ẩn hình vẽ"}
              className={`px-2 py-1 ${hidden ? "bg-warn/20 text-warn" : "text-muted hover:text-foreground"}`}>{hidden ? "◌" : "◉"}</button>
            <button onClick={undo} title="Hoàn tác (Ctrl+Z)" className="px-2 py-1 text-muted hover:text-foreground">↶</button>
            <button onClick={clearAll} title="Xoá toàn bộ hình vẽ của mã này" className="px-2 py-1 text-muted hover:text-down">🗑</button>
          </div>
          <div className="flex rounded-md border border-border text-xs" role="group" aria-label="Thang giá">
            {(["log", "percent"] as const).map((m) => (
              <button key={m} onClick={() => setView((v) => ({ ...v, scale: v.scale === m ? "normal" : m }))}
                title={m === "log" ? "Thang logarit" : "Thang phần trăm (so với nến đầu tiên đang hiển thị)"}
                className={`px-2 py-1 ${view.scale === m ? "bg-accent/20 text-accent" : "text-muted hover:text-foreground"}`}>{m === "log" ? "Log" : "%"}</button>
            ))}
          </div>
          <div className="relative">
            <button onClick={() => setStyleMenu((m) => !m)} title="Màu nến, nền biểu đồ, khối lượng"
              className="rounded-md border border-border px-2 py-1 text-xs text-muted hover:text-foreground">🎨</button>
            {styleMenu && (
              <div className="absolute left-0 z-20 mt-1 grid max-h-[80vh] w-72 max-w-[90vw] gap-2 overflow-y-auto rounded-md border border-border bg-panel p-2 text-xs shadow-xl">
                <div className="text-muted">Mẫu giao diện</div>
                <div className="grid grid-cols-2 gap-1">
                  {CHART_TEMPLATES.map((t) => {
                    const on = isTemplate(view.style, t.style);
                    const bg = t.style.bgColor ?? (t.style.bg === "light" ? "#ffffff" : "#0b0f17");
                    return (
                      <button key={t.label} onClick={() => setStyle({ ...t.style })} title={t.hint}
                        className={`flex items-center gap-1.5 rounded border px-1.5 py-1 text-left ${on ? "border-accent text-foreground" : "border-border text-muted hover:text-foreground"}`}>
                        {/* a tiny preview: the background with an up and a down candle */}
                        <span className="flex h-5 w-7 shrink-0 items-end justify-center gap-0.5 rounded-sm border border-border px-0.5 pb-0.5" style={{ background: bg }}>
                          <span className="h-3 w-1.5 rounded-[1px]" style={{ background: t.style.up, outline: `1px solid ${t.style.up === bg ? "#6b7280" : "transparent"}` }} />
                          <span className="h-2 w-1.5 rounded-[1px]" style={{ background: t.style.down, outline: `1px solid ${t.style.down === bg ? "#6b7280" : "transparent"}` }} />
                        </span>
                        <span className="truncate">{t.label}</span>
                      </button>
                    );
                  })}
                </div>
                <div className="text-muted">Màu nến</div>
                <div className="grid grid-cols-2 gap-1">
                  {CANDLE_PRESETS.map((p) => {
                    const on = view.style.up === p.up && view.style.down === p.down;
                    return (
                      <button key={p.label} onClick={() => setStyle({ up: p.up, down: p.down })}
                        className={`flex items-center gap-1.5 rounded border px-1.5 py-1 ${on ? "border-accent text-foreground" : "border-border text-muted hover:text-foreground"}`}>
                        <span className="h-3 w-2 rounded-sm border border-border" style={{ background: p.up }} />
                        <span className="h-3 w-2 rounded-sm border border-border" style={{ background: p.down }} />
                        {p.label}
                      </button>
                    );
                  })}
                </div>
                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-1 text-muted">Tăng <input type="color" value={view.style.up} onChange={(e) => setStyle({ up: e.target.value })} className="h-6 w-8 cursor-pointer p-0" /></label>
                  <label className="flex items-center gap-1 text-muted">Giảm <input type="color" value={view.style.down} onChange={(e) => setStyle({ down: e.target.value })} className="h-6 w-8 cursor-pointer p-0" /></label>
                </div>
                <div className="text-muted">Nền biểu đồ</div>
                <div className="flex items-center gap-2">
                  <div className="flex flex-1 rounded border border-border">
                    {(["dark", "light"] as const).map((bg) => (
                      <button key={bg} onClick={() => setStyle({ bg, bgColor: null })}
                        className={`flex-1 px-2 py-1 ${!view.style.bgColor && view.style.bg === bg ? "bg-accent text-white" : "text-muted hover:text-foreground"}`}>{bg === "dark" ? "Tối" : "Sáng"}</button>
                    ))}
                  </div>
                  <label className={`flex items-center gap-1 ${view.style.bgColor ? "text-foreground" : "text-muted"}`} title="Chọn màu nền tuỳ ý">Tuỳ chọn
                    <input type="color" value={view.style.bgColor ?? (view.style.bg === "light" ? "#ffffff" : "#0b0f17")}
                      onChange={(e) => setStyle({ bgColor: e.target.value, bg: bgFamily(e.target.value) })} className="h-6 w-8 cursor-pointer p-0" />
                  </label>
                </div>
                <label className="flex cursor-pointer items-center gap-2">
                  <input type="checkbox" checked={view.style.grid !== false} onChange={(e) => setStyle({ grid: e.target.checked })} />
                  <span>Hiện lưới (tắt cho đỡ rối mắt)</span>
                </label>
                <label className="flex cursor-pointer items-center gap-2">
                  <input type="checkbox" checked={view.style.volume} onChange={(e) => setStyle({ volume: e.target.checked })} />
                  <span>Khối lượng ở đáy biểu đồ giá</span>
                </label>
                <p className="text-muted/80">Chỉ báo dạng dao động (RSI, MACD…) tự nằm ở vùng riêng bên dưới; kéo đường ngăn cách để đổi chiều cao.</p>
                <button onClick={() => setStyleMenu(false)} className="rounded bg-accent px-2 py-1 text-white">Xong</button>
              </div>
            )}
          </div>
          <div className="flex rounded-md border border-border text-xs">
            <button onClick={screenshot} title="Tải ảnh biểu đồ (PNG)" className="px-2 py-1 text-muted hover:text-foreground">📷</button>
            <button onClick={fullscreen} title="Toàn màn hình" className="px-2 py-1 text-muted hover:text-foreground">⛶</button>
          </div>
          <div className="flex rounded-md border border-border text-xs">
            {signedIn && (
              <button onClick={() => setOverlays((o) => ({ ...o, trades: !o.trades }))} title="Lệnh của Master và kết quả copy"
                className={`px-2 py-1 ${overlays.trades ? "text-foreground" : "text-muted line-through"}`}>⇅ Lệnh copy</button>
            )}
            <button onClick={() => setOverlays((o) => ({ ...o, events: !o.events }))} title="Tin kinh tế ảnh hưởng mạnh/trung bình"
              className={`px-2 py-1 ${overlays.events ? "text-foreground" : "text-muted line-through"}`}>📅 Tin</button>
          </div>
          <PatternAlertsButton signedIn={signedIn} symbol={symbol} />
          <button onClick={toggleTextHidden} aria-pressed={textHidden}
            title={textHidden ? "Hiện lại chữ báo hiệu mô hình trên biểu đồ" : "Ẩn chữ báo hiệu mô hình (vai đầu vai, nhấn chìm, mục tiêu, Vol ×…); giữ mũi tên, chấm tròn và đường vẽ — rê chuột vào nến để xem tên"}
            className={`rounded-md border px-2 py-1 text-xs hover:bg-panel-2 ${textHidden ? "border-warn/50 bg-warn/10 text-warn" : "border-border"}`}>
            {textHidden ? "Aa Hiện chữ" : "Aa Ẩn chữ"}
          </button>
          <div className="relative">
            <button onClick={() => setAutoMenu((m) => !m)} title="Tự nhận diện mô hình giá, mô hình nến, key level và phiên giao dịch"
              className={`rounded-md border px-2 py-1 text-xs hover:bg-panel-2 ${AUTO_LAYERS.some((l) => auto[l.key]) ? "border-accent/50 text-accent" : "border-border"}`}>🔍 Tự nhận diện</button>
            {autoMenu && (
              <div className="absolute right-0 z-20 mt-1 grid w-80 max-w-[90vw] gap-1.5 rounded-md border border-border bg-panel p-2 text-xs shadow-xl">
                {AUTO_LAYERS.map((l) => (
                  <label key={l.key} className="flex cursor-pointer items-start gap-2 rounded px-1 py-0.5 hover:bg-panel-2">
                    <input type="checkbox" checked={auto[l.key]} onChange={(e) => setAuto((a) => ({ ...a, [l.key]: e.target.checked }))} className="mt-0.5" />
                    <span><span className="block text-foreground">{l.label}</span><span className="text-muted">{l.hint}</span></span>
                  </label>
                ))}
                <div className="flex items-center gap-2 px-1">
                  <span className="text-muted">Độ nhạy mô hình giá</span>
                  <span className="flex rounded border border-border">
                    {DEPTHS.map((d) => (
                      <button key={d.v} onClick={() => setAuto((a) => ({ ...a, depth: d.v }))} title={`Đỉnh/đáy cần ${d.v} nến mỗi bên`}
                        className={`px-1.5 py-0.5 ${auto.depth === d.v ? "bg-accent text-white" : "text-muted hover:text-foreground"}`}>{d.label}</button>
                    ))}
                  </span>
                </div>
                <p className="px-1 text-muted/80">Nhận diện tự động theo quy tắc, chỉ để tham khảo, không phải tín hiệu giao dịch. Mô hình chỉ được xác nhận khi giá đóng cửa phá qua đường biên.</p>
                <button onClick={() => setAutoMenu(false)} className="rounded bg-accent px-2 py-1 text-white">Xong</button>
              </div>
            )}
          </div>
          {sessionNow && (
            <span className="rounded border border-border px-1.5 py-0.5 text-xs text-muted" title="Giờ phiên theo giờ địa phương của từng trung tâm (đã tính giờ mùa hè)">
              🕐 {sessionNow.open.length
                ? sessionNow.open.map((s) => <span key={s.id} style={{ color: s.color }}>{s.name} </span>)
                : "Ngoài phiên "}
              {sessionNow.next && <>· {sessionNow.next.name} {sessionNow.next.kind === "open" ? "mở" : "đóng"} sau {countdown(sessionNow.next.at * 1000 - clock)}</>}
            </span>
          )}
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

        {/* indicators: a row that folds away like the watchlist, and a switch that takes them all off the chart */}
        {indicators.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-3 py-1.5 text-xs">
            <PanelToggle panel="ind" title="Thu gọn / mở rộng hàng chỉ báo" className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-muted hover:bg-panel-2 hover:text-foreground">
              <span aria-hidden className="ind-collapsed:hidden">▾</span><span aria-hidden className="ind-expanded:hidden">▸</span>
              Chỉ báo ({indicators.length})
            </PanelToggle>
            <button onClick={toggleIndHidden} aria-pressed={indHidden}
              title={indHidden ? "Hiện lại chỉ báo và hình nhận diện trên biểu đồ" : "Ẩn mọi chỉ báo và hình nhận diện khỏi biểu đồ (không xoá, bấm lại để hiện)"}
              className={`rounded border px-1.5 py-0.5 ${indHidden ? "border-warn/50 bg-warn/10 text-warn" : "border-border text-muted hover:text-foreground"}`}>
              {indHidden ? "◌ Đang ẩn · bấm để hiện" : "👁 Ẩn tất cả"}
            </button>
            <span className="contents ind-collapsed:hidden">
            {indicators.map((ind) => {
              const def = BY_ID[ind.id];
              const editable = (def?.inputs ?? []).filter((i) => ["int", "float", "select", "source"].includes(i.type));
              return (
                <span key={ind.uid} className={`relative inline-flex items-center gap-1 rounded border border-border bg-panel-2 px-1.5 py-0.5 ${indHidden ? "opacity-50" : ""}`}>
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
            </span>
          </div>
        )}

        {/* automatic pattern recognition: its own folding row */}
        {(wedgeChips.length > 0 || patternChips.length > 0 || liveCandle) && (
          <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-3 py-1.5 text-xs">
            <PanelToggle panel="pat" title="Thu gọn / mở rộng hàng nhận diện" className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-muted hover:bg-panel-2 hover:text-foreground">
              <span aria-hidden className="pat-collapsed:hidden">▾</span><span aria-hidden className="pat-expanded:hidden">▸</span>
              Nhận diện ({wedgeChips.length + patternChips.length + (liveCandle ? 1 : 0)})
            </PanelToggle>
            <span className={`contents pat-collapsed:hidden ${indHidden ? "[&>*]:opacity-50" : ""}`}>
            {wedgeChips.map((w) => (
              <span key={`${w.kind}${w.start}`}
                title={[
                  w.reasons.length ? `Điểm ${w.score}/100: ${w.reasons.join(", ")}` : `Điểm ${w.score}/100`,
                  w.entry != null ? `Vào ${fmt(w.entry, info.digits)} · SL ${fmt(w.stop ?? 0, info.digits)} · TP1 ${fmt(w.tp1 ?? 0, info.digits)} · TP2 ${fmt(w.target ?? 0, info.digits)}` : `Đỉnh nêm lúc ${new Date(w.apex * 1000).toLocaleString("vi-VN")}`,
                  "Chỉ để tham khảo, không phải khuyến nghị.",
                ].join("\n")}
                className={`rounded border px-1.5 py-0.5 ${w.bias > 0 ? "border-up/40 text-up" : "border-down/40 text-down"} ${w.stage === "ready" ? "animate-pulse font-semibold" : ""} ${w.stage === "failed" ? "opacity-60" : ""}`}>
                ◢ {w.name} · {STATUS_VI[w.status] ?? w.status} · {w.score}đ{w.entry != null ? ` · vào ${fmt(w.entry, info.digits)} SL ${fmt(w.stop ?? 0, info.digits)}` : ""}
              </span>
            ))}
            {patternChips.map((p) => (
              <span key={`${p.kind}${p.start}`} title={`${new Date(p.start * 1000).toLocaleString("vi-VN")} → ${new Date(p.end * 1000).toLocaleString("vi-VN")}${p.target != null ? ` · mục tiêu ${fmt(p.target, info.digits)}` : ""}`}
                className={`rounded border px-1.5 py-0.5 ${p.bias > 0 ? "border-up/40 text-up" : p.bias < 0 ? "border-down/40 text-down" : "border-warn/40 text-warn"}`}>
                ◆ {p.name} · {STATUS_VI[p.status]}{p.target != null ? ` → ${fmt(p.target, info.digits)}` : ""}
              </span>
            ))}
            {liveCandle && (
              <span className={`rounded border px-1.5 py-0.5 ${liveCandle.bias > 0 ? "border-up/40 text-up" : liveCandle.bias < 0 ? "border-down/40 text-down" : "border-border text-muted"}`}
                title="Mô hình nến trên 3 nến gần nhất (nến cuối có thể chưa đóng)">
                🕯 {liveCandle.name}
              </span>
            )}
            </span>
          </div>
        )}

        {/* tool in use, drawings, alerts, news */}
        {(hlines.length > 0 || shapes.length > 0 || activeTool || notice || recent.length > 0) && (
          <div className="flex flex-wrap gap-1.5 border-b border-border px-3 py-1.5 text-xs">
            {activeTool && (
              <span className="rounded border border-warn/50 bg-warn/10 px-1.5 py-0.5 text-warn">
                {activeTool.label}: {activeTool.hint}{activeTool.id !== "hline" && SHAPE_POINTS[activeTool.id] > 1 && view.magnet ? " · nam châm bật" : ""} · Esc để huỷ
              </span>
            )}
            {hlines.map((h) => (
              <span key={h.price} className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 ${h.alert ? "border-accent/50 text-accent" : "border-warn/40 text-warn"}`}>
                ― {fmt(h.price, info.digits)}
                <button onClick={() => toggleAlert(h.price)} title={h.alert ? "Tắt cảnh báo" : "Báo khi giá chạm đường này"}
                  className={h.alert ? "" : "opacity-50 hover:opacity-100"}>🔔</button>
                <button onClick={() => removeLine(h.price)} className="hover:text-down" title="Xoá đường">×</button>
              </span>
            ))}
            {shapes.map((s) => (
              <span key={s.id} className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 ${s.id === selected ? "border-warn bg-warn/10 text-warn" : "border-accent/40 text-accent"}`}>
                <button onClick={() => setSelected(s.id === selected ? null : s.id)} title="Chọn (Delete để xoá)">
                  {TOOLS.find((t) => t.id === s.kind)?.icon} {s.kind === "text" && s.text ? `“${s.text.slice(0, 20)}”` : SHAPE_LABEL[s.kind]}
                </button>
                <button onClick={() => removeShape(s.id)} className="hover:text-down" title="Xoá">×</button>
              </span>
            ))}
            {hidden && (shapes.length > 0 || hlines.length > 0) && <span className="text-warn">Hình vẽ đang ẩn</span>}
            {recent.map((e) => (
              <span key={`${e.country}${e.title}${e.time}`} className="rounded border border-down/40 px-1.5 py-0.5 text-down" title="Tin mạnh trong 6 giờ qua">
                📰 {e.country} {e.title}: thực tế {e.actual ?? "—"} / dự báo {e.forecast ?? "—"}
              </span>
            ))}
            {notice && <span className="text-muted">{notice}</span>}
          </div>
        )}

        <div className="relative h-[65vh] min-h-[420px] lg:h-auto lg:flex-1">
          <PriceChart ref={chartApi} bars={bars} digits={info.digits} barSeconds={tfSeconds(tf)} indicators={indHidden ? NO_INDICATORS : indicators}
            chartType={view.type} scaleMode={view.scale} magnet={view.magnet} style={view.style}
            hlines={hlines} shapes={shapes} hidden={hidden} selected={selected} events={events} auto={indHidden ? NO_AUTO : autoDraw} tradeMarkers={chartMarkers} tradeLines={tradeLines} patternText={!textHidden}
            tool={tool} onAddLine={addLine} onAddShape={addShape} onSelect={setSelected} onChangeShape={changeShape} viewKey={key} />
          {loading && <div className="absolute inset-0 grid place-items-center bg-background/60 text-sm text-muted">Đang tải {symbol}…</div>}
          {!loading && data?.error && (
            <div className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-down">{data.error}</div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border px-3 py-1.5 text-xs text-muted">
          <span className="flex gap-0.5" role="group" aria-label="Khoảng thời gian hiển thị">
            {RANGES.map((r) => (
              <button key={r.label} onClick={() => chartApi.current?.showRange(r.seconds)} className="rounded px-1.5 py-0.5 hover:bg-panel-2 hover:text-foreground">{r.label}</button>
            ))}
            <button onClick={() => chartApi.current?.toLatest()} title="Về nến mới nhất" className="rounded px-1.5 py-0.5 hover:bg-panel-2 hover:text-foreground">⇥</button>
          </span>
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
          {/* the chart library's licence asks for its notice and a link on the page when the logo is off the chart */}
          <a href="https://www.tradingview.com/" target="_blank" rel="noopener noreferrer" className="ml-auto text-muted/70 hover:text-foreground">
            Biểu đồ: TradingView Lightweight Charts™ · © TradingView, Inc.
          </a>
        </div>
      </section>
    </div>
  );
}
