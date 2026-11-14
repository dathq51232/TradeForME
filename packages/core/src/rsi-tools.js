// RSI reading tools: trendlines drawn on the RSI the way a trader draws them, regular and hidden divergence
// between price and RSI (hội tụ / phân kỳ), and volume spikes. Pure functions over arrays and bars
// { time, open, high, low, close, volume }; no DOM, no network. A reading aid, not signals.

const finite = (v) => typeof v === "number" && Number.isFinite(v);

/**
 * Pivots of a series: a high beats the `left` values before it and is not beaten by the `right` values after it
 * (lows mirrored). Only pivots with `right` values after them are returned, so each is confirmed `right` bars later.
 * @returns {{ i: number, v: number, kind: "H"|"L" }[]} in order
 */
export function seriesPivots(values, left = 3, right = left) {
  const out = [];
  for (let i = left; i < values.length - right; i++) {
    const v = values[i];
    if (!finite(v)) continue;
    let hi = true, lo = true;
    for (let k = 1; k <= left && (hi || lo); k++) {
      const a = values[i - k];
      if (!finite(a)) { hi = lo = false; break; }
      if (a >= v) hi = false;
      if (a <= v) lo = false;
    }
    for (let k = 1; k <= right && (hi || lo); k++) {
      const a = values[i + k];
      if (!finite(a)) { hi = lo = false; break; }
      if (a > v) hi = false;
      if (a < v) lo = false;
    }
    if (hi) out.push({ i, v, kind: "H" });
    else if (lo) out.push({ i, v, kind: "L" });
  }
  return out;
}

/**
 * Trendlines on an oscillator (RSI): a resistance joins two pivot highs with every value between them under the
 * line, and runs on to the right until the RSI closes above it (a break) or for as long again as the two touches
 * span. Supports mirror that on the lows. Lines touching more pivots win; lines on the same side that overlap
 * most of their length keep only the best one.
 * @param {number[]} values the RSI
 * @param {{ depth?: number, minSpan?: number, maxSpan?: number, tol?: number, breakTol?: number, lookback?: number, max?: number, maxSlope?: number }} [opts]
 *   depth: pivot strength (bars each side); minSpan/maxSpan: bars between the first and last touch; tol: how close
 *   (RSI points) a value must come to count as a touch, and how far over the line it may poke; breakTol: how far
 *   past the line a value must close to break it; lookback: only lines whose last touch is this recent; max: lines per side; maxSlope: steepest line, in RSI
 *   points a bar (a trader's RSI trendline is gentle; a steep one is just two neighbouring swings)
 * @returns {{ side: "res"|"sup", i1: number, v1: number, i2: number, v2: number, end: number, broken: boolean,
 *   touches: number, at: (i: number) => number }[]} oldest first
 */
export function oscTrendlines(values, opts = {}) {
  const { depth = 3, minSpan = 6, maxSpan = 90, tol = 1.5, breakTol = 1, lookback = 300, max = 6, maxSlope = 0.6 } = opts;
  const n = values.length;
  const piv = seriesPivots(values, depth, depth);
  const lines = [];
  for (const side of ["res", "sup"]) {
    const s = side === "res" ? 1 : -1; // +1: values must stay under the line
    const pts = piv.filter((p) => p.kind === (side === "res" ? "H" : "L"));
    const cands = [];
    for (let b = pts.length - 1; b >= 1; b--) {
      const q = pts[b];
      if (q.i < n - lookback) break;
      for (let a = b - 1; a >= Math.max(0, b - 4); a--) {
        const p = pts[a];
        const span = q.i - p.i;
        if (span < minSpan) continue;
        if (span > maxSpan) break;
        const slope = (q.v - p.v) / span;
        if (Math.abs(slope) > maxSlope) continue;
        const at = (i) => p.v + slope * (i - p.i);
        let ok = true;
        for (let k = p.i + 1; k < q.i && ok; k++) if (finite(values[k]) && s * (values[k] - at(k)) > tol) ok = false;
        if (!ok) continue;
        let touches = 0;
        for (const m of pts) if (m.i >= p.i && m.i <= q.i && Math.abs(m.v - at(m.i)) <= tol) touches++;
        // run on to the right until the oscillator closes through the line
        const limit = Math.min(n - 1, q.i + Math.max(span, 12));
        let end = limit, broken = false;
        for (let k = q.i + 1; k <= limit; k++) {
          if (!finite(values[k])) continue;
          if (s * (values[k] - at(k)) > breakTol) { end = k; broken = true; break; }
        }
        if (Math.min(at(p.i), at(end)) < 0 || Math.max(at(p.i), at(end)) > 100) continue;
        cands.push({ side, i1: p.i, v1: p.v, i2: q.i, v2: q.v, end, broken, touches, at });
      }
    }
    cands.sort((x, y) => y.touches - x.touches || (y.i2 - y.i1) - (x.i2 - x.i1) || y.i2 - x.i2);
    const kept = [];
    for (const c of cands) {
      const clash = kept.some((k) => {
        const lo = Math.max(k.i1, c.i1), hi = Math.min(k.end, c.end);
        return hi - lo > 0.4 * Math.min(k.end - k.i1, c.end - c.i1);
      });
      if (!clash) kept.push(c);
      if (kept.length >= max) break;
    }
    lines.push(...kept);
  }
  return lines.sort((a, b) => a.i1 - b.i1);
}

export const DIVERGENCE_NAMES = {
  bull: "Hội tụ",            // price lower low, RSI higher low
  bear: "Phân kỳ",           // price higher high, RSI lower high
  hiddenBull: "Hội tụ ẩn",   // price higher low, RSI lower low (uptrend continuation)
  hiddenBear: "Phân kỳ ẩn",  // price lower high, RSI higher high (downtrend continuation)
};

/**
 * Divergence between price and an oscillator, on consecutive oscillator pivots (`left` bars before, `right` after,
 * so each is known `right` bars later) between `minGap` and `maxGap` bars apart. Price is the bar's low at pivot
 * lows and its high at pivot highs.
 * @returns {{ kind: "bull"|"bear"|"hiddenBull"|"hiddenBear", name: string, i1: number, i2: number, p1: number, p2: number,
 *   r1: number, r2: number, confirmed: number }[]} oldest first
 */
export function divergences(bars, values, opts = {}) {
  const { left = 5, right = 5, minGap = 5, maxGap = 60, hidden = true, minDiff = 1 } = opts;
  const piv = seriesPivots(values, left, right);
  const out = [];
  for (const kind of ["L", "H"]) {
    const pts = piv.filter((p) => p.kind === kind);
    for (let k = 1; k < pts.length; k++) {
      const a = pts[k - 1], b = pts[k];
      const gap = b.i - a.i;
      if (gap < minGap || gap > maxGap) continue;
      const pa = kind === "L" ? bars[a.i].low : bars[a.i].high;
      const pb = kind === "L" ? bars[b.i].low : bars[b.i].high;
      const dr = b.v - a.v;
      if (Math.abs(dr) < minDiff) continue;
      let type = null;
      if (kind === "L") {
        if (pb < pa && dr > 0) type = "bull";
        else if (hidden && pb > pa && dr < 0) type = "hiddenBull";
      } else {
        if (pb > pa && dr < 0) type = "bear";
        else if (hidden && pb < pa && dr > 0) type = "hiddenBear";
      }
      if (type) out.push({ kind: type, name: DIVERGENCE_NAMES[type], i1: a.i, i2: b.i, p1: pa, p2: pb, r1: a.v, r2: b.v, confirmed: b.i + right });
    }
  }
  return out.sort((x, y) => x.i2 - y.i2);
}

/**
 * Bars whose volume is at least `mult` times the average of the `length` bars before them.
 * @returns {{ i: number, ratio: number, up: boolean }[]} up: the bar closed above its open (buying came in)
 */
export function volumeSpikes(bars, { length = 20, mult = 2.5 } = {}) {
  const out = [];
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    if (i >= length) {
      const avg = sum / length;
      const v = bars[i].volume;
      if (avg > 0 && finite(v) && v >= mult * avg) out.push({ i, ratio: v / avg, up: bars[i].close >= bars[i].open });
      sum -= bars[i - length].volume || 0;
    }
    sum += bars[i].volume || 0;
  }
  return out;
}

/**
 * Lays straight segments into a few series of one value per bar (NaN elsewhere), so each can be drawn as a line
 * series: segments that overlap in time go to different series, and two in the same series keep a gap between them.
 * Segments beyond `slots` series are dropped (the oldest first, as segments come oldest first).
 * @param {{ i1: number, v1: number, i2: number, v2: number }[]} segs drawn from (i1, v1) to (i2, v2)
 * @returns {number[][]} `slots` arrays of length `n`
 */
export function layoutSegments(segs, n, slots) {
  const out = Array.from({ length: slots }, () => new Array(n).fill(NaN));
  // newest first, so the lines that matter now are the ones kept when there are too many
  for (const s of [...segs].sort((a, b) => b.i2 - a.i2)) {
    const lo = Math.max(0, Math.min(s.i1, s.i2)), hi = Math.min(n - 1, Math.max(s.i1, s.i2));
    const slot = out.findIndex((arr) => {
      for (let i = Math.max(0, lo - 1); i <= Math.min(n - 1, hi + 1); i++) if (finite(arr[i])) return false;
      return true;
    });
    if (slot < 0) continue;
    const slope = s.i2 === s.i1 ? 0 : (s.v2 - s.v1) / (s.i2 - s.i1);
    for (let i = lo; i <= hi; i++) out[slot][i] = s.v1 + slope * (i - s.i1);
  }
  return out;
}
