// Canvas overlay for the price pane (Lightweight Charts v5 series primitive): user drawings (trend line,
// ray, rectangle, Fibonacci), the shape being drawn, and economic events as vertical markers.
// Points are stored as (unix seconds, price). Times between bars or beyond the last bar are placed by
// interpolating on the bar index, so drawings and future events stay put when bars update.
import type {
  ISeriesPrimitive, IPrimitivePaneView, IPrimitivePaneRenderer, ISeriesApi, IChartApi, SeriesAttachedParameter,
  SeriesType, Time, Logical, PrimitivePaneViewZOrder,
} from "lightweight-charts";

export type Pt = { t: number; p: number };
export type ShapeKind = "trend" | "ray" | "rect" | "fib";
export type Shape = { id: string; kind: ShapeKind; a: Pt; b: Pt };
export type ChartEvent = { time: number; title: string; country: string; impact: "high" | "medium" | "low" };

export const SHAPE_LABEL: Record<ShapeKind, string> = { trend: "Đường xu hướng", ray: "Tia", rect: "Hình chữ nhật", fib: "Fibonacci" };
export const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
const COLOR = { line: "#4f8cff", rect: "rgba(79,140,255,0.12)", fib: "#c58af9", high: "#f45b69", medium: "#f5a142", low: "#8292a8", text: "#c9d4e3" };

type Media = { context: CanvasRenderingContext2D; mediaSize: { width: number; height: number } };
type Target = { useMediaCoordinateSpace<T>(f: (s: Media) => T): T };

/** Bar index (fractional) <-> unix time, extrapolating with the bar length outside the loaded bars. */
export class TimeIndex {
  constructor(private times: number[], private step: number) {}
  logical(t: number): number {
    const ts = this.times, n = ts.length;
    if (!n) return 0;
    if (t <= ts[0]) return (t - ts[0]) / this.step;
    if (t >= ts[n - 1]) return n - 1 + (t - ts[n - 1]) / this.step;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (ts[m] <= t) lo = m; else hi = m; }
    return lo + (t - ts[lo]) / (ts[hi] - ts[lo]);
  }
  time(logical: number): number {
    const ts = this.times, n = ts.length;
    if (!n) return 0;
    if (logical <= 0) return Math.round(ts[0] + logical * this.step);
    if (logical >= n - 1) return Math.round(ts[n - 1] + (logical - (n - 1)) * this.step);
    const i = Math.floor(logical);
    return Math.round(ts[i] + (logical - i) * (ts[i + 1] - ts[i]));
  }
  /** Time of the bar that contains t (for markers, which must sit on a bar), or null before the first bar. */
  snap(t: number): number | null {
    const ts = this.times;
    if (!ts.length || t < ts[0]) return null;
    let lo = 0, hi = ts.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (ts[m] <= t) lo = m; else hi = m - 1; }
    return ts[lo];
  }
}

export class ChartOverlay implements ISeriesPrimitive<Time> {
  shapes: Shape[] = [];
  preview: Shape | null = null;
  events: ChartEvent[] = [];
  index = new TimeIndex([], 3600);
  digits = 2;
  private chart: IChartApi | null = null;
  private series: ISeriesApi<SeriesType> | null = null;
  private request: (() => void) | null = null;

  attached(p: SeriesAttachedParameter<Time>) {
    this.chart = p.chart as IChartApi;
    this.series = p.series;
    this.request = p.requestUpdate;
  }
  detached() { this.chart = null; this.series = null; this.request = null; }
  update(patch: Partial<Pick<ChartOverlay, "shapes" | "preview" | "events" | "index" | "digits">>) {
    Object.assign(this, patch);
    this.request?.();
  }
  updateAllViews() {}

  private x(t: number) {
    return this.chart?.timeScale().logicalToCoordinate(this.index.logical(t) as Logical) ?? null;
  }
  private y(p: number) { return this.series?.priceToCoordinate(p) ?? null; }
  /** Screen point -> (time, price) for the click handlers. */
  toPoint(x: number, y: number): Pt | null {
    const l = this.chart?.timeScale().coordinateToLogical(x);
    const p = this.series?.coordinateToPrice(y);
    return l == null || p == null ? null : { t: this.index.time(l), p: Number(p) };
  }

  private renderer: IPrimitivePaneRenderer = {
    draw: (target) => (target as unknown as Target).useMediaCoordinateSpace((s) => this.drawShapes(s)),
    drawBackground: (target) => (target as unknown as Target).useMediaCoordinateSpace((s) => this.drawEvents(s)),
  };
  private view: IPrimitivePaneView = { zOrder: (): PrimitivePaneViewZOrder => "top", renderer: () => this.renderer };
  paneViews() { return [this.view]; }

  private drawEvents({ context: ctx, mediaSize }: Media) {
    ctx.save();
    ctx.font = "10px system-ui, sans-serif";
    // labels that would overlap the previous ones move down a row (up to 4 rows)
    const rowEnds = [-Infinity, -Infinity, -Infinity, -Infinity];
    for (const e of [...this.events].sort((a, b) => a.time - b.time)) {
      const x = this.x(e.time);
      if (x == null || x < 0 || x > mediaSize.width) continue;
      const label = `${e.country} ${e.title}`.slice(0, 28);
      const w = ctx.measureText(label).width + 8;
      let row = rowEnds.findIndex((end) => x > end);
      if (row < 0) row = rowEnds.indexOf(Math.min(...rowEnds));
      ctx.strokeStyle = COLOR[e.impact];
      ctx.globalAlpha = e.impact === "high" ? 0.8 : 0.45;
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, 0); ctx.lineTo(Math.round(x) + 0.5, mediaSize.height); ctx.stroke();
      if (e.impact !== "low") {
        ctx.globalAlpha = 1;
        ctx.fillStyle = COLOR[e.impact];
        ctx.fillText(label, x + 3, 12 + row * 12);
        rowEnds[row] = x + w;
      }
    }
    ctx.restore();
  }

  private drawShapes({ context: ctx, mediaSize }: Media) {
    const list = this.preview ? [...this.shapes, this.preview] : this.shapes;
    ctx.save();
    ctx.lineWidth = 1.5;
    ctx.font = "10px system-ui, sans-serif";
    for (const s of list) {
      const cx1 = this.x(s.a.t), cy1 = this.y(s.a.p), cx2 = this.x(s.b.t), cy2 = this.y(s.b.p);
      if (cx1 == null || cy1 == null || cx2 == null || cy2 == null) continue;
      const x1: number = cx1, y1: number = cy1, x2: number = cx2, y2: number = cy2;
      ctx.globalAlpha = s === this.preview ? 0.6 : 1;
      ctx.setLineDash([]);
      if (s.kind === "trend" || s.kind === "ray") {
        let ex = x2, ey = y2;
        if (s.kind === "ray" && x2 !== x1) { ex = x2 > x1 ? mediaSize.width : 0; ey = y1 + ((y2 - y1) * (ex - x1)) / (x2 - x1); }
        ctx.strokeStyle = COLOR.line;
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(ex, ey); ctx.stroke();
      } else if (s.kind === "rect") {
        ctx.fillStyle = COLOR.rect;
        ctx.strokeStyle = COLOR.line;
        ctx.fillRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
        ctx.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
      } else {
        const left = Math.min(x1, x2);
        ctx.strokeStyle = COLOR.fib;
        ctx.fillStyle = COLOR.fib;
        for (const lv of FIB_LEVELS) {
          const price = s.b.p + (s.a.p - s.b.p) * lv;
          const y = this.y(price);
          if (y == null) continue;
          ctx.globalAlpha = lv === 0 || lv === 1 ? 0.9 : 0.6;
          ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(mediaSize.width, y); ctx.stroke();
          ctx.fillText(`${(lv * 100).toFixed(1)}%  ${price.toFixed(this.digits)}`, left + 4, y - 3);
        }
        ctx.setLineDash([4, 4]);
        ctx.globalAlpha = 0.5;
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      }
    }
    ctx.restore();
  }
}
