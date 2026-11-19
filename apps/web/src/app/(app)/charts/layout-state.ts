// A saved chart layout or template, cleaned so an old or edited one never breaks the page. Used by the server page
// (the saved layout and templates) and in the browser (templates kept on this browser when signed out).
import { SYMBOLS, TF_IDS } from "@qt/shared/market";
import { BY_ID } from "@qt/core/indicators";
import type { LayoutState, SplitChart } from "./terminal";
import { DEFAULT_STYLE, WAVE_COLORS, cleanLayerStyles, cleanOutputStyles, cleanPriceLine } from "./chart-overlay";

const isHex = (v: unknown): v is string => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);

export const DEFAULT_LAYOUT: LayoutState = {
  symbol: "XAUUSD", tf: "1h",
  indicators: [{ uid: "ema20", id: "ema", params: { length: 20, source: "close" } }, { uid: "rsi", id: "rsi", params: {} }],
  overlays: { trades: true, events: true },
  view: { type: "candles", scale: "normal", magnet: false, style: DEFAULT_STYLE, htf: null, htfOpacity: 1 },
  auto: { chart: true, wedges: true, candles: true, levels: true, periods: false, sessions: true, elliott: true, waveUpOnly: false, waveColor: "#e879f9", depth: 5, styles: {} },
  split: null,
};
const CHART_TYPES = new Set(["candles", "hollow", "heikin", "bars", "line", "area"]);
const SCALES = new Set(["normal", "log", "percent"]);

function cleanSplit(raw: unknown): SplitChart | null {
  const s = raw as Partial<SplitChart> | null;
  if (!s || typeof s.symbol !== "string" || !SYMBOLS[s.symbol]) return null;
  return { symbol: s.symbol, tf: typeof s.tf === "string" && TF_IDS.includes(s.tf) ? s.tf : "1h", sameIndicators: s.sameIndicators !== false };
}

export function cleanLayout(raw: unknown): LayoutState {
  const s = (raw ?? {}) as Partial<LayoutState>;
  const htf = s.view?.htf;
  return {
    symbol: s.symbol && SYMBOLS[s.symbol] ? s.symbol : DEFAULT_LAYOUT.symbol,
    tf: s.tf && TF_IDS.includes(s.tf) ? s.tf : DEFAULT_LAYOUT.tf,
    indicators: Array.isArray(s.indicators)
      ? s.indicators.filter((i) => i && BY_ID[i.id]).slice(0, 12).map((i) => {
        const styles = cleanOutputStyles(i.styles);
        return { uid: String(i.uid), id: i.id, params: i.params ?? {}, ...(styles ? { styles } : {}) };
      })
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
        priceLine: cleanPriceLine(s.view?.style?.priceLine),
        lineColor: isHex(s.view?.style?.lineColor) ? s.view.style.lineColor : null,
      },
      htf: htf === "auto" || (typeof htf === "string" && TF_IDS.includes(htf)) ? htf : null,
      htfOpacity: [0.5, 1, 1.6].includes(Number(s.view?.htfOpacity)) ? Number(s.view?.htfOpacity) : 1,
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
      styles: cleanLayerStyles(s.auto?.styles),
    },
    split: cleanSplit(s.split),
  };
}

// ---------- templates: indicators, chart look and automatic reading, applied to any symbol ----------
export type TemplateState = Pick<LayoutState, "indicators" | "overlays" | "view" | "auto">;
export type ChartTemplate = { id: string; name: string; state: TemplateState };
/** Templates are rows of the layouts table whose name starts with this (the working layout is "default"). */
export const TEMPLATE_PREFIX = "template:";

export function cleanTemplate(id: unknown, name: unknown, state: unknown): ChartTemplate | null {
  if (typeof name !== "string" || !name.trim()) return null;
  const { indicators, overlays, view, auto } = cleanLayout(state);
  return { id: String(id), name: name.trim().slice(0, 40), state: { indicators, overlays, view, auto } };
}
