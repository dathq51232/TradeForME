"use client";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Badge, Empty, Panel, btn, td, th } from "@/components/ui";
import { ago, num, type Tone } from "@/lib/format";
import { saveRadarSettings } from "./actions";

// Shapes written by supabase/functions/_shared/radar.ts.
type Leg = { ex: string; native: string; quote: string; price: number; volUsd: number };
type Depth = { gross: number; full: boolean; filledUsd: number };
export type ArbRow = {
  base: string; buy: Leg; sell: Leg; gross: number; volUsd: number; exchanges: number; age: number;
  suspect: boolean; suspects: string[]; depth?: Record<string, Depth>; depthError?: string;
};
export type PumpRow = {
  base: string; native: string; price: number; chg5m: number; chg15m: number; chg60m: number; volRatio: number;
  tradesRatio: number; takerBuy: number; fromPeak: number; score: number; stage: "pumping" | "topping" | "dumping" | "volume" | null;
  vol24hUsd: number; funding: number | null; thin: boolean;
};
export type ListingRow = {
  id: number; exchange: string; native: string; base: string; quote: string; kind: "new" | "opened"; status: string;
  opens_at: string | null; elsewhere: string[]; seen_at: string;
};
export type Settings = { alerts_on: boolean; arb_alert: number; pump_alert: number; listing_alert: boolean; min_vol: number; fees: Record<string, number> };
export type RadarData = {
  now: number; updatedAt: string | null; arbitrage: ArbRow[]; pumps: PumpRow[]; listings: ListingRow[];
  status: Record<string, { ok: boolean; pairs?: number; error?: string }>;
  rates: { USDT: number; USDC: number; source?: { USDT: string } } | null; settings: Settings;
};

export const DEFAULT_FEES: Record<string, number> = { BINANCE: 0.1, OKX: 0.1, BYBIT: 0.1, KRAKEN: 0.4, KUCOIN: 0.1, GATE: 0.1, COINBASE: 0.6 };
const EX_NAME: Record<string, string> = { BINANCE: "Binance", OKX: "OKX", BYBIT: "Bybit", KRAKEN: "Kraken", KUCOIN: "KuCoin", GATE: "Gate", COINBASE: "Coinbase" };
const exName = (x: string) => EX_NAME[x] ?? x;
const SIZES = ["100", "1000", "10000"];
const TABS = [["arbitrage", "Chênh lệch giá"], ["pumps", "Bơm giá"], ["listings", "Niêm yết mới"], ["settings", "Cảnh báo"]] as const;
type Tab = (typeof TABS)[number][0];

const pct = (v: number | null | undefined, d = 2) => (v == null || !Number.isFinite(v) ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(d)}%`);
const toneOf = (v: number) => (v >= 0 ? "text-up" : "text-down");
const price = (v: number) => {
  const a = Math.abs(v);
  const d = a >= 1000 ? 2 : a >= 1 ? 4 : a >= 0.01 ? 6 : 8;
  return v.toLocaleString("en-US", { maximumFractionDigits: d });
};
const money = (v: number) => (v >= 1e9 ? `${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(0)}K` : num(v, 0));

export function RadarView({ data, tab: initial }: { data: RadarData; tab?: string }) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>(TABS.some(([k]) => k === initial) ? (initial as Tab) : "arbitrage");
  // the scan runs every minute on the server; follow it while the page is open
  useEffect(() => {
    const t = setInterval(() => { if (!document.hidden) router.refresh(); }, 60_000);
    return () => clearInterval(t);
  }, [router]);

  const stale = data.updatedAt ? data.now - Date.parse(data.updatedAt) > 5 * 60_000 : true;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex overflow-hidden rounded-md border border-border" role="tablist">
          {TABS.map(([k, label]) => (
            <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
              className={`border-border px-3 py-1.5 text-sm [&+&]:border-l ${tab === k ? "bg-accent/15 text-foreground" : "text-muted hover:bg-panel-2"}`}>
              {label}
            </button>
          ))}
        </div>
        <span className="ml-auto flex flex-wrap items-center gap-1.5 text-xs text-muted">
          {Object.entries(data.status).sort(([a], [b]) => a.localeCompare(b)).map(([ex, s]) => (
            <span key={ex} title={s.ok ? `${s.pairs} cặp` : s.error}>
              <Badge tone={s.ok ? "up" : "down"}>{exName(ex)}</Badge>
            </span>
          ))}
          <span>· quét {ago(data.updatedAt, data.now)}</span>
          <button className={`${btn.ghost} ml-1 px-2 py-1 text-xs`} onClick={() => router.refresh()}>Làm mới</button>
        </span>
      </div>
      {stale && (
        <p className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn">
          {data.updatedAt ? "Lần quét gần nhất đã cũ hơn 5 phút: hàm radar-cron có thể chưa được lên lịch hoặc đang lỗi." : "Chưa có lần quét nào. Radar chạy sau khi hàm radar-cron được deploy và lên lịch (pg_cron, mỗi phút)."}
        </p>
      )}
      {tab === "arbitrage" && <Arbitrage data={data} />}
      {tab === "pumps" && <Pumps data={data} />}
      {tab === "listings" && <Listings data={data} />}
      {tab === "settings" && <SettingsForm s={data.settings} />}
      <p className="text-xs text-muted">
        Chỉ dùng dữ liệu thị trường công khai; Radar không đặt lệnh. Nó phát hiện biến động khi đã bắt đầu, không dự đoán được trước,
        và không phải khuyến nghị đầu tư. Trước khi làm gì với một khoản chênh lệch, hãy kiểm tra nạp/rút đang mở trên cả hai sàn.
      </p>
    </div>
  );
}

function useSort<T>(rows: T[], initial: string, get: (r: T, k: string) => number | string | null | undefined) {
  const [sort, setSort] = useState<[string, number]>([initial, -1]);
  const sorted = useMemo(() => [...rows].sort((a, b) => {
    const x = get(a, sort[0]), y = get(b, sort[0]);
    if (typeof x === "string" || typeof y === "string") return sort[1] * String(x ?? "").localeCompare(String(y ?? ""));
    const fx = Number.isFinite(x) ? (x as number) : -Infinity, fy = Number.isFinite(y) ? (y as number) : -Infinity;
    return sort[1] * (fx - fy);
  }), [rows, sort, get]);
  const head = (k: string, label: string, right = true) => (
    <th className={`${th} cursor-pointer select-none whitespace-nowrap ${right ? "text-right" : ""}`}
      onClick={() => setSort(([c, d]) => [k, c === k ? -d : -1])}>
      {label}{sort[0] === k ? (sort[1] < 0 ? " ↓" : " ↑") : ""}
    </th>
  );
  return { sorted, head };
}

// ---------- arbitrage ----------
function Arbitrage({ data }: { data: RadarData }) {
  const fees = data.settings.fees;
  const [size, setSize] = useState("1000");
  const [minNet, setMinNet] = useState("0");
  const [showSuspect, setShowSuspect] = useState(false);
  const fee = (r: ArbRow) => (fees[r.buy.ex] ?? 0.1) + (fees[r.sell.ex] ?? 0.1);
  const rows = useMemo(() => data.arbitrage
    .filter((r) => showSuspect || !r.suspect)
    .map((r) => {
      const d = r.depth?.[size];
      return { ...r, net: r.gross - fee(r), slip: d ? d.gross - fee(r) : null, full: d?.full ?? null, filled: d?.filledUsd ?? null };
    })
    .filter((r) => (r.slip ?? r.net) >= Number(minNet || -Infinity)),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [data.arbitrage, size, minNet, showSuspect, fees]);
  const get = useMemo(() => (r: (typeof rows)[number], k: string) =>
    k === "buy" ? r.buy.ex : k === "sell" ? r.sell.ex : (r as unknown as Record<string, number | string | null>)[k], []);
  const { sorted, head } = useSort(rows, "slip", get);

  return (
    <Panel title={`Chênh lệch giá (${rows.length})`} action={
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <label className="flex items-center gap-1.5">Lãi ròng tối thiểu
          <input type="number" step="0.1" value={minNet} onChange={(e) => setMinNet(e.target.value)}
            className="w-16 rounded border border-border bg-background px-1.5 py-0.5 font-mono" />%</label>
        <label className="flex items-center gap-1.5">Khối lượng giao dịch
          <select value={size} onChange={(e) => setSize(e.target.value)} className="rounded border border-border bg-background px-1.5 py-0.5">
            {SIZES.map((s) => <option key={s} value={s}>${Number(s).toLocaleString("en-US")}</option>)}
          </select></label>
        <label className="flex items-center gap-1.5"><input type="checkbox" checked={showSuspect} onChange={(e) => setShowSuspect(e.target.checked)} /> Hiện cặp đáng ngờ</label>
      </div>
    }>
      {sorted.length ? (
        <div className="-m-4 overflow-x-auto">
          <table className="w-full min-w-[980px] text-sm">
            <thead className="border-b border-border">
              <tr>
                {head("base", "Coin", false)}{head("buy", "Mua trên (giá bán, $)", false)}{head("sell", "Bán trên (giá mua, $)", false)}
                {head("gross", "Gộp")}{head("net", "Sau phí")}{head("slip", `Sau trượt giá ($${Number(size).toLocaleString("en-US")})`)}
                {head("volUsd", "KL 24h (bên thấp)")}{head("exchanges", "Số sàn")}
              </tr>
            </thead>
            <tbody>
              {sorted.slice(0, 300).map((r) => (
                <tr key={`${r.base}:${r.buy.ex}:${r.sell.ex}:${r.suspect}`} className={`border-b border-border/60 ${r.suspect ? "opacity-70" : ""}`}>
                  <td className={`${td} whitespace-nowrap`}>
                    <span className="font-medium">{r.base}</span>
                    {r.suspect && <span className="ml-1.5" title="Giá lệch xa các sàn khác: thường là token khác trùng tên, hoặc sàn đang khóa nạp/rút"><Badge tone="warn">đáng ngờ</Badge></span>}
                  </td>
                  <td className={td}><div>{exName(r.buy.ex)} <span className="text-xs text-muted">{r.buy.native}</span></div><div className="font-mono text-xs">{price(r.buy.price)}</div></td>
                  <td className={td}><div>{exName(r.sell.ex)} <span className="text-xs text-muted">{r.sell.native}</span></div><div className="font-mono text-xs">{price(r.sell.price)}</div></td>
                  <td className={`${td} text-right font-mono`}>{pct(r.gross)}</td>
                  <td className={`${td} text-right font-mono ${toneOf(r.net)}`}>{pct(r.net)}</td>
                  <td className={`${td} text-right font-mono`}>
                    {r.slip == null ? <span className="text-muted" title={r.depthError ?? "Chỉ tính cho 20 dòng tốt nhất"}>—</span> : (
                      <>
                        <span className={toneOf(r.slip)}>{pct(r.slip)}</span>
                        {r.full === false && <span className="ml-1" title={`Sổ lệnh chỉ đủ khoảng $${num(r.filled ?? 0, 0)}`}><Badge tone="warn">thiếu thanh khoản</Badge></span>}
                      </>
                    )}
                  </td>
                  <td className={`${td} text-right font-mono`}>{money(r.volUsd)}</td>
                  <td className={`${td} text-right`}>{r.exchanges}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <Empty>Không có khoản chênh lệch nào trên {minNet}% lúc này.</Empty>}
      <p className="mt-3 text-xs text-muted">
        Giá quy về USD (USDT ≈ ${data.rates?.USDT?.toFixed(4) ?? "1"}, USDC ≈ ${data.rates?.USDC?.toFixed(4) ?? "1"}).
        Phí là phí taker bạn đặt ở tab Cảnh báo. Trượt giá được tính bằng sổ lệnh thật của cả hai sàn cho 20 dòng tốt nhất.
      </p>
    </Panel>
  );
}

// ---------- pumps ----------
const STAGE: Record<string, [string, Tone]> = {
  pumping: ["Đang bơm", "up"], topping: ["Tạo đỉnh", "warn"], dumping: ["Đang xả", "down"], volume: ["Khối lượng tăng", "muted"],
};
function Pumps({ data }: { data: RadarData }) {
  const get = useMemo(() => (r: PumpRow, k: string) => (r as unknown as Record<string, number | string | null>)[k], []);
  const { sorted, head } = useSort(data.pumps, "score", get);
  return (
    <Panel title={`Bơm giá (${data.pumps.length})`}>
      {sorted.length ? (
        <div className="-m-4 overflow-x-auto">
          <table className="w-full min-w-[1000px] text-sm">
            <thead className="border-b border-border">
              <tr>
                {head("base", "Coin", false)}{head("stage", "Giai đoạn", false)}{head("score", "Điểm")}{head("price", "Giá")}
                {head("chg5m", "5 phút")}{head("chg15m", "15 phút")}{head("chg60m", "1 giờ")}{head("volRatio", "KL so bình thường")}
                {head("takerBuy", "Lệnh mua chủ động")}{head("fromPeak", "Từ đỉnh 30 phút")}{head("funding", "Funding")}{head("vol24hUsd", "KL 24h")}
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => {
                const [label, tone] = STAGE[r.stage ?? ""] ?? ["—", "muted" as Tone];
                return (
                  <tr key={r.native} className="border-b border-border/60">
                    <td className={`${td} whitespace-nowrap`}><span className="font-medium">{r.base}</span>{r.thin && <span className="ml-1.5" title="Thanh khoản mỏng: dễ bị đẩy giá, nhiều tín hiệu giả"><Badge tone="warn">mỏng</Badge></span>}</td>
                    <td className={td}><Badge tone={tone}>{label}</Badge></td>
                    <td className={`${td} text-right font-mono`}>{r.score}</td>
                    <td className={`${td} text-right font-mono`}>{price(r.price)}</td>
                    <td className={`${td} text-right font-mono ${toneOf(r.chg5m)}`}>{pct(r.chg5m)}</td>
                    <td className={`${td} text-right font-mono ${toneOf(r.chg15m)}`}>{pct(r.chg15m)}</td>
                    <td className={`${td} text-right font-mono ${toneOf(r.chg60m)}`}>{pct(r.chg60m)}</td>
                    <td className={`${td} text-right font-mono`}>{r.volRatio.toFixed(1)}×</td>
                    <td className={`${td} text-right font-mono ${r.takerBuy >= 0.6 ? "text-up" : r.takerBuy <= 0.4 ? "text-down" : ""}`}>{Math.round(r.takerBuy * 100)}%</td>
                    <td className={`${td} text-right font-mono ${toneOf(r.fromPeak)}`}>{pct(r.fromPeak)}</td>
                    <td className={`${td} text-right font-mono text-muted`}>{r.funding == null ? "—" : `${r.funding.toFixed(3)}%`}</td>
                    <td className={`${td} text-right font-mono`}>{money(r.vol24hUsd)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : <Empty>Không có gì bất thường trên Binance lúc này.</Empty>}
      <p className="mt-3 text-xs text-muted">
        Cặp USDT trên Binance, từ nến 1 phút. Khối lượng so 5 phút gần nhất với mức thường ngày trong 2,5 giờ trước. Đang bơm: giá và khối lượng
        cùng tăng. Tạo đỉnh: cách đỉnh từ 3% hoặc bên bán bắt đầu áp đảo. Đang xả: cách đỉnh từ 8% và vẫn đang giảm.
      </p>
    </Panel>
  );
}

// ---------- listings ----------
function Listings({ data }: { data: RadarData }) {
  return (
    <Panel title={`Niêm yết mới (${data.listings.length})`}>
      {data.listings.length ? (
        <div className="-m-4 overflow-x-auto">
          <table className="w-full min-w-[820px] text-sm">
            <thead className="border-b border-border">
              <tr><th className={th}>Thấy lúc</th><th className={th}>Sàn</th><th className={th}>Cặp</th><th className={th}>Trạng thái</th><th className={th}>Mở giao dịch</th><th className={th}>Đã có trên</th></tr>
            </thead>
            <tbody>
              {data.listings.map((l) => (
                <tr key={l.id} className="border-b border-border/60">
                  <td className={`${td} text-muted`}>{ago(l.seen_at, data.now)}</td>
                  <td className={td}>{exName(l.exchange)}</td>
                  <td className={td}><span className="font-medium">{l.base}</span>/{l.quote} <span className="text-xs text-muted">{l.native}</span></td>
                  <td className={td}>
                    {l.kind === "opened" ? <Badge tone="up">Đã mở giao dịch</Badge>
                      : l.status === "pre" ? <Badge tone="warn">Niêm yết, chưa giao dịch</Badge>
                      : l.status === "trading" ? <Badge tone="up">Mới, đang giao dịch</Badge> : <Badge tone="muted">Mới, tạm dừng</Badge>}
                  </td>
                  <td className={`${td} text-muted`}>{l.opens_at ? new Date(l.opens_at).toLocaleString("vi-VN") : "—"}</td>
                  <td className={td}>{l.elsewhere.length ? l.elsewhere.map(exName).join(", ") : <span className="text-muted">chưa có sàn nào khác</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <Empty>Chưa có cặp mới nào kể từ khi Radar bắt đầu theo dõi. Danh sách cặp của 7 sàn được so mỗi 2 phút; lần đầu chỉ ghi lại danh sách hiện có.</Empty>}
    </Panel>
  );
}

// ---------- alert settings ----------
function SettingsForm({ s }: { s: Settings }) {
  const field = "rounded border border-border bg-background px-2 py-1 font-mono text-sm";
  return (
    <Panel title="Cảnh báo Radar">
      <form action={saveRadarSettings} className="space-y-4 text-sm">
        <label className="flex items-center gap-2"><input type="checkbox" name="alerts_on" defaultChecked={s.alerts_on} /> Bật cảnh báo cho tôi (chuông thông báo và Telegram nếu đã nhập chat id)</label>
        <div className="flex flex-wrap gap-4">
          <label className="flex flex-col gap-1">Chênh lệch ròng từ (%)<input name="arb_alert" type="number" step="0.1" defaultValue={s.arb_alert} className={`${field} w-28`} /></label>
          <label className="flex flex-col gap-1">Điểm bơm giá từ (0-100)<input name="pump_alert" type="number" step="1" min="0" max="100" defaultValue={s.pump_alert} className={`${field} w-28`} /></label>
          <label className="flex flex-col gap-1">Khối lượng 24h tối thiểu ($)<input name="min_vol" type="number" step="10000" min="0" defaultValue={s.min_vol} className={`${field} w-36`} /></label>
          <label className="flex items-center gap-2 self-end pb-1"><input type="checkbox" name="listing_alert" defaultChecked={s.listing_alert} /> Báo coin mới niêm yết</label>
        </div>
        <fieldset>
          <legend className="mb-1 text-muted">Phí taker từng sàn (%), dùng để tính lãi ròng</legend>
          <div className="flex flex-wrap gap-3">
            {Object.keys(DEFAULT_FEES).map((ex) => (
              <label key={ex} className="flex flex-col gap-1 text-xs">{exName(ex)}
                <input name={`fee_${ex}`} type="number" step="0.01" min="0" max="5" defaultValue={s.fees[ex] ?? DEFAULT_FEES[ex]} className={`${field} w-20`} /></label>
            ))}
          </div>
        </fieldset>
        <p className="text-xs text-muted">Cảnh báo chênh lệch tính sau phí và trượt giá với $1,000. Mỗi coin hoặc cặp sàn báo tối đa một lần mỗi 30 phút.</p>
        <button className={btn.primary}>Lưu</button>
      </form>
    </Panel>
  );
}
