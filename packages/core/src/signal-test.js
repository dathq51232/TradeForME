// Walk-forward test of the automatic chart reading: how often its predictions come true.
//
// At each bar t the detector sees only bars[0..t] (what was on the chart then). Every prediction is taken the first
// time it appears, with two price levels fixed at that moment: `hit` (it came true) and `fail` (the reading was
// wrong). The bars after t decide which is reached first; neither within `horizon` bars = "open".
// Inside one bar that touches both, it counts as a miss (the worst case, as a trader could not know the order).
//
// Elliott readings tested:
//   wave4    (1)-(4) counted: wave 5 comes             hit = beyond the end of 3    fail = into wave 1's territory
//   top      (5) done, price closed beyond the 2-4 line: a correction comes
//                                                      hit = 38.2% retrace of 0-5  fail = beyond the end of 5
//   waveC    B done (C under way): C goes past A       hit = beyond the end of A    fail = B beyond 138.2% of A
//   resume   A-B-C done: the trend resumes             hit = beyond the end of B    fail = beyond the end of C
// (topAfter24: false / cAfterB: false test the early calls instead: at the wave-5 pivot, while B still runs. On
// 15 000 bars of gold, oil, silver, BTC and ETH those early calls did no better than a coin; see summarize's edge.)
// Micro wedges (stage "broken"): hit = TP1, fail = stop. Chart patterns (breakout with a target): hit = target,
// fail = back beyond the breakout bar's opposite extreme.
// Also: how often the Elliott count repaints (a wave point already confirmed moves or disappears later).
// Pure functions over bars { time, open, high, low, close }.
import { elliottWaves } from "./elliott.js";
import { chartPatterns, microWedges } from "./patterns.js";

/** Which of the two levels the bars from `from` on reach first. dir 1: hit above, fail below; -1: the reverse. */
export function resolve(bars, from, { dir, hit, fail }, horizon = 200) {
  const end = Math.min(bars.length, from + horizon);
  for (let i = from; i < end; i++) {
    const b = bars[i];
    const reachedHit = dir > 0 ? b.high >= hit : b.low <= hit;
    const reachedFail = dir > 0 ? b.low <= fail : b.high >= fail;
    if (reachedFail) return { outcome: "miss", at: i };
    if (reachedHit) return { outcome: "hit", at: i };
  }
  return { outcome: end - from >= horizon ? "expired" : "open", at: null };
}

/** The Elliott predictions in one count (see the table above), each with a key that stays the same while it holds. */
export function elliottPredictions(count, { topNeedsDivergence = false, topAfter24 = true, cAfterB = true } = {}) {
  if (!count) return [];
  const pts = count.points;
  const at = (label) => pts.findIndex((p) => p.label === label);
  const firm = (k) => k >= 0 && !pts[k].provisional;
  const key = (n) => pts.slice(0, n).map((p) => `${p.label}@${p.time}`).join(",");
  const dir = count.dir;
  const out = [];
  const i1 = at("(1)"), i3 = at("(3)"), i4 = at("(4)"), i5 = at("(5)"), iA = at("A"), iB = at("B"), iC = at("C");
  if (count.stage === "w4" && firm(i3)) {
    out.push({ kind: "wave4", key: `w4:${key(i3 + 1)}`, dir, hit: pts[i3].price, fail: pts[i1].price, label: "Sau sóng 4 có sóng 5" });
  }
  if ((count.stage === "w5" || count.stage === "A") && firm(i5) && (!topNeedsDivergence || count.divergence) && (!topAfter24 || count.endConfirmed)) {
    const span = pts[i5].price - pts[0].price;
    out.push({ kind: "top", key: `top:${key(i5 + 1)}`, dir: -dir, hit: pts[i5].price - 0.382 * span, fail: pts[i5].price, label: "Sóng 5 xong → điều chỉnh" });
  }
  if ((cAfterB ? count.stage === "C" && pts[iC].provisional && firm(iB) : count.stage === "B") && firm(iA)) {
    // the wave before A ends where A starts: (5), or the top of a correction counted on its own
    const startA = pts[iA - 1];
    const d = pts[iA].price < startA.price ? -1 : 1;
    // B may run past the start of A up to bMax of A (an expanded flat); beyond that the count is wrong
    const lenA = Math.abs(pts[iA].price - startA.price);
    const fail = pts[iA].price - d * (count.bMax ?? 1.382) * lenA;
    out.push({ kind: "waveC", key: `C:${key(iA + 1)}`, dir: d, hit: pts[iA].price, fail, label: "B xong → C vượt A" });
  }
  if (count.stage === "C" && firm(iC) && iB >= 0) {
    const d = pts[iC].price < pts[iB].price ? 1 : -1;
    out.push({ kind: "resume", key: `R:${key(iC + 1)}`, dir: d, hit: pts[iB].price, fail: pts[iC].price, label: "Sau A-B-C xu hướng chạy tiếp" });
  }
  return out;
}

/** Confirmed (not provisional) wave points of a count, as "label@time". */
const confirmed = (count) => new Set((count?.points ?? []).filter((p) => !p.provisional && p.label).map((p) => `${p.label}@${p.time}`));

export const SIGNAL_KINDS = {
  wave4: "Elliott: sau sóng 4 có sóng 5",
  top: "Elliott: sóng 5 xong (đã phá đường 2-4) → điều chỉnh",
  waveC: "Elliott: B xong → sóng C vượt A",
  resume: "Elliott: sau A-B-C xu hướng chạy tiếp",
  wedge: "Nêm nhỏ đã phá: chạm TP1 trước SL",
  pattern: "Mô hình giá đã phá: chạm mục tiêu",
};

/**
 * Walk forward over `bars` and test the readings.
 * @param {object} o
 * @param {("elliott"|"wedges"|"patterns")[]} [o.detectors]
 * @param {number} [o.warmup] bars before the first reading
 * @param {number} [o.every] read every n bars (1 = every bar; larger is faster, a prediction is then seen later)
 * @param {number} [o.horizon] bars a prediction has to come true
 * @param {object} [o.elliott] options for elliottWaves (depth, minAtr, upOnly)
 * @param {(done: number) => void} [o.onProgress]
 * @returns {{ signals: object[], summary: Record<string, {n:number, hit:number, miss:number, open:number, rate:number|null, bars:number|null}>,
 *   repaints: number, repaintPer100: number|null, steps: number }}
 */
export function signalTest(bars, { detectors = ["elliott", "wedges", "patterns"], warmup = 150, every = 1, horizon = 200, elliott = {}, predict = {}, onProgress } = {}) {
  const seen = new Set();
  const signals = [];
  let prevFirm = null, repaints = 0, steps = 0, countedSteps = 0;
  const add = (t, p) => {
    if (seen.has(p.key)) return;
    seen.add(p.key);
    const r = resolve(bars, t + 1, p, horizon);
    // what a coin would score: a random walk from the close reaches the nearer level first, in proportion
    const c = bars[t].close, dh = Math.abs(p.hit - c), df = Math.abs(p.fail - c);
    const base = dh + df > 0 ? df / (dh + df) : 0.5;
    signals.push({ ...p, degree: p.degree, time: bars[t].time, i: t, close: c, base, outcome: r.outcome, at: r.at, resolvedTime: r.at != null ? bars[r.at].time : null });
  };
  for (let t = Math.max(warmup, 30); t < bars.length; t += every) {
    const view = bars.slice(0, t + 1);
    steps++;
    if (detectors.includes("elliott")) {
      const c = elliottWaves(view, elliott);
      for (const p of elliottPredictions(c, predict)) add(t, { ...p, degree: c.degree });
      // repaint: a point that was confirmed at the last reading is gone now (moved or relabelled)
      const firm = confirmed(c);
      if (prevFirm && prevFirm.size) {
        countedSteps++;
        for (const k of prevFirm) if (!firm.has(k)) { repaints++; break; }
      }
      prevFirm = firm;
    }
    if (detectors.includes("wedges")) {
      for (const w of microWedges(view, { max: 3 })) {
        if (w.stage !== "broken" || w.entry == null || w.stop == null || w.tp1 == null) continue;
        add(t, { kind: "wedge", key: `wedge:${w.kind}:${w.start}`, dir: w.bias, hit: w.tp1, fail: w.stop, label: w.name });
      }
    }
    if (detectors.includes("patterns")) {
      for (const p of chartPatterns(view, { depth: elliott.depth ?? 5, max: 6 })) {
        if (p.target == null || (p.status !== "breakoutUp" && p.status !== "breakoutDown")) continue;
        const bi = view.findIndex((b) => b.time === p.end);
        if (bi < 0 || t - bi > every) continue; // only when the breakout is new: older ones were taken already or are stale
        const dir = p.status === "breakoutUp" ? 1 : -1;
        add(t, { kind: "pattern", key: `pat:${p.kind}:${p.start}`, dir, hit: p.target, fail: dir > 0 ? view[bi].low : view[bi].high, label: p.name });
      }
    }
    onProgress?.(t);
  }
  return { signals, summary: summarize(signals), repaints, repaintPer100: countedSteps ? (100 * repaints) / countedSteps : null, steps };
}

/**
 * By kind: hit rate = hits / (hits + misses) (open and expired ones left out); `base` the rate a coin would get on
 * the same levels (see signalTest), so `edge` = rate - base is what the reading adds; `bars` the average wait for a hit.
 */
export function summarize(signals) {
  const out = {};
  for (const s of signals) {
    const r = (out[s.kind] ??= { n: 0, hit: 0, miss: 0, open: 0, rate: null, base: null, edge: null, bars: null, _bars: 0, _base: 0 });
    r.n++;
    if (s.outcome === "hit") { r.hit++; r._bars += s.at - s.i; } else if (s.outcome === "miss") r.miss++; else { r.open++; continue; }
    r._base += s.base ?? 0.5;
  }
  for (const r of Object.values(out)) {
    const done = r.hit + r.miss;
    r.rate = done ? r.hit / done : null;
    r.base = done ? r._base / done : null;
    r.edge = done ? r.rate - r.base : null;
    r.bars = r.hit ? r._bars / r.hit : null;
    delete r._bars; delete r._base;
  }
  return out;
}
