import { Suspense } from "react";
import { SYMBOLS, DEFAULT_WATCHLIST } from "@qt/shared/market";
import { createClient } from "@/lib/supabase/server";
import { ChartTerminal, type PriceAlert, type SymbolDrawings } from "./terminal";
import { SHAPE_KINDS, SHAPE_POINTS, type Shape } from "./chart-overlay";
import { DEFAULT_LAYOUT, TEMPLATE_PREFIX, cleanLayout, cleanTemplate, type ChartTemplate } from "./layout-state";

export default function ChartsPage(props: PageProps<"/charts">) {
  return (
    <Suspense fallback={<p className="text-sm text-muted">Đang tải biểu đồ…</p>}>
      <Charts searchParams={props.searchParams} />
    </Suspense>
  );
}

const KINDS = new Set<string>(SHAPE_KINDS);
const isPt = (p: unknown): p is { t: number; p: number } =>
  !!p && typeof (p as { t: unknown }).t === "number" && typeof (p as { p: unknown }).p === "number";

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
    return <ChartTerminal signedIn={false} initial={{ layout, layoutId: null, watchlist: DEFAULT_WATCHLIST, watchlistId: null, drawings: {}, alerts: [], templates: [] }} />;
  }
  const [{ data: layout }, { data: watchlist }, { data: drawings }, { data: alerts }, { data: tpls }] = await Promise.all([
    supabase.from("layouts").select("id, state").eq("name", "default").order("updated_at", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("watchlists").select("id, symbols").order("created_at").limit(1).maybeSingle(),
    supabase.from("drawings").select("id, symbol, data"),
    supabase.from("alerts").select("id, symbol, rule").eq("active", true).not("symbol", "is", null),
    supabase.from("layouts").select("id, name, state").like("name", `${TEMPLATE_PREFIX}%`).order("name").limit(50),
  ]);
  const templates = (tpls ?? []).flatMap((t): ChartTemplate[] => {
    const c = cleanTemplate(t.id, String(t.name).slice(TEMPLATE_PREFIX.length), t.state);
    return c ? [c] : [];
  });
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
      templates,
    }} />
  );
}
