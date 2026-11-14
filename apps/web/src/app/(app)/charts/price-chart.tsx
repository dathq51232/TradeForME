"use client";
import { useEffect, useRef } from "react";
import {
  createChart, createSeriesMarkers, CandlestickSeries, HistogramSeries, LineSeries,
  type IChartApi, type ISeriesApi, type IPriceLine, type UTCTimestamp, type SeriesMarker, type Time,
} from "lightweight-charts";
import { BY_ID, compute } from "@qt/core/indicators";
import { ChartOverlay, TimeIndex, type ChartEvent, type Pt, type Shape, type ShapeKind } from "./chart-overlay";

export type Bar = { time: number; open: number; high: number; low: number; close: number; volume: number };
export type ActiveIndicator = { uid: string; id: string; params: Record<string, unknown> };
export type Tool = null | "hline" | ShapeKind;
/** A marker at any unix time; it is moved onto the bar that contains it. */
export type TimedMarker = { time: number; position: "aboveBar" | "belowBar" | "inBar"; shape: "arrowUp" | "arrowDown" | "circle" | "square"; color: string; text?: string };
export type PriceLineSpec = { price: number; color: string; title: string; dashed?: boolean };
export type HLine = { price: number; alert: boolean };

const C = { bg: "#0b0f17", grid: "#1a2230", text: "#8292a8", border: "#263244", up: "#00c087", down: "#f45b69" };
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const sid = () => Math.random().toString(36).slice(2, 9);

type Props = {
  bars: Bar[];
  digits: number;
  barSeconds: number;
  indicators: ActiveIndicator[];
  hlines: HLine[];
  shapes: Shape[];
  events: ChartEvent[];
  tradeMarkers: TimedMarker[];
  tradeLines: PriceLineSpec[];
  tool: Tool;
  onAddLine: (price: number) => void;
  onAddShape: (shape: Shape) => void;
  /** Bumps when the symbol/timeframe changes, so the view refits instead of keeping the old zoom. */
  viewKey: string;
};

/**
 * Candles + indicators (overlay or own pane) + horizontal price lines + drawings, economic events and
 * copy-trade activity, on Lightweight Charts v5.
 */
export function PriceChart(props: Props) {
  const { bars, digits, barSeconds, indicators, hlines, shapes, events, tradeMarkers, tradeLines, tool, viewKey } = props;
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const candles = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const overlay = useRef<ChartOverlay | null>(null);
  const extra = useRef<ISeriesApi<"Line" | "Histogram">[]>([]);
  const lines = useRef<IPriceLine[]>([]);
  const posLines = useRef<IPriceLine[]>([]);
  const markers = useRef<ReturnType<typeof createSeriesMarkers<Time>> | null>(null);
  const fittedFor = useRef("");
  const anchor = useRef<Pt | null>(null);
  const live = useRef(props);
  useEffect(() => { live.current = props; });

  // create once
  useEffect(() => {
    if (!host.current) return;
    const c = createChart(host.current, {
      autoSize: true,
      layout: { background: { color: C.bg }, textColor: C.text, fontFamily: "var(--font-geist-sans), system-ui", panes: { separatorColor: C.border } },
      grid: { vertLines: { color: C.grid }, horzLines: { color: C.grid } },
      rightPriceScale: { borderColor: C.border },
      timeScale: { borderColor: C.border, timeVisible: true, secondsVisible: false, rightOffset: 12 },
      crosshair: { mode: 0 },
    });
    const s = c.addSeries(CandlestickSeries, {
      upColor: C.up, downColor: C.down, borderUpColor: C.up, borderDownColor: C.down, wickUpColor: C.up, wickDownColor: C.down,
    });
    const o = new ChartOverlay();
    s.attachPrimitive(o);
    markers.current = createSeriesMarkers(s, []);

    // Shape tools: first click sets the anchor, the crosshair previews, the second click finishes.
    // Two quick clicks arrive as a double-click (the second "click" is not reported), so both are handled.
    const onPoint = (p: { point?: { x: number; y: number } }) => {
      const { tool: t, onAddLine, onAddShape } = live.current;
      if (!t || !p.point) return;
      if (t === "hline") {
        const price = s.coordinateToPrice(p.point.y);
        if (price != null) onAddLine(Number(price));
        return;
      }
      const pt = o.toPoint(p.point.x, p.point.y);
      if (!pt) return;
      const a = anchor.current;
      if (!a) { anchor.current = pt; return; }
      if (a.t === pt.t && Math.abs(a.p - pt.p) < 1e-9) return;   // the same click reported twice
      onAddShape({ id: sid(), kind: t, a, b: pt });
      anchor.current = null;
      o.update({ preview: null });
    };
    c.subscribeClick(onPoint);
    c.subscribeDblClick(onPoint);
    c.subscribeCrosshairMove((p) => {
      const t = live.current.tool;
      if (!anchor.current || !t || t === "hline" || !p.point) return;
      const pt = o.toPoint(p.point.x, p.point.y);
      if (pt) o.update({ preview: { id: "preview", kind: t, a: anchor.current, b: pt } });
    });

    chart.current = c; candles.current = s; overlay.current = o;
    return () => {
      c.remove();
      chart.current = null; candles.current = null; overlay.current = null; extra.current = []; lines.current = []; posLines.current = [];
    };
  }, []);

  // switching or leaving a tool drops a half-drawn shape
  useEffect(() => {
    anchor.current = null;
    overlay.current?.update({ preview: null });
  }, [tool]);

  // price format follows the symbol
  useEffect(() => {
    candles.current?.applyOptions({ priceFormat: { type: "price", precision: digits, minMove: 1 / 10 ** digits } });
    overlay.current?.update({ digits });
  }, [digits]);

  // candles + indicators + markers
  useEffect(() => {
    const c = chart.current, s = candles.current;
    if (!c || !s) return;
    s.setData(bars.map((b) => ({ ...b, time: b.time as UTCTimestamp })));
    const index = new TimeIndex(bars.map((b) => b.time), barSeconds);
    overlay.current?.update({ index });

    for (const x of extra.current) c.removeSeries(x);
    extra.current = [];
    while (c.panes().length > 1) c.removePane(c.panes().length - 1);

    const allMarkers: SeriesMarker<Time>[] = [];
    let pane = 0;
    for (const ind of indicators) {
      const def = BY_ID[ind.id];
      if (!def || !bars.length) continue;
      let out: ReturnType<typeof compute>;
      try { out = compute(ind.id, bars, ind.params); } catch { continue; }
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
  }, [bars, barSeconds, indicators, tradeMarkers, viewKey]);

  useEffect(() => { overlay.current?.update({ shapes }); }, [shapes]);
  useEffect(() => { overlay.current?.update({ events }); }, [events]);

  // horizontal lines (bell = price alert armed) and open copy-trade positions
  useEffect(() => {
    const s = candles.current;
    if (!s) return;
    for (const l of lines.current) s.removePriceLine(l);
    lines.current = hlines.map((h) => s.createPriceLine({
      price: h.price, color: h.alert ? "#4f8cff" : "#f5b942", lineWidth: 1, lineStyle: 0, axisLabelVisible: true, title: h.alert ? "🔔" : "",
    }));
  }, [hlines]);
  useEffect(() => {
    const s = candles.current;
    if (!s) return;
    for (const l of posLines.current) s.removePriceLine(l);
    posLines.current = tradeLines.map((l) => s.createPriceLine({
      price: l.price, color: l.color, lineWidth: 1, lineStyle: l.dashed ? 2 : 0, axisLabelVisible: true, title: l.title,
    }));
  }, [tradeLines]);

  return <div ref={host} className={`absolute inset-0 ${tool ? "cursor-crosshair" : ""}`} />;
}
