import { Suspense } from "react";
import { SYMBOLS, TF_IDS, DEFAULT_WATCHLIST } from "@qt/shared/market";
import { BY_ID } from "@qt/core/indicators";
import { createClient } from "@/lib/supabase/server";
import { ChartTerminal, WAVE_COLORS, type LayoutState, type PriceAlert, type SymbolDrawings } from "./terminal";
import { SHAPE_KINDS, SHAPE_POINTS, type Shape } from "./chart-overlay";
import { DEFAULT_STYLE } from "./chart-overlay";

const isHex = (v: unknown): v is string => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);

export default function ChartsPage(props: PageProps<"/charts">) {
  return (
    <Suspense fallback={<p className="text-sm text-muted">Đang tải biểu đồ…</p>}>
      <Charts searchParams={props.searchParams} />
    </Suspense>
  );
}

const DEFAULT_LAYOUT: LayoutState = {
  symbol: "XAUUSD", tf: "1h",
  indicators: [{ uid: "ema20", id: "ema", params: { length: 20, source: "close" } }, { uid: "rsi", id: "rsi", params: {} }],
  overlays: { trades: true, events: true },
  view: { type: "candles", scale: "normal", magnet: false, style: DEFAULT_STYLE },
  auto: { chart: true, wedges: true, candles: true, levels: true, periods: false, sessions: true, elliott: true, waveUpOnly: false, waveColor: "#e879f9", depth: 5 },
};
const KINDS = new Set<string>(SHAPE_KINDS);
const CHART_TYPES = new Set(["candles", "hollow", "heikin", "bars", "line", "area"]);
const SCALES = new Set(["normal", "log", "percent"]);
const isPt = (p: unknown): p is { t: number; p: number } =>
  !!p && typeof (p as { t: unknown }).t === "number" && typeof (p as { p: unknown }).p === "number";

/** Accept only what this version understands, so an old or edited layout never breaks the page. */
function cleanLayout(raw: unknown): LayoutState {
  const s = (raw ?? {}) as Partial<LayoutState>;
  return {
    symbol: s.symbol && SYMBOLS[s.symbol] ? s.symbol : DEFAULT_LAYOUT.symbol,
    tf: s.tf && TF_IDS.includes(s.tf) ? s.tf : DEFAULT_LAYOUT.tf,
    indicators: Array.isArray(s.indicators)
      ? s.indicators.filter((i) => i && BY_ID[i.id]).slice(0, 12).map((i) => ({ uid: String(i.uid), id: i.id, params: i.params ?? {} }))
      : DEFAULT_LAYOUT.indicators,
    overlays: { trades: s.overlays?.trades !== false, events: s.overlays?.events !== false },
    view: {
      type: s.view?.type && CHART_TYPES.has(s.view.type) ? s.view.type : DEFAULT_LAYOUT.view.type,
      scale: s.view?.scale && SCALES.has(s.view.scale) ? s.view.scale : DEFAULT_LAYOUT.view.scale,
      magnet: s.view?.magnet === true,
      style: {
        up: isHex(s.view?.style?.up) ? s.view.style.up : DEFAULT_STYLE.up,
        down: isHex(s.view?.style?.down) ? s.view.style.down : DEFAULT_STYLE.down,
        bg: s.view?.style?.bg === "light" ? "light" : "dark",
        volume: s.view?.style?.volume === true,
        bgColor: isHex(s.view?.style?.bgColor) ? s.view.style.bgColor : null,
        grid: s.view?.style?.grid !== false,
      },
    },
    auto: {
      chart: typeof s.auto?.chart === "boolean" ? s.auto.chart : DEFAULT_LAYOUT.auto.chart,
      wedges: typeof s.auto?.wedges === "boolean" ? s.auto.wedges : DEFAULT_LAYOUT.auto.wedges,
      candles: typeof s.auto?.candles === "boolean" ? s.auto.candles : DEFAULT_LAYOUT.auto.candles,
      levels: typeof s.auto?.levels === "boolean" ? s.auto.levels : DEFAULT_LAYOUT.auto.levels,
      periods: typeof s.auto?.periods === "boolean" ? s.auto.periods : DEFAULT_LAYOUT.auto.periods,
      sessions: typeof s.auto?.sessions === "boolean" ? s.auto.sessions : DEFAULT_LAYOUT.auto.sessions,
      elliott: typeof s.auto?.elliott === "boolean" ? s.auto.elliott : DEFAULT_LAYOUT.auto.elliott,
      waveUpOnly: s.auto?.waveUpOnly === true,
      waveColor: WAVE_COLORS.some((c) => c.v === s.auto?.waveColor) ? s.auto!.waveColor : DEFAULT_LAYOUT.auto.waveColor,
      depth: [3, 5, 8].includes(Number(s.auto?.depth)) ? Number(s.auto?.depth) : DEFAULT_LAYOUT.auto.depth,
    },
  };
}

function cleanDrawing(id: string, data: unknown): SymbolDrawings {
  const d = (data ?? {}) as { hlines?: unknown; shapes?: unknown };
  const hlines = Array.isArray(d.hlines) ? d.hlines.filter((x): x is number => typeof x === "number") : [];
  const shapes = Array.isArray(d.shapes)
    ? (d.shapes as Shape[]).filter((s) => s && KINDS.has(s.kind) && isPt(s.a) && isPt(s.b) && (SHAPE_POINTS[s.kind] < 3 || isPt(s.c))).slice(0, 100)
        .map((s) => ({
          id: String(s.id), kind: s.kind, a: s.a, b: s.b,
          ...(isPt(s.c) ? { c: s.c } : {}),
          ...(typeof s.text === "string" ? { text: s.text.slice(0, 120) } : {}),
        }))
    : [];
  return { id, hlines, shapes };
}

// Market data is public: anyone can view charts; layouts, watchlists, drawings and alerts are saved only when signed in.
async function Charts({ searchParams }: { searchParams: PageProps<"/charts">["searchParams"] }) {
  const sp = await searchParams;
  const want = typeof sp.symbol === "string" && SYMBOLS[sp.symbol.toUpperCase()] ? sp.symbol.toUpperCase() : null;
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  if (!claims?.claims?.sub) {
    const layout = want ? { ...DEFAULT_LAYOUT, symbol: want } : DEFAULT_LAYOUT;
    return <ChartTerminal signedIn={false} initial={{ layout, layoutId: null, watchlist: DEFAULT_WATCHLIST, watchlistId: null, drawings: {}, alerts: [] }} />;
  }
  const [{ data: layout }, { data: watchlist }, { data: drawings }, { data: alerts }] = await Promise.all([
    supabase.from("layouts").select("id, state").eq("name", "default").order("updated_at", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("watchlists").select("id, symbols").order("created_at").limit(1).maybeSingle(),
    supabase.from("drawings").select("id, symbol, data"),
    supabase.from("alerts").select("id, symbol, rule").eq("active", true).not("symbol", "is", null),
  ]);
  const symbols = (watchlist?.symbols ?? []).filter((s: string) => SYMBOLS[s]);
  const bySymbol: Record<string, SymbolDrawings> = {};
  for (const d of drawings ?? []) bySymbol[d.symbol] = cleanDrawing(d.id, d.data);
  const clean = layout ? cleanLayout(layout.state) : DEFAULT_LAYOUT;
  const priceAlerts: PriceAlert[] = (alerts ?? []).flatMap((a) => {
    const r = a.rule as { kind?: string; op?: string; price?: unknown };
    return r?.kind === "price" && typeof r.price === "number" && (r.op === "above" || r.op === "below")
      ? [{ id: a.id, symbol: a.symbol as string, price: r.price, op: r.op }] : [];
  });
  return (
    <ChartTerminal signedIn initial={{
      layout: want ? { ...clean, symbol: want } : clean,
      layoutId: layout?.id ?? null,
      watchlist: symbols.length ? symbols : DEFAULT_WATCHLIST,
      watchlistId: watchlist?.id ?? null,
      drawings: bySymbol,
      alerts: priceAlerts,
    }} />
  );
}
