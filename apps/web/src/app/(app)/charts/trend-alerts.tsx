"use client";
import { useEffect, useMemo, useState } from "react";
import { SYMBOLS } from "@qt/shared/market";
import { trendSummary, type TrendSummary } from "@qt/core/trend";
import { createClient } from "@/lib/supabase/client";

// Long-term trend of gold, silver, oil and Bitcoin: where it stands now (daily closes, EMA50 / EMA200, the same rules
// as the server), and the alerts (table trend_alert_settings; sent by the Edge Function pattern-cron after each daily close).
type Settings = { enabled: boolean; symbols: string[]; trend_change: boolean; crosses: boolean; ema200: boolean; weekly: boolean };
const MARKETS = ["XAUUSD", "XAGUSD", "WTI", "BRENT", "BTCUSD"];
const KINDS = [
  ["trend_change", "Trend dài hạn đổi chiều", "Tăng ↔ đi ngang ↔ giảm, xác nhận bằng 2 nến ngày liên tiếp"],
  ["crosses", "Golden cross / Death cross", "EMA50 cắt lên / cắt xuống EMA200"],
  ["ema200", "Giá đóng cửa cắt EMA200", "Sớm hơn nhưng nhiều tin hơn"],
  ["weekly", "Tóm tắt mỗi thứ Hai", "Trend dài hạn hiện tại của từng mã đã chọn"],
] as const;
const DEFAULT: Settings = { enabled: false, symbols: ["XAUUSD", "BTCUSD", "WTI", "XAGUSD"], trend_change: true, crosses: true, ema200: false, weekly: false };
const STATE_STYLE = { up: "text-up", down: "text-down", side: "text-warn" } as const;
const ARROW = { up: "▲", down: "▼", side: "◆" } as const;

const fmt = (v: number, d: number) => v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (v: number | null) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`);
const day = (t: number) => new Date(t * 1000).toLocaleDateString("vi-VN");

export function TrendAlertsButton({ signedIn, onPick }: { signedIn: boolean; onPick: (symbol: string) => void }) {
  const supabase = useMemo(() => (signedIn ? createClient() : null), [signedIn]);
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Record<string, TrendSummary | null | "error">>({});
  const [s, setS] = useState<Settings | null>(null);
  const [telegram, setTelegram] = useState<boolean | null>(null);
  const [state, setState] = useState<"" | "saving" | "saved" | "error">("");
  const [error, setError] = useState("");

  // the trend table: daily bars of each market, read when the panel opens (daily closes change once a day)
  useEffect(() => {
    if (!open) return;
    let alive = true;
    for (const m of MARKETS) {
      fetch(`/api/bars?symbol=${m}&tf=1D&limit=750`).then((r) => (r.ok ? r.json() : Promise.reject()))
        .then((j) => {
          // the last daily bar is still forming: the trend is read on closed days, like the alerts
          const closed = (j.bars as Bar[]).filter((b) => b.time + 86400 <= Date.now() / 1000);
          if (alive) setRows((x) => ({ ...x, [m]: trendSummary(closed) }));
        })
        .catch(() => { if (alive) setRows((x) => ({ ...x, [m]: "error" })); });
    }
    return () => { alive = false; };
  }, [open]);

  useEffect(() => {
    if (!supabase) return;
    let alive = true;
    (async () => {
      const { data: auth } = await supabase.auth.getUser();
      if (!auth.user || !alive) return;
      const [{ data: row }, { data: prof }] = await Promise.all([
        supabase.from("trend_alert_settings").select("enabled, symbols, trend_change, crosses, ema200, weekly").eq("user_id", auth.user.id).maybeSingle(),
        supabase.from("profiles").select("telegram_chat_id").eq("id", auth.user.id).maybeSingle(),
      ]);
      if (!alive) return;
      setS(row ? { ...DEFAULT, ...row } : DEFAULT);
      setTelegram(Boolean(prof?.telegram_chat_id));
    })();
    return () => { alive = false; };
  }, [supabase]);

  const toggleSymbol = (v: string) => setS((x) => x && { ...x, symbols: x.symbols.includes(v) ? x.symbols.filter((y) => y !== v) : [...x.symbols, v] });
  const save = async () => {
    if (!supabase || !s) return;
    setState("saving"); setError("");
    const { data: auth } = await supabase.auth.getUser();
    const { error: e } = await supabase.from("trend_alert_settings").upsert({ user_id: auth.user?.id, ...s, updated_at: new Date().toISOString() });
    if (e) { setState("error"); setError(e.message); } else setState("saved");
  };
  const on = Boolean(s?.enabled);

  return (
    <div className="relative">
      <button onClick={() => setOpen((o) => !o)} title="Trend dài hạn của vàng, bạc, dầu, Bitcoin và cảnh báo khi trend đổi chiều"
        className={`rounded-md border px-2 py-1 text-xs hover:bg-panel-2 ${on ? "border-up/50 text-up" : "border-border"}`}>
        📈 Trend dài hạn
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 grid max-h-[80vh] w-[22rem] max-w-[92vw] gap-2 overflow-y-auto rounded-md border border-border bg-panel p-2 text-xs shadow-xl">
          <div className="font-medium">Trend dài hạn (nến ngày đã đóng, EMA50 / EMA200)</div>
          <table className="w-full">
            <thead className="text-muted">
              <tr><th className="text-left font-normal">Mã</th><th className="text-left font-normal">Trend</th><th className="text-right font-normal" title="Giá đóng cửa so với EMA200">vs EMA200</th><th className="text-right font-normal" title="Độ dốc EMA200 trong 20 phiên">Dốc 20p</th></tr>
            </thead>
            <tbody>
              {MARKETS.map((m) => {
                const r = rows[m];
                return (
                  <tr key={m} className="cursor-pointer hover:bg-panel-2" onClick={() => { onPick(m); setOpen(false); }}
                    title={r && r !== "error" ? `${r.label} từ ${day(r.since)} (${r.bars} phiên). Đóng cửa ${fmt(r.close, SYMBOLS[m].digits)}, EMA50 ${fmt(r.emaFast, SYMBOLS[m].digits)}, EMA200 ${fmt(r.emaSlow, SYMBOLS[m].digits)}. 52 tuần: ${fmt(r.low52, SYMBOLS[m].digits)} – ${fmt(r.high52, SYMBOLS[m].digits)}` : undefined}>
                    <td className="py-0.5 font-medium">{m}</td>
                    {r === undefined ? <td colSpan={3} className="text-muted">Đang tải…</td>
                      : r === "error" || r === null ? <td colSpan={3} className="text-muted">{r === null ? "Chưa đủ dữ liệu" : "Không lấy được dữ liệu"}</td>
                      : (<>
                        <td className={STATE_STYLE[r.state]}>{ARROW[r.state]} {r.label}<span className="block text-muted/80">từ {day(r.since)}</span></td>
                        <td className="text-right font-mono">{pct(r.distPct)}</td>
                        <td className="text-right font-mono">{pct(r.slopePct)}</td>
                      </>)}
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="text-muted/80">Tăng: EMA50 và giá trên EMA200 · Giảm: cả hai dưới · còn lại là đi ngang. Vàng, bạc, dầu dùng giá hợp đồng tương lai (COMEX/NYMEX/ICE) theo ngày.</p>

          <div className="border-t border-border pt-2" />
          {!signedIn ? (
            <p className="text-muted">Đăng nhập để nhận cảnh báo trend dài hạn qua Telegram.</p>
          ) : !s ? (
            <p className="text-muted">Đang tải…</p>
          ) : (
            <>
              <label className="flex cursor-pointer items-center gap-2 font-medium">
                <input type="checkbox" checked={s.enabled} onChange={(e) => setS({ ...s, enabled: e.target.checked })} />
                Bật cảnh báo trend dài hạn
              </label>
              {KINDS.map(([k, label, hint]) => (
                <label key={k} className="flex cursor-pointer items-start gap-2" title={hint}>
                  <input type="checkbox" className="mt-0.5" checked={s[k]} onChange={(e) => setS({ ...s, [k]: e.target.checked })} />
                  <span>{label}<span className="block text-muted/80">{hint}</span></span>
                </label>
              ))}
              <div className="text-muted">Mã</div>
              <div className="flex flex-wrap gap-1">
                {Object.keys(SYMBOLS).map((x) => (
                  <button key={x} onClick={() => toggleSymbol(x)}
                    className={`rounded border px-1.5 py-0.5 ${s.symbols.includes(x) ? "border-accent bg-accent/15 text-foreground" : "border-border text-muted hover:text-foreground"}`}>{x}</button>
                ))}
              </div>
              {telegram === false && (
                <p className="rounded border border-warn/40 bg-warn/10 px-2 py-1 text-warn">
                  Chưa có chat id Telegram: bấm chuông thông báo ở góc trên để nhập. Cho đến lúc đó cảnh báo chỉ hiện trong chuông.
                </p>
              )}
              {s.enabled && !s.symbols.length && <p className="text-warn">Chọn ít nhất một mã.</p>}
              <p className="text-muted/80">
                Server xét ngay sau khi nến ngày đóng (07:00 giờ Việt Nam), kể cả khi bạn đã tắt trình duyệt. Mỗi sự kiện chỉ báo một lần.
                Chỉ để tham khảo, không phải khuyến nghị.
              </p>
              <div className="flex items-center gap-2">
                <button onClick={save} disabled={state === "saving"} className="rounded bg-accent px-3 py-1 text-white disabled:opacity-50">
                  {state === "saving" ? "Đang lưu…" : "Lưu"}
                </button>
                {state === "saved" && <span className="text-up">Đã lưu</span>}
                {state === "error" && <span className="text-down">{error}</span>}
                <button onClick={() => setOpen(false)} className="ml-auto text-muted hover:text-foreground">Đóng</button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
