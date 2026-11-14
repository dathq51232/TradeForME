"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser, withMsg } from "@/lib/auth";

const EXCHANGES = ["BINANCE", "OKX", "BYBIT", "KRAKEN", "KUCOIN", "GATE", "COINBASE"];

/** Saves the signed-in user's radar alert settings (thresholds, fees, on/off). */
export async function saveRadarSettings(form: FormData) {
  const { supabase, userId } = await requireUser("/radar");
  const numOf = (k: string, lo: number, hi: number, label: string) => {
    const v = Number(String(form.get(k) ?? "").replace(",", "."));
    if (!Number.isFinite(v) || v < lo || v > hi) redirect(withMsg("/radar?tab=settings", "error", `${label} phải từ ${lo} đến ${hi}.`));
    return v;
  };
  const fees: Record<string, number> = {};
  for (const ex of EXCHANGES) fees[ex] = numOf(`fee_${ex}`, 0, 5, `Phí ${ex}`);
  const row = {
    user_id: userId,
    alerts_on: form.get("alerts_on") === "on",
    arb_alert: numOf("arb_alert", -5, 100, "Ngưỡng chênh lệch"),
    pump_alert: Math.round(numOf("pump_alert", 0, 100, "Ngưỡng điểm bơm")),
    listing_alert: form.get("listing_alert") === "on",
    min_vol: numOf("min_vol", 0, 1e12, "Khối lượng tối thiểu"),
    fees,
    updated_at: new Date().toISOString(),
  };
  const { error } = await supabase.from("radar_settings").upsert(row);
  revalidatePath("/radar");
  redirect(withMsg("/radar?tab=settings", error ? "error" : "msg", error ? error.message : "Đã lưu cài đặt Radar."));
}
