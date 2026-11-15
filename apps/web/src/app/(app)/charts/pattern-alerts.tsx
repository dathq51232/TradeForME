"use client";
import { useEffect, useMemo, useState } from "react";
import { SYMBOLS } from "@qt/shared/market";
import { createClient } from "@/lib/supabase/client";

// Pattern alerts on Telegram (table pattern_alert_settings; sent by the Edge Function pattern-cron on closed candles).
type Settings = {
  enabled: boolean; symbols: string[]; timeframes: string[];
  formed: boolean; breakout: boolean; wedges: boolean; candles: boolean;
};
const TFS = [["5m", "M5"], ["15m", "M15"], ["1h", "H1"], ["4h", "H4"], ["1D", "D1"]] as const;
const KINDS = [
  ["formed", "Mô hình giá hình thành xong", "Tam giác, nêm, hai đỉnh/đáy, vai đầu vai… vừa đủ điểm chạm"],
  ["breakout", "Mô hình giá bị phá vỡ", "Giá đóng cửa phá qua đường biên, kèm mục tiêu"],
  ["wedges", "Nêm nhỏ sẵn sàng / đã phá", "Nêm nhỏ tiếp diễn sau một nhịp mạnh"],
  ["candles", "Mô hình nến vừa đóng", "Búa, nhấn chìm, harami, sao mai… trên cây nến vừa đóng (nhiều tin hơn)"],
] as const;
const DEFAULT: Settings = { enabled: false, symbols: ["XAUUSD", "BTCUSD"], timeframes: ["1h", "4h"], formed: true, breakout: true, wedges: true, candles: false };

export function PatternAlertsButton({ signedIn, symbol }: { signedIn: boolean; symbol: string }) {
  const supabase = useMemo(() => (signedIn ? createClient() : null), [signedIn]);
  const [open, setOpen] = useState(false);
  const [s, setS] = useState<Settings | null>(null);
  const [telegram, setTelegram] = useState<boolean | null>(null);
  const [state, setState] = useState<"" | "saving" | "saved" | "error">("");
  const [error, setError] = useState("");

  // the switch's colour shows whether alerts are on, so the settings are read once up front
  useEffect(() => {
    if (!supabase) return;
    let alive = true;
    (async () => {
      const { data: auth } = await supabase.auth.getUser();
      if (!auth.user || !alive) return;
      const [{ data: row }, { data: prof }] = await Promise.all([
        supabase.from("pattern_alert_settings").select("enabled, symbols, timeframes, formed, breakout, wedges, candles").eq("user_id", auth.user.id).maybeSingle(),
        supabase.from("profiles").select("telegram_chat_id").eq("id", auth.user.id).maybeSingle(),
      ]);
      if (!alive) return;
      setS(row ? { ...DEFAULT, ...row } : { ...DEFAULT, symbols: [...new Set([symbol, ...DEFAULT.symbols])].slice(0, 2) });
      setTelegram(Boolean(prof?.telegram_chat_id));
    })();
    return () => { alive = false; };
  }, [supabase, symbol]);

  const toggle = <K extends "symbols" | "timeframes">(key: K, v: string) =>
    setS((x) => x && { ...x, [key]: x[key].includes(v) ? x[key].filter((y) => y !== v) : [...x[key], v] });
  const save = async () => {
    if (!supabase || !s) return;
    setState("saving"); setError("");
    const { data: auth } = await supabase.auth.getUser();
    const { error: e } = await supabase.from("pattern_alert_settings").upsert({ user_id: auth.user?.id, ...s, updated_at: new Date().toISOString() });
    if (e) { setState("error"); setError(e.message); } else setState("saved");
  };
  const on = Boolean(s?.enabled);

  return (
    <div className="relative">
      <button onClick={() => setOpen((o) => !o)} title="Báo về Telegram khi mô hình hình thành, bị phá vỡ, hoặc một mô hình nến vừa đóng"
        className={`rounded-md border px-2 py-1 text-xs hover:bg-panel-2 ${on ? "border-up/50 text-up" : "border-border"}`}>
        {on ? "🔔" : "🔕"} Báo Telegram
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 grid max-h-[80vh] w-80 max-w-[90vw] gap-2 overflow-y-auto rounded-md border border-border bg-panel p-2 text-xs shadow-xl">
          {!signedIn ? (
            <p className="text-muted">Đăng nhập để nhận cảnh báo mô hình qua Telegram.</p>
          ) : !s ? (
            <p className="text-muted">Đang tải…</p>
          ) : (
            <>
              <label className="flex cursor-pointer items-center gap-2 font-medium">
                <input type="checkbox" checked={s.enabled} onChange={(e) => setS({ ...s, enabled: e.target.checked })} />
                Bật cảnh báo mô hình
              </label>
              <div className="text-muted">Báo khi</div>
              {KINDS.map(([k, label, hint]) => (
                <label key={k} className="flex cursor-pointer items-start gap-2" title={hint}>
                  <input type="checkbox" className="mt-0.5" checked={s[k]} onChange={(e) => setS({ ...s, [k]: e.target.checked })} />
                  <span>{label}<span className="block text-muted/80">{hint}</span></span>
                </label>
              ))}
              <div className="text-muted">Mã</div>
              <div className="flex flex-wrap gap-1">
                {Object.keys(SYMBOLS).map((x) => (
                  <button key={x} onClick={() => toggle("symbols", x)}
                    className={`rounded border px-1.5 py-0.5 ${s.symbols.includes(x) ? "border-accent bg-accent/15 text-foreground" : "border-border text-muted hover:text-foreground"}`}>{x}</button>
                ))}
              </div>
              <div className="text-muted">Khung thời gian (xét khi nến đóng)</div>
              <div className="flex flex-wrap gap-1">
                {TFS.map(([tf, label]) => (
                  <button key={tf} onClick={() => toggle("timeframes", tf)}
                    className={`rounded border px-2 py-0.5 ${s.timeframes.includes(tf) ? "border-accent bg-accent/15 text-foreground" : "border-border text-muted hover:text-foreground"}`}>{label}</button>
                ))}
              </div>
              {telegram === false && (
                <p className="rounded border border-warn/40 bg-warn/10 px-2 py-1 text-warn">
                  Chưa có chat id Telegram: bấm chuông thông báo ở góc trên để nhập. Cho đến lúc đó cảnh báo chỉ hiện trong chuông.
                </p>
              )}
              {s.enabled && (!s.symbols.length || !s.timeframes.length) && <p className="text-warn">Chọn ít nhất một mã và một khung thời gian.</p>}
              <p className="text-muted/80">
                Server xét mỗi khung ngay khi một cây nến đóng, kể cả khi bạn đã tắt trình duyệt. Mỗi sự kiện chỉ báo một lần.
                Nhận diện tự động, chỉ để tham khảo, không phải khuyến nghị.
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
