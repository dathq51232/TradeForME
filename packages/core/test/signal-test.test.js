import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve, elliottPredictions, signalTest, summarize } from "../src/signal-test.js";
import { elliottWaves } from "../src/elliott.js";

/** Bars along straight legs between waypoints, `per` bars a leg, with a small wick on each bar. */
function path(points, per = 10) {
  const bars = [];
  let prev = points[0];
  for (let s = 1; s < points.length; s++) {
    const n = Array.isArray(per) ? per[s - 1] : per;
    for (let k = 1; k <= n; k++) {
      const close = points[s - 1] + ((points[s] - points[s - 1]) * k) / n;
      bars.push({ time: bars.length * 3600, open: prev, high: Math.max(prev, close) + 0.2, low: Math.min(prev, close) - 0.2, close, volume: 1 });
      prev = close;
    }
  }
  return bars;
}

test("resolve: the level reached first decides; a bar touching both is a miss", () => {
  const bars = path([100, 110, 90], 10);
  assert.equal(resolve(bars, 0, { dir: 1, hit: 105, fail: 95 }).outcome, "hit");
  assert.equal(resolve(bars, 0, { dir: -1, hit: 95, fail: 105 }).outcome, "miss");
  const wide = [{ time: 0, open: 100, high: 120, low: 80, close: 100 }];
  assert.equal(resolve(wide, 0, { dir: 1, hit: 110, fail: 90 }).outcome, "miss");
  assert.equal(resolve(bars, 0, { dir: 1, hit: 500, fail: 1 }, 5).outcome, "expired");
  assert.equal(resolve(bars, 0, { dir: 1, hit: 500, fail: 1 }, 500).outcome, "open");
});

test("wave 4 counted: predicts a fifth beyond wave 3, wrong if price enters wave 1", () => {
  const c = elliottWaves(path([100, 120, 108, 150, 138]));
  const [p] = elliottPredictions(c);
  assert.equal(p.kind, "wave4");
  assert.equal(p.dir, 1);
  assert.equal(Math.round(p.hit), 150);
  assert.equal(Math.round(p.fail), 120);
});

test("the top is called only after a close beyond the 2-4 line", () => {
  // a long wave 4, so the 2-4 line rises slowly; the fifth tops at 160 and turns, still above the line
  const legs = [10, 10, 10, 60, 8, 7];
  const early = elliottWaves(path([100, 120, 108, 150, 138, 160, 150], legs));
  assert.equal(early.endConfirmed, false);
  assert.match(early.text, /chưa phá đường 2-4/);
  assert.deepEqual(elliottPredictions(early).filter((p) => p.kind === "top"), []);
  assert.equal(elliottPredictions(early, { topAfter24: false }).filter((p) => p.kind === "top").length, 1);
  // further down it closes below the line: confirmed
  const late = elliottWaves(path([100, 120, 108, 150, 138, 160, 136], [10, 10, 10, 60, 8, 14]));
  assert.equal(late.endConfirmed, true);
  const top = elliottPredictions(late).find((p) => p.kind === "top");
  assert.ok(top);
  assert.equal(top.dir, -1);
  assert.equal(Math.round(top.fail), 160);
  const span = top.fail - late.points[0].price;
  assert.ok(Math.abs(top.hit - (top.fail - 0.382 * span)) < 1e-9);
});

test("no look-ahead: a prediction made at bar t is the same whatever comes after t", () => {
  const bars = path([100, 120, 108, 150, 138, 165, 140, 155, 128, 150, 140, 175, 160, 190], 12);
  const full = signalTest(bars, { detectors: ["elliott"], warmup: 40, horizon: 50 });
  const cut = 120;
  // same history, a different future
  const other = [...bars.slice(0, cut + 1), ...path([bars[cut].close, bars[cut].close * 0.5], 60).map((b, k) => ({ ...b, time: bars[cut].time + (k + 1) * 3600 }))];
  const alt = signalTest(other, { detectors: ["elliott"], warmup: 40, horizon: 50 });
  const before = (r) => r.signals.filter((s) => s.i <= cut).map((s) => [s.key, s.i, s.hit, s.fail]);
  assert.ok(before(full).length > 0);
  assert.deepEqual(before(alt), before(full));
});

test("summary: rate leaves open ones out; edge is rate minus the coin's rate", () => {
  const s = summarize([
    { kind: "x", outcome: "hit", i: 0, at: 4, base: 0.5 },
    { kind: "x", outcome: "miss", i: 0, at: 2, base: 0.5 },
    { kind: "x", outcome: "hit", i: 0, at: 6, base: 0.8 },
    { kind: "x", outcome: "open", i: 0, at: null, base: 0.9 },
  ]);
  assert.equal(s.x.n, 4);
  assert.equal(s.x.open, 1);
  assert.equal(s.x.rate, 2 / 3);
  assert.ok(Math.abs(s.x.base - 0.6) < 1e-9);
  assert.ok(Math.abs(s.x.edge - (2 / 3 - 0.6)) < 1e-9);
  assert.equal(s.x.bars, 5);
});
