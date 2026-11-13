"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SYMBOLS, TIMEFRAMES, quoteFromDaily, binanceInterval } from "@qt/shared/market";
import { INDICATORS, BY_ID, defaults } from "@qt/core/indicators";
import { createClient } from "@/lib/supabase/client";
import { PriceChart, type ActiveIndicator, type Bar } from "./price-chart";

export type LayoutState = { symbol: string; tf: string; indicators: ActiveIndicator[] };
type Initial = {
  layout: LayoutState; layoutId: string | null;
  watchlist: string[]; watchlistId: string | null;
  drawings: Record<string, { id: string; hlines: number[] }>;
};
type BarsResponse = { bars: Bar[]; source: string; realtime: boolean; note?: string; error?: string };

// Indicators that need anchors or draw boxes/profiles are left out of the menu.
const SKIP = new Set(["vpvr", "svp", "avwap", "markov", "zigzag", "pivots", "pivotshl"]);
const MENU = INDICATORS.filter((d) => !SKIP.has(d.id) && (d.outputs?.length ?? 0) > 0);
const QUICK = ["ema", "sma", "bb", "vwap", "supertrend", "rsi", "macd", "atr", "volume"];
const uid = () => Math.random().toString(36).slice(2, 9);
const fmt = (v: number, d: number) => v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
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

export function ChartTerminal({ initial, signedIn }: { initial: Initial; signedIn: boolean }) {
  const [symbol, setSymbol] = useState(initial.layout.symbol);
  const [tf, setTf] = useState(initial.layout.tf);
  const [indicators, setIndicators] = useState<ActiveIndicator[]>(initial.layout.indicators);
  const [watchlist, setWatchlist] = useState(initial.watchlist);
  const [drawings, setDrawings] = useState(initial.drawings);
  const [data, setData] = useState<BarsResponse | null>(null);
  const [loadedKey, setLoadedKey] = useState("");
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [drawMode, setDrawMode] = useState(false);
  const [menu, setMenu] = useState(false);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [quotes, setQuotes] = useState<Record<string, ReturnType<typeof quoteFromDaily>>>({});
  const [saveState, setSaveState] = useState<"" | "saving" | "saved" | "error">("");
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
      const state = { symbol, tf, indicators };
      const { data: auth } = await supabase.auth.getUser();
      if (!auth.user) return setSaveState("error");
      const res = ids.current.layout
        ? await supabase.from("layouts").update({ state, updated_at: new Date().toISOString() }).eq("id", ids.current.layout)
        : await supabase.from("layouts").insert({ user_id: auth.user.id, name: "default", state }).select("id").single();
      if (!ids.current.layout && res.data && "id" in res.data) ids.current.layout = res.data.id as string;
      setSaveState(res.error ? "error" : "saved");
    }, 800);
  }, [symbol, tf, indicators, supabase]);

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

  const hlines = drawings[symbol]?.hlines ?? [];
  const saveLines = async (list: number[]) => {
    const current = drawings[symbol];
    setDrawings((d) => ({ ...d, [symbol]: { id: current?.id ?? "", hlines: list } }));
    if (!supabase) return;
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) return;
    const payload = { data: { hlines: list }, updated_at: new Date().toISOString() };
    if (current?.id) await supabase.from("drawings").update(payload).eq("id", current.id);
    else {
      const { data: row } = await supabase.from("drawings").insert({ user_id: auth.user.id, symbol, ...payload }).select("id").single();
      if (row) setDrawings((d) => ({ ...d, [symbol]: { id: row.id, hlines: list } }));
    }
  };
  const addLine = (price: number) => {
    const p = Number(price.toFixed(info.digits));
    void saveLines([...hlines, p].sort((a, b) => b - a));
    setDrawMode(false);
  };

  // ---------- indicators ----------
  const addIndicator = (id: string) => {
    setIndicators((xs) => [...xs, { uid: uid(), id, params: defaults(id) }]);
    setMenu(false); setQuery("");
  };
  const setParam = (u: string, key: string, value: unknown) =>
    setIndicators((xs) => xs.map((x) => (x.uid === u ? { ...x, params: { ...x.params, [key]: value } } : x)));

  const bars = data?.bars ?? [];
  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  const chg = last && prev ? ((last.close - prev.close) / prev.close) * 100 : null;
  const filtered = MENU.filter((d) => !query || d.name.toLowerCase().includes(query.toLowerCase()) || d.id.includes(query.toLowerCase()));
  const notInList = Object.keys(SYMBOLS).filter((s) => !watchlist.includes(s));

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
                <button onClick={() => setSymbol(s)}
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
          <button onClick={() => setDrawMode((d) => !d)} title="Bấm rồi click lên biểu đồ để đặt đường giá ngang"
            className={`rounded-md border px-2 py-1 text-xs ${drawMode ? "border-warn bg-warn/15 text-warn" : "border-border hover:bg-panel-2"}`}>
            ― Đường giá{drawMode ? ": click lên biểu đồ" : ""}
          </button>
          <span className="ml-auto text-xs text-muted">
            {!signedIn ? "Đăng nhập để lưu layout" : saveState === "saving" ? "Đang lưu…" : saveState === "saved" ? "Đã lưu" : saveState === "error" ? "Lưu lỗi" : ""}
          </span>
        </div>

        {/* active indicators and lines */}
        {(indicators.length > 0 || hlines.length > 0) && (
          <div className="flex flex-wrap gap-1.5 border-b border-border px-3 py-1.5 text-xs">
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
            {hlines.map((p) => (
              <span key={p} className="inline-flex items-center gap-1 rounded border border-warn/40 px-1.5 py-0.5 text-warn">
                ― {fmt(p, info.digits)}
                <button onClick={() => saveLines(hlines.filter((x) => x !== p))} className="hover:text-down" title="Xoá đường">×</button>
              </span>
            ))}
          </div>
        )}

        <div className="relative h-[65vh] min-h-[420px] lg:h-auto lg:flex-1">
          <PriceChart bars={bars} digits={info.digits} indicators={indicators} hlines={hlines} drawMode={drawMode}
            onAddLine={addLine} viewKey={key} />
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
          {info.broker && !data?.source.startsWith("Giá broker") && <span>Khi EA master gửi nến M1, biểu đồ chuyển sang giá broker.</span>}
        </div>
      </section>
    </div>
  );
}
