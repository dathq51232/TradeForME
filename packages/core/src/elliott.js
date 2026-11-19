// Elliott wave count on the chart: the latest five-wave impulse (1)-(5) and the A-B-C correction after it, or an
// impulse still unfolding ((1)-(2)-(3), then (4)). Built on swing pivots with the small swings taken out (a leg must
// move at least `minAtr` ATRs), checked against the three hard rules:
//   wave 2 never goes beyond the start of wave 1
//   wave 3 is never the shortest of 1, 3 and 5
//   wave 4 never enters wave 1's price territory
// and scored on the usual guidelines (wave 2 retraces 38-79% of 1, wave 3 at least 1.0x and ideally 1.618x of 1,
// wave 4 retraces 24-50% of 3, waves 2 and 4 alternate in depth). One count at a time: a reading aid, not signals.
// Pure functions over bars { time, open, high, low, close }.
import { swingPivots } from "./patterns.js";
import { atr, rsiOf, source } from "./indicators.js";

/**
 * Swing pivots with every leg shorter than `minMove` removed (both its ends), with `collapse` sideways swings inside
 * the leg before them merged into that leg, then a provisional last point when
 * price has already moved `minMove` away from the last confirmed pivot (the live wave). Alternates H/L.
 * @returns {{ i: number, time: number, price: number, kind: "H" | "L", provisional?: boolean }[]}
 */
export function wavePivots(bars, { depth = 5, minAtr = 1.5, collapse = false } = {}) {
  if (bars.length < 2 * depth + 3) return [];
  const a = atr(bars, 14);
  const lastAtr = [...a].reverse().find((v) => Number.isFinite(v)) ?? 0;
  const minMove = lastAtr * minAtr;
  let piv = swingPivots(bars, depth);
  // the first leg: the extreme before the first pivot (bars at the very start cannot be pivots)
  if (piv.length) {
    const f = piv[0];
    let lead = null;
    for (let i = 0; i < f.i; i++) {
      if (f.kind === "H" && (!lead || bars[i].low < lead.price)) lead = { i, time: bars[i].time, price: bars[i].low, kind: "L" };
      if (f.kind === "L" && (!lead || bars[i].high > lead.price)) lead = { i, time: bars[i].time, price: bars[i].high, kind: "H" };
    }
    if (lead) piv = [lead, ...piv];
  }
  const merge = (list) => {
    const out = [];
    for (const p of list) {
      const last = out[out.length - 1];
      if (last && last.kind === p.kind) {
        if ((p.kind === "H" && p.price > last.price) || (p.kind === "L" && p.price < last.price)) out[out.length - 1] = p;
      } else out.push(p);
    }
    return out;
  };
  for (;;) {
    let j = -1, small = Infinity;
    for (let k = 0; k < piv.length - 1; k++) {
      const d = Math.abs(piv[k + 1].price - piv[k].price);
      if (d < small) { small = d; j = k; }
    }
    if (j < 0 || small >= minMove) break;
    // an edge leg loses its outer end; an inner leg loses both ends
    const drop = j === 0 ? [0] : j + 1 === piv.length - 1 ? [j + 1] : [j, j + 1];
    piv = merge(piv.filter((_, k) => !drop.includes(k)));
  }
  // a consolidation is one wave: a swing that stays inside the range of the leg before it (it breaks neither end)
  // is a sub-wave of that sideways move, so its two pivots go
  for (let k = 2; collapse && k + 1 < piv.length;) {
    const lo = Math.min(piv[k - 2].price, piv[k - 1].price), hi = Math.max(piv[k - 2].price, piv[k - 1].price);
    const inside = (q) => q.price > lo && q.price < hi;
    if (inside(piv[k]) && inside(piv[k + 1])) piv = merge([...piv.slice(0, k), ...piv.slice(k + 2)]);
    else k++;
  }
  // the live leg after the last confirmed pivot
  const last = piv[piv.length - 1];
  if (last) {
    let ext = null;
    for (let i = last.i + 1; i < bars.length; i++) {
      if (last.kind === "H" && (!ext || bars[i].low < ext.price)) ext = { i, time: bars[i].time, price: bars[i].low, kind: "L" };
      if (last.kind === "L" && (!ext || bars[i].high > ext.price)) ext = { i, time: bars[i].time, price: bars[i].high, kind: "H" };
    }
    if (ext && Math.abs(ext.price - last.price) >= minMove) piv.push({ ...ext, provisional: true });
    else if (ext) {
      // no reversal yet: the last leg may still be extending
      let more = null;
      for (let i = last.i + 1; i < bars.length; i++) {
        if (last.kind === "H" && bars[i].high > (more?.price ?? last.price)) more = { i, time: bars[i].time, price: bars[i].high };
        if (last.kind === "L" && bars[i].low < (more?.price ?? last.price)) more = { i, time: bars[i].time, price: bars[i].low };
      }
      if (more) piv[piv.length - 1] = { ...last, ...more, provisional: true };
    }
  }
  return piv;
}

const inRange = (v, lo, hi) => v >= lo && v <= hi;

/** Hard rules and guideline score for pivots p[0..k] (k = 3, 4 or 5) read as an impulse in direction `dir`. */
function impulseScore(p, dir) {
  const v = p.map((q) => q.price * dir); // up-impulse view: waves 1, 3, 5 go up
  const k = p.length - 1;
  const w1 = v[1] - v[0], w2 = v[1] - v[2], w3 = v[3] - v[2];
  if (!(w1 > 0 && w2 > 0 && w3 > 0)) return null;
  if (v[2] <= v[0]) return null;            // rule: wave 2 stays above the start of wave 1
  if (v[3] <= v[1]) return null;            // wave 3 goes beyond the end of wave 1
  let score = 0;
  const r2 = w2 / w1;
  if (inRange(r2, 0.382, 0.786)) score += 2; else if (inRange(r2, 0.236, 0.886)) score += 1;
  const x3 = w3 / w1;
  if (x3 >= 1.5 && x3 <= 2.8) score += 2; else if (x3 >= 1) score += 1;
  if (k >= 4) {
    const w4 = v[3] - v[4];
    if (!(w4 > 0)) return null;
    if (v[4] <= v[1]) return null;          // rule: wave 4 stays out of wave 1's territory
    const r4 = w4 / w3;
    if (inRange(r4, 0.236, 0.5)) score += 2; else if (r4 < 0.618) score += 1;
    if ((r2 >= 0.5) !== (r4 >= 0.5)) score += 1; // alternation: one deep, one shallow
  }
  if (k >= 5) {
    const w5 = v[5] - v[4];
    if (!(w5 > 0)) return null;
    if (w3 < w1 && w3 < w5) return null;    // rule: wave 3 is not the shortest
    if (v[5] > v[3]) score += 1;            // no truncated fifth
    const x5 = w5 / w1;
    if (inRange(x5, 0.618, 1.618)) score += 1;
  }
  return score;
}

const LABELS = ["", "(1)", "(2)", "(3)", "(4)", "(5)", "A", "B", "C"];

/**
 * The current Elliott count on `bars`, or null. `upOnly`: impulses are counted only upward (a common way to read a
 * market), and a fall is read as an A-B-C correction; by default an impulse follows the larger trend either way
 * (in a falling market, (1)-(5) point down and A-B-C is the bounce), as in Elliott's own rules.
 * @returns {null | {
 *   dir: 1 | -1, stage: "w3" | "w4" | "w5" | "A" | "B" | "C", text: string, score: number,
 *   points: { i: number, time: number, price: number, label: string, provisional: boolean }[],
 *   target: { price: number, label: string } | null
 * }}
 */
export function elliottWaves(bars, { depth = 5, minAtr = 1.5, upOnly = false, ...opt } = {}) {
  const o = { pick: "newest", minScore: 0, anchor: 0, bMax: 1.382, ...opt };
  o.rsi = rsiOf(source(bars, "close"), 14);
  // the smallest wave degree that gives a current count; a choppy correction at one degree is often a single wave
  // of the next one up, so the swing filter is widened before giving up
  const degrees = [minAtr, minAtr * 1.75, minAtr * 3];
  for (let d = o.minDegree ?? 0; d < degrees.length; d++) {
    for (const collapse of [false, true]) {
      const r = countAt(bars, depth, degrees[d], collapse, upOnly, o);
      if (r) return { ...r, degree: d, bMax: o.bMax };
    }
  }
  return null;
}

/** Wave 1 starts at a real turn: the lowest low (highest high going down) of the `n` bars before it. */
function anchored(bars, p0, dir, n) {
  if (!n) return true;
  for (let i = Math.max(0, p0.i - n); i < p0.i; i++) if (dir > 0 ? bars[i].low < p0.price : bars[i].high > p0.price) return false;
  return true;
}

function countAt(bars, depth, minAtr, collapse, upOnly, o) {
  const piv = wavePivots(bars, { depth, minAtr, collapse });
  if (piv.length < 4) return null;
  const n = piv.length;
  const dirOf = (q) => (q.kind === "L" ? 1 : -1);
  let best = null;
  // a complete impulse with at most three pivots after it (its correction), newest first ("best": highest score)
  for (let s = n - 6; s >= Math.max(0, n - 9); s--) {
    const p = piv.slice(s, s + 6);
    const dir = dirOf(p[0]);
    if (upOnly && dir < 0) continue;
    const sc = impulseScore(p, dir);
    if (sc == null || sc < o.minScore || !anchored(bars, p[0], dir, o.anchor)) continue;
    const after = piv.slice(s + 6);
    // correction: A against the trend, B back by at most 138.2% of A (beyond the end of 5 only in an expanded
    // flat), C beyond A
    const corr = [];
    if (after[0]) corr.push(after[0]);
    if (after[1] && Math.abs(after[1].price - after[0].price) <= o.bMax * Math.abs(after[0].price - p[5].price)) corr.push(after[1]);
    if (corr.length === 2 && after[2] && after[2].price * dir < after[0].price * dir) corr.push(after[2]);
    if (corr.length < after.length) continue; // what followed is not a clean A-B-C: the count is not current
    if (!best || (o.pick === "best" && sc > best.score)) best = { s, dir, score: sc, pts: [...p, ...corr] };
    if (o.pick !== "best") break;
  }
  // otherwise an impulse still unfolding, ending at the last pivot: (1)(2)(3) or (1)(2)(3)(4)
  if (!best) {
    for (const k of [4, 3]) {
      if (n < k + 1) continue;
      const p = piv.slice(n - k - 1);
      const dir = dirOf(p[0]);
      if (upOnly && dir < 0) continue;
      const sc = impulseScore(p, dir);
      if (sc != null && sc >= 2 && anchored(bars, p[0], dir, o.anchor)) { best = { s: n - k - 1, dir, score: sc, pts: p }; break; }
    }
  }
  // up-only: a fall from a top read as a correction on its own, A-B-C (or A-B so far), ending at the last pivot
  if (!best && upOnly) {
    for (const k of [3, 2]) {
      if (n < k + 1) continue;
      const p = piv.slice(n - k - 1);
      if (p[0].kind !== "H") continue;
      const a = p[0].price - p[1].price, b = p[2].price - p[1].price;
      if (!(a > 0 && b > 0 && b <= o.bMax * a)) continue;
      if (k === 3 && !(p[3].price < p[1].price)) continue;
      return correctionOnly(p);
    }
  }
  if (!best) return null;
  const { dir, pts } = best;
  const points = pts.map((q, k) => ({ i: q.i, time: q.time, price: q.price, label: LABELS[k], provisional: !!q.provisional }));
  const k = pts.length - 1;
  const stage = ["", "", "", "w3", "w4", "w5", "A", "B", "C"][k];
  const up = dir > 0;
  const trend = up ? "tăng" : "giảm";
  const live = points[k].provisional ? " (đang chạy)" : "";
  // The 2-4 line: the classic check that an impulse is over is a close beyond it after wave 5. Calling the top at
  // the wave-5 pivot alone did no better than chance in the walk-forward test (signal-test.js), so until price closes
  // beyond the line the count only says the fifth MAY be done.
  let line24 = null, endConfirmed = null;
  if (k >= 4) {
    const a = pts[2], b = pts[4];
    const at = (i) => a.price + ((b.price - a.price) * (i - a.i)) / (b.i - a.i || 1);
    line24 = { a: { time: a.time, price: a.price }, b: { time: b.time, price: b.price } };
    if (k >= 5) {
      endConfirmed = false;
      for (let i = pts[5].i + 1; i < bars.length; i++) if ((bars[i].close - at(i)) * dir < 0) { endConfirmed = true; break; }
    }
  }
  const confirm = endConfirmed ? "đã phá đường 2-4" : "chưa phá đường 2-4";
  const text = {
    w3: () => `Sóng đẩy ${trend.toUpperCase()}: đang ở sóng 3${live}`,
    w4: () => `Sóng đẩy ${trend.toUpperCase()}: sóng 4${live}, chờ sóng 5`,
    w5: () => `Sóng đẩy ${trend.toUpperCase()} 1-5${live ? (endConfirmed ? ": giá đã phá đường 2-4 sau sóng 5, sóng 5 có thể đã xong" : " (sóng 5 đang chạy)") : endConfirmed ? " hoàn tất (đã phá đường 2-4), chờ điều chỉnh A-B-C" : ": sóng 5 có thể đã xong, chờ giá phá đường 2-4 để xác nhận"}`,
    A: () => `Hồi ${up ? "giảm" : "tăng"} sau sóng đẩy ${trend}: sóng A${live} · ${confirm}`,
    B: () => `Hồi ${up ? "giảm" : "tăng"} sau sóng đẩy ${trend}: sóng B${live}, C chỉ xác nhận khi B kết thúc`,
    C: () => `Điều chỉnh A-B-C${live ? " (C đang chạy)" : " hoàn tất"}`,
  }[stage]();
  // one projection, where the next wave usually ends: 5 = 1 in length, C = A in length
  let target = null;
  if (stage === "w4") target = { price: pts[4].price + (pts[1].price - pts[0].price), label: "Sóng 5 = sóng 1" };
  if (stage === "B") target = { price: pts[7].price - (pts[5].price - pts[6].price), label: "C = A" };
  // momentum divergence at the end of wave 5: RSI lower at 5 than at 3 for an up impulse (higher going down)
  const r3 = o.rsi[pts[3]?.i], r5 = o.rsi[pts[5]?.i];
  const divergence = k >= 5 && Number.isFinite(r3) && Number.isFinite(r5) ? (r5 - r3) * dir < 0 : null;
  return { dir, stage, text, score: best.score, points, target, divergence, line24, endConfirmed };
}

/** A falling A-B-C (or A-B) after a top, without the impulse before it: labels "", A, B, C. */
function correctionOnly(p) {
  const points = p.map((q, k) => ({ i: q.i, time: q.time, price: q.price, label: ["", "A", "B", "C"][k], provisional: !!q.provisional }));
  const k = p.length - 1;
  const live = points[k].provisional ? " (đang chạy)" : "";
  const stage = k === 3 ? "C" : "B";
  const text = stage === "C" ? `Điều chỉnh giảm A-B-C${live ? " (C đang chạy)" : " hoàn tất"}` : `Điều chỉnh giảm: sóng B${live}, chờ C`;
  const target = stage === "B" ? { price: p[2].price - (p[0].price - p[1].price), label: "C = A" } : null;
  return { dir: 1, stage, text, score: 0, points, target };
}
