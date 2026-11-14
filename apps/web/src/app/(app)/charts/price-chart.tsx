"use client";
import { useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import {
  createChart, createSeriesMarkers, CandlestickSeries, BarSeries, AreaSeries, HistogramSeries, LineSeries, PriceScaleMode,
  type IChartApi, type ISeriesApi, type IPriceLine, type UTCTimestamp, type SeriesMarker, type Time, type SeriesType,
} from "lightweight-charts";
import { BY_ID, compute } from "@qt/core/indicators";
import { ChartOverlay, SHAPE_POINTS, TimeIndex, type ChartEvent, type Pt, type Shape, type ShapeKind } from "./chart-overlay";

export type Bar = { time: number; open: number; high: number; low: number; close: number; volume: number };
export type ActiveIndicator = { uid: string; id: string; params: Record<string, unknown> };
export type Tool = null | "hline" | ShapeKind;
export type ChartType = "candles" | "hollow" | "heikin" | "bars" | "line" | "area";
export type ScaleMode = "normal" | "log" | "percent";
/** A marker at any unix time; it is moved onto the bar that contains it. */
export type TimedMarker = { time: number; position: "aboveBar" | "belowBar" | "inBar"; shape: "arrowUp" | "arrowDown" | "circle" | "square"; color: string; text?: string };
export type PriceLineSpec = { price: number; color: string; title: string; dashed?: boolean };
export type HLine = { price: number; alert: boolean };
/** What the toolbar can ask the chart to do. */
export type ChartHandle = {
  screenshot: () => HTMLCanvasElement | null;
  /** Show the last `seconds` of history, or everything when null. */
  showRange: (seconds: number | null) => void;
  toLatest: () => void;
};

const C = { bg: "#0b0f17", grid: "#1a2230", text: "#8292a8", border: "#263244", up: "#00c087", down: "#f45b69", line: "#4f8cff" };
const SCALE: Record<ScaleMode, PriceScaleMode> = { normal: PriceScaleMode.Normal, log: PriceScaleMode.Logarithmic, percent: PriceScaleMode.Percentage };
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const sid = () => Math.random().toString(36).slice(2, 9);
const fmtNum = (v: number, d: number) => v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtVol = (v: number) => v >= 1e9 ? `${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(2)}K` : v.toFixed(2);

/** Heikin Ashi candles (smoothed: each open is the midpoint of the previous candle's body). */
export function heikinAshi(bars: Bar[]): Bar[] {
  const out: Bar[] = [];
  for (const b of bars) {
    const close = (b.open + b.high + b.low + b.close) / 4;
    const prev = out[out.length - 1];
    const open = prev ? (prev.open + prev.close) / 2 : (b.open + b.close) / 2;
    out.push({ time: b.time, open, close, high: Math.max(b.high, open, close), low: Math.min(b.low, open, close), volume: b.volume });
  }
  return out;
}

/** Time left until the current bar closes (for bars up to a day long; hidden when the bar is already over). */
function BarCountdown({ open, step }: { open: number; step: number }) {
  const [now, setNow] = useState(0);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const t = setInterval(tick, 1000);
    return () => { clearTimeout(first); clearInterval(t); };
  }, []);
  const left = open + step - now / 1000;
  if (!now || step > 86400 || left <= 0 || left > step) return null;
  const s = Math.floor(left), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return <span className="text-muted" title="Thời gian còn lại của nến hiện tại">⏳ {h ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`}</span>;
}

type Props = {
  bars: Bar[];
  digits: number;
  barSeconds: number;
  chartType: ChartType;
  scaleMode: ScaleMode;
  indicators: ActiveIndicator[];
  hlines: HLine[];
  shapes: Shape[];
  hidden: boolean;
  selected: string | null;
  magnet: boolean;
  events: ChartEvent[];
  tradeMarkers: TimedMarker[];
  tradeLines: PriceLineSpec[];
  tool: Tool;
  onAddLine: (price: number) => void;
  onAddShape: (shape: Shape) => void;
  onSelect: (id: string | null) => void;
  /** Bumps when the symbol/timeframe changes, so the view refits instead of keeping the old zoom. */
  viewKey: string;
  ref?: Ref<ChartHandle>;
};

/**
 * Price series (several styles) + indicators (overlay or own pane) + horizontal price lines + drawings, economic
 * events and copy-trade activity, on Lightweight Charts v5. The library's attribution logo stays on (licence).
 */
export function PriceChart(props: Props) {
  const { bars, digits, barSeconds, chartType, scaleMode, indicators, hlines, shapes, hidden, selected, events, tradeMarkers, tradeLines, tool, viewKey, ref } = props;
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const main = useRef<ISeriesApi<SeriesType> | null>(null);
  const overlay = useRef<ChartOverlay>(new ChartOverlay());
  const extra = useRef<ISeriesApi<"Line" | "Histogram">[]>([]);
  const lines = useRef<IPriceLine[]>([]);
  const posLines = useRef<IPriceLine[]>([]);
  const markers = useRef<ReturnType<typeof createSeriesMarkers<Time>> | null>(null);
  const fittedFor = useRef("");
  const points = useRef<Pt[]>([]);
  const live = useRef(props);
  useEffect(() => { live.current = props; });
  const [hover, setHover] = useState<number | null>(null);

  const display = useMemo(() => (chartType === "heikin" ? heikinAshi(bars) : bars), [bars, chartType]);
  const index = useMemo(() => new TimeIndex(bars.map((b) => b.time), barSeconds), [bars, barSeconds]);
  const computed = useMemo(() => indicators.flatMap((ind) => {
    const def = BY_ID[ind.id];
    if (!def || !bars.length) return [];
    try { return [{ ind, def, out: compute(ind.id, bars, ind.params) }]; } catch { return []; }
  }), [bars, indicators]);

  useImperativeHandle(ref, () => ({
    screenshot: () => chart.current?.takeScreenshot(true, false) ?? null,
    showRange: (seconds) => {
      const c = chart.current, { bars: bs, barSeconds: step } = live.current;
      if (!c || !bs.length) return;
      if (seconds == null) { c.timeScale().fitContent(); return; }
      const idx = new TimeIndex(bs.map((b) => b.time), step);
      const from = Math.max(0, idx.logical(bs[bs.length - 1].time - seconds));
      c.timeScale().setVisibleLogicalRange({ from, to: bs.length - 1 + 5 });
    },
    toLatest: () => chart.current?.timeScale().scrollToRealTime(),
  }), []);

  // create once
  useEffect(() => {
    if (!host.current) return;
    const c = createChart(host.current, {
      autoSize: true,
      layout: { background: { color: C.bg }, textColor: C.text, fontFamily: "var(--font-geist-sans), system-ui", panes: { separatorColor: C.border }, attributionLogo: true },
      grid: { vertLines: { color: C.grid }, horzLines: { color: C.grid } },
      rightPriceScale: { borderColor: C.border },
      timeScale: { borderColor: C.border, timeVisible: true, secondsVisible: false, rightOffset: 12 },
      crosshair: { mode: 0 },
    });
    const o = overlay.current;

    /** Screen point -> (time, price), pulled onto the nearest open/high/low/close when the magnet is on. */
    const toPt = (x: number, y: number): Pt | null => {
      const pt = o.toPoint(x, y);
      const { magnet, bars: bs } = live.current;
      if (!pt || !magnet) return pt;
      const i = o.index.barAt(pt.t);
      const b = i == null ? null : bs[i];
      if (!b) return pt;
      const near = [b.open, b.high, b.low, b.close].reduce((best, v) => (Math.abs(v - pt.p) < Math.abs(best - pt.p) ? v : best));
      return { t: b.time, p: near };
    };
    const draft = (kind: ShapeKind, pts: Pt[], cur: Pt | null): Shape | null => {
      const all = cur ? [...pts, cur] : pts;
      if (!all.length) return null;
      return { id: "preview", kind, a: all[0], b: all[1] ?? all[0], ...(all[2] ? { c: all[2] } : {}) };
    };

    // Shape tools: each click adds a point; the crosshair previews; the last click finishes.
    // Two quick clicks arrive as a double-click (the second "click" is not reported), so both are handled.
    const onPoint = (p: { point?: { x: number; y: number } }) => {
      const { tool: t, onAddLine, onAddShape, onSelect } = live.current;
      if (!p.point) return;
      const s = main.current;
      if (!t) {
        onSelect(o.shapeAt(p.point.x, p.point.y, host.current?.clientWidth ?? 0));
        return;
      }
      if (t === "hline") {
        const price = s?.coordinateToPrice(p.point.y);
        if (price != null) onAddLine(Number(price));
        return;
      }
      const pt = toPt(p.point.x, p.point.y);
      if (!pt) return;
      const prev = points.current[points.current.length - 1];
      if (prev && prev.t === pt.t && Math.abs(prev.p - pt.p) < 1e-9) return;   // the same click reported twice
      const pts = [...points.current, pt];
      if (pts.length < SHAPE_POINTS[t]) { points.current = pts; return; }
      points.current = [];
      o.update({ preview: null });
      let text: string | undefined;
      if (t === "text") {
        text = window.prompt("Nội dung ghi chú", "")?.trim().slice(0, 120);
        if (!text) return;
      }
      const shape = draft(t, pts, null)!;
      onAddShape({ ...shape, id: sid(), ...(text ? { text } : {}) });
    };
    c.subscribeClick(onPoint);
    c.subscribeDblClick(onPoint);
    c.subscribeCrosshairMove((p) => {
      const { tool: t, bars: bs } = live.current;
      // legend follows the crosshair; off the chart it shows the last bar
      const i = p.logical == null || !p.point ? null : Math.round(p.logical);
      setHover(i != null && i >= 0 && i < bs.length ? i : null);
      if (!t || t === "hline" || !p.point) return;
      const pt = toPt(p.point.x, p.point.y);
      if (pt) o.update({ preview: draft(t, points.current, pt) });
    });

    chart.current = c;
    return () => {
      c.remove();
      chart.current = null; main.current = null; markers.current = null; extra.current = []; lines.current = []; posLines.current = [];
    };
  }, []);

  // the price series: rebuilt when the style changes, and the overlay and markers move to the new one
  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    const candle = { upColor: C.up, downColor: C.down, borderUpColor: C.up, borderDownColor: C.down, wickUpColor: C.up, wickDownColor: C.down };
    const s: ISeriesApi<SeriesType> =
      chartType === "bars" ? c.addSeries(BarSeries, { upColor: C.up, downColor: C.down, thinBars: false })
      : chartType === "line" ? c.addSeries(LineSeries, { color: C.line, lineWidth: 2 })
      : chartType === "area" ? c.addSeries(AreaSeries, { lineColor: C.line, topColor: "rgba(79,140,255,0.35)", bottomColor: "rgba(79,140,255,0.02)", lineWidth: 2 })
      : c.addSeries(CandlestickSeries, chartType === "hollow" ? { ...candle, upColor: "rgba(0,0,0,0)" } : candle, 0);
    const o = overlay.current;
    s.attachPrimitive(o);
    const m = createSeriesMarkers(s, []);
    markers.current = m;
    main.current = s;
    return () => {
      if (chart.current !== c) return;   // the chart is already gone
      s.detachPrimitive(o);
      m.detach();
      markers.current = null; lines.current = []; posLines.current = [];
      c.removeSeries(s);
      main.current = null;
    };
  }, [chartType]);

  // price format and scale
  useEffect(() => {
    main.current?.applyOptions({ priceFormat: { type: "price", precision: digits, minMove: 1 / 10 ** digits } });
    overlay.current.update({ digits });
  }, [digits, chartType]);
  useEffect(() => {
    chart.current?.priceScale("right").applyOptions({ mode: SCALE[scaleMode] });
  }, [scaleMode]);

  // switching or leaving a tool drops a half-drawn shape
  useEffect(() => {
    points.current = [];
    overlay.current.update({ preview: null });
  }, [tool]);

  // prices + indicators + markers
  useEffect(() => {
    const c = chart.current, s = main.current;
    if (!c || !s) return;
    const line = chartType === "line" || chartType === "area";
    s.setData(display.map((b) => (line ? { time: b.time as UTCTimestamp, value: b.close } : { ...b, time: b.time as UTCTimestamp })));
    overlay.current.update({ index });

    for (const x of extra.current) c.removeSeries(x);
    extra.current = [];
    while (c.panes().length > 1) c.removePane(c.panes().length - 1);

    const allMarkers: SeriesMarker<Time>[] = [];
    let pane = 0;
    for (const { def, out } of computed) {
      const target = def.overlay ? 0 : ++pane;
      for (const o of def.outputs ?? []) {
        const values = out[o.key];
        if (!Array.isArray(values)) continue;
        const colors = Array.isArray(out.colors) ? (out.colors as string[]) : null;
        if (o.kind === "histogram") {
          const h = c.addSeries(HistogramSeries, { color: o.color, priceLineVisible: false, lastValueVisible: false }, target);
          h.setData(bars.flatMap((b, i) => isNum(values[i]) ? [{ time: b.time as UTCTimestamp, value: values[i] as number, ...(colors?.[i] ? { color: colors[i] } : {}) }] : []));
          extra.current.push(h);
        } else {
          const l = c.addSeries(LineSeries, {
            color: o.color, lineWidth: (o.lineWidth ?? 1) as 1 | 2 | 3 | 4, priceLineVisible: false,
            lastValueVisible: !def.overlay, crosshairMarkerVisible: false, lineVisible: !o.dots,
            pointMarkersVisible: Boolean(o.dots), title: def.overlay ? "" : o.label,
          }, target);
          l.setData(bars.flatMap((b, i) => isNum(values[i]) ? [{ time: b.time as UTCTimestamp, value: values[i] as number }] : [{ time: b.time as UTCTimestamp }]));
          extra.current.push(l);
          if (target > 0 && o === def.outputs?.[0]) for (const lv of def.levels ?? []) l.createPriceLine({ price: lv, color: C.border, lineStyle: 2, lineWidth: 1, axisLabelVisible: false });
        }
      }
      if (Array.isArray(out.markers) && def.overlay) {
        for (const m of out.markers) allMarkers.push({ ...m, time: m.time as UTCTimestamp } as SeriesMarker<Time>);
      }
    }
    for (const m of tradeMarkers) {
      const t = index.snap(m.time);
      if (t != null) allMarkers.push({ ...m, time: t as UTCTimestamp });
    }
    for (let i = 1; i < c.panes().length; i++) c.panes()[i].setStretchFactor(0.35);
    markers.current?.setMarkers(allMarkers.sort((a, b) => (a.time as number) - (b.time as number)));

    if (fittedFor.current !== viewKey && bars.length) {
      c.timeScale().setVisibleLogicalRange({ from: Math.max(0, bars.length - 150), to: bars.length + 12 });
      fittedFor.current = viewKey;
    }
  }, [bars, display, index, computed, chartType, tradeMarkers, viewKey]);

  useEffect(() => { overlay.current.update({ shapes, hidden, selected }); }, [shapes, hidden, selected]);
  useEffect(() => { overlay.current.update({ events }); }, [events]);

  // horizontal lines (bell = price alert armed) and open copy-trade positions
  useEffect(() => {
    const s = main.current;
    if (!s) return;
    for (const l of lines.current) s.removePriceLine(l);
    lines.current = hidden ? [] : hlines.map((h) => s.createPriceLine({
      price: h.price, color: h.alert ? "#4f8cff" : "#f5b942", lineWidth: 1, lineStyle: 0, axisLabelVisible: true, title: h.alert ? "🔔" : "",
    }));
  }, [hlines, hidden, chartType]);
  useEffect(() => {
    const s = main.current;
    if (!s) return;
    for (const l of posLines.current) s.removePriceLine(l);
    posLines.current = tradeLines.map((l) => s.createPriceLine({
      price: l.price, color: l.color, lineWidth: 1, lineStyle: l.dashed ? 2 : 0, axisLabelVisible: true, title: l.title,
    }));
  }, [tradeLines, chartType]);

  // ---------- legend: values of the bar under the crosshair (or the last bar) ----------
  const i = hover ?? display.length - 1;
  const bar = display[i];
  const prevClose = i > 0 ? display[i - 1].close : null;
  const change = bar && prevClose ? bar.close - prevClose : null;
  const tone = change == null || change >= 0 ? "text-up" : "text-down";
  const legendInds = computed.map(({ ind, def, out }) => {
    const vals = (def.outputs ?? []).flatMap((o) => {
      const v = (out[o.key] as unknown[] | undefined)?.[i];
      return isNum(v) ? [{ color: o.color, v }] : [];
    });
    return { uid: ind.uid, name: def.name.replace(/\s*\(.*\)$/, ""), vals };
  });

  return (
    <>
      <div ref={host} className={`absolute inset-0 ${tool ? "cursor-crosshair" : ""}`} />
      {bar && (
        <div className="pointer-events-none absolute left-2 top-1 z-10 max-w-[calc(100%-5rem)] font-mono text-[11px] leading-4">
          <div className="flex flex-wrap gap-x-2">
            {chartType === "line" || chartType === "area" ? (
              <span>C <span className={tone}>{fmtNum(bar.close, digits)}</span></span>
            ) : (
              <>
                <span>O <span className={tone}>{fmtNum(bar.open, digits)}</span></span>
                <span>H <span className={tone}>{fmtNum(bar.high, digits)}</span></span>
                <span>L <span className={tone}>{fmtNum(bar.low, digits)}</span></span>
                <span>C <span className={tone}>{fmtNum(bar.close, digits)}</span></span>
              </>
            )}
            {change != null && prevClose ? (
              <span className={tone}>{change >= 0 ? "+" : ""}{fmtNum(change, digits)} ({change >= 0 ? "+" : ""}{((change / prevClose) * 100).toFixed(2)}%)</span>
            ) : null}
            {bar.volume > 0 && <span className="text-muted">Vol {fmtVol(bar.volume)}</span>}
            {chartType === "heikin" && <span className="text-muted">(Heikin Ashi)</span>}
            {hover == null && display.length > 0 && <BarCountdown open={display[display.length - 1].time} step={barSeconds} />}
          </div>
          {legendInds.filter((x) => x.vals.length).map((x) => (
            <div key={x.uid} className="flex flex-wrap gap-x-1.5 text-muted">
              <span>{x.name}</span>
              {x.vals.map((v, k) => <span key={k} style={{ color: v.color }}>{fmtNum(v.v, Math.abs(v.v) >= 1000 ? 2 : Math.min(4, Math.max(2, digits)))}</span>)}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
