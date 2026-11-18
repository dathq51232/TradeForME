import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { trendSeries, trendSummary, trendChanges } from "../src/trend.js";

const btc = JSON.parse(readFileSync(new URL("./fixtures/btc-1d.json", import.meta.url), "utf8"));
const day = 86400;
const line = (closes, t0 = 0) => closes.map((c, i) => ({ time: t0 + i * day, open: c, high: c * 1.01, low: c * 0.99, close: c, volume: 1 }));

test("no state until EMA200 is ready", () => {
  const bars = line(Array.from({ length: 150 }, (_, i) => 100 + i));
  assert.equal(trendSummary(bars), null);
  assert.deepEqual(trendChanges(bars), []);
});

test("a steady rise is an uptrend, a steady fall a downtrend", () => {
  const up = trendSummary(line(Array.from({ length: 300 }, (_, i) => 100 + i)));
  assert.equal(up.state, "up");
  assert.ok(up.distPct > 0 && up.slopePct > 0);
  const down = trendSummary(line(Array.from({ length: 300 }, (_, i) => 400 - i)));
  assert.equal(down.state, "down");
  assert.ok(down.distPct < 0);
});

test("one close across does not flip the state; two in a row do", () => {
  const base = Array.from({ length: 260 }, (_, i) => 100 + i * 0.5); // uptrend, EMA200 well below
  const ema200 = trendSeries(line(base)).slow.at(-1);
  const once = line([...base, ema200 * 0.9, base.at(-1)]);
  assert.equal(trendSeries(once).raw.at(-2), "side");
  assert.equal(trendSeries(once).state.at(-2), "up", "a single close below EMA200 is not confirmed");
  const twice = line([...base, ema200 * 0.9, ema200 * 0.9]);
  assert.equal(trendSeries(twice).state.at(-1), "side");
  const ch = trendChanges(twice);
  assert.ok(ch.some((c) => c.type === "trend" && c.state === "side"), JSON.stringify(ch));
  // the close crossed EMA200 on the first of the two bars, not the second
  assert.ok(trendChanges(twice.slice(0, -1)).some((c) => c.id === "ema200|below"));
  assert.ok(!ch.some((c) => c.type === "ema200"));
});

test("golden and death crosses on real BTC daily bars match the averages", () => {
  const { fast, slow } = trendSeries(btc);
  let crosses = 0;
  for (let i = 201; i < btc.length; i++) {
    const ev = trendChanges(btc.slice(0, i + 1)).filter((c) => c.type === "cross");
    const was = fast[i - 1] - slow[i - 1], is = fast[i] - slow[i];
    const expect = (was <= 0 && is > 0) || (was >= 0 && is < 0);
    assert.equal(ev.length, expect ? 1 : 0, `bar ${i}`);
    if (expect) { crosses++; assert.equal(ev[0].dir, is > 0 ? 1 : -1); }
  }
  assert.ok(crosses >= 1, "the fixture has at least one cross");
  const s = trendSummary(btc);
  assert.ok(["up", "down", "side"].includes(s.state));
  assert.ok(s.high52 >= s.close && s.low52 <= s.close);
  assert.ok(s.since <= s.time && s.bars >= 1);
});
