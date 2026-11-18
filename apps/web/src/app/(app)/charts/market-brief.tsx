"use client";
import { useEffect, useMemo, useState } from "react";
import { SYMBOLS } from "@qt/shared/market";
import { trendSummary, type TrendSummary } from "@qt/core/trend";
import { ema, rsiOf } from "@qt/core/indicators";
import { closeLevels } from "@qt/core/patterns";
import type { ElliottCount } from "@qt/core/elliott";

// The right-hand panel under the watchlist: a live reading of the open chart (rule-based, recomputed on every price
// update) and the long-term trend board of the main markets (daily closes, EMA50 / EMA200, same rules as the alerts).
export const TREND_MARKETS = ["XAUUSD", "XAGUSD", "WTI", "BRENT", "BTCUSD"];
type Row = TrendSummary | null | "error";
type Line = { icon: string; text: string; tone: "up" | "down" | "side" | "muted"; vote?: number };

const TONE = { up: "text-up", down: "text-down", side: "text-warn", muted: "text-muted" } as const;
const ARROW = { up: "▲", down: "▼", side: "◆" } as const;
const fmt = (v: number, d: number) => v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (v: number | null | undefined) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`);
const day = (t: number) => new Date(t * 1000).toLocaleDateString("vi-VN");

/** Daily trend of the board's markets and of the open symbol, read on closed days; refreshed every 30 minutes. */
function useTrendBoard(symbol: string) {
  const [rows, setRows] = useState<Record<string, Row>>({});
  const list = useMemo(() => [...new Set([...TREND_MARKETS, symbol])], [symbol]);
  useEffect(() => {
    let alive = true;
    const run = () => list.forEach((m) => {
      fetch(`/api/bars?symbol=${m}&tf=1D&limit=750`).then((r) => (r.ok ? r.json() : Promise.reject()))
        .then((j: { bars: Bar[] }) => {
          // the last daily bar is still forming: the trend is read on closed days, like the alerts
          const closed = j.bars.filter((b) => b.time + 86400 <= Date.now() / 1000);
          if (alive) setRows((x) => ({ ...x, [m]: trendSummary(closed) }));
        })
        .catch(() => { if (alive) setRows((x) => ({ ...x, [m]: x[m] && x[m] !== "error" ? x[m] : "error" })); });
    });
    run();
    const t = setInterval(run, 30 * 60_000);
    return () => { alive = false; clearInterval(t); };
  }, [list]);
  return rows;
}

/** The live reading: one short line per signal, each voting up (+1), down (-1) or neither. */
function buildBrief(bars: Bar[], digits: number, tfLabel: string, daily: Row | undefined, elliott: ElliottCount | null): Line[] {
  const out: Line[] = [];
  if (daily && daily !== "error") {
    out.push({
      icon: ARROW[daily.state], tone: daily.state, vote: daily.state === "up" ? 1 : daily.state === "down" ? -1 : 0,
      text: `Dài hạn: ${daily.label.toLowerCase()} từ ${day(daily.since)} · đóng cửa ${pct(daily.distPct)} so với EMA200 ngày`,
    });
  }
  if (bars.length < 60) return out;
  const close = bars.map((b) => b.close);
  const price = close[close.length - 1];
  const e20 = ema(close, 20), e50 = ema(close, 50);
  const f = e20[e20.length - 1], s = e50[e50.length - 1], s10 = e50[e50.length - 11];
  const slope = s10 ? ((s - s10) / s10) * 100 : 0;
  if (Number.isFinite(f) && Number.isFinite(s)) {
    const st = price > f && f > s ? "up" : price < f && f < s ? "down" : "side";
    out.push({
      icon: ARROW[st], tone: st, vote: st === "up" ? 1 : st === "down" ? -1 : 0,
      text: `Ngắn hạn ${tfLabel}: ${st === "up" ? "tăng, giá trên EMA20 > EMA50" : st === "down" ? "giảm, giá dưới EMA20 < EMA50" : "giằng co quanh EMA20/EMA50"} · EMA50 ${slope >= 0 ? "dốc lên" : "dốc xuống"} ${Math.abs(slope).toFixed(2)}%`,
    });
  }
  const r = rsiOf(close, 14);
  const rv = r[r.length - 1];
  if (Number.isFinite(rv)) {
    const [txt, tone, vote] = rv >= 70 ? ["quá mua, dễ chững lại", "side", 0] as const
      : rv <= 30 ? ["quá bán, dễ hồi lên", "side", 0] as const
      : rv >= 55 ? ["nghiêng tăng", "up", 1] as const
      : rv <= 45 ? ["nghiêng giảm", "down", -1] as const
      : ["trung tính", "muted", 0] as const;
    out.push({ icon: "◎", tone, vote, text: `RSI ${tfLabel} ${rv.toFixed(0)}: ${txt}` });
  }
  if (elliott) {
    const vote = elliott.stage === "w3" || elliott.stage === "w5" ? elliott.dir : elliott.stage === "A" || elliott.stage === "C" ? -elliott.dir : 0;
    out.push({
      icon: "〰", tone: vote > 0 ? "up" : vote < 0 ? "down" : "side", vote,
      text: `Elliott: ${elliott.text}${elliott.target ? ` · ${elliott.target.label} ≈ ${fmt(elliott.target.price, digits)}` : ""}`,
    });
  }
  // nearest close-based key levels above and below the live price
  const lv = closeLevels(bars, { max: 10 });
  const above = lv.filter((l) => l.price > price).sort((a, b) => a.price - b.price)[0];
  const below = lv.filter((l) => l.price < price).sort((a, b) => b.price - a.price)[0];
  if (above || below) {
    const part = (l: typeof above, name: string) => (l ? `${name} ${fmt(l.price, digits)} (${pct(((l.price - price) / price) * 100)})` : "");
    out.push({ icon: "≡", tone: "muted", text: [part(above, "Kháng cự"), part(below, "Hỗ trợ")].filter(Boolean).join(" · ") });
  }
  return out;
}

export function MarketBrief({ symbol, tfLabel, bars, digits, elliott, quotes, onPick }: {
  symbol: string; tfLabel: string; bars: Bar[]; digits: number; elliott: ElliottCount | null;
  quotes: Record<string, { price: number; changePct: number } | null | undefined>; onPick: (symbol: string) => void;
}) {
  const rows = useTrendBoard(symbol);
  const lines = useMemo(() => buildBrief(bars, digits, tfLabel, rows[symbol], elliott), [bars, digits, tfLabel, rows, symbol, elliott]);
  const score = lines.reduce((a, l) => a + (l.vote ?? 0), 0);
  const votes = lines.filter((l) => l.vote !== undefined).length;
  const bias = score >= 2 ? "up" : score <= -2 ? "down" : "side";
  const last = bars[bars.length - 1];

  return (
    <div className="grid gap-3 border-t border-border px-3 py-2 text-xs wl-collapsed:hidden">
      <section className="grid gap-1.5">
        <div className="flex items-center gap-2">
          <span className="relative flex h-2 w-2"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-up opacity-60" /><span className="relative inline-flex h-2 w-2 rounded-full bg-up" /></span>
          <span className="font-medium text-foreground">Nhận định realtime · {symbol} {tfLabel}</span>
        </div>
        {lines.length ? (
          <>
            <div className={`rounded border px-2 py-1 font-medium ${bias === "up" ? "border-up/40 bg-up/10 text-up" : bias === "down" ? "border-down/40 bg-down/10 text-down" : "border-warn/40 bg-warn/10 text-warn"}`}
              title="Cộng các tín hiệu bên dưới: mỗi tín hiệu tăng +1, giảm −1. Từ +2 là nghiêng tăng, từ −2 là nghiêng giảm.">
              {ARROW[bias]} Tổng hợp: {bias === "up" ? "nghiêng tăng" : bias === "down" ? "nghiêng giảm" : "trung tính / chờ xác nhận"} ({score >= 0 ? "+" : ""}{score}/{votes})
              {last && <span className="float-right font-mono font-normal">{fmt(last.close, digits)}</span>}
            </div>
            <ul className="grid gap-1">
              {lines.map((l) => (
                <li key={l.text.slice(0, 12)} className="flex gap-1.5 leading-snug">
                  <span className={`w-3 shrink-0 text-center ${TONE[l.tone]}`}>{l.icon}</span>
                  <span className="text-foreground/90">{l.text}</span>
                </li>
              ))}
            </ul>
          </>
        ) : <p className="text-muted">Đang đọc dữ liệu…</p>}
        <p className="text-muted/70">Tự động theo quy tắc, cập nhật theo từng giá. Chỉ để tham khảo, không phải khuyến nghị.</p>
      </section>

      <section className="grid gap-1">
        <div className="flex items-baseline justify-between">
          <span className="font-medium text-foreground">Trend dài hạn</span>
          <span className="text-muted/70" title="Nến ngày đã đóng, EMA50 / EMA200">D1 · EMA50/200</span>
        </div>
        <ul className="grid">
          {TREND_MARKETS.map((m) => {
            const r = rows[m];
            const q = quotes[m];
            return (
              <li key={m}>
                <button onClick={() => onPick(m)}
                  title={r && r !== "error" ? `${r.label} từ ${day(r.since)} (${r.bars} phiên). Đóng cửa ${fmt(r.close, SYMBOLS[m].digits)}, EMA50 ${fmt(r.emaFast, SYMBOLS[m].digits)}, EMA200 ${fmt(r.emaSlow, SYMBOLS[m].digits)}, độ dốc EMA200 20 phiên ${pct(r.slopePct)}. 52 tuần: ${fmt(r.low52, SYMBOLS[m].digits)} – ${fmt(r.high52, SYMBOLS[m].digits)}` : undefined}
                  className={`flex w-full items-center gap-2 rounded px-1 py-1 text-left hover:bg-panel-2 ${m === symbol ? "bg-accent/10" : ""}`}>
                  <span className="w-14 font-medium">{m}</span>
                  {r === undefined ? <span className="text-muted">…</span>
                    : r === "error" || r === null ? <span className="text-muted">—</span>
                    : (
                      <span className={`flex-1 ${TONE[r.state]}`}>
                        {ARROW[r.state]} {r.state === "up" ? "Tăng" : r.state === "down" ? "Giảm" : "Ngang"}
                        <span className="ml-1 font-mono text-muted">{pct(r.distPct)}</span>
                      </span>
                    )}
                  {q && <span className={`font-mono ${q.changePct >= 0 ? "text-up" : "text-down"}`}>{q.changePct >= 0 ? "+" : ""}{q.changePct.toFixed(1)}%</span>}
                </button>
              </li>
            );
          })}
        </ul>
        <p className="text-muted/70">% cạnh trend: đóng cửa so với EMA200 ngày. Bấm một mã để mở biểu đồ.</p>
      </section>
    </div>
  );
}
