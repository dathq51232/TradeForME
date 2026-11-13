"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser, withMsg } from "@/lib/auth";
import { LOT_MODES, RISK_ACTIONS } from "@qt/shared/copytrade";

const ACTION_MSG: Record<string, string> = {
  start: "Đã bắt đầu copy.",
  resume: "Đã tiếp tục copy.",
  pause: "Đã tạm dừng: không mở lệnh mới; lệnh đóng/sửa của vị thế đang có vẫn được sao chép.",
  stop: "Đã dừng group: không phát thêm lệnh nào. Vị thế đang mở được giữ nguyên.",
  emergency_stop: "ĐÃ DỪNG KHẨN CẤP: chặn mọi lệnh. Vị thế đang mở được giữ nguyên; dùng Close All nếu cần đóng.",
};

const back = (form: FormData, fallback = "/copy") => {
  const b = String(form.get("back") ?? "");
  return b.startsWith("/") && !b.startsWith("//") ? b : fallback;
};

export async function groupControl(form: FormData) {
  const { supabase } = await requireUser("/copy");
  const action = String(form.get("action"));
  const reason = String(form.get("reason") ?? "").trim() || null;
  if (action === "emergency_stop" && form.get("ack") !== "on") {
    redirect(withMsg("/copy", "error", "Đánh dấu xác nhận trước khi dừng khẩn cấp."));
  }
  const { error } = await supabase.rpc("copy_group_control", { p_group: String(form.get("group")), p_action: action, p_reason: reason });
  revalidatePath("/copy"); revalidatePath("/dashboard");
  if (error) {
    const text = error.message.includes("needs a reason") ? "Thoát khỏi dừng khẩn cấp cần ghi lý do." : error.message;
    redirect(withMsg(back(form), "error", text));
  }
  redirect(withMsg(back(form), "msg", ACTION_MSG[action] ?? "Đã cập nhật."));
}

export async function pauseAll(form: FormData) {
  const { supabase } = await requireUser("/dashboard");
  const { data, error } = await supabase.rpc("copy_pause_all", { p_reason: "pause all (web)" });
  revalidatePath("/copy"); revalidatePath("/dashboard");
  redirect(withMsg(back(form, "/dashboard"), error ? "error" : "msg", error ? error.message : `Đã tạm dừng ${data} group.`));
}

export async function closeAll(form: FormData) {
  const { supabase } = await requireUser("/copy");
  const { error } = await supabase.rpc("copy_request_close_all", {
    p_group: String(form.get("group")), p_confirm: String(form.get("confirm") ?? ""),
  });
  revalidatePath("/copy");
  if (error) {
    const text = error.message.includes("type the group name") ? "Tên group không khớp, chưa gửi lệnh đóng." : error.message;
    redirect(withMsg("/copy", "error", text));
  }
  redirect(withMsg("/copy", "msg", "Đã gửi yêu cầu đóng toàn bộ vị thế copy tới mọi receiver. Theo dõi kết quả từng tài khoản bên dưới."));
}

export async function addReceiver(form: FormData) {
  const { supabase } = await requireUser("/copy");
  const master = String(form.get("master"));
  const receiver = String(form.get("receiver") ?? "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(receiver)) redirect(withMsg("/copy", "error", "Account ID của receiver không hợp lệ."));
  // links start disabled: the operator reviews the settings, then enables
  const { error } = await supabase.from("copy_links").insert({ master_id: master, receiver_id: receiver, enabled: false });
  revalidatePath("/copy");
  if (error) {
    const text = error.code === "23505" ? "Receiver này đã thuộc group." : error.code === "23514" ? "Master và receiver phải khác nhau." : error.message;
    redirect(withMsg("/copy", "error", text));
  }
  redirect(withMsg("/copy", "msg", "Đã thêm receiver ở trạng thái TẮT. Kiểm tra cấu hình rồi bật."));
}

export async function setLinkEnabled(form: FormData) {
  const { supabase } = await requireUser("/copy");
  const enabled = form.get("enabled") === "true";
  const { error } = await supabase.from("copy_links").update({ enabled, paused_reason: enabled ? null : "disabled from web" })
    .eq("id", String(form.get("link")));
  revalidatePath("/copy");
  redirect(withMsg(back(form), error ? "error" : "msg", error ? error.message : enabled ? "Đã bật receiver." : "Đã tắt receiver."));
}

export async function removeReceiver(form: FormData) {
  const { supabase } = await requireUser("/copy");
  const { error } = await supabase.from("copy_links").delete().eq("id", String(form.get("link")));
  revalidatePath("/copy");
  redirect(withMsg("/copy", error ? "error" : "msg", error ? error.message : "Đã gỡ receiver khỏi group. Vị thế đã copy trên receiver không bị đóng."));
}

const optNum = (form: FormData, k: string) => {
  const v = String(form.get(k) ?? "").trim();
  if (v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${k} không hợp lệ`);
  return n;
};
const bool = (form: FormData, k: string) => form.get(k) === "on";

export async function saveReceiverSettings(form: FormData) {
  const { supabase } = await requireUser("/copy");
  const id = String(form.get("link"));
  const path = `/copy/receivers/${id}`;
  let patch: Record<string, unknown>;
  try {
    const lot_mode = String(form.get("lot_mode"));
    const risk_action = String(form.get("risk_action"));
    if (!LOT_MODES.includes(lot_mode)) throw new Error("Chế độ lot không hợp lệ");
    if (!RISK_ACTIONS.includes(risk_action)) throw new Error("Hành động rủi ro không hợp lệ");
    const lot_value = optNum(form, "lot_value");
    if (!lot_value) throw new Error("Giá trị lot phải lớn hơn 0");
    const map: Record<string, string> = {};
    for (const line of String(form.get("symbol_map") ?? "").split(/\r?\n/)) {
      const [m, r] = line.split(/[=:>\s]+/).map((s) => s.trim()).filter(Boolean);
      if (m && r) map[m] = r;
    }
    const symbols = String(form.get("allowed_symbols") ?? "").split(/[\s,]+/).filter(Boolean);
    patch = {
      lot_mode, lot_value, risk_action,
      min_lot: optNum(form, "min_lot"), max_lot: optNum(form, "max_lot"),
      below_min: form.get("below_min") === "min_lot" ? "min_lot" : "skip",
      symbol_map: map, allowed_symbols: symbols.length ? symbols : null,
      copy_buy: bool(form, "copy_buy"), copy_sell: bool(form, "copy_sell"), copy_market: bool(form, "copy_market"),
      copy_pending: bool(form, "copy_pending"), copy_sl_tp: bool(form, "copy_sl_tp"), copy_close: bool(form, "copy_close"),
      copy_modify: bool(form, "copy_modify"), copy_partial_close: bool(form, "copy_partial_close"), reverse: bool(form, "reverse"),
      max_open_positions: optNum(form, "max_open_positions"), max_exposure_lots: optNum(form, "max_exposure_lots"),
      max_daily_loss_pct: optNum(form, "max_daily_loss_pct"), max_drawdown_pct: optNum(form, "max_drawdown_pct"),
      max_margin_usage_pct: optNum(form, "max_margin_usage_pct"), max_spread_points: optNum(form, "max_spread_points"),
      max_slippage_points: optNum(form, "max_slippage_points") ?? 50, max_signal_age_s: optNum(form, "max_signal_age_s") ?? 10,
    };
  } catch (e) {
    redirect(withMsg(path, "error", (e as Error).message));
  }
  const { error } = await supabase.from("copy_links").update(patch).eq("id", id);
  revalidatePath("/copy"); revalidatePath(path);
  redirect(withMsg(path, error ? "error" : "msg", error ? error.message : "Đã lưu cấu hình. Thay đổi được ghi vào nhật ký."));
}
