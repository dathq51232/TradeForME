"use client";
import { useEffect, useMemo, useState } from "react";
import { SYMBOLS } from "@qt/shared/market";
import { createClient } from "@/lib/supabase/client";

// Long-term trend alerts (table trend_alert_settings; sent by the Edge Function pattern-cron after each daily close).
// Where each market's trend stands now is shown in the side panel (market-brief.tsx), not here.
type Settings = { enabled: boolean; symbols: string[]; trend_change: boolean; crosses: boolean; ema200: boolean; weekly: boolean };
const KINDS = [
  ["trend_change", "Trend dài hạn đổi chiều", "Tăng ↔ đi ngang ↔ giảm, xác nhận bằng 2 nến ngày liên tiếp"],
  ["crosses", "Golden cross / Death cross", "EMA50 cắt lên / cắt xuống EMA200"],
  ["ema200", "Giá đóng cửa cắt EMA200", "Sớm hơn nhưng nhiều tin hơn"],
  ["weekly", "Tóm tắt mỗi thứ Hai", "Trend dài hạn hiện tại của từng mã đã chọn"],
] as const;
const DEFAULT: Settings = { enabled: false, symbols: ["XAUUSD", "BTCUSD", "WTI", "XAGUSD"], trend_change: true, crosses: true, ema200: false, weekly: false };

export function TrendAlertsButton({ signedIn }: { signedIn: boolean }) {
  const supabase = useMemo(() => (signedIn ? createClient() : null), [signedIn]);
  const [open, setOpen] = useState(false);
  const [s, setS] = useState<Settings | null>(null);
  const [telegram, setTelegram] = useState<boolean | null>(null);
  const [state, setState] = useState<"" | "saving" | "saved" | "error">("");
  const [error, setError] = useState("");

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
      <button onClick={() => setOpen((o) => !o)} title="Cảnh báo khi trend dài hạn đổi chiều (trend hiện tại xem ở cột bên phải)"
        className={`rounded-md border px-2 py-1 text-xs hover:bg-panel-2 ${on ? "border-up/50 text-up" : "border-border"}`}>
        🔔 Cảnh báo trend
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 grid max-h-[80vh] w-[22rem] max-w-[92vw] gap-2 overflow-y-auto rounded-md border border-border bg-panel p-2 text-xs shadow-xl">
          <div className="font-medium">Cảnh báo trend dài hạn (nến ngày đã đóng, EMA50 / EMA200)</div>
          <p className="text-muted/80">Trend hiện tại của từng mã và nhận định realtime nằm ở cột bên phải, dưới Watchlist.</p>
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
