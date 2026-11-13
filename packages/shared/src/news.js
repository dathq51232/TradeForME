// News impact contract: the JSON the LLM must return in news-score (docs §5.2), and the score shown in the UI.
import { z } from "zod";

export const ASSETS = ["XAU", "BTC", "WTI", "BRENT"];
export const CATEGORIES = ["monetary", "inflation", "jobs", "growth", "geopolitics", "supply", "regulation", "flows", "other"];

export const AssetImpact = z.object({
  asset: z.enum(ASSETS),
  impact: z.number().int().min(1).max(5),
  direction: z.enum(["up", "down", "mixed"]),
  confidence: z.number().min(0).max(1),
  horizon: z.enum(["intraday", "days", "weeks"]),
});

export const NewsScore = z.object({
  id: z.number().int(),
  relevant: z.boolean(),
  assets: z.array(AssetImpact).max(4),
  category: z.enum(CATEGORIES),
  reason_vi: z.string().max(400),
});

export const NewsScoreBatch = z.object({ items: z.array(NewsScore) });

// Cheap keyword pre-filter applied before any LLM call.
const KEYWORDS = {
  XAU: /\b(gold|bullion|xau|precious metals?|fed|fomc|powell|cpi|inflation|pce|nfp|payrolls?|treasury yields?|real yields?|dollar index|dxy|safe[- ]haven|war|sanctions?|tariffs?)\b/i,
  BTC: /\b(bitcoin|btc|crypto|spot etf|etf (in|out)flows?|sec|stablecoins?|halving|coinbase|binance|blackrock)\b/i,
  WTI: /\b(oil|crude|wti|brent|opec\+?|eia|inventor(y|ies)|rig count|refiner(y|ies)|gasoline|strait of hormuz|iran|saudi|pipeline|spr)\b/i,
};

/** Assets a headline may concern ([] = drop before the LLM). */
export function preFilter(text) {
  const out = [];
  for (const [asset, re] of Object.entries(KEYWORDS)) if (re.test(text)) out.push(asset);
  if (out.includes("WTI")) out.push("BRENT");
  return out;
}

/** Displayed score 0..100 = LLM impact x source weight x confidence, capped. */
export function displayScore({ impact, confidence }, sourceWeight = 1) {
  return Math.min(100, Math.round(impact * 20 * sourceWeight * (0.5 + confidence / 2)));
}

/** Normalised forms used for de-duplication (UNIQUE url_hash / title_hash). */
export function normaliseUrl(u) {
  const url = new URL(u);
  url.hash = "";
  for (const k of [...url.searchParams.keys()]) if (/^(utm_|fbclid|gclid|ref$|cmpid)/i.test(k)) url.searchParams.delete(k);
  url.hostname = url.hostname.replace(/^www\./, "").toLowerCase();
  return url.toString().replace(/\/$/, "");
}

export function normaliseTitle(t) {
  return t.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N} ]/gu, " ").replace(/\s+/g, " ").trim();
}
