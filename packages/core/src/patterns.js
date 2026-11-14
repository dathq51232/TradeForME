// Automatic chart reading: swing pivots, chart patterns (triangles, wedges, broadening, double tops/bottoms,
// head and shoulders), candlestick patterns, key levels from candle closes, and forex trading sessions.
// Pure functions over bars { time (UTC seconds), open, high, low, close, volume }; no DOM, no network.
// The rules are this project's own, written from the textbook descriptions of each pattern. Results are a
// reading aid, not signals.
import { atr as atrOf, periodKey } from "./indicators.js";

const finite = (v) => typeof v === "number" && Number.isFinite(v);

/** ATR(14) per bar, falling back to the average range where ATR is not ready yet. */
function atrSeries(bars) {
  const a = atrOf(bars, 14);
  let sum = 0;
  return bars.map((b, i) => {
    sum += b.high - b.low;
    return finite(a[i]) && a[i] > 0 ? a[i] : sum / (i + 1) || 1e-9;
  });
}

// ---------- swing pivots ----------

/**
 * Swing highs and lows: a high beats the `depth` bars before it and is not beaten by the `depth` bars after it
 * (lows mirrored). Consecutive pivots of the same kind keep only the more extreme one, so the list alternates.
 * @returns {{ i: number, time: number, price: number, kind: "H" | "L" }[]}
 */
export function swingPivots(bars, depth = 5) {
  const raw = [];
  for (let i = depth; i < bars.length - depth; i++) {
    let hi = true, lo = true;
    for (let k = 1; k <= depth && (hi || lo); k++) {
      if (bars[i - k].high >= bars[i].high || bars[i + k].high > bars[i].high) hi = false;
      if (bars[i - k].low <= bars[i].low || bars[i + k].low < bars[i].low) lo = false;
    }
    if (hi) raw.push({ i, time: bars[i].time, price: bars[i].high, kind: "H" });
    if (lo) raw.push({ i, time: bars[i].time, price: bars[i].low, kind: "L" });
  }
  const out = [];
  for (const p of raw) {
    const last = out[out.length - 1];
    if (last && last.kind === p.kind) {
      if ((p.kind === "H" && p.price > last.price) || (p.kind === "L" && p.price < last.price)) out[out.length - 1] = p;
    } else out.push(p);
  }
  return out;
}

// ---------- chart patterns ----------

export const CHART_PATTERN_NAMES = {
  ascTriangle: "Tam giác tăng",
  descTriangle: "Tam giác giảm",
  symTriangle: "Tam giác cân",
  broadening: "Tam giác mở rộng (tam giác ngược)",
  risingWedge: "Nêm tăng",
  fallingWedge: "Nêm giảm",
  doubleTop: "Hai đỉnh",
  doubleBottom: "Hai đáy",
  headShoulders: "Vai đầu vai",
  invHeadShoulders: "Vai đầu vai ngược",
};

const line = (a, b) => ({ a: { t: a.time, p: a.price }, b: { t: b.time, p: b.price } });
/** Price of the line through pivots a and b at bar index i (lines are straight in bar-index space). */
const at = (a, b, i) => a.price + ((b.price - a.price) * (i - a.i)) / (b.i - a.i || 1);
const pt = (bars, i, p) => ({ t: bars[i].time, p });

/** Does every bar between i0 and i1 stay inside the two lines (a few wicks may poke out)? */
function contained(bars, i0, i1, upper, lower, tol) {
  let out = 0;
  for (let i = i0; i <= i1; i++) {
    if (bars[i].high > at(upper[0], upper[1], i) + tol || bars[i].low < at(lower[0], lower[1], i) - tol) out++;
  }
  return out <= Math.max(1, Math.floor((i1 - i0 + 1) * 0.08));
}

/** The highs (or lows) of a window lie on the line through the first and last of them. */
function onLine(points, tol) {
  const a = points[0], b = points[points.length - 1];
  return points.every((p) => Math.abs(p.price - at(a, b, p.i)) <= tol);
}

/** Triangles, wedges and the broadening triangle from a window of alternating pivots. */
function convergence(bars, atr, win) {
  const highs = win.filter((p) => p.kind === "H"), lows = win.filter((p) => p.kind === "L");
  if (highs.length < 2 || lows.length < 2) return null;
  const i0 = win[0].i, i1 = win[win.length - 1].i, span = i1 - i0;
  const a = atr[i1], tol = 0.35 * a;
  if (span < 10 || !onLine(highs, tol) || !onLine(lows, tol)) return null;
  const U = [highs[0], highs[highs.length - 1]], L = [lows[0], lows[lows.length - 1]];
  const wStart = at(U[0], U[1], i0) - at(L[0], L[1], i0), wEnd = at(U[0], U[1], i1) - at(L[0], L[1], i1);
  if (wStart <= 0 || wEnd <= 0) return null;
  const du = (at(U[0], U[1], i1) - at(U[0], U[1], i0)) / a, dl = (at(L[0], L[1], i1) - at(L[0], L[1], i0)) / a;
  const flat = (d) => Math.abs(d) < 0.8, up = (d) => d >= 0.8, down = (d) => d <= -0.8;
  let kind = null;
  if (wEnd < wStart * 0.8) {
    if (flat(du) && up(dl)) kind = "ascTriangle";
    else if (down(du) && flat(dl)) kind = "descTriangle";
    else if (down(du) && up(dl)) kind = "symTriangle";
    else if (up(du) && up(dl)) kind = "risingWedge";
    else if (down(du) && down(dl)) kind = "fallingWedge";
  } else if (wEnd > wStart * 1.25 && up(du) && down(dl)) kind = "broadening";
  if (!kind || !contained(bars, i0, i1, U, L, tol)) return null;

  // breakout: the first close beyond a line after the last pivot, within as many bars as the pattern took
  const limit = Math.min(bars.length - 1, i1 + span);
  let status = "forming", end = limit, target = null;
  for (let i = i1 + 1; i <= limit; i++) {
    const u = at(U[0], U[1], i), l = at(L[0], L[1], i);
    if (u - l <= 0) { end = i; status = "expired"; break; }   // lines met without a breakout
    if (bars[i].close > u + 0.1 * atr[i]) { status = "breakoutUp"; end = i; target = bars[i].close + wStart; break; }
    if (bars[i].close < l - 0.1 * atr[i]) { status = "breakoutDown"; end = i; target = bars[i].close - wStart; break; }
  }
  if (status === "forming" && limit < bars.length - 1) status = "expired";
  const bias = { ascTriangle: 1, fallingWedge: 1, descTriangle: -1, risingWedge: -1, symTriangle: 0, broadening: 0 }[kind];
  return {
    kind, bias, status, start: bars[i0].time, end: bars[end].time, target,
    lines: [
      { role: "upper", a: pt(bars, i0, at(U[0], U[1], i0)), b: pt(bars, end, at(U[0], U[1], end)) },
      { role: "lower", a: pt(bars, i0, at(L[0], L[1], i0)), b: pt(bars, end, at(L[0], L[1], end)) },
    ],
    label: pt(bars, i0, at(U[0], U[1], i0)),
    pivots: win.length,
  };
}

/** Double top (dir 1) or double bottom (dir -1) from pivots X1, Y, X2. */
function double(bars, atr, [x1, y, x2], dir) {
  const a = atr[x2.i];
  if (dir * (x1.price - y.price) <= 0 || Math.abs(x1.price - x2.price) > 0.6 * a) return null;
  const peak = dir > 0 ? Math.max(x1.price, x2.price) : Math.min(x1.price, x2.price);
  const shallower = dir > 0 ? Math.min(x1.price, x2.price) : Math.max(x1.price, x2.price);
  const height = dir * (shallower - y.price);
  if (height < 2 * a || x2.i - x1.i < 8) return null;
  const span = x2.i - x1.i, limit = Math.min(bars.length - 1, x2.i + span);
  let status = "forming", end = limit, target = null;
  for (let i = x2.i + 1; i <= limit; i++) {
    if (dir * (bars[i].close - peak) > 0.3 * atr[i]) return null;   // went on to a new extreme: no pattern
    if (dir * (y.price - bars[i].close) > 0.1 * atr[i]) { status = dir > 0 ? "breakoutDown" : "breakoutUp"; end = i; target = y.price - dir * height; break; }
  }
  if (status === "forming" && limit < bars.length - 1) status = "expired";
  return {
    kind: dir > 0 ? "doubleTop" : "doubleBottom", bias: -dir, status, start: x1.time, end: bars[end].time, target,
    lines: [
      { role: "path", ...line(x1, y) }, { role: "path", ...line(y, x2) },
      { role: "neck", a: { t: x1.time, p: y.price }, b: { t: bars[end].time, p: y.price } },
    ],
    label: { t: x1.time, p: x1.price },
    pivots: 3,
  };
}

/** Head and shoulders (dir 1) or inverse (dir -1) from pivots S1, N1, H, N2, S2. */
function headShoulders(bars, atr, [s1, n1, h, n2, s2], dir) {
  const a = atr[s2.i];
  if (dir * (h.price - s1.price) < 0.5 * a || dir * (h.price - s2.price) < 0.5 * a) return null;
  if (Math.abs(s1.price - s2.price) > 1.2 * a) return null;
  if (dir * (s1.price - n1.price) <= 0 || dir * (s2.price - n2.price) <= 0) return null;
  const neckAt = (i) => at(n1, n2, i);
  const height = dir * (h.price - neckAt(h.i));
  if (height < 2 * a || s2.i - s1.i < 12) return null;
  const span = s2.i - s1.i, limit = Math.min(bars.length - 1, s2.i + Math.ceil(span / 2));
  let status = "forming", end = limit, target = null;
  for (let i = s2.i + 1; i <= limit; i++) {
    if (dir * (bars[i].close - h.price) > 0) return null;   // beyond the head: no pattern
    if (dir * (neckAt(i) - bars[i].close) > 0.1 * atr[i]) { status = dir > 0 ? "breakoutDown" : "breakoutUp"; end = i; target = neckAt(i) - dir * height; break; }
  }
  if (status === "forming" && limit < bars.length - 1) status = "expired";
  return {
    kind: dir > 0 ? "headShoulders" : "invHeadShoulders", bias: -dir, status, start: s1.time, end: bars[end].time, target,
    lines: [
      { role: "path", ...line(s1, n1) }, { role: "path", ...line(n1, h) }, { role: "path", ...line(h, n2) }, { role: "path", ...line(n2, s2) },
      { role: "neck", a: pt(bars, s1.i, neckAt(s1.i)), b: pt(bars, end, neckAt(end)) },
    ],
    label: { t: h.time, p: h.price },
    pivots: 5,
  };
}

/**
 * Chart patterns on the pivots of `bars`, newest first. Patterns do not share pivots; a pattern found on more
 * pivots wins over a smaller one ending at the same place.
 * @param {{ depth?: number, max?: number }} [opts] depth: pivot strength (bars each side); max: how many to return.
 * @returns {{ kind: string, name: string, bias: -1|0|1, status: "forming"|"breakoutUp"|"breakoutDown"|"expired",
 *   start: number, end: number, target: number|null, lines: { role: string, a: {t:number,p:number}, b: {t:number,p:number} }[],
 *   label: {t:number,p:number} }[]}
 */
export function chartPatterns(bars, { depth = 5, max = 8 } = {}) {
  if (bars.length < depth * 4 + 10) return [];
  const atr = atrSeries(bars);
  const piv = swingPivots(bars, depth);
  const found = [];
  let e = piv.length - 1;
  while (e >= 2 && found.length < max) {
    let best = null;
    // triangles and wedges need five touches (three on one line, two on the other)
    for (const n of [6, 5]) {
      if (e - n + 1 < 0) continue;
      const r = convergence(bars, atr, piv.slice(e - n + 1, e + 1));
      if (r) { best = r; break; }
    }
    if (!best && e >= 4) {
      const w = piv.slice(e - 4, e + 1);
      best = headShoulders(bars, atr, w, w[0].kind === "H" ? 1 : -1);
    }
    if (!best) {
      const w = piv.slice(e - 2, e + 1);
      best = double(bars, atr, w, w[0].kind === "H" ? 1 : -1);
    }
    if (best) { found.push({ ...best, name: CHART_PATTERN_NAMES[best.kind] }); e -= best.pivots; }
    else e -= 1;
  }
  return found.map(({ pivots: _p, ...r }) => r);
}

// ---------- candlestick patterns ----------

export const CANDLE_PATTERN_NAMES = {
  hammer: "Búa", hangingMan: "Người treo cổ", invHammer: "Búa ngược", shootingStar: "Sao băng",
  bullEngulfing: "Nhấn chìm tăng", bearEngulfing: "Nhấn chìm giảm", bullHarami: "Harami tăng", bearHarami: "Harami giảm",
  piercing: "Xuyên thủng", darkCloud: "Mây đen che phủ", morningStar: "Sao mai", eveningStar: "Sao hôm",
  threeSoldiers: "Ba chàng lính", threeCrows: "Ba con quạ", tweezerBottom: "Đáy nhíp", tweezerTop: "Đỉnh nhíp",
  bullMarubozu: "Marubozu tăng", bearMarubozu: "Marubozu giảm", doji: "Doji",
};

/**
 * Candlestick patterns, at most one per bar (three-bar patterns first, then two-bar, then one-bar). Reversal
 * patterns need the trend they reverse: the close before the pattern below (or above) both its 10-bar average
 * and the close 5 bars earlier.
 * @param {{ doji?: boolean }} [opts] doji: also report plain dojis (off by default: they are very common).
 * @returns {{ i: number, time: number, kind: string, name: string, bias: -1|0|1 }[]}
 */
export function candlestickPatterns(bars, { doji = false } = {}) {
  const atr = atrSeries(bars);
  const out = [];
  const body = (b) => Math.abs(b.close - b.open), green = (b) => b.close > b.open, red = (b) => b.close < b.open;
  const upperW = (b) => b.high - Math.max(b.open, b.close), lowerW = (b) => Math.min(b.open, b.close) - b.low;
  const mid = (b) => (b.open + b.close) / 2;
  const pre = [0];
  for (const b of bars) pre.push(pre[pre.length - 1] + b.close);
  for (let i = 10; i < bars.length; i++) {
    const b = bars[i], p = bars[i - 1], q = bars[i - 2], a = atr[i];
    const ref = p.close, sma = (pre[i] - pre[i - 10]) / 10;   // average of the 10 closes before this bar
    // trend into this bar (uses closes up to the previous bar)
    const before = i >= 3 ? bars[i - 3].close : ref, five = bars[i - 6].close;
    const down = ref < sma && ref < five, up = ref > sma && ref > five;
    const down3 = before < five, up3 = before > five;   // trend before a three-bar pattern
    const range = b.high - b.low, bb = body(b);
    let kind = null;
    // three bars
    if (down3 && red(q) && body(q) >= 0.8 * a && body(p) <= 0.35 * body(q) && green(b) && b.close > mid(q)) kind = "morningStar";
    else if (up3 && green(q) && body(q) >= 0.8 * a && body(p) <= 0.35 * body(q) && red(b) && b.close < mid(q)) kind = "eveningStar";
    else if ([q, p, b].every(green) && p.close > q.close && b.close > p.close && [q, p, b].every((x) => body(x) >= 0.5 * a && upperW(x) <= 0.3 * body(x))
      && p.open >= q.open && p.open <= q.close && b.open >= p.open && b.open <= p.close) kind = "threeSoldiers";
    else if ([q, p, b].every(red) && p.close < q.close && b.close < p.close && [q, p, b].every((x) => body(x) >= 0.5 * a && lowerW(x) <= 0.3 * body(x))
      && p.open <= q.open && p.open >= q.close && b.open <= p.open && b.open >= p.close) kind = "threeCrows";
    // two bars
    else if (down && red(p) && green(b) && b.close >= p.open && b.open <= p.close && bb > body(p) && bb >= 0.5 * a) kind = "bullEngulfing";
    else if (up && green(p) && red(b) && b.close <= p.open && b.open >= p.close && bb > body(p) && bb >= 0.5 * a) kind = "bearEngulfing";
    else if (down && red(p) && body(p) >= a && green(b) && b.open <= p.close && b.close > mid(p) && b.close < p.open) kind = "piercing";
    else if (up && green(p) && body(p) >= a && red(b) && b.open >= p.close && b.close < mid(p) && b.close > p.open) kind = "darkCloud";
    else if (down && red(p) && body(p) >= a && green(b) && bb <= 0.5 * body(p) && b.open >= p.close && b.close <= p.open) kind = "bullHarami";
    else if (up && green(p) && body(p) >= a && red(b) && bb <= 0.5 * body(p) && b.open <= p.close && b.close >= p.open) kind = "bearHarami";
    else if (down && red(p) && green(b) && Math.abs(b.low - p.low) <= 0.05 * a && body(p) >= 0.4 * a && bb >= 0.4 * a) kind = "tweezerBottom";
    else if (up && green(p) && red(b) && Math.abs(b.high - p.high) <= 0.05 * a && body(p) >= 0.4 * a && bb >= 0.4 * a) kind = "tweezerTop";
    // one bar
    else if (range >= 0.6 * a && lowerW(b) >= 2 * bb && upperW(b) <= 0.15 * range && bb >= 0.05 * range) kind = down ? "hammer" : up ? "hangingMan" : null;
    else if (range >= 0.6 * a && upperW(b) >= 2 * bb && lowerW(b) <= 0.15 * range && bb >= 0.05 * range) kind = down ? "invHammer" : up ? "shootingStar" : null;
    else if (range >= 1.2 * a && bb >= 0.9 * range) kind = green(b) ? "bullMarubozu" : "bearMarubozu";
    else if (doji && range >= 0.5 * a && bb <= 0.1 * range) kind = "doji";
    if (!kind) continue;
    const bias = ["hammer", "invHammer", "bullEngulfing", "bullHarami", "piercing", "morningStar", "threeSoldiers", "tweezerBottom", "bullMarubozu"].includes(kind) ? 1
      : kind === "doji" ? 0 : -1;
    out.push({ i, time: b.time, kind, name: CANDLE_PATTERN_NAMES[kind], bias });
  }
  return out;
}

// ---------- key levels from candle closes ----------

/**
 * Price levels where candles keep closing and turning: closes at swing points (on the close series) are grouped
 * when they lie within 0.35 ATR of each other. A level needs at least two swing closes. Score = 2 per swing
 * close + 0.5 per other close near the level + a bonus when the level was used in the last quarter of the window.
 * @param {{ lookback?: number, max?: number, depth?: number }} [opts]
 * @returns {{ price: number, swings: number, touches: number, first: number, last: number, strength: 1|2|3, side: "support"|"resistance" }[]}
 *   Sorted from the highest price to the lowest.
 */
export function closeLevels(bars, { lookback = 400, max = 8, depth = 3 } = {}) {
  const from = Math.max(0, bars.length - lookback);
  const win = bars.slice(from);
  if (win.length < depth * 2 + 5) return [];
  const atr = atrSeries(bars);
  const tol = 0.35 * atr[bars.length - 1];
  const closes = win.map((b) => b.close);
  const cands = [];
  for (let i = depth; i < win.length - depth; i++) {
    let hi = true, lo = true;
    for (let k = 1; k <= depth; k++) {
      if (closes[i - k] >= closes[i] || closes[i + k] > closes[i]) hi = false;
      if (closes[i - k] <= closes[i] || closes[i + k] < closes[i]) lo = false;
    }
    if (hi || lo) cands.push({ price: closes[i], i });
  }
  cands.sort((a, b) => a.price - b.price);
  const clusters = [];
  for (const c of cands) {
    const last = clusters[clusters.length - 1];
    if (last && c.price - last.lowest <= tol) last.items.push(c);
    else clusters.push({ lowest: c.price, items: [c] });
  }
  const now = bars[bars.length - 1].close;
  const recentFrom = Math.floor(win.length * 0.75);
  const levels = clusters.filter((c) => c.items.length >= 2).map((c) => {
    const price = c.items.reduce((s, x) => s + x.price, 0) / c.items.length;
    const used = new Set(c.items.map((x) => x.i));
    let touches = 0;
    for (let i = 0; i < closes.length; i++) if (!used.has(i) && Math.abs(closes[i] - price) <= tol / 2) touches++;
    const idx = c.items.map((x) => x.i);
    const lastI = Math.max(...idx);
    return {
      price, swings: c.items.length, touches, first: win[Math.min(...idx)].time, last: win[lastI].time,
      score: c.items.length * 2 + touches * 0.5 + (lastI >= recentFrom ? 2 : 0),
      side: price >= now ? "resistance" : "support",
    };
  });
  // strongest first; a weaker level too close to a stronger one is dropped (closer than 1.2 ATR or 4% of the
  // window's price range, whichever is wider), so the chart shows distinct zones rather than a stack of lines
  let hi = -Infinity, lo = Infinity;
  for (const b of win) { hi = Math.max(hi, b.high); lo = Math.min(lo, b.low); }
  const gap = Math.max(tol * 1.5, atr[bars.length - 1] * 1.2, (hi - lo) * 0.04);
  const top = [];
  for (const l of levels.sort((a, b) => b.score - a.score)) {
    if (top.length >= max) break;
    if (top.every((t) => Math.abs(t.price - l.price) > gap)) top.push(l);
  }
  const scores = top.map((l) => l.score).sort((a, b) => b - a);
  const cut1 = scores[Math.floor(scores.length / 3)] ?? 0, cut2 = scores[Math.floor((scores.length * 2) / 3)] ?? 0;
  return top
    .map(({ score, ...l }) => ({ ...l, strength: score > cut1 ? 3 : score > cut2 ? 2 : 1 }))
    .sort((a, b) => b.price - a.price);
}

/**
 * Close of the previous day, week and month (UTC calendar periods; a forex "day" that ends at 17:00 New York
 * differs by a few hours). A period is skipped when the bars do not reach back to it.
 * @returns {{ period: "day"|"week"|"month", label: string, price: number, time: number }[]}
 */
export function periodCloses(bars) {
  const out = [];
  const labels = { day: "Đóng cửa ngày trước", week: "Đóng cửa tuần trước", month: "Đóng cửa tháng trước" };
  if (!bars.length) return out;
  for (const period of ["day", "week", "month"]) {
    const cur = periodKey(bars[bars.length - 1].time, period);
    for (let i = bars.length - 2; i >= 0; i--) {
      if (periodKey(bars[i].time, period) !== cur) { out.push({ period, label: labels[period], price: bars[i].close, time: bars[i].time }); break; }
    }
  }
  return out;
}

// ---------- trading sessions ----------

/** Forex sessions in each centre's local time, so daylight saving moves them on its own. */
export const SESSIONS = [
  { id: "sydney", name: "Sydney", tz: "Australia/Sydney", open: 7, close: 16, color: "#c58af9" },
  { id: "tokyo", name: "Tokyo", tz: "Asia/Tokyo", open: 9, close: 18, color: "#f5a142" },
  { id: "london", name: "London", tz: "Europe/London", open: 8, close: 17, color: "#4f8cff" },
  { id: "newyork", name: "New York", tz: "America/New_York", open: 8, close: 17, color: "#00c087" },
];

const formatters = new Map();
/** Offset of a time zone from UTC at the given instant, in milliseconds. */
function tzOffset(ms, tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
    formatters.set(tz, f);
  }
  const v = Object.fromEntries(f.formatToParts(new Date(ms)).filter((p) => p.type !== "literal").map((p) => [p.type, Number(p.value)]));
  return Date.UTC(v.year, v.month - 1, v.day, v.hour % 24, v.minute, v.second) - Math.floor(ms / 1000) * 1000;
}
/** UTC milliseconds of a wall-clock hour on a calendar date in a time zone. */
function zoned(y, m, d, h, tz) {
  const guess = Date.UTC(y, m, d, h);
  let t = guess - tzOffset(guess, tz);
  const again = guess - tzOffset(t, tz);
  if (again !== t) t = again;
  return t;
}

/**
 * Sessions (Monday to Friday, local dates) that overlap [from, to], in UTC seconds, sorted by start.
 * @returns {{ id: string, name: string, color: string, start: number, end: number }[]}
 */
export function sessionsBetween(from, to) {
  const out = [];
  const day0 = Math.floor(from / 86400) - 1, day1 = Math.floor(to / 86400) + 1;
  for (let day = day0; day <= day1; day++) {
    const date = new Date(day * 86400000);
    const y = date.getUTCFullYear(), m = date.getUTCMonth(), d = date.getUTCDate(), wd = date.getUTCDay();
    if (wd === 0 || wd === 6) continue;
    for (const s of SESSIONS) {
      const start = zoned(y, m, d, s.open, s.tz) / 1000, end = zoned(y, m, d, s.close, s.tz) / 1000;
      if (end > from && start < to) out.push({ id: s.id, name: s.name, color: s.color, start, end });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * Which sessions are open at `now` (UTC seconds), and the next open or close.
 * @returns {{ open: { id: string, name: string, color: string, end: number }[], next: { name: string, kind: "open"|"close", at: number } | null }}
 */
export function sessionStatus(now) {
  const list = sessionsBetween(now - 86400, now + 4 * 86400);
  const open = list.filter((s) => s.start <= now && now < s.end).map((s) => ({ id: s.id, name: s.name, color: s.color, end: s.end }));
  let next = null;
  for (const s of list) {
    for (const [kind, at] of [["open", s.start], ["close", s.end]]) {
      if (at > now && (!next || at < next.at)) next = { name: s.name, kind, at };
    }
  }
  return { open, next };
}
