// Canvas overlay for the price pane (Lightweight Charts v5 series primitive): user drawings, the shape being
// drawn, the selected shape's handles, and economic events as vertical markers.
// Points are stored as (unix seconds, price). Times between bars or beyond the last bar are placed by
// interpolating on the bar index, so drawings and future events stay put when bars update.
import type {
  ISeriesPrimitive, IPrimitivePaneView, IPrimitivePaneRenderer, ISeriesApi, IChartApi, SeriesAttachedParameter,
  SeriesType, Time, Logical, PrimitivePaneViewZOrder,
} from "lightweight-charts";

export type Pt = { t: number; p: number };
export type ShapeKind = "trend" | "ray" | "hray" | "vline" | "rect" | "fib" | "channel" | "measure" | "position" | "text";
/** a, b, c: the clicked points (c only for 3-point tools); text: the note of a text shape. */
export type Shape = { id: string; kind: ShapeKind; a: Pt; b: Pt; c?: Pt; text?: string };
export type ChartEvent = { time: number; title: string; country: string; impact: "high" | "medium" | "low" };

export const SHAPE_KINDS: ShapeKind[] = ["trend", "ray", "hray", "vline", "rect", "fib", "channel", "measure", "position", "text"];
export const SHAPE_LABEL: Record<ShapeKind, string> = {
  trend: "Đường xu hướng", ray: "Tia", hray: "Tia ngang", vline: "Đường dọc", rect: "Hình chữ nhật", fib: "Fibonacci",
  channel: "Kênh song song", measure: "Đo giá/thời gian", position: "Vị thế (R:R)", text: "Ghi chú",
};
/** Clicks needed to finish each tool. */
export const SHAPE_POINTS: Record<ShapeKind, 1 | 2 | 3> = {
  trend: 2, ray: 2, hray: 1, vline: 1, rect: 2, fib: 2, channel: 3, measure: 2, position: 3, text: 1,
};
export const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
const COLOR = {
  line: "#4f8cff", rect: "rgba(79,140,255,0.12)", fib: "#c58af9", high: "#f45b69", medium: "#f5a142", low: "#8292a8",
  text: "#c9d4e3", up: "#00c087", down: "#f45b69", upFill: "rgba(0,192,135,0.14)", downFill: "rgba(244,91,105,0.14)",
  select: "#f5b942", measure: "rgba(79,140,255,0.16)",
};

type Media = { context: CanvasRenderingContext2D; mediaSize: { width: number; height: number } };
type Target = { useMediaCoordinateSpace<T>(f: (s: Media) => T): T };
type XY = { x: number; y: number };
/** How the price pane looks: candle colours, background, and volume bars along its bottom (saved in the layout). */
export type ChartStyle = { up: string; down: string; bg: "dark" | "light"; volume: boolean };
export const DEFAULT_STYLE: ChartStyle = { up: "#00c087", down: "#f45b69", bg: "dark", volume: false };

/** a, b, c: a clicked point; ab / ba: the other two corners of a box (time of one point, price of the other). */
export type HandlePart = "a" | "b" | "c" | "ab" | "ba";

/** Bar index (fractional) <-> unix time, extrapolating with the bar length outside the loaded bars. */
export class TimeIndex {
  constructor(private times: number[], private step: number) {}
  get length() { return this.times.length; }
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
    const i = this.barAt(t);
    return i == null ? null : this.times[i];
  }
  /** Index of the bar that contains t, or null before the first bar. */
  barAt(t: number): number | null {
    const ts = this.times;
    if (!ts.length || t < ts[0]) return null;
    let lo = 0, hi = ts.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (ts[m] <= t) lo = m; else hi = m - 1; }
    return lo;
  }
}

/** Distance from p to the segment a-b (or the ray from a through b, or the whole line). */
function distToSegment(p: XY, a: XY, b: XY, mode: "segment" | "ray" | "line" = "segment"): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = dx * dx + dy * dy;
  let u = len ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len : 0;
  if (mode !== "line") u = Math.max(0, u);
  if (mode === "segment") u = Math.min(1, u);
  return Math.hypot(p.x - (a.x + u * dx), p.y - (a.y + u * dy));
}
const inBox = (p: XY, a: XY, b: XY, pad = 0) =>
  p.x >= Math.min(a.x, b.x) - pad && p.x <= Math.max(a.x, b.x) + pad && p.y >= Math.min(a.y, b.y) - pad && p.y <= Math.max(a.y, b.y) + pad;

/** Short human duration for the measure tool. */
function span(seconds: number): string {
  const s = Math.abs(seconds);
  if (s >= 86400) return `${(s / 86400).toFixed(s >= 864000 ? 0 : 1)} ngày`;
  if (s >= 3600) return `${(s / 3600).toFixed(s >= 36000 ? 0 : 1)} giờ`;
  return `${Math.round(s / 60)} phút`;
}

/** What automatic chart reading asks the overlay to draw (computed by @qt/core/patterns). */
export type AutoDraw = {
  patterns: { name: string; status: string; bias: number; target: number | null; end: number; label: Pt; lines: { role: string; a: Pt; b: Pt }[] }[];
  levels: { price: number; from: number; label: string; color: string; width: number; dashed: boolean }[];
  sessions: { name: string; color: string; start: number; end: number; high: number; low: number }[];
};
export const NO_AUTO: AutoDraw = { patterns: [], levels: [], sessions: [] };
const STATUS_TEXT: Record<string, string> = { forming: "đang hình thành", breakoutUp: "đã phá lên", breakoutDown: "đã phá xuống", expired: "hết hiệu lực" };

export class ChartOverlay implements ISeriesPrimitive<Time> {
  shapes: Shape[] = [];
  preview: Shape | null = null;
  selected: string | null = null;
  hidden = false;
  events: ChartEvent[] = [];
  auto: AutoDraw = NO_AUTO;
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
  update(patch: Partial<Pick<ChartOverlay, "shapes" | "preview" | "selected" | "hidden" | "events" | "auto" | "index" | "digits">>) {
    Object.assign(this, patch);
    this.request?.();
  }
  updateAllViews() {}

  private x(t: number) {
    return this.chart?.timeScale().logicalToCoordinate(this.index.logical(t) as Logical) ?? null;
  }
  private y(p: number) { return this.series?.priceToCoordinate(p) ?? null; }
  private xy(pt: Pt): XY | null {
    const x = this.x(pt.t), y = this.y(pt.p);
    return x == null || y == null ? null : { x, y };
  }
  /** Screen point -> (time, price) for the click handlers. */
  toPoint(x: number, y: number): Pt | null {
    const l = this.chart?.timeScale().coordinateToLogical(x);
    const p = this.series?.coordinateToPrice(y);
    return l == null || p == null ? null : { t: this.index.time(l), p: Number(p) };
  }

  /** The topmost shape within a few pixels of (x, y), for selecting with the mouse. */
  shapeAt(x: number, y: number, width: number): string | null {
    if (this.hidden) return null;
    const p = { x, y }, tol = 6;
    for (let i = this.shapes.length - 1; i >= 0; i--) {
      const s = this.shapes[i];
      const a = this.xy(s.a), b = this.xy(s.b), c = s.c ? this.xy(s.c) : null;
      if (!a || !b) continue;
      let hit = false;
      switch (s.kind) {
        case "trend": hit = distToSegment(p, a, b) < tol; break;
        case "ray": hit = distToSegment(p, a, b, "ray") < tol; break;
        case "hray": hit = x >= a.x - tol && Math.abs(y - a.y) < tol; break;
        case "vline": hit = Math.abs(x - a.x) < tol; break;
        case "text": hit = x >= a.x - 4 && x <= a.x + 8 + 7 * (s.text?.length ?? 4) && y >= a.y - 16 && y <= a.y + 4; break;
        case "rect": case "measure": hit = inBox(p, a, b, tol); break;
        case "fib": {
          const top = Math.min(a.y, b.y), bottom = Math.max(a.y, b.y);
          hit = x >= Math.min(a.x, b.x) - tol && x <= width && y >= top - tol && y <= bottom + tol;
          break;
        }
        case "channel": {
          if (!c) break;
          const off = this.channelOffset(a, b, c);
          const a2 = { x: a.x, y: a.y + off }, b2 = { x: b.x, y: b.y + off };
          hit = distToSegment(p, a, b) < tol || distToSegment(p, a2, b2) < tol
            || (x >= Math.min(a.x, b.x) && x <= Math.max(a.x, b.x)
              && (y - (a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x || 1))) * (y - (a2.y + ((b2.y - a2.y) * (x - a2.x)) / (b2.x - a2.x || 1))) <= 0);
          break;
        }
        case "position": {
          if (!c) break;
          const right = Math.max(a.x + 60, b.x, c.x);
          hit = x >= a.x - tol && x <= right + tol && y >= Math.min(b.y, c.y) - tol && y <= Math.max(b.y, c.y) + tol;
          break;
        }
      }
      if (hit) return s.id;
    }
    return null;
  }

  /** Drag handles of a shape on screen: its clicked points, plus the two other corners of a box. */
  handles(s: Shape): (XY & { part: HandlePart })[] {
    const a = this.xy(s.a), b = this.xy(s.b), c = s.c ? this.xy(s.c) : null;
    if (!a || !b) return [];
    const one = s.kind === "hray" || s.kind === "vline" || s.kind === "text";
    const out: (XY & { part: HandlePart })[] = [{ ...a, part: "a" }];
    if (!one) out.push({ ...b, part: "b" });
    if (c) out.push({ ...c, part: "c" });
    if (s.kind === "rect" || s.kind === "measure") out.push({ x: a.x, y: b.y, part: "ab" }, { x: b.x, y: a.y, part: "ba" });
    return out;
  }

  /**
   * What the mouse would grab at (x, y): a handle of a shape (the selected shape first) to resize it, or the
   * shape's body to move it.
   */
  grab(x: number, y: number, width: number): { id: string; part: HandlePart | "body" } | null {
    if (this.hidden) return null;
    const order = [...this.shapes].sort((p, q) => Number(q.id === this.selected) - Number(p.id === this.selected));
    for (const s of order) {
      for (const h of this.handles(s)) if (Math.hypot(h.x - x, h.y - y) <= 7) return { id: s.id, part: h.part };
    }
    const id = this.shapeAt(x, y, width);
    return id ? { id, part: "body" } : null;
  }

  /**
   * The shape after dragging `part` from `start` to `to` (both as time/price). The body moves by whole bar steps
   * in bar-index space, so a shape keeps its width across weekend gaps; a handle moves just that point.
   */
  dragged(s: Shape, part: HandlePart | "body", start: Pt, to: Pt): Shape {
    if (part === "body") {
      const dl = this.index.logical(to.t) - this.index.logical(start.t), dp = to.p - start.p;
      const shift = (q: Pt): Pt => ({ t: this.index.time(this.index.logical(q.t) + dl), p: q.p + dp });
      return { ...s, a: shift(s.a), b: shift(s.b), ...(s.c ? { c: shift(s.c) } : {}) };
    }
    if (part === "ab") return { ...s, a: { ...s.a, t: to.t }, b: { ...s.b, p: to.p } };
    if (part === "ba") return { ...s, b: { ...s.b, t: to.t }, a: { ...s.a, p: to.p } };
    const one = s.kind === "hray" || s.kind === "vline" || s.kind === "text";
    return { ...s, [part]: to, ...(one && part === "a" ? { b: to } : {}) };
  }

  /** Vertical offset (px) of the channel's parallel line: through c, parallel to a-b. */
  private channelOffset(a: XY, b: XY, c: XY) {
    const slope = b.x === a.x ? 0 : (b.y - a.y) / (b.x - a.x);
    return c.y - (a.y + slope * (c.x - a.x));
  }

  private renderer: IPrimitivePaneRenderer = {
    draw: (target) => (target as unknown as Target).useMediaCoordinateSpace((s) => { this.drawPatterns(s); this.drawShapes(s); }),
    drawBackground: (target) => (target as unknown as Target).useMediaCoordinateSpace((s) => { this.drawSessions(s); this.drawLevels(s); this.drawEvents(s); }),
  };
  private view: IPrimitivePaneView = { zOrder: (): PrimitivePaneViewZOrder => "top", renderer: () => this.renderer };
  paneViews() { return [this.view]; }

  /** Session boxes: from the session's open to its close, spanning the high and low traded inside it. */
  private drawSessions({ context: ctx, mediaSize }: Media) {
    if (!this.auto.sessions.length) return;
    ctx.save();
    ctx.font = "10px system-ui, sans-serif";
    for (const s of this.auto.sessions) {
      const x1 = this.x(s.start), x2 = this.x(s.end), yh = this.y(s.high), yl = this.y(s.low);
      if (x1 == null || x2 == null || yh == null || yl == null || x2 < 0 || x1 > mediaSize.width) continue;
      ctx.globalAlpha = 0.07;
      ctx.fillStyle = s.color;
      ctx.fillRect(x1, yh, x2 - x1, yl - yh);
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = s.color;
      ctx.setLineDash([2, 3]);
      ctx.strokeRect(x1, yh, x2 - x1, yl - yh);
      if (x2 - x1 > 34) {
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = s.color;
        ctx.fillText(s.name, x1 + 2, yh - 3);
      }
    }
    ctx.restore();
  }

  /** Key levels and previous-period closes: a line from where the level starts to the right edge, label on the right. */
  private drawLevels({ context: ctx, mediaSize }: Media) {
    if (!this.auto.levels.length) return;
    ctx.save();
    ctx.font = "10px system-ui, sans-serif";
    for (const l of this.auto.levels) {
      const y = this.y(l.price);
      if (y == null || y < 0 || y > mediaSize.height) continue;
      const x0 = Math.max(0, Math.min(this.x(l.from) ?? 0, mediaSize.width - 140));
      ctx.globalAlpha = 0.75;
      ctx.strokeStyle = l.color;
      ctx.lineWidth = l.width;
      ctx.setLineDash(l.dashed ? [5, 4] : []);
      ctx.beginPath(); ctx.moveTo(x0, Math.round(y) + 0.5); ctx.lineTo(mediaSize.width, Math.round(y) + 0.5); ctx.stroke();
      const text = l.label;
      const w = ctx.measureText(text).width;
      ctx.globalAlpha = 1;
      ctx.fillStyle = l.color;
      ctx.fillText(text, mediaSize.width - w - 8, y - 3);
    }
    ctx.restore();
  }

  /** Detected chart patterns: their lines, name and status, and the measured-move target after a breakout. */
  private drawPatterns({ context: ctx }: Media) {
    if (!this.auto.patterns.length) return;
    ctx.save();
    ctx.font = "11px system-ui, sans-serif";
    for (const pat of this.auto.patterns) {
      const color = pat.bias > 0 ? COLOR.up : pat.bias < 0 ? COLOR.down : COLOR.medium;
      const faded = pat.status === "expired";
      for (const l of pat.lines) {
        const a = this.xy(l.a), b = this.xy(l.b);
        if (!a || !b) continue;
        ctx.globalAlpha = faded ? 0.35 : 0.85;
        ctx.strokeStyle = color;
        ctx.lineWidth = l.role === "path" ? 1 : 1.5;
        ctx.setLineDash(l.role === "neck" ? [6, 4] : []);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
      const at = this.xy(pat.label);
      if (at) this.label(ctx, `${pat.name} · ${STATUS_TEXT[pat.status] ?? pat.status}`, at.x, at.y - 8, faded ? COLOR.low : color);
      if (pat.target != null && !faded) {
        const xe = this.x(pat.end), yt = this.y(pat.target);
        if (xe != null && yt != null) {
          ctx.globalAlpha = 0.8;
          ctx.strokeStyle = color;
          ctx.lineWidth = 1;
          ctx.setLineDash([2, 3]);
          ctx.beginPath(); ctx.moveTo(xe, yt); ctx.lineTo(xe + 70, yt); ctx.stroke();
          ctx.font = "10px system-ui, sans-serif";
          this.label(ctx, `Mục tiêu ${pat.target.toFixed(this.digits)}`, xe + 2, yt - 4, color);
          ctx.font = "11px system-ui, sans-serif";
        }
      }
    }
    ctx.restore();
  }

  private drawEvents({ context: ctx, mediaSize }: Media) {
    ctx.save();
    ctx.font = "10px system-ui, sans-serif";
    // labels sit at the bottom (the legend is at the top); one that would overlap moves up a row (up to 4 rows)
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
        ctx.fillText(label, x + 3, mediaSize.height - 6 - row * 12);
        rowEnds[row] = x + w;
      }
    }
    ctx.restore();
  }

  private label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string, bg = "rgba(11,15,23,0.85)") {
    const w = ctx.measureText(text).width + 8;
    ctx.globalAlpha = 1;
    ctx.fillStyle = bg;
    ctx.fillRect(x, y - 11, w, 15);
    ctx.fillStyle = color;
    ctx.fillText(text, x + 4, y);
  }

  private drawShapes({ context: ctx, mediaSize }: Media) {
    const list = this.hidden ? (this.preview ? [this.preview] : []) : this.preview ? [...this.shapes, this.preview] : this.shapes;
    const W = mediaSize.width;
    const fmt = (v: number) => v.toFixed(this.digits);
    ctx.save();
    ctx.lineWidth = 1.5;
    ctx.font = "10px system-ui, sans-serif";
    for (const s of list) {
      const a = this.xy(s.a), b = this.xy(s.b);
      if (!a || !b) continue;
      const c = s.c ? this.xy(s.c) : null;
      const selected = s.id === this.selected;
      ctx.globalAlpha = s === this.preview ? 0.6 : 1;
      ctx.setLineDash([]);
      ctx.strokeStyle = COLOR.line;
      ctx.fillStyle = COLOR.line;
      switch (s.kind) {
        case "trend": case "ray": {
          let ex = b.x, ey = b.y;
          if (s.kind === "ray" && b.x !== a.x) { ex = b.x > a.x ? W : 0; ey = a.y + ((b.y - a.y) * (ex - a.x)) / (b.x - a.x); }
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(ex, ey); ctx.stroke();
          break;
        }
        case "hray": {
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(W, a.y); ctx.stroke();
          this.label(ctx, fmt(s.a.p), a.x + 2, a.y - 4, COLOR.line);
          break;
        }
        case "vline": {
          ctx.beginPath(); ctx.moveTo(Math.round(a.x) + 0.5, 0); ctx.lineTo(Math.round(a.x) + 0.5, mediaSize.height); ctx.stroke();
          break;
        }
        case "text": {
          ctx.font = "12px system-ui, sans-serif";
          this.label(ctx, s.text || "Ghi chú", a.x, a.y, COLOR.text, "rgba(79,140,255,0.25)");
          ctx.font = "10px system-ui, sans-serif";
          break;
        }
        case "rect": {
          ctx.fillStyle = COLOR.rect;
          ctx.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
          ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
          break;
        }
        case "fib": {
          const left = Math.min(a.x, b.x);
          ctx.strokeStyle = COLOR.fib;
          ctx.fillStyle = COLOR.fib;
          for (const lv of FIB_LEVELS) {
            const price = s.b.p + (s.a.p - s.b.p) * lv;
            const y = this.y(price);
            if (y == null) continue;
            ctx.globalAlpha = lv === 0 || lv === 1 ? 0.9 : 0.6;
            ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(W, y); ctx.stroke();
            ctx.fillText(`${(lv * 100).toFixed(1)}%  ${fmt(price)}`, left + 4, y - 3);
          }
          ctx.setLineDash([4, 4]);
          ctx.globalAlpha = 0.5;
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
          break;
        }
        case "channel": {
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
          if (!c) break;
          const off = this.channelOffset(a, b, c);
          ctx.fillStyle = COLOR.rect;
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(b.x, b.y + off); ctx.lineTo(a.x, a.y + off); ctx.closePath(); ctx.fill();
          ctx.beginPath(); ctx.moveTo(a.x, a.y + off); ctx.lineTo(b.x, b.y + off); ctx.stroke();
          ctx.setLineDash([4, 4]);
          ctx.globalAlpha *= 0.6;
          ctx.beginPath(); ctx.moveTo(a.x, a.y + off / 2); ctx.lineTo(b.x, b.y + off / 2); ctx.stroke();
          break;
        }
        case "measure": {
          const dp = s.b.p - s.a.p, up = dp >= 0;
          const bars = Math.round(this.index.logical(s.b.t) - this.index.logical(s.a.t));
          ctx.fillStyle = up ? COLOR.upFill : COLOR.downFill;
          ctx.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
          ctx.strokeStyle = up ? COLOR.up : COLOR.down;
          const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
          ctx.beginPath(); ctx.moveTo(mx, a.y); ctx.lineTo(mx, b.y); ctx.moveTo(a.x, my); ctx.lineTo(b.x, my); ctx.stroke();
          const pct = s.a.p ? (dp / s.a.p) * 100 : 0;
          const text = `${dp >= 0 ? "+" : ""}${fmt(dp)} (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%) · ${bars} nến · ${span(s.b.t - s.a.t)}`;
          this.label(ctx, text, Math.min(a.x, b.x), up ? Math.min(a.y, b.y) - 6 : Math.max(a.y, b.y) + 16, up ? COLOR.up : COLOR.down);
          break;
        }
        case "position": {
          // a = entry, b = stop, c = target (while drawing, the target is not chosen yet)
          const right = Math.max(a.x + 60, b.x, c?.x ?? 0);
          const long = c ? s.c!.p >= s.a.p : s.b.p < s.a.p;
          ctx.fillStyle = COLOR.downFill;
          ctx.fillRect(a.x, Math.min(a.y, b.y), right - a.x, Math.abs(b.y - a.y));
          if (c) {
            ctx.fillStyle = COLOR.upFill;
            ctx.fillRect(a.x, Math.min(a.y, c.y), right - a.x, Math.abs(c.y - a.y));
          }
          ctx.strokeStyle = COLOR.text;
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(right, a.y); ctx.stroke();
          const risk = Math.abs(s.a.p - s.b.p);
          this.label(ctx, `${long ? "Mua" : "Bán"} ${fmt(s.a.p)}`, a.x + 2, a.y - 4, COLOR.text);
          this.label(ctx, `Dừng lỗ ${fmt(s.b.p)} (${fmt(risk)})`, a.x + 2, b.y + (b.y > a.y ? 14 : -4), COLOR.down);
          if (c && s.c) {
            const reward = Math.abs(s.c.p - s.a.p);
            this.label(ctx, `Chốt lời ${fmt(s.c.p)} · R:R ${risk ? (reward / risk).toFixed(2) : "—"}`, a.x + 2, c.y + (c.y > a.y ? 14 : -4), COLOR.up);
          }
          break;
        }
      }
      if (selected) {
        ctx.globalAlpha = 1;
        ctx.setLineDash([]);
        ctx.fillStyle = COLOR.select;
        ctx.strokeStyle = "#0b0f17";
        ctx.lineWidth = 1;
        for (const h of this.handles(s)) {
          ctx.beginPath(); ctx.arc(h.x, h.y, 4.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        }
      }
    }
    ctx.restore();
  }
}
