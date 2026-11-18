import { test } from "node:test";
import assert from "node:assert/strict";
import { elliottWaves, wavePivots } from "../src/elliott.js";

/** Bars along straight legs between waypoints, `per` bars a leg, with a small wick on each bar. */
function path(points, per = 10) {
  const bars = [];
  let prev = points[0];
  for (let s = 1; s < points.length; s++) {
    for (let k = 1; k <= per; k++) {
      const close = points[s - 1] + ((points[s] - points[s - 1]) * k) / per;
      bars.push({ time: bars.length * 3600, open: prev, high: Math.max(prev, close) + 0.2, low: Math.min(prev, close) - 0.2, close, volume: 1 });
      prev = close;
    }
  }
  return bars;
}
const labels = (r) => r.points.map((p) => p.label).filter(Boolean).join(" ");

test("a clean five-wave impulse up, then A-B-C", () => {
  const r = elliottWaves(path([100, 120, 108, 150, 138, 160, 145, 153, 140, 141]));
  assert.ok(r);
  assert.equal(r.dir, 1);
  assert.equal(r.stage, "C");
  assert.equal(labels(r), "(1) (2) (3) (4) (5) A B C");
  assert.deepEqual(r.points.slice(1, 6).map((p) => Math.round(p.price)), [120, 108, 150, 138, 160]);
});

test("right after wave 5 turns: wave A, still running", () => {
  const r = elliottWaves(path([100, 120, 108, 150, 138, 160, 150]));
  assert.equal(r?.stage, "A");
  assert.ok(r.points.at(-1).provisional);
  assert.match(r.text, /sóng A/);
});

test("an impulse still unfolding: wave 4 with a wave-5 projection", () => {
  const r = elliottWaves(path([100, 120, 108, 150, 138]));
  assert.equal(r?.stage, "w4");
  assert.equal(labels(r), "(1) (2) (3) (4)");
  // wave 5 = wave 1: 138 + (120 - 100)
  assert.ok(Math.abs(r.target.price - 158.2) < 1);
});

test("the mirror: an impulse down, labelled the same way", () => {
  const r = elliottWaves(path([200, 180, 192, 150, 162, 140, 152]));
  assert.equal(r?.dir, -1);
  assert.equal(r.stage, "A");
  assert.equal(labels(r), "(1) (2) (3) (4) (5) A");
});

test("hard rules: wave 4 into wave 1's territory, or wave 2 below the start, is not an impulse", () => {
  const overlap = elliottWaves(path([100, 120, 108, 150, 115, 160, 158]));
  assert.ok(!overlap || overlap.stage !== "w5");
  const deep2 = elliottWaves(path([100, 120, 95, 150, 138]));
  assert.ok(!deep2 || !(deep2.stage === "w4" && deep2.dir === 1 && Math.round(deep2.points[0].price) === 100));
});

test("small wiggles are not waves", () => {
  // a 1-point zigzag on top of a rise: the pivots after filtering are just the big turns
  const pts = [100, 120, 108, 150];
  const bars = path(pts).map((b, i) => (i % 2 ? { ...b, high: b.high + 0.6, close: b.close + 0.4 } : b));
  const piv = wavePivots(bars);
  assert.ok(piv.length <= 4, `got ${piv.length} pivots`);
  assert.equal(elliottWaves(path([100, 101])), null);
});

test("an expanded flat: wave B may run past the end of wave 5, up to 138.2% of A", () => {
  // down impulse 200..140, A up to 155 (15), B down to 136 (19 = 127% of A)
  const r = elliottWaves(path([200, 180, 192, 150, 162, 140, 155, 136, 137]));
  assert.equal(r?.stage, "B");
  assert.equal(labels(r), "(1) (2) (3) (4) (5) A B");
  // C = A from B: 136 + 15
  assert.ok(Math.abs(r.target.price - 151) < 1);
});
