"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { createChart, AreaSeries, type UTCTimestamp } from "lightweight-charts";
import { SYMBOLS, TIMEFRAMES, tfSeconds } from "@qt/shared/market";
import { SIGNAL_KINDS, type Signal, type SignalKind, type SignalTestResult } from "@qt/core/signal-test";
import { EXAMPLE_STRATEGIES, backtest, tradesCsv, type Strategy, type Stats, type Trade } from "@qt/core/backtest";
import { Kpi, Panel } from "@/components/ui";
import { fetchBars, type BarsResponse } from "../charts/feed";
import { PriceChart, type Bar, type PriceLineSpec, type TimedMarker } from "../charts/price-chart";
import { DEFAULT_STYLE, NO_AUTO, type ChartEvent, type Shape } from "../charts/chart-overlay";

const COLORS = { up: "#00c087", down: "#f45b69", muted: "#8292a8", accent: "#4f8cff" };
const SIZES = [500, 1000, 1500];
const NO_EVENTS: ChartEvent[] = [];
const NO_SHAPES: Shape[] = [];
const NO_HLINES: { price: number; alert: boolean }[] = [];
const NO_INDICATORS: never[] = [];
const noop = () => {};
const fmt = (v: number, d: number) => v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (v: number | null | undefined, d = 1) => (v == null ? "—" : `${(v * 100).toFixed(d)}%`);
const when = (t: number) => new Date(t * 1000).toLocaleString("vi-VN", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

/** A price chart for results: markers and price lines only, nothing to draw or edit. */
function ResultChart({ bars, digits, tf, markers, lines, viewKey }: { bars: Bar[]; digits: number; tf: string; markers: TimedMarker[]; lines: PriceLineSpec[]; viewKey: string }) {
  return (
    <div className="relative h-[420px] overflow-hidden rounded-md border border-border">
      <PriceChart bars={bars} digits={digits} barSeconds={tfSeconds(tf)} indicators={NO_INDICATORS} chartType="candles" scaleMode="normal" magnet={false}
        style={DEFAULT_STYLE} hlines={NO_HLINES} shapes={NO_SHAPES} hidden={false} selected={null} events={NO_EVENTS} auto={NO_AUTO}
        tradeMarkers={markers} tradeLines={lines} tool={null} onAddLine={noop} onAddShape={noop} onSelect={noop} onChangeShape={noop} viewKey={viewKey} />
    </div>
  );
}

export function BacktestView({ initialSymbol }: { initialSymbol: string }) {
  const [symbol, setSymbol] = useState(initialSymbol);
  const [tf, setTf] = useState("1h");
  const [size, setSize] = useState(1500);
  const [tab, setTab] = useState<"signals" | "strategy">("signals");
  const [data, setData] = useState<{ key: string; res: BarsResponse } | null>(null);
  const key = `${symbol}:${tf}:${size}`;
  useEffect(() => {
    let alive = true;
    fetchBars(symbol, tf, size).then((res) => { if (alive) setData({ key: `${symbol}:${tf}:${size}`, res }); });
    return () => { alive = false; };
  }, [symbol, tf, size]);
  const ready = data?.key === key ? data.res : null;
  const bars = ready?.bars ?? [];
  const info = SYMBOLS[symbol];
  const span = bars.length > 1 ? `${new Date(bars[0].time * 1000).toLocaleDateString("vi-VN")} → ${new Date(bars[bars.length - 1].time * 1000).toLocaleDateString("vi-VN")}` : "";

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <select aria-label="Mã" value={symbol} onChange={(e) => setSymbol(e.target.value)} className="font-semibold">
          {Object.keys(SYMBOLS).map((s) => <option key={s} value={s}>{s} · {SYMBOLS[s].name}</option>)}
        </select>
        <div className="flex rounded-md border border-border" role="group" aria-label="Khung thời gian">
          {TIMEFRAMES.map((t) => (
            <button key={t.tf} onClick={() => setTf(t.tf)} className={`px-2 py-1 text-xs ${t.tf === tf ? "bg-accent text-white" : "text-muted hover:text-foreground"}`}>{t.label}</button>
          ))}
        </div>
        <label className="flex items-center gap-1 text-xs text-muted">Số nến
          <select value={size} onChange={(e) => setSize(Number(e.target.value))} className="text-xs">
            {SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <span className="text-xs text-muted">
          {!ready ? "Đang tải nến…" : ready.error ? <span className="text-down">{ready.error}</span> : `${bars.length} nến · ${span} · ${ready.source}`}
        </span>
        <div className="ml-auto flex rounded-md border border-border" role="tablist">
          {([["signals", "Độ chính xác nhận diện"], ["strategy", "Chiến lược chỉ báo"]] as const).map(([id, label]) => (
            <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
              className={`px-3 py-1 text-xs ${tab === id ? "bg-accent text-white" : "text-muted hover:text-foreground"}`}>{label}</button>
          ))}
        </div>
      </div>
      {tab === "signals"
        ? <SignalsPanel bars={bars} ready={!!ready && !ready.error && bars.length > 0} digits={info.digits} tf={tf} dataKey={key} />
        : <StrategyPanel bars={bars} ready={!!ready && !ready.error && bars.length > 0} digits={info.digits} tf={tf} dataKey={key} />}
      {/* the chart library's licence asks for its notice and a link on the page when the logo is off the chart */}
      <a href="https://www.tradingview.com/" target="_blank" rel="noopener noreferrer" className="justify-self-end text-xs text-muted/70 hover:text-foreground">
        Biểu đồ: TradingView Lightweight Charts™ · © TradingView, Inc.
      </a>
    </div>
  );
}

// ---------------------------------------------------------------- automatic readings

const KIND_ORDER: SignalKind[] = ["wave4", "top", "waveC", "resume", "wedge", "pattern"];
const OUTCOME: Record<Signal["outcome"], { label: string; color: string }> = {
  hit: { label: "Đúng", color: COLORS.up }, miss: { label: "Sai", color: COLORS.down },
  open: { label: "Chưa ngã ngũ", color: COLORS.muted }, expired: { label: "Hết hạn", color: COLORS.muted },
};

function SignalsPanel({ bars, ready, digits, tf, dataKey }: { bars: Bar[]; ready: boolean; digits: number; tf: string; dataKey: string }) {
  const [detectors, setDetectors] = useState({ elliott: true, wedges: true, patterns: true });
  const [horizon, setHorizon] = useState(200);
  const [every, setEvery] = useState(2);
  const [depth, setDepth] = useState(5);
  const [upOnly, setUpOnly] = useState(false);
  const [early, setEarly] = useState(false);
  const [run, setRun] = useState<{ key: string; progress: number; result: SignalTestResult | null; error?: string } | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const worker = useRef<Worker | null>(null);
  useEffect(() => () => worker.current?.terminate(), []);

  const start = () => {
    worker.current?.terminate();
    const w = new Worker(new URL("./signal-worker.ts", import.meta.url), { type: "module" });
    worker.current = w;
    setRun({ key: dataKey, progress: 0, result: null });
    setPick(null);
    w.onmessage = (e: MessageEvent<{ progress?: number; result?: SignalTestResult; error?: string }>) => {
      if (e.data.progress != null) setRun((r) => r && { ...r, progress: e.data.progress! });
      if (e.data.result) { setRun((r) => r && { ...r, progress: 1, result: e.data.result! }); w.terminate(); }
      if (e.data.error) { setRun((r) => r && { ...r, error: e.data.error }); w.terminate(); }
    };
    w.postMessage({
      bars,
      opts: {
        detectors: (Object.keys(detectors) as (keyof typeof detectors)[]).filter((k) => detectors[k]),
        horizon, every, elliott: { depth, upOnly },
        predict: early ? { topAfter24: false, cAfterB: false } : {},
      },
    });
  };
  const result = run?.key === dataKey ? run.result : null;
  const busy = run?.key === dataKey && !run.result && !run.error;
  const signals = useMemo(() => [...(result?.signals ?? [])].reverse(), [result]);
  const picked = signals.find((s) => s.key === pick) ?? null;
  const markers = useMemo<TimedMarker[]>(() => (result?.signals ?? []).map((s) => ({
    time: s.time, position: s.dir > 0 ? "belowBar" : "aboveBar", shape: s.dir > 0 ? "arrowUp" : "arrowDown",
    color: OUTCOME[s.outcome].color, text: s.key === pick ? `${s.label} · ${OUTCOME[s.outcome].label}` : "",
  })), [result, pick]);
  const lines = useMemo<PriceLineSpec[]>(() => picked ? [
    { price: picked.hit, color: COLORS.up, title: "Mức đúng" }, { price: picked.fail, color: COLORS.down, title: "Mức sai", dashed: true },
  ] : [], [picked]);

  return (
    <div className="grid gap-4">
      <Panel title="Thiết lập">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs">
          {([["elliott", "Sóng Elliott"], ["wedges", "Nêm nhỏ"], ["patterns", "Mô hình giá"]] as const).map(([k, label]) => (
            <label key={k} className="flex cursor-pointer items-center gap-1.5">
              <input type="checkbox" checked={detectors[k]} onChange={(e) => setDetectors((d) => ({ ...d, [k]: e.target.checked }))} /> {label}
            </label>
          ))}
          <label className="flex items-center gap-1 text-muted" title="Số nến tối đa để một dự báo thành sự thật; quá hạn thì không tính vào tỷ lệ">Thời hạn
            <select value={horizon} onChange={(e) => setHorizon(Number(e.target.value))}>{[100, 200, 400].map((n) => <option key={n} value={n}>{n} nến</option>)}</select>
          </label>
          <label className="flex items-center gap-1 text-muted" title="Đọc lại biểu đồ sau mỗi bao nhiêu nến: 1 là chính xác nhất nhưng chậm nhất">Đọc mỗi
            <select value={every} onChange={(e) => setEvery(Number(e.target.value))}>{[1, 2, 5].map((n) => <option key={n} value={n}>{n} nến</option>)}</select>
          </label>
          <label className="flex items-center gap-1 text-muted" title="Số nến mỗi bên để thành đỉnh/đáy, như nút Độ nhạy trên biểu đồ">Độ nhạy
            <select value={depth} onChange={(e) => setDepth(Number(e.target.value))}>{[[3, "Nhạy"], [5, "Vừa"], [8, "Chặt"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          </label>
          <label className="flex cursor-pointer items-center gap-1.5"><input type="checkbox" checked={upOnly} onChange={(e) => setUpOnly(e.target.checked)} /> Chỉ đếm sóng đẩy tăng</label>
          <label className="flex cursor-pointer items-center gap-1.5" title="Đo cách báo sớm cũ: báo đỉnh ngay ở đỉnh sóng 5 và báo sóng C khi B còn đang chạy, để so sánh">
            <input type="checkbox" checked={early} onChange={(e) => setEarly(e.target.checked)} /> Đo cách báo sớm (để so sánh)
          </label>
          <button onClick={start} disabled={!ready || busy || !Object.values(detectors).some(Boolean)}
            className="ml-auto rounded bg-accent px-3 py-1.5 text-white disabled:opacity-50">
            {busy ? `Đang chạy… ${Math.round((run?.progress ?? 0) * 100)}%` : "▶ Chạy kiểm tra"}
          </button>
        </div>
        <p className="mt-3 text-xs text-muted">
          Chạy lùi từng nến: ở mỗi nến, bộ nhận diện chỉ thấy các nến tới thời điểm đó, như khi bạn nhìn biểu đồ lúc ấy. Mỗi dự báo có một mức <b className="text-up">đúng</b> và
          một mức <b className="text-down">sai</b> cố định ngay khi nó xuất hiện; các nến sau đó chạm mức nào trước thì tính mức đó (một nến chạm cả hai tính là sai).
          <b> Ngẫu nhiên</b> là tỷ lệ một đồng xu đạt được trên đúng các mức ấy (mức gần giá hơn thì dễ chạm trước hơn); <b>lợi thế</b> = tỷ lệ đúng − ngẫu nhiên mới là thứ bộ nhận diện thật sự thêm vào.
        </p>
      </Panel>

      {run?.key === dataKey && run.error && <p className="text-sm text-down">Lỗi: {run.error}</p>}
      {result && (
        <>
          <Panel title="Kết quả theo loại dự báo"
            action={result.repaintPer100 != null && (
              <span className="text-xs text-muted" title="Phần trăm số lần đọc mà một điểm sóng đã xác nhận ở lần đọc trước bị dời hoặc mất">
                Elliott vẽ lại: <b className="text-foreground">{result.repaintPer100.toFixed(1)}%</b> số lần đọc
              </span>
            )}>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted">
                  <tr><th className="py-1 pr-3">Dự báo</th><th className="px-2 text-right">Số lần</th><th className="px-2 text-right">Đúng</th><th className="px-2 text-right">Sai</th>
                    <th className="px-2 text-right">Chưa xong</th><th className="px-2 text-right">Tỷ lệ đúng</th><th className="px-2 text-right">Ngẫu nhiên</th><th className="px-2 text-right">Lợi thế</th><th className="pl-2 text-right">Chờ TB</th></tr>
                </thead>
                <tbody>
                  {KIND_ORDER.filter((k) => result.summary[k]).map((k) => {
                    const r = result.summary[k]!;
                    const edge = r.edge;
                    const few = r.hit + r.miss < 20;
                    return (
                      <tr key={k} className="border-t border-border">
                        <td className="py-1.5 pr-3">{SIGNAL_KINDS[k]}</td>
                        <td className="px-2 text-right font-mono">{r.n}</td>
                        <td className="px-2 text-right font-mono text-up">{r.hit}</td>
                        <td className="px-2 text-right font-mono text-down">{r.miss}</td>
                        <td className="px-2 text-right font-mono text-muted">{r.open}</td>
                        <td className="px-2 text-right font-mono">{pct(r.rate)}</td>
                        <td className="px-2 text-right font-mono text-muted">{pct(r.base)}</td>
                        <td className={`px-2 text-right font-mono ${edge == null ? "" : edge > 0.05 ? "text-up" : edge < -0.05 ? "text-down" : "text-muted"}`}
                          title={few ? "Dưới 20 lần đã ngã ngũ: quá ít để kết luận" : undefined}>
                          {edge == null ? "—" : `${edge >= 0 ? "+" : ""}${(edge * 100).toFixed(1)} điểm`}{few ? " *" : ""}
                        </td>
                        <td className="pl-2 text-right font-mono text-muted">{r.bars == null ? "—" : `${r.bars.toFixed(0)} nến`}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {!Object.keys(result.summary).length && <p className="py-3 text-sm text-muted">Không có dự báo nào trong khoảng này.</p>}
              <p className="mt-2 text-xs text-muted">* dưới 20 lần đã ngã ngũ: quá ít để kết luận. Lợi thế trong khoảng ±5 điểm coi như ngang ngẫu nhiên.</p>
            </div>
          </Panel>
          <Panel title="Trên biểu đồ" action={<span className="text-xs text-muted">Mũi tên xanh: đúng · đỏ: sai · xám: chưa ngã ngũ. Bấm một dòng bên dưới để xem mức đúng/sai.</span>}>
            <ResultChart bars={bars} digits={digits} tf={tf} markers={markers} lines={lines} viewKey={dataKey} />
          </Panel>
          <Panel title={`Từng dự báo (${signals.length})`}>
            <div className="max-h-96 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-panel text-left text-muted">
                  <tr><th className="py-1 pr-2">Lúc</th><th className="pr-2">Loại</th><th className="pr-2">Hướng</th><th className="pr-2 text-right">Giá lúc báo</th>
                    <th className="pr-2 text-right">Mức đúng</th><th className="pr-2 text-right">Mức sai</th><th className="pr-2">Kết quả</th><th>Sau</th></tr>
                </thead>
                <tbody>
                  {signals.map((s) => (
                    <tr key={s.key} onClick={() => setPick(s.key === pick ? null : s.key)}
                      className={`cursor-pointer border-t border-border hover:bg-panel-2 ${s.key === pick ? "bg-accent/10" : ""}`}>
                      <td className="py-1 pr-2 font-mono">{when(s.time)}</td>
                      <td className="pr-2">{s.label}{s.degree != null ? <span className="text-muted"> · cấp {["nhỏ", "vừa", "lớn"][s.degree]}</span> : null}</td>
                      <td className={`pr-2 ${s.dir > 0 ? "text-up" : "text-down"}`}>{s.dir > 0 ? "▲ Lên" : "▼ Xuống"}</td>
                      <td className="pr-2 text-right font-mono">{fmt(s.close, digits)}</td>
                      <td className="pr-2 text-right font-mono text-up">{fmt(s.hit, digits)}</td>
                      <td className="pr-2 text-right font-mono text-down">{fmt(s.fail, digits)}</td>
                      <td className="pr-2" style={{ color: OUTCOME[s.outcome].color }}>{OUTCOME[s.outcome].label}</td>
                      <td className="font-mono text-muted">{s.at != null ? `${s.at - s.i} nến` : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- indicator strategies

type Rules = Pick<Strategy, "indicators" | "entryLong" | "exitLong" | "entryShort" | "exitShort" | "exitMatch" | "maxBarsInTrade">;
const PRESETS = Object.keys(EXAMPLE_STRATEGIES);
const rulesOf = (s: Strategy): Rules => ({
  indicators: s.indicators ?? {}, entryLong: s.entryLong ?? [], exitLong: s.exitLong ?? [],
  entryShort: s.entryShort ?? [], exitShort: s.exitShort ?? [], ...(s.exitMatch ? { exitMatch: s.exitMatch } : {}),
});
type Money = { stopLossPct: number; takeProfitPct: number; trailingStopPct: number; feePct: number; slippagePct: number; initialCapital: number; positionPct: number };
const moneyOf = (s: Strategy): Money => ({
  stopLossPct: s.stopLossPct ?? 0, takeProfitPct: s.takeProfitPct ?? 0, trailingStopPct: s.trailingStopPct ?? 0,
  feePct: s.feePct ?? 0.1, slippagePct: s.slippagePct ?? 0.05, initialCapital: s.initialCapital ?? 10000, positionPct: s.positionPct ?? 100,
});

function StrategyPanel({ bars, ready, digits, tf, dataKey }: { bars: Bar[]; ready: boolean; digits: number; tf: string; dataKey: string }) {
  const [preset, setPreset] = useState(PRESETS[0]);
  const [rules, setRules] = useState(() => JSON.stringify(rulesOf(EXAMPLE_STRATEGIES[PRESETS[0]]), null, 2));
  const [money, setMoney] = useState<Money>(() => moneyOf(EXAMPLE_STRATEGIES[PRESETS[0]]));
  const [out, setOut] = useState<{ key: string; trades: Trade[]; equity: { time: number; value: number }[]; stats: Stats } | null>(null);
  const [error, setError] = useState("");
  const choose = (name: string) => {
    setPreset(name);
    setRules(JSON.stringify(rulesOf(EXAMPLE_STRATEGIES[name]), null, 2));
    setMoney(moneyOf(EXAMPLE_STRATEGIES[name]));
    setOut(null); setError("");
  };
  const runIt = () => {
    let parsed: Rules;
    try { parsed = JSON.parse(rules); } catch (e) { return setError(`Quy tắc không phải JSON hợp lệ: ${(e as Error).message}`); }
    try {
      const r = backtest(bars, { ...parsed, ...money });
      setOut({ key: dataKey, ...r }); setError("");
    } catch (e) { setError(`Không chạy được: ${(e as Error).message}`); }
  };
  const result = out?.key === dataKey ? out : null;
  const markers = useMemo<TimedMarker[]>(() => (result?.trades ?? []).flatMap((t): TimedMarker[] => {
    const long = t.side === "long";
    return [
      { time: t.entryTime, position: long ? "belowBar" : "aboveBar", shape: long ? "arrowUp" : "arrowDown", color: long ? COLORS.up : COLORS.down, text: long ? "Mua" : "Bán" },
      { time: t.exitTime, position: long ? "aboveBar" : "belowBar", shape: "circle", color: t.pnl > 0 ? COLORS.up : COLORS.down, text: `${t.pnlPct >= 0 ? "+" : ""}${t.pnlPct.toFixed(1)}%` },
    ];
  }), [result]);
  const download = () => {
    if (!result) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([tradesCsv(result.trades)], { type: "text/csv" }));
    a.download = `backtest_${dataKey.replace(/:/g, "_")}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const num = (k: keyof Money, label: string, hint: string, step = "any") => (
    <label className="grid gap-0.5" title={hint}>
      <span className="text-muted">{label}</span>
      <input type="number" min={0} step={step} value={money[k]} onChange={(e) => setMoney((m) => ({ ...m, [k]: Math.max(0, Number(e.target.value) || 0) }))} className="w-full" />
    </label>
  );
  const s = result?.stats;
  const tone = (v: number | null | undefined) => (v == null ? undefined : v > 0 ? "up" as const : v < 0 ? "down" as const : undefined);

  return (
    <div className="grid gap-4">
      <Panel title="Chiến lược">
        <div className="grid gap-3 text-xs lg:grid-cols-[1fr_1.4fr]">
          <div className="grid content-start gap-2">
            <label className="grid gap-0.5"><span className="text-muted">Mẫu có sẵn</span>
              <select value={preset} onChange={(e) => choose(e.target.value)}>{PRESETS.map((p) => <option key={p} value={p}>{p}</option>)}</select>
            </label>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {num("stopLossPct", "Cắt lỗ %", "0 = không cắt lỗ")}
              {num("takeProfitPct", "Chốt lời %", "0 = không chốt lời cố định")}
              {num("trailingStopPct", "Dừng lỗ kéo theo %", "0 = tắt")}
              {num("feePct", "Phí mỗi chiều %", "Phí giao dịch mỗi lần vào hoặc ra")}
              {num("slippagePct", "Trượt giá %", "Giá khớp xấu hơn giá tín hiệu mỗi chiều")}
              {num("positionPct", "Vốn mỗi lệnh %", "Phần trăm vốn đưa vào mỗi lệnh")}
              {num("initialCapital", "Vốn ban đầu", "Đơn vị tiền tuỳ ý", "100")}
            </div>
            <p className="text-muted">Tín hiệu đọc ở giá đóng cửa nến và khớp ở giá mở cửa nến kế tiếp, nên không dùng thông tin tương lai. Cắt lỗ và chốt lời: nến chạm cả hai thì tính cắt lỗ trước.</p>
            <button onClick={runIt} disabled={!ready} className="rounded bg-accent px-3 py-1.5 text-white disabled:opacity-50">▶ Chạy backtest</button>
            {error && <p className="text-down">{error}</p>}
          </div>
          <label className="grid gap-0.5">
            <span className="text-muted">Quy tắc (JSON): chỉ báo, điều kiện vào/ra lệnh Mua (Long) và Bán (Short). Toán tử: &gt; &lt; &gt;= &lt;= crossesAbove crossesBelow crosses. Toán hạng: số, close/open/high/low/hl2…, tên chỉ báo hoặc tên.đầu_ra (vd. macd.signal).</span>
            <textarea value={rules} onChange={(e) => setRules(e.target.value)} spellCheck={false} rows={16} className="w-full font-mono text-xs" />
          </label>
        </div>
      </Panel>

      {result && s && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
            <Kpi label="Lãi/lỗ ròng" value={`${(s.netProfitPct ?? 0) >= 0 ? "+" : ""}${s.netProfitPct ?? 0}%`} tone={tone(s.netProfitPct)} sub={s.netProfit != null ? fmt(s.netProfit, 2) : undefined} />
            <Kpi label="Mua và giữ" value={s.buyHoldPct == null ? "—" : `${s.buyHoldPct >= 0 ? "+" : ""}${s.buyHoldPct}%`} tone={tone(s.buyHoldPct)} />
            <Kpi label="Số lệnh" value={s.totalTrades} sub={s.exposurePct != null ? `${s.exposurePct}% thời gian có lệnh` : undefined} />
            <Kpi label="Tỷ lệ thắng" value={s.winRatePct == null ? "—" : `${s.winRatePct}%`} />
            <Kpi label="Profit factor" value={s.profitFactor ?? "—"} tone={s.profitFactor == null ? undefined : s.profitFactor >= 1 ? "up" : "down"} />
            <Kpi label="Sụt giảm tối đa" value={s.maxDrawdownPct == null ? "—" : `${s.maxDrawdownPct}%`} tone="down" />
            <Kpi label="Sharpe" value={s.sharpe ?? "—"} />
            <Kpi label="TB mỗi lệnh" value={s.avgTradePct == null ? "—" : `${s.avgTradePct}%`} tone={tone(s.avgTradePct)}
              sub={s.avgWinPct != null || s.avgLossPct != null ? `thắng ${s.avgWinPct ?? "—"}% · thua ${s.avgLossPct ?? "—"}%` : undefined} />
          </div>
          <Panel title="Đường vốn" action={<span className="text-xs text-muted">{s.feesAndSlippage}</span>}>
            <EquityChart equity={result.equity} />
          </Panel>
          <Panel title="Lệnh trên biểu đồ">
            <ResultChart bars={bars} digits={digits} tf={tf} markers={markers} lines={[]} viewKey={dataKey} />
          </Panel>
          <Panel title={`Danh sách lệnh (${result.trades.length})`} action={<button onClick={download} className="rounded border border-border px-2 py-1 text-xs hover:bg-panel-2">⬇ CSV</button>}>
            <div className="max-h-96 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-panel text-left text-muted">
                  <tr><th className="py-1 pr-2">Chiều</th><th className="pr-2">Vào</th><th className="pr-2 text-right">Giá vào</th><th className="pr-2">Ra</th>
                    <th className="pr-2 text-right">Giá ra</th><th className="pr-2 text-right">Lãi/lỗ</th><th className="pr-2 text-right">Số nến</th><th>Lý do ra</th></tr>
                </thead>
                <tbody>
                  {[...result.trades].reverse().map((t) => (
                    <tr key={`${t.entryTime}${t.side}`} className="border-t border-border">
                      <td className={`py-1 pr-2 ${t.side === "long" ? "text-up" : "text-down"}`}>{t.side === "long" ? "Mua" : "Bán"}</td>
                      <td className="pr-2 font-mono">{when(t.entryTime)}</td>
                      <td className="pr-2 text-right font-mono">{fmt(t.entryPrice, digits)}</td>
                      <td className="pr-2 font-mono">{when(t.exitTime)}</td>
                      <td className="pr-2 text-right font-mono">{fmt(t.exitPrice, digits)}</td>
                      <td className={`pr-2 text-right font-mono ${t.pnl > 0 ? "text-up" : "text-down"}`}>{t.pnlPct >= 0 ? "+" : ""}{t.pnlPct.toFixed(2)}%</td>
                      <td className="pr-2 text-right font-mono">{t.bars}</td>
                      <td className="text-muted">{t.exitReason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!result.trades.length && <p className="py-3 text-sm text-muted">Không có lệnh nào: điều kiện vào lệnh chưa lần nào thoả.</p>}
            </div>
          </Panel>
        </>
      )}
    </div>
  );
}

/** The account value over the test, as an area. */
function EquityChart({ equity }: { equity: { time: number; value: number }[] }) {
  const host = useRef<HTMLDivElement>(null);
  // one effect for chart and series: a new result is a new small chart, so cleanup never outlives the chart
  useEffect(() => {
    if (!host.current || !equity.length) return;
    const c = createChart(host.current, {
      autoSize: true,
      layout: { background: { color: "transparent" }, textColor: COLORS.muted, attributionLogo: false },
      grid: { vertLines: { visible: false }, horzLines: { color: "rgba(130,146,168,0.12)" } },
      rightPriceScale: { borderVisible: false }, timeScale: { borderVisible: false, timeVisible: true },
    });
    const start = equity[0].value, end = equity[equity.length - 1].value;
    const color = end >= start ? COLORS.up : COLORS.down;
    const s = c.addSeries(AreaSeries, { lineColor: color, topColor: `${color}55`, bottomColor: `${color}05`, lineWidth: 2, priceLineVisible: false });
    s.setData(equity.map((e) => ({ time: e.time as UTCTimestamp, value: e.value })));
    c.timeScale().fitContent();
    return () => c.remove();
  }, [equity]);
  return <div ref={host} className="h-64" />;
}
