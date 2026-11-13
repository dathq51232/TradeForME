"use client";
import { useEffect, useRef } from "react";
import {
  createChart, createSeriesMarkers, CandlestickSeries, HistogramSeries, LineSeries,
  type IChartApi, type ISeriesApi, type IPriceLine, type UTCTimestamp, type SeriesMarker, type Time,
} from "lightweight-charts";
import { BY_ID, compute } from "@qt/core/indicators";

export type Bar = { time: number; open: number; high: number; low: number; close: number; volume: number };
export type ActiveIndicator = { uid: string; id: string; params: Record<string, unknown> };

const C = { bg: "#0b0f17", grid: "#1a2230", text: "#8292a8", border: "#263244", up: "#00c087", down: "#f45b69" };
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

type Props = {
  bars: Bar[];
  digits: number;
  indicators: ActiveIndicator[];
  hlines: number[];
  drawMode: boolean;
  onAddLine: (price: number) => void;
  /** Bumps when the symbol/timeframe changes, so the view refits instead of keeping the old zoom. */
  viewKey: string;
};

/** Candles + indicators (overlay or own pane) + horizontal price lines, on Lightweight Charts v5. */
export function PriceChart({ bars, digits, indicators, hlines, drawMode, onAddLine, viewKey }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const candles = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const extra = useRef<ISeriesApi<"Line" | "Histogram">[]>([]);
  const lines = useRef<IPriceLine[]>([]);
  const markers = useRef<ReturnType<typeof createSeriesMarkers<Time>> | null>(null);
  const fittedFor = useRef("");
  const addLine = useRef(onAddLine);
  const drawing = useRef(drawMode);
  useEffect(() => { addLine.current = onAddLine; drawing.current = drawMode; });

  // create once
  useEffect(() => {
    if (!host.current) return;
    const c = createChart(host.current, {
      autoSize: true,
      layout: { background: { color: C.bg }, textColor: C.text, fontFamily: "var(--font-geist-sans), system-ui", panes: { separatorColor: C.border } },
      grid: { vertLines: { color: C.grid }, horzLines: { color: C.grid } },
      rightPriceScale: { borderColor: C.border },
      timeScale: { borderColor: C.border, timeVisible: true, secondsVisible: false, rightOffset: 6 },
      crosshair: { mode: 0 },
    });
    candles.current = c.addSeries(CandlestickSeries, {
      upColor: C.up, downColor: C.down, borderUpColor: C.up, borderDownColor: C.down, wickUpColor: C.up, wickDownColor: C.down,
    });
    markers.current = createSeriesMarkers(candles.current, []);
    c.subscribeClick((p) => {
      if (!drawing.current || !p.point || !candles.current) return;
      const price = candles.current.coordinateToPrice(p.point.y);
      if (price != null) addLine.current(Number(price));
    });
    chart.current = c;
    return () => { c.remove(); chart.current = null; candles.current = null; extra.current = []; lines.current = []; };
  }, []);

  // price format follows the symbol
  useEffect(() => {
    candles.current?.applyOptions({ priceFormat: { type: "price", precision: digits, minMove: 1 / 10 ** digits } });
  }, [digits]);

  // candles + indicators
  useEffect(() => {
    const c = chart.current, s = candles.current;
    if (!c || !s) return;
    s.setData(bars.map((b) => ({ ...b, time: b.time as UTCTimestamp })));

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
    for (let i = 1; i < c.panes().length; i++) c.panes()[i].setStretchFactor(0.35);
    markers.current?.setMarkers(allMarkers.sort((a, b) => (a.time as number) - (b.time as number)));

    if (fittedFor.current !== viewKey && bars.length) {
      c.timeScale().setVisibleLogicalRange({ from: Math.max(0, bars.length - 150), to: bars.length + 5 });
      fittedFor.current = viewKey;
    }
  }, [bars, indicators, viewKey]);

  // horizontal lines
  useEffect(() => {
    const s = candles.current;
    if (!s) return;
    for (const l of lines.current) s.removePriceLine(l);
    lines.current = hlines.map((price) => s.createPriceLine({ price, color: "#f5b942", lineWidth: 1, lineStyle: 0, axisLabelVisible: true }));
  }, [hlines]);

  return <div ref={host} className={`absolute inset-0 ${drawMode ? "cursor-crosshair" : ""}`} />;
}
