"use client";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  SYMBOLS, TIMEFRAMES, quoteFromDaily, quoteFromTicker, tickerStreamUrl, spotUsdFactor, fetchSpotUsdFactor, USD_PROXY_TICKER, tfSeconds, usesFutures,
  BINANCE_SPOT_HOST, BINANCE_SPOT_STREAM, BINANCE_FUTURES_HOST, BINANCE_FUTURES_STREAM,
} from "@qt/shared/market";
import { INDICATORS, BY_ID, defaults } from "@qt/core/indicators";
import { createClient } from "@/lib/supabase/client";
import { PanelToggle } from "@/components/panel-toggle";
import { PatternAlertsButton } from "./pattern-alerts";
import { TrendAlertsButton } from "./trend-alerts";
import { MarketBrief } from "./market-brief";
import { useLiveBar, withLive, type LiveBarStore, type LiveState } from "./live-bar";
import { autoHtf, largerTimeframes, liveSocket, useBarsFeed, useHtfBars } from "./feed";
import { TEMPLATE_PREFIX, cleanTemplate, type ChartTemplate, type TemplateState } from "./layout-state";
import { PriceChart, type ActiveIndicator, type Bar, type ChartHandle, type ChartStyle, type ChartType, type PriceLineSpec, type ScaleMode, type TimedMarker, type Tool } from "./price-chart";
import { CHART_TEMPLATES, WAVE_COLORS, LAYER_STYLE_DEFAULT, PRICE_LINE_DEFAULT, type LayerKey, type LayerStyle, type LayerDash, type LineDash, type OutputStyle, NO_AUTO, SHAPE_LABEL, SHAPE_POINTS, bgFamily, isTemplate, type AutoDraw, type ChartEvent, type Shape } from "./chart-overlay";
import { elliottWaves } from "@qt/core/elliott";
import { candlestickPatterns, chartPatterns, closeLevels, microWedges, periodCloses, sessionsBetween, sessionStatus } from "@qt/core/patterns";
import type { TradesResponse } from "@/app/api/trades/route";
import type { CalendarEvent } from "@/app/api/calendar/route";

export type Overlays = { trades: boolean; events: boolean };
/** htf: higher-timeframe candles behind the chart ("auto" = the next larger timeframe, null = off). */
export type ChartView = { type: ChartType; scale: ScaleMode; magnet: boolean; style: ChartStyle; htf: string | null; htfOpacity: number };
/** A second chart beside the main one: its own symbol and timeframe, the main chart's look. */
export type SplitChart = { symbol: string; tf: string; sameIndicators: boolean };
/** Automatic chart reading: which layers are on, and pivot strength (bars each side) for chart patterns. */
export type AutoSettings = { chart: boolean; wedges: boolean; candles: boolean; levels: boolean; periods: boolean; sessions: boolean; elliott: boolean; waveUpOnly: boolean; waveColor: string; depth: number; styles: Partial<Record<LayerKey, LayerStyle>> };
export type LayoutState = { symbol: string; tf: string; indicators: ActiveIndicator[]; overlays: Overlays; view: ChartView; auto: AutoSettings; split: SplitChart | null };
export type SymbolDrawings = { id: string; hlines: number[]; shapes: Shape[] };
export type PriceAlert = { id: string; symbol: string; price: number; op: "above" | "below" };
type Initial = {
  layout: LayoutState; layoutId: string | null;
  watchlist: string[]; watchlistId: string | null;
  drawings: Record<string, SymbolDrawings>;
  alerts: PriceAlert[];
  templates: ChartTemplate[];
};

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
  { id: "fib", icon: "𝑓", label: "Fibonacci thoái lui (0 → 1, mở rộng 1.272 / 1.618)", hint: "click điểm đầu sóng rồi điểm cuối sóng (đáy → đỉnh để đo hồi giảm)", group: 1 },
  { id: "fibext", icon: "𝑓⁺", label: "Fibonacci mở rộng theo xu hướng (mục tiêu sóng)", hint: "click đầu sóng, đỉnh sóng, rồi điểm cuối nhịp hồi: các mức 0.618 / 1 / 1.618 / 2.618 tính từ điểm thứ 3", group: 1 },
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
const TEMPLATES_KEY = "qt-chart-templates";
const CANDLE_PRESETS = [
  { label: "Xanh / Đỏ", up: "#00c087", down: "#f45b69" },
  { label: "Trắng / Đen", up: "#ffffff", down: "#000000" },
  { label: "Xanh dương / Cam", up: "#4f8cff", down: "#f5a142" },
  { label: "Xám / Đen", up: "#9aa4b2", down: "#000000" },
];
const AUTO_LAYERS: { key: Exclude<keyof AutoSettings, "depth" | "waveUpOnly" | "waveColor" | "styles">; label: string; hint: string }[] = [
  { key: "chart", label: "Mô hình giá", hint: "Tam giác tăng/giảm/cân, tam giác mở rộng (tam giác ngược), nêm, hai đỉnh/hai đáy, vai đầu vai" },
  { key: "wedges", label: "Nêm nhỏ tiếp diễn (báo sớm)", hint: "Sau một nhịp mạnh, giá hồi trong nêm hẹp dần; chấm điểm 0–100 (key level/EMA21, khối lượng, biên độ, RSI) và báo Sẵn sàng trước khi phá" },
  { key: "candles", label: "Mô hình nến", hint: "Búa, sao băng, nhấn chìm, harami, sao mai/sao hôm, ba chàng lính/ba con quạ, nhíp, marubozu…" },
  { key: "levels", label: "Key level theo giá đóng cửa", hint: "Vùng giá nến hay đóng cửa và đảo chiều; nét đậm hơn = mạnh hơn" },
  { key: "periods", label: "Giá đóng cửa ngày/tuần/tháng trước", hint: "Theo lịch UTC" },
  { key: "sessions", label: "Phiên Sydney/Tokyo/London/New York", hint: "Khung cao-thấp của từng phiên (khung ≤ 1H) và giờ mở/đóng phiên" },
  { key: "elliott", label: "Đếm sóng Elliott", hint: "Sóng đẩy (1)–(5) và điều chỉnh A-B-C gần nhất, theo 3 quy tắc cứng: sóng 2 không thủng đầu sóng 1, sóng 3 không ngắn nhất, sóng 4 không chồng vùng sóng 1. Độ nhạy theo mục Đỉnh/đáy" },
];
/** Display settings for one detection layer: strength, line width, and for pattern lines their length. */
function LayerStyleControls({ k, value, onChange }: { k: LayerKey; value: LayerStyle; onChange: (s: LayerStyle) => void }) {
  const row = "grid grid-cols-[4.5rem_1fr_2.5rem] items-center gap-2";
  const lines = k === "chart" || k === "wedges";
  return (
    <div className="ml-6 grid gap-1 rounded border border-border bg-panel-2/40 px-2 py-1.5">
      <label className={row}><span className="text-muted">Độ đậm</span>
        <input type="range" min={10} max={100} step={5} value={Math.round(value.opacity * 100)} onChange={(e) => onChange({ ...value, opacity: Number(e.target.value) / 100 })} />
        <span className="text-right font-mono">{Math.round(value.opacity * 100)}%</span></label>
      <label className={row}><span className="text-muted">Độ dày nét</span>
        <input type="range" min={0.5} max={3} step={0.25} value={value.width} onChange={(e) => onChange({ ...value, width: Number(e.target.value) })} />
        <span className="text-right font-mono">×{value.width}</span></label>
      {lines && (
        <label className={row} title="Rút ngắn (âm) hoặc kéo dài (dương) các cạnh của mô hình/nêm theo tỷ lệ chiều dài của chúng; đường zigzag nối đỉnh đáy giữ nguyên">
          <span className="text-muted">Độ dài cạnh</span>
          <input type="range" min={-50} max={200} step={10} value={Math.round(value.extend * 100)} onChange={(e) => onChange({ ...value, extend: Number(e.target.value) / 100 })} />
          <span className="text-right font-mono">{value.extend > 0 ? "+" : ""}{Math.round(value.extend * 100)}%</span></label>
      )}
      {k === "elliott" && (
        <label className="flex cursor-pointer items-center gap-2">
          <input type="checkbox" checked={value.path} onChange={(e) => onChange({ ...value, path: e.target.checked })} />
          <span>Hiện đường nối các đỉnh/đáy sóng</span>
        </label>
      )}
      {/* Elliott has its own colour choice (Màu sóng); the others take one colour for all their lines and labels */}
      {k !== "elliott" && (
        <div className={row} title="Một màu cho mọi đường và nhãn của lớp này; bỏ chọn để dùng màu riêng của lớp (theo hướng tăng/giảm, theo phiên…)">
          <span className="text-muted">Màu</span>
          <label className="flex cursor-pointer items-center gap-1.5">
            <input type="checkbox" checked={!!value.color} onChange={(e) => onChange({ ...value, color: e.target.checked ? "#f5d742" : "" })} />
            <span>{value.color ? "Màu riêng" : "Theo lớp"}</span>
          </label>
          {value.color ? (
            <input type="color" value={value.color} onChange={(e) => onChange({ ...value, color: e.target.value })} aria-label="Chọn màu" className="h-6 w-full cursor-pointer rounded border border-border bg-transparent p-0" />
          ) : <span />}
        </div>
      )}
      <label className={row}><span className="text-muted">Kiểu nét</span>
        <select value={value.dash} onChange={(e) => onChange({ ...value, dash: e.target.value as LayerDash })}>
          {LAYER_DASHES.map((d) => <option key={d.v} value={d.v}>{d.label}</option>)}
        </select>
        <span /></label>
      <button onClick={() => onChange(LAYER_STYLE_DEFAULT)} className="justify-self-start text-muted hover:text-foreground">↺ Mặc định</button>
    </div>
  );
}
const LAYER_DASHES: { v: LayerDash; label: string }[] = [
  { v: "auto", label: "Mặc định của lớp" }, { v: "solid", label: "━ Liền" }, { v: "dashed", label: "╍ Đứt" }, { v: "dotted", label: "┈ Chấm" },
];
const LINE_DASHES: { v: LineDash; label: string }[] = [{ v: "solid", label: "━ Liền" }, { v: "dashed", label: "╍ Đứt" }, { v: "dotted", label: "┈ Chấm" }];
const DASH_OF_LINE_STYLE: LineDash[] = ["solid", "dotted", "dashed", "dashed", "dotted"];
const toHex = (c: string | undefined) => (c && /^#[0-9a-fA-F]{6}/.test(c) ? c.slice(0, 7) : "#4f8cff");

/** Colour, width and dash of each output of one indicator; histogram and dot outputs only take a colour. */
function OutputStyleControls({ ind, onChange }: { ind: ActiveIndicator; onChange: (key: string, s: OutputStyle | null) => void }) {
  const outputs = BY_ID[ind.id]?.outputs ?? [];
  if (!outputs.length) return null;
  return (
    <div className="grid gap-1 border-t border-border pt-2">
      <span className="text-muted">Kiểu hiển thị</span>
      {outputs.map((o) => {
        const s = ind.styles?.[o.key] ?? {};
        const lineLike = o.kind !== "histogram" && !o.dots;
        return (
          <div key={o.key} className="grid gap-0.5">
            <span className="truncate" title={o.label}>{o.label}</span>
            <div className="flex items-center gap-1.5">
              <input type="color" value={toHex(s.color ?? o.color)} onChange={(e) => onChange(o.key, { ...s, color: e.target.value })}
                aria-label={`Màu ${o.label}`} title="Màu" className="h-6 w-9 shrink-0 cursor-pointer rounded border border-border bg-transparent p-0" />
              {lineLike && (
                <select value={s.width ?? o.lineWidth ?? 1} onChange={(e) => onChange(o.key, { ...s, width: Number(e.target.value) as OutputStyle["width"] })}
                  aria-label={`Độ dày ${o.label}`} title="Độ dày nét" className="w-16">
                  {[1, 2, 3, 4].map((w) => <option key={w} value={w}>{w}px</option>)}
                </select>
              )}
              {lineLike && (
                <select value={s.dash ?? DASH_OF_LINE_STYLE[o.lineStyle ?? 0] ?? "solid"} onChange={(e) => onChange(o.key, { ...s, dash: e.target.value as LineDash })}
                  aria-label={`Kiểu nét ${o.label}`} title="Kiểu nét" className="min-w-0 flex-1">
                  {LINE_DASHES.map((d) => <option key={d.v} value={d.v}>{d.label}</option>)}
                </select>
              )}
            </div>
          </div>
        );
      })}
      {ind.styles && (
        <button onClick={() => outputs.forEach((o) => onChange(o.key, null))} className="justify-self-start text-muted hover:text-foreground">↺ Màu và nét mặc định</button>
      )}
    </div>
  );
}
const STYLED_LAYERS = new Set<string>(["chart", "wedges", "levels", "periods", "sessions", "elliott"]);
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
/**
 * Live perpetual -> spot USD multipliers (see spotUsdFactor) for the given futures tickers, kept in `out`:
 * a REST snapshot first, then each perpetual's `@markPrice@1s` stream (mark p, index i) and USDC/USDT's ticker.
 * Returns the close function.
 */
function liveSpotUsdFactors(tickers: string[], out: Record<string, number>) {
  if (!tickers.length) return () => {};
  const mark: Record<string, { p: number; i: number }> = {};
  let usd = 0;
  const update = (t: string) => {
    const m = mark[t];
    const f = m && usd ? spotUsdFactor(m.p, m.i, usd) : null;
    if (f) out[t] = f;
  };
  tickers.forEach((t) => fetchSpotUsdFactor(fetch, t).then((f) => { if (f && !mark[t]) out[t] = f; }));
  const closers = tickers.map((t) => liveSocket(`${BINANCE_FUTURES_STREAM}${t.toLowerCase()}@markPrice@1s`, (msg) => {
    const m = msg as { p?: string; i?: string };
    if (Number(m.p) > 0 && Number(m.i) > 0) { mark[t] = { p: +m.p!, i: +m.i! }; update(t); }
  }));
  closers.push(liveSocket(`${BINANCE_SPOT_STREAM}${USD_PROXY_TICKER.toLowerCase()}@ticker`, (msg) => {
    const c = Number((msg as { c?: string }).c);
    if (c > 0) { usd = c; tickers.forEach(update); }
  }));
  return () => closers.forEach((c) => c());
}
const paramText = (ind: ActiveIndicator) =>
  Object.entries(ind.params).filter(([, v]) => typeof v === "number").map(([, v]) => v).join(", ");
const countdown = (ms: number) => {
  const m = Math.max(0, Math.floor(ms / 60_000));
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  return d ? `${d}n ${h}g` : h ? `${h}g ${mm}p` : `${mm}p`;
};
const NO_TRADES: TradesResponse = { trades: [], positions: [] };
const NO_BARS: Bar[] = [];

/**
 * The bars with the forming candle as it was at most `ms` ago: the pattern and wave detectors scan every bar and
 * need not rerun on each tick, nor re-render the page twice a second. A new candle or reload passes straight through.
 */
function useSettledBars(bars: Bar[] | undefined, live: LiveBarStore, key: string, ms: number) {
  const [snap, setSnap] = useState<LiveState>(live.get);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = live.subscribe(() => {
      if (!timer) timer = setTimeout(() => { timer = null; setSnap(live.get()); }, ms);
    });
    return () => { off(); if (timer) clearTimeout(timer); };
  }, [live, ms]);
  return useMemo(() => bars && withLive(bars, key, snap), [bars, key, snap]);
}

/** Last price and change of the open symbol, following the live candle. */
function LivePrice({ bars, live, liveKey, digits }: { bars: Bar[]; live: LiveBarStore; liveKey: string; digits: number }) {
  const bs = withLive(bars, liveKey, useLiveBar(live));
  const last = bs[bs.length - 1], prev = bs[bs.length - 2];
  if (!last) return null;
  const chg = prev ? ((last.close - prev.close) / prev.close) * 100 : null;
  return (
    <span className="ml-2 font-mono text-sm">
      {fmt(last.close, digits)}{" "}
      {chg != null && <span className={chg >= 0 ? "text-up" : "text-down"}>{chg >= 0 ? "+" : ""}{chg.toFixed(2)}%</span>}
    </span>
  );
}

/** Time of the last bars load or live tick. */
function LiveUpdated({ at, live }: { at: number | null; live: LiveBarStore }) {
  const t = Math.max(at ?? 0, useLiveBar(live).at);
  return t ? <span>Cập nhật {new Date(t).toLocaleTimeString("vi-VN")}</span> : null;
}

/** The market brief reads the open chart live: it alone re-renders with the forming candle. */
function LiveBrief({ live, liveKey, bars, ...rest }: Omit<Parameters<typeof MarketBrief>[0], "bars"> & { bars: Bar[]; live: LiveBarStore; liveKey: string }) {
  const state = useLiveBar(live);
  const merged = useMemo(() => withLive(bars, liveKey, state), [bars, liveKey, state]);
  return <MarketBrief bars={merged} {...rest} />;
}

/** Saved templates: apply one to the current symbol, delete it, or save the current setup under a name. */
function TemplateMenu({ templates, signedIn, onSave, onApply, onDelete, onClose }: {
  templates: ChartTemplate[]; signedIn: boolean;
  onSave: (name: string) => Promise<boolean>; onApply: (t: ChartTemplate) => void; onDelete: (t: ChartTemplate) => void; onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    if (await onSave(name)) setName("");
    setBusy(false);
  };
  return (
    <div className="absolute left-0 z-20 mt-1 grid w-72 max-w-[90vw] gap-2 rounded-md border border-border bg-panel p-2 text-xs shadow-xl">
      <div className="text-muted">Mẫu đã lưu</div>
      {templates.length === 0 && <p className="text-muted/80">Chưa có mẫu nào. Lưu bộ chỉ báo, màu biểu đồ và lớp tự nhận diện hiện tại để dùng lại cho mã khác.</p>}
      {templates.length > 0 && (
        <ul className="grid max-h-60 gap-0.5 overflow-y-auto">
          {templates.map((t) => (
            <li key={t.id} className="group flex items-center gap-1 rounded hover:bg-panel-2">
              <button onClick={() => onApply(t)} className="min-w-0 flex-1 truncate px-1.5 py-1 text-left"
                title={`Áp dụng mẫu: ${t.state.indicators.length} chỉ báo${t.state.view.htf ? " · nến khung lớn" : ""}`}>
                {t.name}<span className="ml-1 text-muted">· {t.state.indicators.length} chỉ báo</span>
              </button>
              <button onClick={() => onDelete(t)} className="px-1.5 text-muted opacity-0 hover:text-down focus:opacity-100 group-hover:opacity-100" title="Xoá mẫu" aria-label={`Xoá mẫu ${t.name}`}>×</button>
            </li>
          ))}
        </ul>
      )}
      <div className="text-muted">Lưu thiết lập hiện tại thành mẫu</div>
      <form className="flex gap-1" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="Tên mẫu, vd. Scalp vàng" className="min-w-0 flex-1" aria-label="Tên mẫu" />
        <button type="submit" disabled={!name.trim() || busy} className="rounded bg-accent px-2 py-1 text-white disabled:opacity-50">Lưu</button>
      </form>
      <p className="text-muted/80">
        Mẫu gồm chỉ báo (tham số, màu, nét), kiểu và màu biểu đồ, nến khung lớn và lớp tự nhận diện. Không gồm mã, khung thời gian và hình vẽ.
        {signedIn ? "" : " Chưa đăng nhập: mẫu chỉ lưu trên trình duyệt này."}
      </p>
      <button onClick={onClose} className="rounded border border-border px-2 py-1 hover:bg-panel-2">Đóng</button>
    </div>
  );
}

const HTF_OPACITY = [{ v: 0.5, label: "Nhạt" }, { v: 1, label: "Vừa" }, { v: 1.6, label: "Đậm" }];
const tfLabel = (tf: string | null) => TIMEFRAMES.find((t) => t.tf === tf)?.label ?? tf ?? "";
/** The higher timeframe a chart at `tf` draws behind its candles, or null. */
const htfFor = (view: ChartView, tf: string) =>
  view.htf === "auto" ? autoHtf(tf) : view.htf && tfSeconds(view.htf) > tfSeconds(tf) ? view.htf : null;
/** Higher-timeframe bars for a chart, ready for PriceChart's `htf` prop. */
function useHtf(symbol: string, tf: string, view: ChartView) {
  const htfTf = htfFor(view, tf);
  const bars = useHtfBars(symbol, tf, htfTf);
  return useMemo(() => (htfTf && bars ? { tf: htfTf, bars, label: tfLabel(htfTf), opacity: view.htfOpacity } : null), [htfTf, bars, view.htfOpacity]);
}

/** Which higher timeframe to draw behind the chart, and how strongly. */
function HtfMenu({ tf, view, onChange, onClose }: { tf: string; view: ChartView; onChange: (patch: Partial<ChartView>) => void; onClose: () => void }) {
  const larger = largerTimeframes(tf);
  const auto = autoHtf(tf);
  const opt = (v: string | null, text: string, hint?: string) => (
    <button key={v ?? "off"} onClick={() => onChange({ htf: v })} title={hint}
      className={`rounded border px-1.5 py-1 ${view.htf === v ? "border-accent bg-accent/15 text-foreground" : "border-border text-muted hover:text-foreground"}`}>{text}</button>
  );
  return (
    <div className="absolute left-0 z-20 mt-1 grid w-72 max-w-[90vw] gap-2 rounded-md border border-border bg-panel p-2 text-xs shadow-xl">
      <div className="text-muted">Vẽ nến khung lớn mờ phía sau nến khung hiện tại</div>
      {larger.length === 0 ? <p className="text-muted/80">Khung {tfLabel(tf)} là khung lớn nhất.</p> : (
        <div className="flex flex-wrap gap-1">
          {opt(null, "Tắt")}
          {auto && opt("auto", `Tự động (${tfLabel(auto)})`, "Khung lớn kế tiếp chứa ít nhất 4 nến khung hiện tại; tự đổi khi bạn đổi khung")}
          {larger.map((t) => opt(t.tf, t.label))}
        </div>
      )}
      <div className="flex items-center gap-2">
        <span className="text-muted">Độ đậm</span>
        <span className="flex rounded border border-border">
          {HTF_OPACITY.map((o) => (
            <button key={o.v} onClick={() => onChange({ htfOpacity: o.v })}
              className={`px-2 py-0.5 ${view.htfOpacity === o.v ? "bg-accent text-white" : "text-muted hover:text-foreground"}`}>{o.label}</button>
          ))}
        </span>
      </div>
      <p className="text-muted/80">Mỗi nến lớn là một hộp thân với bấc ở giữa, cùng màu tăng/giảm của biểu đồ. Nến lớn đang chạy cập nhật theo giá realtime; 3 nến lớn gần nhất ghi % thay đổi.</p>
      <button onClick={onClose} className="rounded bg-accent px-2 py-1 text-white">Xong</button>
    </div>
  );
}

const NO_EVENTS: ChartEvent[] = [];
const NO_MARKERS: TimedMarker[] = [];
const NO_LINES: PriceLineSpec[] = [];
const NO_SHAPES: Shape[] = [];
const noop = () => {};

/**
 * The second chart beside the main one: its own symbol and timeframe (its own bars and live candle), the main
 * chart's look and, if chosen, its indicators. Drawings of that symbol are shown, not edited.
 */
function SideChart({ split, onChange, onClose, onSwap, view, indicators, usdFactors, drawings }: {
  split: SplitChart; onChange: (s: SplitChart) => void; onClose: () => void; onSwap: () => void;
  view: ChartView; indicators: ActiveIndicator[]; usdFactors: RefObject<Record<string, number>>; drawings: SymbolDrawings | undefined;
}) {
  const info = SYMBOLS[split.symbol];
  const { data, loading, live, streamKey, step, key } = useBarsFeed(split.symbol, split.tf, usdFactors);
  const htf = useHtf(split.symbol, split.tf, view);
  const hlines = useMemo(() => (drawings?.hlines ?? []).map((price) => ({ price, alert: false })), [drawings]);
  const bars = data?.bars ?? NO_BARS;
  return (
    <div className="flex h-[65vh] min-h-[420px] flex-col border-t border-border lg:h-auto lg:min-w-0 lg:flex-1 lg:border-l lg:border-t-0">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-2 py-1 text-xs">
        <select aria-label="Mã của biểu đồ thứ hai" value={split.symbol} onChange={(e) => onChange({ ...split, symbol: e.target.value })} className="py-0.5 text-xs font-semibold">
          {Object.keys(SYMBOLS).map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <LivePrice bars={bars} live={live} liveKey={streamKey} digits={info.digits} />
        <select aria-label="Khung thời gian của biểu đồ thứ hai" value={split.tf} onChange={(e) => onChange({ ...split, tf: e.target.value })} className="py-0.5 text-xs">
          {TIMEFRAMES.map((t) => <option key={t.tf} value={t.tf}>{t.label}</option>)}
        </select>
        <label className="flex cursor-pointer items-center gap-1 text-muted" title="Dùng cùng bộ chỉ báo với biểu đồ chính">
          <input type="checkbox" checked={split.sameIndicators} onChange={(e) => onChange({ ...split, sameIndicators: e.target.checked })} /> Cùng chỉ báo
        </label>
        {htf && <span className="text-muted" title="Nến khung lớn phía sau">🕯 {htf.label}</span>}
        {data?.source && (
          <span className={`rounded border px-1 py-0.5 ${data.realtime ? "border-up/40 text-up" : "border-warn/40 text-warn"}`} title={`Nguồn: ${data.source}`}>
            {data.realtime ? "● Realtime" : "▲ Trễ"}
          </span>
        )}
        <span className="ml-auto flex gap-0.5">
          <button onClick={onSwap} title="Đổi chỗ với biểu đồ chính" className="rounded px-1.5 py-0.5 text-muted hover:bg-panel-2 hover:text-foreground">⇄</button>
          <button onClick={onClose} title="Đóng biểu đồ thứ hai" aria-label="Đóng biểu đồ thứ hai" className="rounded px-1.5 py-0.5 text-muted hover:bg-panel-2 hover:text-down">×</button>
        </span>
      </div>
      <div className="relative min-h-0 flex-1">
        <PriceChart bars={bars} digits={info.digits} barSeconds={step} indicators={split.sameIndicators ? indicators : NO_INDICATORS}
          chartType={view.type} scaleMode={view.scale} magnet={false} style={view.style}
          hlines={hlines} shapes={drawings?.shapes ?? NO_SHAPES} hidden={false} selected={null} events={NO_EVENTS} auto={NO_AUTO} tradeMarkers={NO_MARKERS} tradeLines={NO_LINES}
          tool={null} onAddLine={noop} onAddShape={noop} onSelect={noop} onChangeShape={noop} viewKey={key} htf={htf}
          live={live} liveKey={streamKey} />
        {loading && <div className="absolute inset-0 grid place-items-center bg-background/60 text-sm text-muted">Đang tải {split.symbol}…</div>}
        {!loading && data?.error && <div className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-down">{data.error}</div>}
      </div>
    </div>
  );
}

export function ChartTerminal({ initial, signedIn }: { initial: Initial; signedIn: boolean }) {
  const [symbol, setSymbol] = useState(initial.layout.symbol);
  const [tf, setTf] = useState(initial.layout.tf);
  const [indicators, setIndicators] = useState<ActiveIndicator[]>(initial.layout.indicators);
  const [overlays, setOverlays] = useState<Overlays>(initial.layout.overlays);
  const [watchlist, setWatchlist] = useState(initial.watchlist);
  const [drawings, setDrawings] = useState(initial.drawings);
  const [alerts, setAlerts] = useState(initial.alerts);
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
  const [split, setSplit] = useState<SplitChart | null>(initial.layout.split);
  const [templates, setTemplates] = useState<ChartTemplate[]>(initial.templates);
  const [tplMenu, setTplMenu] = useState(false);
  const [htfMenu, setHtfMenu] = useState(false);
  const [autoMenu, setAutoMenu] = useState(false);
  const [styleFor, setStyleFor] = useState<LayerKey | null>(null);
  const layerStyle = (k: LayerKey): LayerStyle => ({ ...LAYER_STYLE_DEFAULT, ...auto.styles?.[k] });
  const setLayerStyle = (k: LayerKey, s: LayerStyle) => setAuto((a) => ({ ...a, styles: { ...a.styles, [k]: s } }));
  const [styleMenu, setStyleMenu] = useState(false);
  const setStyle = (patch: Partial<ChartStyle>) => setView((v) => ({ ...v, style: { ...v.style, ...patch } }));
  const priceLine = { ...PRICE_LINE_DEFAULT, ...view.style.priceLine };
  const setPriceLine = (patch: Partial<typeof priceLine>) =>
    setView((v) => ({ ...v, style: { ...v.style, priceLine: { ...PRICE_LINE_DEFAULT, ...v.style.priceLine, ...patch } } }));
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

  // ---------- bars: load, then keep fresh (feed.ts) ----------
  // gold, silver, oil from the USDT perpetual: shown in spot USD like MT5's XAUUSD (liveSpotUsdFactors)
  const usdFactors = useRef<Record<string, number>>({});
  const futTickers = [...new Set([...watchlist, symbol, ...(split ? [split.symbol] : [])].filter((s) => SYMBOLS[s]?.futures && !SYMBOLS[s]?.binance).map((s) => SYMBOLS[s].futures!))].sort().join(",");
  useEffect(() => liveSpotUsdFactors(futTickers ? futTickers.split(",") : [], usdFactors.current), [futTickers]);
  const { data, loading, updatedAt, live, stream, streamKey, step, tfInfo, key } = useBarsFeed(symbol, tf, usdFactors);
  const htf = useHtf(symbol, tf, view);

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
  // Binance-priced symbols: the 24h ticker streamed from Binance (live). The rest: the daily bars API every minute.
  useEffect(() => {
    let alive = true;
    // a perpetual's USDT quote in spot USD, like the chart (24h change scaled the same way; % unchanged)
    const factors = usdFactors.current;
    const toUsd = (s: string, q: ReturnType<typeof quoteFromTicker>) => {
      const i = SYMBOLS[s];
      const f = !i?.binance && i?.futures ? factors[i.futures] : undefined;
      return q && f ? { ...q, price: q.price * f, change: q.change * f } : q;
    };
    const ticker = async (s: string) => {
      const i = SYMBOLS[s];
      const url = i?.binance ? `${BINANCE_SPOT_HOST}/api/v3/ticker/24hr?symbol=${i.binance}`
        : i?.futures ? `${BINANCE_FUTURES_HOST}/fapi/v1/ticker/24hr?symbol=${i.futures}` : null;
      if (!url) return null;
      try {
        const r = await fetch(url);
        return r.ok ? toUsd(s, quoteFromTicker(await r.json())) : null;
      } catch { return null; }
    };
    const daily = async (s: string) => {
      try {
        const r = await fetch(`/api/bars?symbol=${s}&tf=1D&limit=2`);
        const j: { bars: Bar[] } = await r.json();
        return r.ok ? quoteFromDaily(j.bars) : null;
      } catch { return null; }
    };
    const live = watchlist.filter((s) => SYMBOLS[s]?.binance || SYMBOLS[s]?.futures);
    const merge = (rows: (readonly [string, ReturnType<typeof quoteFromDaily>])[]) => {
      if (alive) setQuotes((q) => ({ ...q, ...Object.fromEntries(rows.filter(([, v]) => v)) }));
    };
    // Live symbols: one REST call for a first price, then the `@ticker` stream (one event a second). A symbol whose
    // stream says nothing for 15 s (Binance blocked here) is polled again, and falls back to the daily bars.
    const heard: Record<string, number> = {};
    const pending: Record<string, ReturnType<typeof quoteFromDaily>> = {};
    const closers = live.map((s) => liveSocket(tickerStreamUrl(SYMBOLS[s])!, (msg) => {
      const q = toUsd(s, quoteFromTicker(msg));
      if (q) { pending[s] = q; heard[s] = Date.now(); }
    }));
    const flush = setInterval(() => {
      const rows = Object.entries(pending);
      if (!rows.length) return;
      for (const [s] of rows) delete pending[s];
      merge(rows);
    }, 1000);
    const runLive = (only?: string[]) =>
      Promise.all((only ?? live).map(async (s) => [s, (await ticker(s)) ?? (await daily(s))] as const)).then(merge);
    const runDaily = () => Promise.all(watchlist.filter((s) => !live.includes(s)).map(async (s) => [s, await daily(s)] as const)).then(merge);
    runLive(); runDaily();
    const t1 = setInterval(() => {
      const silent = live.filter((s) => Date.now() - (heard[s] ?? 0) > 15_000);
      if (silent.length) runLive(silent);
    }, 15_000);
    const t2 = setInterval(runDaily, 60_000);
    return () => { alive = false; closers.forEach((c) => c()); clearInterval(flush); clearInterval(t1); clearInterval(t2); };
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
      const state = { symbol, tf, indicators, overlays, view, auto, split };
      const { data: auth } = await supabase.auth.getUser();
      if (!auth.user) return setSaveState("error");
      const res = ids.current.layout
        ? await supabase.from("layouts").update({ state, updated_at: new Date().toISOString() }).eq("id", ids.current.layout)
        : await supabase.from("layouts").insert({ user_id: auth.user.id, name: "default", state }).select("id").single();
      if (!ids.current.layout && res.data && "id" in res.data) ids.current.layout = res.data.id as string;
      setSaveState(res.error ? "error" : "saved");
    }, 800);
  }, [symbol, tf, indicators, overlays, view, auto, split, supabase]);

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

  // ---------- second chart beside the main one ----------
  const openSplit = (sym?: string) => {
    const other = sym ?? watchlist.find((s) => s !== symbol) ?? Object.keys(SYMBOLS).find((s) => s !== symbol)!;
    setSplit((sp) => ({ symbol: other, tf: sp?.tf ?? tf, sameIndicators: sp?.sameIndicators ?? true }));
  };
  const swapSplit = () => {
    if (!split) return;
    setSplit({ ...split, symbol, tf });
    setSymbol(split.symbol); setTf(split.tf); setTool(null); setSelected(null);
  };

  // ---------- templates: indicators, chart look and automatic reading, saved by name (layout.ts) ----------
  // signed in: rows of the layouts table (name "template:…"); signed out: this browser only
  useEffect(() => {
    if (signedIn) return;
    try {
      const raw: unknown = JSON.parse(window.localStorage.getItem(TEMPLATES_KEY) ?? "[]");
      const list = Array.isArray(raw) ? raw.flatMap((t: { id?: unknown; name?: unknown; state?: unknown }) => {
        const c = cleanTemplate(t?.id, t?.name, t?.state);
        return c ? [c] : [];
      }) : [];
      // eslint-disable-next-line react-hooks/set-state-in-effect -- read once after mount: storage is not there on the server
      if (list.length) setTemplates(list);
    } catch { /* storage blocked or bad JSON: no templates */ }
  }, [signedIn]);
  const keepLocal = (list: ChartTemplate[]) => {
    try { window.localStorage.setItem(TEMPLATES_KEY, JSON.stringify(list)); } catch { /* storage blocked: this visit only */ }
  };
  const byName = (a: ChartTemplate, b: ChartTemplate) => a.name.localeCompare(b.name, "vi");
  const saveTemplate = async (raw: string) => {
    const name = raw.trim().slice(0, 40);
    if (!name) return false;
    const state: TemplateState = { indicators, overlays, view, auto };
    const old = templates.find((t) => t.name.toLowerCase() === name.toLowerCase());
    if (old && !window.confirm(`Đã có mẫu “${old.name}”. Ghi đè bằng thiết lập hiện tại?`)) return false;
    if (!supabase) {
      const next = [...templates.filter((t) => t.id !== old?.id), { id: old?.id ?? uid(), name, state }].sort(byName);
      setTemplates(next); keepLocal(next);
      setNotice(`💾 Đã lưu mẫu “${name}” trên trình duyệt này. Đăng nhập để mẫu đi theo tài khoản.`);
      return true;
    }
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) { setNotice("Phiên đăng nhập đã hết, tải lại trang để lưu mẫu."); return false; }
    const row = { name: TEMPLATE_PREFIX + name, state, updated_at: new Date().toISOString() };
    const res = old
      ? await supabase.from("layouts").update(row).eq("id", old.id).select("id").single()
      : await supabase.from("layouts").insert({ user_id: auth.user.id, ...row }).select("id").single();
    if (res.error || !res.data) { setNotice(`Không lưu được mẫu: ${res.error?.message ?? ""}`); return false; }
    const id = res.data.id as string;
    setTemplates((ts) => [...ts.filter((t) => t.id !== old?.id), { id, name, state }].sort(byName));
    setNotice(`💾 Đã lưu mẫu “${name}”.`);
    return true;
  };
  /** The template's indicators, look and automatic reading on the current symbol and timeframe. */
  const applyTemplate = (t: ChartTemplate) => {
    setIndicators(t.state.indicators.map((i) => ({ ...i, uid: uid() })));
    setOverlays(t.state.overlays);
    setView((v) => ({ ...t.state.view, magnet: v.magnet }));
    setAuto(t.state.auto);
    setEditing(null); setTplMenu(false);
    setNotice(`Đã áp dụng mẫu “${t.name}”.`);
  };
  const deleteTemplate = async (t: ChartTemplate) => {
    if (!window.confirm(`Xoá mẫu “${t.name}”?`)) return;
    if (supabase) {
      const { error } = await supabase.from("layouts").delete().eq("id", t.id);
      if (error) return setNotice(`Không xoá được mẫu: ${error.message}`);
    }
    const next = templates.filter((x) => x.id !== t.id);
    setTemplates(next);
    if (!supabase) keepLocal(next);
  };

  // ---------- drawings: horizontal lines and shapes, one row per symbol ----------
  const alertAt = (price: number) => alerts.find((a) => a.symbol === symbol && Math.abs(a.price - price) < 1e-9);
  const mine = drawings[symbol];
  const hlinePrices = useMemo(() => mine?.hlines ?? [], [mine]);
  const shapes = useMemo(() => mine?.shapes ?? [], [mine]);
  const saveDrawing = async (next: { hlines: number[]; shapes: Shape[] }, undoable = true) => {
    const current = drawings[symbol];
    if (undoable) {
      const h = history.current[symbol] ?? (history.current[symbol] = []);
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
    const now = data ? withLive(data.bars, stream ?? "", live.get()) : [];
    const cur = now[now.length - 1]?.close;
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
  /** null puts that output back to the indicator's own colour, width and dash */
  const setOutputStyle = (u: string, key: string, s: OutputStyle | null) =>
    setIndicators((xs) => xs.map((x) => {
      if (x.uid !== u) return x;
      const styles = { ...x.styles };
      if (s) styles[key] = s; else delete styles[key];
      return { ...x, styles: Object.keys(styles).length ? styles : undefined };
    }));

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

  // closed candles plus the forming one as of the last new candle or reload; live ticks are merged in by the
  // subscribers (LivePrice, LiveBrief, PriceChart) and, every 5 s, by the detectors
  const bars = data?.bars ?? NO_BARS;
  const filtered = MENU.filter((d) => !query || d.name.toLowerCase().includes(query.toLowerCase()) || d.id.includes(query.toLowerCase()));
  const notInList = Object.keys(SYMBOLS).filter((s) => !watchlist.includes(s));
  const activeTool = TOOLS.find((t) => t.id === tool);

  // ---------- automatic chart reading (all in the browser, on the loaded bars) ----------
  // re-read at most every 5 s while the forming candle streams; at once on a new candle, symbol or timeframe
  const rawBars = useSettledBars(data?.bars, live, streamKey, 5000);
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
      elliott: auto.elliott && bs.length ? elliottWaves(bs, { depth: auto.depth, upOnly: auto.waveUpOnly }) : null,
    };
  }, [rawBars, auto, step]);
  const autoDraw = useMemo<AutoDraw>(() => {
    if (!found.patterns.length && !found.wedges.length && !found.levels.length && !found.periods.length && !found.sessions.length && !found.elliott) return NO_AUTO;
    return {
      styles: auto.styles,
      // the three newest patterns that still matter; older ones stay listed only while they are recent
      patterns: [
        ...found.wedges.filter((w) => w.stage !== "expired").slice(0, 3).map((w) => ({ ...w, layer: "wedges" as const, name: `${w.name} ${w.score}đ` })),
        ...found.patterns.filter((p) => p.status !== "expired").slice(0, 3).map((p) => ({ ...p, layer: "chart" as const })),
      ],
      levels: [
        ...found.levels.map((l) => ({
          layer: "levels" as const, price: l.price, from: l.first, color: l.side === "support" ? COLORS.up : COLORS.down, width: 0.5 + l.strength * 0.5, dashed: false,
          label: `Key ${fmt(l.price, info.digits)} · ${l.swings} lần`,
        })),
        ...found.periods.map((p) => ({ layer: "periods" as const, price: p.price, from: p.time, color: COLORS.muted, width: 1, dashed: true, label: `${p.label} ${fmt(p.price, info.digits)}` })),
      ],
      sessions: found.sessions,
      waves: found.elliott && {
        points: found.elliott.points.map((q) => ({ t: q.time, p: q.price, label: q.label, provisional: q.provisional })),
        target: found.elliott.target,
        color: auto.waveColor,
      },
    };
  }, [found, info.digits, auto.waveColor, auto.styles]);
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
      <aside className="order-first border-b border-border bg-panel lg:order-last lg:max-h-[calc(100vh-4rem)] lg:w-64 lg:shrink-0 lg:overflow-y-auto lg:border-b-0 lg:border-l wl-collapsed:lg:w-10">
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
                <button onClick={() => openSplit(s)} title="Mở mã này ở biểu đồ thứ hai, bên cạnh"
                  className="absolute bottom-0 right-0 hidden px-1 text-xs text-muted hover:text-accent group-hover:block">⧉</button>
                {watchlist.length > 1 && (
                  <button onClick={() => saveWatchlist(watchlist.filter((x) => x !== s))} title="Bỏ khỏi watchlist"
                    className="absolute right-0 top-0 hidden px-1 text-xs text-muted hover:text-down group-hover:block">×</button>
                )}
              </li>
            );
          })}
        </ul>
        <LiveBrief live={live} liveKey={streamKey} symbol={symbol} tfLabel={tfInfo.label} bars={bars} digits={info.digits} elliott={found.elliott} quotes={quotes}
          onPick={(m) => { setSymbol(m); setTool(null); setSelected(null); }} />
      </aside>

      {/* Chart area */}
      <section ref={shell} className="flex min-w-0 flex-1 flex-col bg-background">
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
          <div className="mr-2">
            <span className="text-base font-semibold">{symbol}</span>
            <LivePrice bars={bars} live={live} liveKey={streamKey} digits={info.digits} />
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
                <div className="text-muted">Đường giá hiện tại</div>
                <div className="grid gap-1.5 rounded border border-border px-2 py-1.5">
                  <label className="flex cursor-pointer items-center gap-2">
                    <input type="checkbox" checked={priceLine.visible} onChange={(e) => setPriceLine({ visible: e.target.checked })} />
                    <span>Hiện đường ngang và nhãn giá ở trục phải</span>
                  </label>
                  <div className={`flex items-center gap-1.5 ${priceLine.visible ? "" : "pointer-events-none opacity-50"}`}>
                    <label className="flex cursor-pointer items-center gap-1" title="Bỏ chọn: đường đổi màu theo nến cuối (xanh khi tăng, đỏ khi giảm)">
                      <input type="checkbox" checked={!!priceLine.color} onChange={(e) => setPriceLine({ color: e.target.checked ? "#f5d742" : null })} />
                      <span>{priceLine.color ? "Màu" : "Theo nến"}</span>
                    </label>
                    {priceLine.color && (
                      <input type="color" value={priceLine.color} onChange={(e) => setPriceLine({ color: e.target.value })} aria-label="Màu đường giá"
                        className="h-6 w-8 shrink-0 cursor-pointer rounded border border-border bg-transparent p-0" />
                    )}
                    <select value={priceLine.width} onChange={(e) => setPriceLine({ width: Number(e.target.value) as 1 | 2 | 3 | 4 })} aria-label="Độ dày đường giá" title="Độ dày nét" className="w-16 shrink-0">
                      {[1, 2, 3, 4].map((w) => <option key={w} value={w}>{w}px</option>)}
                    </select>
                    <select value={priceLine.dash} onChange={(e) => setPriceLine({ dash: e.target.value as LineDash })} aria-label="Kiểu nét đường giá" title="Kiểu nét" className="min-w-0 flex-1">
                      {LINE_DASHES.map((d) => <option key={d.v} value={d.v}>{d.label}</option>)}
                    </select>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-muted">Màu biểu đồ Đường / Vùng</span>
                  <input type="color" value={view.style.lineColor ?? "#4f8cff"} onChange={(e) => setStyle({ lineColor: e.target.value })} aria-label="Màu biểu đồ đường"
                    className="h-6 w-8 shrink-0 cursor-pointer rounded border border-border bg-transparent p-0" />
                  {view.style.lineColor && <button onClick={() => setStyle({ lineColor: null })} className="text-muted hover:text-foreground" title="Về màu xanh mặc định">↺</button>}
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
          <div className="relative">
            <button onClick={() => setHtfMenu((m) => !m)} title="Hiện nến của khung thời gian lớn hơn phía sau nến khung hiện tại, để thấy rõ xu hướng"
              className={`rounded-md border px-2 py-1 text-xs hover:bg-panel-2 ${htf ? "border-accent/50 text-accent" : "border-border text-muted hover:text-foreground"}`}>
              🕯 {htf ? `Nến ${htf.label}` : "Nến khung lớn"}
            </button>
            {htfMenu && <HtfMenu tf={tf} view={view} onChange={(patch) => setView((v) => ({ ...v, ...patch }))} onClose={() => setHtfMenu(false)} />}
          </div>
          <div className="relative">
            <button onClick={() => setTplMenu((m) => !m)} title="Lưu thiết lập hiện tại thành mẫu, hoặc áp dụng mẫu đã lưu"
              className="rounded-md border border-border px-2 py-1 text-xs text-muted hover:bg-panel-2 hover:text-foreground">📑 Mẫu{templates.length ? ` (${templates.length})` : ""}</button>
            {tplMenu && <TemplateMenu templates={templates} signedIn={signedIn} onSave={saveTemplate} onApply={applyTemplate} onDelete={(t) => void deleteTemplate(t)} onClose={() => setTplMenu(false)} />}
          </div>
          <button onClick={() => (split ? setSplit(null) : openSplit())} aria-pressed={!!split}
            title={split ? "Đóng biểu đồ thứ hai" : "Mở thêm một biểu đồ của mã khác bên cạnh"}
            className={`rounded-md border px-2 py-1 text-xs hover:bg-panel-2 ${split ? "border-accent/50 text-accent" : "border-border text-muted hover:text-foreground"}`}>⧉ 2 biểu đồ</button>
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
          <TrendAlertsButton signedIn={signedIn} />
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
                  <div key={l.key} className="grid gap-1">
                    <div className="flex items-start gap-1">
                      <label className="flex flex-1 cursor-pointer items-start gap-2 rounded px-1 py-0.5 hover:bg-panel-2">
                        <input type="checkbox" checked={auto[l.key]} onChange={(e) => setAuto((a) => ({ ...a, [l.key]: e.target.checked }))} className="mt-0.5" />
                        <span><span className="block text-foreground">{l.label}</span><span className="text-muted">{l.hint}</span></span>
                      </label>
                      {STYLED_LAYERS.has(l.key) && (
                        <button onClick={() => setStyleFor((k) => (k === l.key ? null : (l.key as LayerKey)))} title="Tuỳ chỉnh hiển thị lớp này: độ đậm, độ dày nét, độ dài cạnh"
                          aria-label={`Tuỳ chỉnh hiển thị: ${l.label}`}
                          className={`rounded px-1.5 py-0.5 ${styleFor === l.key ? "bg-accent/20 text-foreground" : "text-muted hover:text-foreground"}`}>⚙</button>
                      )}
                    </div>
                    {styleFor === l.key && <LayerStyleControls k={l.key as LayerKey} value={layerStyle(l.key as LayerKey)} onChange={(s) => setLayerStyle(l.key as LayerKey, s)} />}
                  </div>
                ))}
                {auto.elliott && (
                  <div className="grid gap-1.5 rounded border border-border px-2 py-1.5">
                    <span className="text-foreground">Sóng Elliott</span>
                    <label className="flex cursor-pointer items-start gap-2" title="Theo Elliott, sóng đẩy đi theo xu hướng lớn: thị trường giá xuống có sóng đẩy 1-5 đi xuống và A-B-C là nhịp hồi lên. Bật mục này nếu bạn muốn 1-5 chỉ dùng cho sóng tăng, nhịp giảm luôn đọc là A-B-C.">
                      <input type="checkbox" className="mt-0.5" checked={auto.waveUpOnly} onChange={(e) => setAuto((a) => ({ ...a, waveUpOnly: e.target.checked }))} />
                      <span>Chỉ đếm sóng đẩy tăng (1-5 đi lên, nhịp giảm là A-B-C)<span className="block text-muted">Tắt: theo đúng Elliott, sóng đẩy đi theo xu hướng, nên khi thị trường giảm 1-5 sẽ đi xuống</span></span>
                    </label>
                    <div className="flex items-center gap-1.5">
                      <span className="text-muted">Màu sóng 1-5</span>
                      {WAVE_COLORS.map((c) => (
                        <button key={c.v} onClick={() => setAuto((a) => ({ ...a, waveColor: c.v }))} title={c.label} aria-label={`Màu sóng: ${c.label}`}
                          className={`h-4 w-4 rounded-full border ${auto.waveColor === c.v ? "border-foreground ring-2 ring-accent" : "border-border"}`} style={{ background: c.v }} />
                      ))}
                      <span className="ml-1 text-muted">A-B-C luôn màu cam</span>
                    </div>
                  </div>
                )}
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
                  <button onClick={() => setEditing(editing === ind.uid ? null : ind.uid)} title="Sửa tham số, màu và kiểu nét">
                    {(def?.outputs ?? []).slice(0, 3).map((o) => (
                      <span key={o.key} aria-hidden className="mr-0.5 inline-block h-2 w-2 rounded-full align-middle" style={{ background: ind.styles?.[o.key]?.color ?? o.color }} />
                    ))}
                    {def?.name.replace(/\s*\(.*\)$/, "") ?? ind.id}{paramText(ind) && <span className="text-muted"> ({paramText(ind)})</span>}
                  </button>
                  <button onClick={() => setIndicators((xs) => xs.filter((x) => x.uid !== ind.uid))} className="text-muted hover:text-down" title="Xoá">×</button>
                  {editing === ind.uid && (
                    <div className="absolute left-0 top-full z-20 mt-1 grid w-72 gap-2 rounded-md border border-border bg-panel p-2 shadow-xl">
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
                      <OutputStyleControls ind={ind} onChange={(k, s) => setOutputStyle(ind.uid, k, s)} />
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
              Nhận diện ({wedgeChips.length + patternChips.length + (liveCandle ? 1 : 0) + (found.elliott ? 1 : 0)})
            </PanelToggle>
            <span className={`contents pat-collapsed:hidden ${indHidden ? "[&>*]:opacity-50" : ""}`}>
            {found.elliott && (
              <span className={`rounded border px-1.5 py-0.5 ${found.elliott.stage.startsWith("w") ? (found.elliott.dir > 0 ? "border-up/40 text-up" : "border-down/40 text-down") : "border-warn/40 text-warn"}`}
                title={[
                  `Điểm phù hợp quy tắc phụ: ${found.elliott.score}`,
                  found.elliott.target ? `${found.elliott.target.label}: ${fmt(found.elliott.target.price, info.digits)}` : "",
                  "Đếm sóng tự động, có thể đếm lại khi có đỉnh/đáy mới. Chỉ để tham khảo, không phải khuyến nghị.",
                ].filter(Boolean).join("\n")}>
                〰 {found.elliott.text}{found.elliott.target ? ` → ${fmt(found.elliott.target.price, info.digits)}` : ""}
              </span>
            )}
            {auto.elliott && !found.elliott && rawBars?.length ? (
              <span className="rounded border border-border px-1.5 py-0.5 text-muted" title="Không có sóng đẩy 1-5 nào đúng 3 quy tắc cứng kết thúc gần đây. Thử khung thời gian khác hoặc độ nhạy Đỉnh/đáy khác.">
                〰 Elliott: chưa có số đếm rõ ở khung này
              </span>
            ) : null}
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

        <div className="flex flex-col lg:min-h-0 lg:flex-1 lg:flex-row">
        <div className="relative h-[65vh] min-h-[420px] lg:h-auto lg:min-w-0 lg:flex-1">
          <PriceChart ref={chartApi} bars={bars} digits={info.digits} barSeconds={tfSeconds(tf)} indicators={indHidden ? NO_INDICATORS : indicators}
            chartType={view.type} scaleMode={view.scale} magnet={view.magnet} style={view.style}
            hlines={hlines} shapes={shapes} hidden={hidden} selected={selected} events={events} auto={indHidden ? NO_AUTO : autoDraw} tradeMarkers={chartMarkers} tradeLines={tradeLines} patternText={!textHidden}
            tool={tool} onAddLine={addLine} onAddShape={addShape} onSelect={setSelected} onChangeShape={changeShape} viewKey={key}
            live={live} liveKey={streamKey} htf={htf} />
          {loading && <div className="absolute inset-0 grid place-items-center bg-background/60 text-sm text-muted">Đang tải {symbol}…</div>}
          {!loading && data?.error && (
            <div className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-down">{data.error}</div>
          )}
        </div>
        {split && (
          <SideChart split={split} onChange={setSplit} onClose={() => setSplit(null)} onSwap={swapSplit}
            view={view} indicators={indHidden ? NO_INDICATORS : indicators} usdFactors={usdFactors} drawings={drawings[split.symbol]} />
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
          <LiveUpdated at={updatedAt} live={live} />
          {data?.note && <span className="text-warn">{data.note}</span>}
          {overlays.trades && signedIn && (trades.trades.length > 0 || trades.positions.length > 0) && (
            <span>Lệnh copy 14 ngày: {trades.trades.filter((t) => t.kind === "open").length} lệnh mở · {trades.positions.length} vị thế đang mở</span>
          )}
          {info.broker && !data?.source.startsWith("Giá broker") && <span>Khi EA master gửi nến M1, biểu đồ chuyển sang giá broker (khớp giá MT5 nhất).</span>}
          {info.futures && !data?.realtime && !usesFutures(info, tf) && <span>Khung H4 trở xuống có giá realtime (Binance Futures {info.futures}).</span>}
          {/* the chart library's licence asks for its notice and a link on the page when the logo is off the chart */}
          <a href="https://www.tradingview.com/" target="_blank" rel="noopener noreferrer" className="ml-auto text-muted/70 hover:text-foreground">
            Biểu đồ: TradingView Lightweight Charts™ · © TradingView, Inc.
          </a>
        </div>
      </section>
    </div>
  );
}
