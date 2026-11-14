// RSI trendlines, divergence (hội tụ / phân kỳ), volume spikes, and the rsiTools indicator that draws them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { seriesPivots, oscTrendlines, divergences, volumeSpikes, layoutSegments } from "../src/rsi-tools.js";
import { compute, BY_ID } from "../src/indicators.js";

// Binance 15m klines -> bars
const btc15m = () => JSON.parse(readFileSync(new URL("./fixtures/btcusdt-15m-2026-11-14.json", import.meta.url), "utf8"))
  .map((k) => ({ time: k[0] / 1000, open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }));
const bar = (i, low, high = low + 2, volume = 100, up = true) =>
  ({ time: i * 60, open: up ? low + 0.5 : high - 0.5, high, low, close: up ? high - 0.5 : low + 0.5, volume });

test("pivots are confirmed by the bars after them", () => {
  const v = [1, 2, 5, 2, 1, 0, 1, 2, 3];
  assert.deepEqual(seriesPivots(v, 2, 2).map((p) => [p.i, p.kind]), [[2, "H"], [5, "L"]]);
  assert.deepEqual(seriesPivots([1, 2, 5, 2], 2, 2), [], "a high with too few bars after it is not a pivot yet");
});

// RSI waves whose highs touch a falling line (60 - 0.1 i) every 12 bars, then break above it.
function fallingResistance(breakAt = 62) {
  return Array.from({ length: 80 }, (_, i) => {
    const line = 60 - 0.1 * i;
    if (i >= breakAt) return line + 6;
    return line - 8 * (1 - Math.cos((2 * Math.PI * i) / 12)) / 2;
  });
}

test("a resistance drawn through RSI highs, broken when RSI closes above it", () => {
  const lines = oscTrendlines(fallingResistance(), { depth: 3, tol: 0.5 });
  const res = lines.filter((l) => l.side === "res");
  assert.ok(res.length >= 1);
  const best = res.find((l) => l.touches >= 3);
  assert.ok(best, JSON.stringify(res.map(({ at: _a, ...l }) => l)));
  assert.ok(Math.abs((best.v2 - best.v1) / (best.i2 - best.i1) + 0.1) < 1e-9, "the line follows the falling highs");
  assert.equal(best.broken, true);
  assert.equal(best.end, 62);
  // nothing between the touches pokes above the line
  for (let i = best.i1; i <= best.i2; i++) assert.ok(fallingResistance()[i] <= best.at(i) + 0.5);
});

test("an unbroken line runs on to the right for as long again as its touches span", () => {
  const v = fallingResistance(1e9).slice(0, 50);
  const res = oscTrendlines(v, { depth: 3, tol: 0.5 }).filter((l) => l.side === "res");
  assert.ok(res.every((l) => !l.broken));
  assert.ok(res.some((l) => l.end === v.length - 1));
});

test("supports mirror resistances", () => {
  const v = fallingResistance().map((x) => 100 - x); // rising lows, broken downward
  const sup = oscTrendlines(v, { depth: 3, tol: 0.5 }).filter((l) => l.side === "sup");
  assert.ok(sup.some((l) => l.touches >= 3 && l.broken && l.end === 62));
});

// RSI with pivot lows at 10 and 30, price lows at the same bars.
function setup(r1, r2, p1, p2, kind = "L") {
  const n = 45;
  const values = Array.from({ length: n }, () => (kind === "L" ? 55 : 45));
  const bars = Array.from({ length: n }, (_, i) => bar(i, kind === "L" ? 110 : 80));
  values[10] = r1; values[30] = r2;
  if (kind === "L") { bars[10] = bar(10, p1); bars[30] = bar(30, p2); }
  else { bars[10] = bar(10, p1 - 2, p1); bars[30] = bar(30, p2 - 2, p2); }
  return { bars, values };
}

test("divergence: hội tụ, phân kỳ, and their hidden forms", () => {
  const kinds = (s) => divergences(s.bars, s.values, { left: 5, right: 5 }).map((d) => d.kind);
  assert.deepEqual(kinds(setup(25, 32, 100, 95)), ["bull"], "price lower low, RSI higher low");
  assert.deepEqual(kinds(setup(32, 25, 95, 100)), ["hiddenBull"], "price higher low, RSI lower low");
  assert.deepEqual(kinds(setup(75, 68, 100, 105, "H")), ["bear"], "price higher high, RSI lower high");
  assert.deepEqual(kinds(setup(68, 75, 105, 100, "H")), ["hiddenBear"], "price lower high, RSI higher high");
  assert.deepEqual(kinds(setup(25, 32, 95, 100)), [], "both higher: no divergence");
  const s = setup(32, 25, 95, 100);
  assert.deepEqual(divergences(s.bars, s.values, { left: 5, right: 5, hidden: false }), []);
  const [d] = divergences(...Object.values(setup(25, 32, 100, 95)), { left: 5, right: 5 });
  assert.deepEqual([d.i1, d.i2, d.p1, d.p2, d.r1, d.r2, d.confirmed, d.name], [10, 30, 100, 95, 25, 32, 35, "Hội tụ"]);
});

test("volume spikes compare with the average of the bars before", () => {
  const bars = Array.from({ length: 30 }, (_, i) => bar(i, 100, 102, 100, true));
  bars[25] = bar(25, 100, 102, 400, false);
  bars[26] = bar(26, 100, 102, 240, true);
  const s = volumeSpikes(bars, { length: 20, mult: 2.5 });
  assert.equal(s.length, 1);
  assert.deepEqual([s[0].i, s[0].up], [25, false]);
  assert.ok(Math.abs(s[0].ratio - 4) < 1e-9);
});

test("segments that overlap go to different series, and the newest are kept", () => {
  const segs = [{ i1: 0, v1: 0, i2: 10, v2: 10 }, { i1: 12, v1: 2, i2: 20, v2: 2 }, { i1: 21, v1: 3, i2: 25, v2: 3 }];
  const [a, b] = layoutSegments(segs, 30, 2);
  assert.equal(a[25], 3, "the newest line is laid first");
  assert.ok(Number.isNaN(a[20]) && b[20] === 2, "touching segments do not share a series, so they don't join up");
  assert.ok(Math.abs(a[4] - 4) < 1e-9 && Number.isNaN(a[11]), "a segment that leaves a gap shares the series");
  const crowded = layoutSegments([{ i1: 0, v1: 1, i2: 10, v2: 1 }, { i1: 2, v1: 2, i2: 12, v2: 2 }, { i1: 4, v1: 3, i2: 14, v2: 3 }], 20, 2);
  assert.deepEqual(crowded.map((x) => x[8]).sort(), [2, 3], "with two series the oldest of three overlapping lines is dropped");
});

test("the rsiTools indicator on real 15m BTC bars: one value per bar for every output, valid markers", () => {
  const bars = btc15m();
  const out = compute("rsiTools", bars);
  for (const o of BY_ID.rsiTools.outputs) {
    assert.equal(out[o.key].length, bars.length, o.key);
  }
  // same RSI as the plain RSI indicator
  const plain = compute("rsi", bars);
  assert.deepEqual(out.value.slice(-50), plain.value.slice(-50));
  const drawn = (k) => out[k].some((v) => Number.isFinite(v));
  assert.ok(["res1", "sup1"].every(drawn), "draws trendlines on the RSI");
  const times = new Set(bars.map((b) => b.time));
  for (const m of [...out.markers, ...out.priceMarkers]) {
    assert.ok(times.has(m.time) && ["aboveBar", "belowBar"].includes(m.position) && ["arrowUp", "arrowDown", "circle"].includes(m.shape), JSON.stringify(m));
  }
  assert.ok(out.priceMarkers.some((m) => m.text.startsWith("Vol ×")), "marks volume spikes on the price");
  for (let i = 1; i < out.markers.length; i++) assert.ok(out.markers[i].time >= out.markers[i - 1].time);
});
