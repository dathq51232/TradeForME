import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as P from '../src/patterns.js';

const H = 3600;
const T0 = Date.UTC(2026, 0, 5) / 1000; // a Monday

/** Bars whose closes walk straight between waypoints [index, price]; small wicks on both sides. */
function path(points, wick = 0.2) {
  const closes = [];
  for (let k = 1; k < points.length; k++) {
    const [i0, p0] = points[k - 1], [i1, p1] = points[k];
    for (let i = i0; i < i1; i++) closes[i] = p0 + ((p1 - p0) * (i - i0)) / (i1 - i0);
  }
  const [iz, pz] = points[points.length - 1];
  closes[iz] = pz;
  return closes.map((c, i) => {
    const o = i ? closes[i - 1] : c;
    return { time: T0 + i * H, open: o, high: Math.max(o, c) + wick, low: Math.min(o, c) - wick, close: c, volume: 1 };
  });
}
const bar = (i, o, h, l, c) => ({ time: T0 + i * H, open: o, high: h, low: l, close: c, volume: 1 });
/** n falling bars from `from`, each `step` lower, then the given bars. */
function afterDowntrend(n, from, step, ...tail) {
  const out = [];
  for (let i = 0; i < n; i++) { const o = from - i * step; out.push(bar(i, o, o + 0.3, o - step - 0.3, o - step)); }
  tail.forEach((b, k) => out.push({ ...b, time: T0 + (n + k) * H }));
  return out;
}

test('swing pivots alternate high and low', () => {
  const piv = P.swingPivots(path([[0, 100], [8, 110], [16, 90], [24, 110], [32, 95], [45, 100]]), 5);
  assert.deepEqual(piv.map((p) => p.kind), ['H', 'L', 'H', 'L']);
  assert.deepEqual(piv.map((p) => p.i), [8, 16, 24, 32]);
});

test('ascending triangle: flat top, rising lows, still forming', () => {
  const bars = path([[0, 100], [8, 110], [16, 90], [24, 110], [32, 95], [40, 110], [48, 100], [54, 105]]);
  const [p] = P.chartPatterns(bars);
  assert.equal(p.kind, 'ascTriangle');
  assert.equal(p.name, 'Tam giác tăng');
  assert.equal(p.bias, 1);
  assert.equal(p.status, 'forming');
  const upper = p.lines.find((l) => l.role === 'upper');
  assert.ok(Math.abs(upper.a.p - upper.b.p) < 0.5, 'top line is flat');
});

test('broadening triangle (tam giác ngược): higher highs and lower lows', () => {
  const bars = path([[0, 100], [8, 104], [16, 96], [24, 108], [32, 92], [40, 112], [48, 88], [54, 95]]);
  const kinds = P.chartPatterns(bars).map((p) => p.kind);
  assert.ok(kinds.includes('broadening'), kinds.join());
});

test('symmetric triangle breaking up gets a target', () => {
  const bars = path([[0, 100], [8, 120], [16, 80], [24, 115], [32, 85], [40, 110], [48, 90], [56, 125]]);
  const p = P.chartPatterns(bars).find((x) => x.kind === 'symTriangle');
  assert.ok(p, 'found');
  assert.equal(p.status, 'breakoutUp');
  assert.ok(p.target > 125);
});

test('double top confirmed below the neckline', () => {
  const bars = path([[0, 100], [10, 120], [20, 105], [30, 120], [40, 100], [46, 99]]);
  const [p] = P.chartPatterns(bars);
  assert.equal(p.kind, 'doubleTop');
  assert.equal(p.status, 'breakoutDown');
  // pivots sit on the wicks: top 120.2, neckline 104.8, so the measured move ends at 104.8 - 15.4
  assert.ok(Math.abs(p.target - 89.4) < 0.05, String(p.target));
});

test('head and shoulders and its inverse', () => {
  const top = path([[0, 100], [8, 115], [16, 105], [26, 125], [36, 105], [44, 115], [54, 100], [60, 98]]);
  assert.equal(P.chartPatterns(top)[0].kind, 'headShoulders');
  const flip = top.map((b) => ({ ...b, open: 200 - b.open, close: 200 - b.close, high: 200 - b.low, low: 200 - b.high }));
  const inv = P.chartPatterns(flip)[0];
  assert.equal(inv.kind, 'invHeadShoulders');
  assert.equal(inv.bias, 1);
  assert.equal(inv.status, 'breakoutUp');
});

test('no pattern in a straight trend', () => {
  assert.deepEqual(P.chartPatterns(path([[0, 100], [80, 180]])), []);
});

test('candlestick patterns need the trend they reverse', () => {
  const hammer = afterDowntrend(12, 120, 1, bar(0, 107.5, 107.7, 104, 107.9));
  assert.equal(P.candlestickPatterns(hammer).at(-1)?.kind, 'hammer');
  const engulf = afterDowntrend(12, 120, 1, bar(0, 108, 108.2, 106.8, 107), bar(0, 106.8, 109.5, 106.5, 109.2));
  const last = P.candlestickPatterns(engulf).at(-1);
  assert.equal(last.kind, 'bullEngulfing');
  assert.equal(last.bias, 1);
  // the same hammer shape after a rise is a hanging man
  const rise = afterDowntrend(12, 120, -1, bar(0, 132.5, 132.7, 129, 132.9));
  assert.equal(P.candlestickPatterns(rise).at(-1)?.kind, 'hangingMan');
});

test('morning star', () => {
  const bars = afterDowntrend(12, 120, 1, bar(0, 108, 108.2, 104.8, 105), bar(0, 104.9, 105.2, 104.4, 104.8), bar(0, 105, 107.6, 104.9, 107.4));
  assert.equal(P.candlestickPatterns(bars).at(-1)?.kind, 'morningStar');
});

test('close levels find the range edges', () => {
  const pts = [[0, 100]];
  for (let k = 1; k <= 10; k++) pts.push([k * 8, k % 2 ? 110 : 100]);
  const levels = P.closeLevels(path(pts));
  const near = (x) => levels.some((l) => Math.abs(l.price - x) < 0.6 && l.swings >= 3);
  assert.ok(near(110) && near(100), JSON.stringify(levels));
  assert.ok(levels.every((l, i) => i === 0 || levels[i - 1].price > l.price), 'sorted high to low');
  assert.ok(levels.every((l) => [1, 2, 3].includes(l.strength)));
});

test('previous day, week and month closes', () => {
  const bars = [];
  for (let i = 0; i < 24 * 40; i++) bars.push(bar(i, i, i + 1, i - 1, i)); // hourly, close = bar number
  const t = (s) => Math.round((Date.UTC(...s) / 1000 - T0) / H);
  const got = Object.fromEntries(P.periodCloses(bars).map((x) => [x.period, x.price]));
  const lastDay = new Date(bars.at(-1).time * 1000);
  assert.equal(got.day, t([lastDay.getUTCFullYear(), lastDay.getUTCMonth(), lastDay.getUTCDate()]) - 1);
  assert.equal(got.month, t([2026, 1, 1]) - 1);
  assert.ok(got.week > 0 && got.week < bars.length);
});

test('sessions follow daylight saving and skip weekends', () => {
  const hourUtc = (id, y, m, d) => {
    const s = P.sessionsBetween(Date.UTC(y, m, d) / 1000, Date.UTC(y, m, d, 23) / 1000).find((x) => x.id === id && new Date(x.start * 1000).getUTCDate() === d);
    return s && new Date(s.start * 1000).getUTCHours();
  };
  assert.equal(hourUtc('london', 2026, 0, 14), 8);   // winter: GMT
  assert.equal(hourUtc('london', 2026, 6, 15), 7);   // summer: BST
  assert.equal(hourUtc('newyork', 2026, 0, 14), 13); // EST
  assert.equal(hourUtc('newyork', 2026, 6, 15), 12); // EDT
  assert.equal(hourUtc('tokyo', 2026, 6, 15), 0);
  const sat = P.sessionsBetween(Date.UTC(2026, 0, 10, 12) / 1000, Date.UTC(2026, 0, 10, 20) / 1000);
  assert.deepEqual(sat, []);
});

test('session status: London and New York overlap, next event', () => {
  const now = Date.UTC(2026, 0, 14, 14) / 1000; // Wednesday 14:00 UTC
  const s = P.sessionStatus(now);
  assert.deepEqual(s.open.map((x) => x.id).sort(), ['london', 'newyork']);
  assert.deepEqual({ name: s.next.name, kind: s.next.kind }, { name: 'London', kind: 'close' });
  assert.equal(s.next.at, Date.UTC(2026, 0, 14, 17) / 1000);
});

test('real data runs without errors and gives sane shapes', () => {
  const bars = JSON.parse(readFileSync(new URL('./fixtures/btc-1d.json', import.meta.url), 'utf8'));
  const pats = P.chartPatterns(bars, { max: 20 });
  for (const p of pats) {
    assert.ok(p.start <= p.end && p.lines.length >= 2 && p.name);
    assert.ok(['forming', 'breakoutUp', 'breakoutDown', 'expired'].includes(p.status));
  }
  const candles = P.candlestickPatterns(bars);
  assert.ok(candles.length > 0 && candles.length < bars.length / 2, `${candles.length} of ${bars.length}`);
  assert.ok(P.closeLevels(bars).length > 0);
});

// ---------- small continuation wedges ----------
const Q = 900; // 15-minute bars
/** Bars walking between waypoints, with a volume per bar. */
function walk(points, vol, wick = 0.15) {
  return path(points, wick).map((b, i) => ({ ...b, time: T0 + i * Q, volume: vol(i) }));
}
// sideways, a sharp drop (heavy volume) to 80, then a narrowing pullback on light volume
// (lows 80 → 82 → 85: rising faster and faster; highs 88 → 87.6 → 87.3: flat to falling)
const WEDGE = [[0, 100], [5, 101], [10, 99], [15, 101], [20, 99], [25, 101], [30, 99], [35, 101], [40, 100], [48, 80], [52, 88], [56, 82], [60, 87.6], [63, 85], [66, 87.3]];
const wedgeVol = (i) => (i >= 40 && i <= 48 ? 300 : i > 48 ? 80 : 120);

test('micro wedge: a narrowing pullback after a sharp drop is flagged before it breaks', () => {
  const [w] = P.microWedges(walk([...WEDGE, [68, 86.6]], wedgeVol), { levels: [] });
  assert.equal(w.kind, 'microWedgeDown');
  assert.equal(w.bias, -1);
  assert.equal(w.stage, 'ready');
  assert.ok(w.score >= 60, `score ${w.score}`);
  assert.ok(w.reasons.includes('Khối lượng co lại'));
  assert.equal(w.entry, null);
  assert.ok(w.lines.some((l) => l.role === 'upper') && w.lines.some((l) => l.role === 'lower'));
});

test('micro wedge: a close under the support breaks it, with entry, stop above the wedge and a target', () => {
  const [w] = P.microWedges(walk([...WEDGE, [68, 86.6], [71, 82]], wedgeVol), { levels: [] });
  assert.equal(w.stage, 'broken');
  assert.equal(w.status, 'breakoutDown');
  assert.ok(w.entry < 86.6 && w.stop > w.entry && w.target < w.entry);
});

test('micro wedge: a close over the resistance late in the wedge fails it', () => {
  const [w] = P.microWedges(walk([...WEDGE, [68, 86.6], [72, 93]], wedgeVol), { levels: [] });
  assert.equal(w.stage, 'failed');
  assert.equal(w.entry, null);
});

test('micro wedge: mirrored after a sharp rise', () => {
  const up = WEDGE.concat([[68, 86.6], [71, 82]]).map(([i, p]) => [i, 200 - p]);
  const [w] = P.microWedges(walk(up, wedgeVol), { levels: [] });
  assert.equal(w.kind, 'microWedgeUp');
  assert.equal(w.status, 'breakoutUp');
  assert.ok(w.target > w.entry && w.stop < w.entry);
});

test('micro wedge: nothing without a sharp leg', () => {
  assert.deepEqual(P.microWedges(walk([[0, 100], [60, 101], [70, 100]], () => 100)), []);
});

test('micro wedge on BTCUSDT 15m (14/11/2026): ready from 01:00 UTC, broken at 01:45 before the drop', () => {
  const raw = JSON.parse(readFileSync(new URL('./fixtures/btcusdt-15m-2026-11-14.json', import.meta.url), 'utf8'));
  const bars = raw.map((k) => ({ time: k[0] / 1000, open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }));
  const upTo = (iso) => bars.slice(0, bars.findIndex((b) => b.time >= Date.parse(iso) / 1000) + 1);
  const before = P.microWedges(upTo('2026-11-14T01:00:00Z'))[0];
  assert.equal(before.kind, 'microWedgeDown');
  assert.equal(before.stage, 'ready');
  const after = P.microWedges(upTo('2026-11-14T01:45:00Z'))[0];
  assert.equal(after.stage, 'broken');
  assert.ok(Math.abs(after.entry - 68290) < 1);
  assert.ok(after.stop > after.entry && after.target < after.entry);
});
