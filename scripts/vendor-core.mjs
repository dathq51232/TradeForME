// Copies the pure calculation modules the Edge Functions need (pattern recognition, indicators, resampling, market
// parsers) from the workspace packages into supabase/functions/_shared/vendor/, because a deployed Edge Function
// only carries the files under supabase/functions. Same code as the web app, so the server sees the patterns the
// chart shows.
//   node scripts/vendor-core.mjs          writes the copies
//   node scripts/vendor-core.mjs --check  fails if a copy is out of date (run by npm test)
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(root, "supabase", "functions", "_shared", "vendor");
const FILES = [
  ["packages/core/src/series.js", "series.js"],
  ["packages/core/src/rsi-tools.js", "rsi-tools.js"],
  ["packages/core/src/indicators.js", "indicators.js"],
  ["packages/core/src/patterns.js", "patterns.js"],
  ["packages/shared/src/market.js", "market.js"],
];
const header = (src) => `// GENERATED from ${src} by scripts/vendor-core.mjs. Do not edit: change the source and run the script.\n`;

const check = process.argv.includes("--check");
const stale = [];
mkdirSync(OUT, { recursive: true });
for (const [src, name] of FILES) {
  const text = header(src) + readFileSync(join(root, src), "utf8").replace(/\r\n/g, "\n");
  const dest = join(OUT, name);
  const cur = existsSync(dest) ? readFileSync(dest, "utf8").replace(/\r\n/g, "\n") : null;
  if (cur === text) continue;
  if (check) stale.push(name);
  else writeFileSync(dest, text);
}
if (stale.length) {
  console.error(`supabase/functions/_shared/vendor is out of date (${stale.join(", ")}): run node scripts/vendor-core.mjs`);
  process.exit(1);
}
if (!check) console.log(`vendored ${FILES.length} modules into supabase/functions/_shared/vendor`);
