import { Suspense } from "react";
import { requestTime, requireUser } from "@/lib/auth";
import { Notice, PageHeader } from "@/components/ui";
import { RadarView, type RadarData, DEFAULT_FEES } from "./radar-view";

// Market radar: cross-exchange arbitrage, pumps and new listings. The Edge Function radar-cron scans seven
// exchanges every minute into radar_snapshot / radar_listings; this page shows the latest scan.
export default function RadarPage(props: PageProps<"/radar">) {
  return (
    <Suspense fallback={<p className="text-sm text-muted">Đang tải…</p>}>
      <Radar searchParams={props.searchParams} />
    </Suspense>
  );
}

async function Radar({ searchParams }: { searchParams: PageProps<"/radar">["searchParams"] }) {
  const { supabase, userId } = await requireUser("/radar");
  const sp = await searchParams;
  const [{ data: snap }, { data: listings }, { data: settings }] = await Promise.all([
    supabase.from("radar_snapshot").select("arbitrage, pumps, status, rates, updated_at").maybeSingle(),
    supabase.from("radar_listings").select("id, exchange, native, base, quote, kind, status, opens_at, elsewhere, seen_at")
      .order("seen_at", { ascending: false }).limit(200),
    supabase.from("radar_settings").select("alerts_on, arb_alert, pump_alert, listing_alert, min_vol, fees").eq("user_id", userId).maybeSingle(),
  ]);
  const data: RadarData = {
    now: requestTime(),
    updatedAt: snap?.updated_at ?? null,
    arbitrage: snap?.arbitrage ?? [],
    pumps: snap?.pumps ?? [],
    status: snap?.status ?? {},
    rates: snap?.rates ?? null,
    listings: listings ?? [],
    settings: {
      alerts_on: settings?.alerts_on ?? false,
      arb_alert: Number(settings?.arb_alert ?? 1),
      pump_alert: Number(settings?.pump_alert ?? 60),
      listing_alert: settings?.listing_alert ?? true,
      min_vol: Number(settings?.min_vol ?? 100000),
      fees: { ...DEFAULT_FEES, ...((settings?.fees as Record<string, number> | null) ?? {}) },
    },
  };
  return (
    <>
      <PageHeader title="Radar thị trường"
        sub="Chênh lệch giá giữa 7 sàn crypto, coin đang bị bơm và coin mới niêm yết. Quét mỗi phút từ dữ liệu công khai; không đặt lệnh nào." />
      {sp.msg && <Notice tone="up">{String(sp.msg)}</Notice>}
      {sp.error && <Notice tone="down">{String(sp.error)}</Notice>}
      <RadarView data={data} tab={String(sp.tab ?? "")} />
    </>
  );
}
