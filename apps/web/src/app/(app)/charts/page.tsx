import { Suspense } from "react";
import { SYMBOLS, TF_IDS, DEFAULT_WATCHLIST } from "@qt/shared/market";
import { BY_ID } from "@qt/core/indicators";
import { createClient } from "@/lib/supabase/server";
import { ChartTerminal, type LayoutState } from "./terminal";

export default function ChartsPage() {
  return (
    <Suspense fallback={<p className="text-sm text-muted">Đang tải biểu đồ…</p>}>
      <Charts />
    </Suspense>
  );
}

const DEFAULT_LAYOUT: LayoutState = {
  symbol: "XAUUSD", tf: "1h",
  indicators: [{ uid: "ema20", id: "ema", params: { length: 20, source: "close" } }, { uid: "rsi", id: "rsi", params: {} }],
};

/** Accept only what this version understands, so an old or edited layout never breaks the page. */
function cleanLayout(raw: unknown): LayoutState {
  const s = (raw ?? {}) as Partial<LayoutState>;
  return {
    symbol: s.symbol && SYMBOLS[s.symbol] ? s.symbol : DEFAULT_LAYOUT.symbol,
    tf: s.tf && TF_IDS.includes(s.tf) ? s.tf : DEFAULT_LAYOUT.tf,
    indicators: Array.isArray(s.indicators)
      ? s.indicators.filter((i) => i && BY_ID[i.id]).slice(0, 12).map((i) => ({ uid: String(i.uid), id: i.id, params: i.params ?? {} }))
      : DEFAULT_LAYOUT.indicators,
  };
}

// Market data is public: anyone can view charts; layouts, watchlists and lines are saved only when signed in.
async function Charts() {
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  if (!claims?.claims?.sub) {
    return <ChartTerminal signedIn={false} initial={{ layout: DEFAULT_LAYOUT, layoutId: null, watchlist: DEFAULT_WATCHLIST, watchlistId: null, drawings: {} }} />;
  }
  const [{ data: layout }, { data: watchlist }, { data: drawings }] = await Promise.all([
    supabase.from("layouts").select("id, state").eq("name", "default").order("updated_at", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("watchlists").select("id, symbols").order("created_at").limit(1).maybeSingle(),
    supabase.from("drawings").select("id, symbol, data"),
  ]);
  const symbols = (watchlist?.symbols ?? []).filter((s: string) => SYMBOLS[s]);
  const lines: Record<string, { id: string; hlines: number[] }> = {};
  for (const d of drawings ?? []) {
    const h = (d.data as { hlines?: unknown })?.hlines;
    lines[d.symbol] = { id: d.id, hlines: Array.isArray(h) ? h.filter((x): x is number => typeof x === "number") : [] };
  }
  return (
    <ChartTerminal signedIn initial={{
      layout: layout ? cleanLayout(layout.state) : DEFAULT_LAYOUT,
      layoutId: layout?.id ?? null,
      watchlist: symbols.length ? symbols : DEFAULT_WATCHLIST,
      watchlistId: watchlist?.id ?? null,
      drawings: lines,
    }} />
  );
}
