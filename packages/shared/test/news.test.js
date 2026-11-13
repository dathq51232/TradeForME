import { test } from "node:test";
import assert from "node:assert/strict";
import { NewsScoreBatch, preFilter, displayScore, normaliseUrl, normaliseTitle } from "../src/news.js";

test("pre-filter routes headlines to assets", () => {
  assert.deepEqual(preFilter("Gold hits record as Treasury yields fall"), ["XAU"]);
  assert.deepEqual(preFilter("OPEC+ agrees to extend output cuts"), ["WTI", "BRENT"]);
  assert.ok(preFilter("Spot bitcoin ETF inflows top $1bn").includes("BTC"));
  assert.ok(preFilter("Hotter CPI print lifts the dollar").includes("XAU"));
  assert.deepEqual(preFilter("Local bakery wins award"), []);
});

test("LLM batch schema rejects out-of-range impact", () => {
  const ok = { items: [{ id: 1, relevant: true, assets: [{ asset: "XAU", impact: 4, direction: "up", confidence: 0.8, horizon: "days" }], category: "monetary", reason_vi: "Fed hạ lãi suất." }] };
  assert.ok(NewsScoreBatch.safeParse(ok).success);
  ok.items[0].assets[0].impact = 7;
  assert.equal(NewsScoreBatch.safeParse(ok).success, false);
});

test("display score is bounded", () => {
  assert.equal(displayScore({ impact: 5, confidence: 1 }), 100);
  assert.equal(displayScore({ impact: 5, confidence: 1 }, 3), 100);
  assert.equal(displayScore({ impact: 1, confidence: 0 }), 10);
});

test("dedupe normalisation strips tracking and noise", () => {
  assert.equal(normaliseUrl("https://www.Example.com/a/?utm_source=x&id=2#top"), "https://example.com/a/?id=2");
  assert.equal(normaliseTitle("Gold — Hits RECORD!!"), normaliseTitle("gold hits record"));
});
