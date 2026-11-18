// Long-term trend on daily closes, for gold, silver, oil and Bitcoin (trend alerts and the trend panel).
//   up    EMA50 above EMA200 and the close above EMA200
//   down  EMA50 below EMA200 and the close below EMA200
//   side  anything else (the averages and the price disagree)
// A new state counts only once two closes in a row agree on it, so a single close around EMA200 does not flip it.
// Pure functions over bars { time (UTC seconds), open, high, low, close, volume }. A reading aid, not signals.
import { ema } from "./indicators.js";

export const FAST = 50;
export const SLOW = 200;
export const TREND_LABEL = { up: "Tăng dài hạn", down: "Giảm dài hạn", side: "Đi ngang / chưa rõ" };

const finite = (v) => typeof v === "number" && Number.isFinite(v);

/** Raw and confirmed trend state per bar, with the two averages. States are null until EMA200 is ready. */
export function trendSeries(bars, fast = FAST, slow = SLOW) {
  const close = bars.map((b) => b.close);
  const f = ema(close, fast);
  const s = ema(close, slow);
  const raw = bars.map((b, i) => {
    if (!finite(f[i]) || !finite(s[i])) return null;
    if (f[i] > s[i] && b.close > s[i]) return "up";
    if (f[i] < s[i] && b.close < s[i]) return "down";
    return "side";
  });
  const state = [];
  let cur = null;
  for (let i = 0; i < bars.length; i++) {
    if (raw[i] == null) { state.push(null); continue; }
    if (cur == null) cur = raw[i];
    else if (raw[i] !== cur && raw[i - 1] === raw[i]) cur = raw[i];
    state.push(cur);
  }
  return { fast: f, slow: s, raw, state };
}

/** Where the long-term trend stands on the last bar of `bars`; null without enough history. */
export function trendSummary(bars, fast = FAST, slow = SLOW) {
  const { fast: f, slow: s, state } = trendSeries(bars, fast, slow);
  const i = bars.length - 1;
  if (i < 0 || state[i] == null) return null;
  let k = i;
  while (k > 0 && state[k - 1] === state[i]) k--;
  const back = (n) => (i - n >= 0 && finite(s[i - n]) ? s[i - n] : null);
  const s20 = back(20);
  const year = bars.filter((b) => b.time > bars[i].time - 365 * 86400);
  return {
    state: state[i],
    label: TREND_LABEL[state[i]],
    since: bars[k].time,
    bars: i - k + 1,
    close: bars[i].close,
    emaFast: f[i],
    emaSlow: s[i],
    distPct: ((bars[i].close - s[i]) / s[i]) * 100,                   // close vs EMA200
    slopePct: s20 ? ((s[i] - s20) / s20) * 100 : null,                 // EMA200 over the last 20 bars
    high52: Math.max(...year.map((b) => b.high)),
    low52: Math.min(...year.map((b) => b.low)),
    time: bars[i].time,
  };
}

/**
 * What changed on the last bar of `bars` (it must be a closed bar):
 *   trend   the confirmed state changed
 *   cross   EMA50 crossed EMA200 (golden cross up, death cross down)
 *   ema200  the close crossed EMA200
 * Each event: { type, id, dir: 1 | -1 | 0, state? }.
 */
export function trendChanges(bars, fast = FAST, slow = SLOW) {
  const { fast: f, slow: s, state } = trendSeries(bars, fast, slow);
  const i = bars.length - 1;
  if (i < 1 || state[i] == null || state[i - 1] == null) return [];
  const out = [];
  if (state[i] !== state[i - 1]) out.push({ type: "trend", id: `trend|${state[i]}`, dir: state[i] === "up" ? 1 : state[i] === "down" ? -1 : 0, state: state[i] });
  const d0 = f[i - 1] - s[i - 1], d1 = f[i] - s[i];
  if (d0 <= 0 && d1 > 0) out.push({ type: "cross", id: "cross|golden", dir: 1 });
  if (d0 >= 0 && d1 < 0) out.push({ type: "cross", id: "cross|death", dir: -1 });
  const c0 = bars[i - 1].close - s[i - 1], c1 = bars[i].close - s[i];
  if (c0 <= 0 && c1 > 0) out.push({ type: "ema200", id: "ema200|above", dir: 1 });
  if (c0 >= 0 && c1 < 0) out.push({ type: "ema200", id: "ema200|below", dir: -1 });
  return out;
}
