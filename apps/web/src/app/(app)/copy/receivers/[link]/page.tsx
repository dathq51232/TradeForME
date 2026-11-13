import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { LOT_MODE_LABEL } from "@/lib/format";
import { Notice, PageHeader, Panel, btn } from "@/components/ui";
import { saveReceiverSettings } from "../../actions";

export default function ReceiverPage(props: PageProps<"/copy/receivers/[link]">) {
  return (
    <Suspense fallback={<p className="text-sm text-muted">Đang tải…</p>}>
      <Receiver params={props.params} searchParams={props.searchParams} />
    </Suspense>
  );
}

const RISK_ACTION_LABEL: Record<string, string> = {
  reject: "Từ chối lệnh đó (khuyến nghị)",
  pause_receiver: "Từ chối và tạm dừng receiver",
  pause_group: "Từ chối và tạm dừng cả group",
  alert: "Chỉ cảnh báo, vẫn vào lệnh",
  manual_approval: "Chờ duyệt thủ công",
};

async function Receiver({ params, searchParams }: {
  params: PageProps<"/copy/receivers/[link]">["params"];
  searchParams: PageProps<"/copy/receivers/[link]">["searchParams"];
}) {
  const { supabase } = await requireUser("/copy");
  const { link } = await params;
  const sp = await searchParams;
  const { data: l } = await supabase.from("copy_links").select("*").eq("id", link).maybeSingle();
  if (!l) notFound();
  const { data: group } = await supabase.from("copy_groups").select("name").eq("id", l.group_id).maybeSingle();
  const { data: rs } = await supabase.rpc("copy_group_receivers", { p_group: l.group_id });
  const label = (rs as { link_id: string; label: string }[] | null)?.find((r) => r.link_id === link)?.label ?? "Receiver";
  const map = Object.entries((l.symbol_map ?? {}) as Record<string, string>).map(([m, r]) => `${m}=${r}`).join("\n");
  const v = (x: unknown) => (x == null ? "" : String(x));
  const box = (name: string, text: string, hint?: string) => (
    <label className="flex items-start gap-2 text-sm">
      <input type="checkbox" name={name} defaultChecked={Boolean(l[name])} className="mt-1" />
      <span>{text}{hint && <span className="block text-xs text-muted">{hint}</span>}</span>
    </label>
  );
  const field = (name: string, text: string, hint: string, step = "any") => (
    <label className="grid gap-1 text-sm">{text}
      <input name={name} type="number" min="0" step={step} defaultValue={v(l[name])} placeholder="không giới hạn" />
      <span className="text-xs text-muted">{hint}</span>
    </label>
  );

  return (
    <>
      <PageHeader title={`Cấu hình ${label}`} sub={<>Group <b>{group?.name}</b> · <Link href="/copy" className="text-accent">← Copy Trading</Link></>} />
      {sp.msg && <Notice tone="up">{String(sp.msg)}</Notice>}
      {sp.error && <Notice tone="down">{String(sp.error)}</Notice>}
      {!l.enabled && <Notice tone="warn">Receiver đang TẮT. Lưu cấu hình xong, bật lại ở trang Copy Trading.</Notice>}

      <form action={saveReceiverSettings} className="grid gap-5 xl:grid-cols-2">
        <input type="hidden" name="link" value={link} />

        <Panel title="A. Loại lệnh được copy">
          <div className="grid gap-2 sm:grid-cols-2">
            {box("copy_buy", "Copy lệnh Buy")}
            {box("copy_sell", "Copy lệnh Sell")}
            {box("copy_market", "Copy lệnh thị trường")}
            {box("copy_pending", "Copy lệnh chờ", "Buy/Sell Limit, Stop")}
            {box("copy_sl_tp", "Copy SL/TP")}
            {box("copy_modify", "Copy sửa lệnh")}
            {box("copy_close", "Copy đóng lệnh")}
            {box("copy_partial_close", "Copy đóng một phần", "Đóng cùng tỷ lệ với Master")}
            {box("reverse", "Đảo chiều", "Master Buy thì receiver Sell. Chỉ dùng khi chắc chắn.")}
          </div>
        </Panel>

        <Panel title="B. Khối lượng (lot)">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="grid gap-1 text-sm">Chế độ
              <select name="lot_mode" defaultValue={l.lot_mode}>
                {Object.entries(LOT_MODE_LABEL).map(([k, t]) => <option key={k} value={k}>{t}</option>)}
              </select>
            </label>
            <label className="grid gap-1 text-sm">Giá trị
              <input name="lot_value" type="number" min="0" step="any" required defaultValue={v(l.lot_value)} />
              <span className="text-xs text-muted">Lot cố định, hệ số k, hoặc % rủi ro tuỳ chế độ</span>
            </label>
            {field("min_lot", "Lot tối thiểu", "Thấp hơn mức này thì xử lý theo chính sách bên dưới")}
            {field("max_lot", "Lot tối đa", "Lot vượt mức này bị cắt về mức tối đa")}
            <label className="grid gap-1 text-sm sm:col-span-2">Khi lot tính ra nhỏ hơn mức tối thiểu
              <select name="below_min" defaultValue={l.below_min}>
                <option value="skip">Bỏ qua lệnh (ghi lý do)</option>
                <option value="min_lot">Vào lệnh với lot tối thiểu</option>
              </select>
            </label>
          </div>
          <p className="mt-3 text-xs text-muted">
            Ví dụ Master Buy 0.50 lot với hệ số 0.5 thì receiver vào 0.25 lot. Lot luôn được làm tròn xuống theo bước khối lượng của broker,
            và có quy đổi khi hai broker có contract size khác nhau.
          </p>
        </Panel>

        <Panel title="C. Giới hạn rủi ro">
          <div className="grid gap-3 sm:grid-cols-2">
            {field("max_daily_loss_pct", "Lỗ tối đa trong ngày (%)", "Tính theo equity đầu ngày")}
            {field("max_drawdown_pct", "Drawdown tối đa (%)", "Tính từ đỉnh equity")}
            {field("max_open_positions", "Số vị thế mở tối đa", "", "1")}
            {field("max_exposure_lots", "Tổng lot mở tối đa", "")}
            {field("max_margin_usage_pct", "Margin sử dụng tối đa (%)", "margin / equity")}
            {field("max_spread_points", "Spread tối đa (points)", "", "1")}
            <label className="grid gap-1 text-sm">Trượt giá tối đa (points)
              <input name="max_slippage_points" type="number" min="0" step="1" defaultValue={v(l.max_slippage_points)} /></label>
            <label className="grid gap-1 text-sm">Tín hiệu quá cũ sau (giây)
              <input name="max_signal_age_s" type="number" min="1" step="1" defaultValue={v(l.max_signal_age_s)} />
              <span className="text-xs text-muted">Lệnh mở cũ hơn mức này bị bỏ qua, lệnh đóng luôn được thực hiện</span></label>
            <label className="grid gap-1 text-sm sm:col-span-2">Khi vi phạm giới hạn
              <select name="risk_action" defaultValue={l.risk_action}>
                {Object.entries(RISK_ACTION_LABEL).map(([k, t]) => <option key={k} value={k}>{t}</option>)}
              </select>
              <span className="text-xs text-muted">Hệ thống không tự đóng vị thế khi vi phạm; lệnh đóng không bao giờ bị chặn bởi giới hạn rủi ro.</span>
            </label>
          </div>
        </Panel>

        <Panel title="D. Symbol">
          <label className="grid gap-1 text-sm">Ánh xạ symbol (mỗi dòng: Master=Receiver)
            <textarea name="symbol_map" rows={5} defaultValue={map} placeholder={"XAUUSD=GOLD\nUSOIL=WTI.cash"} className="font-mono" />
            <span className="text-xs text-muted">Không có trong bảng thì EA tự dò theo hậu tố phổ biến (m, .r, #, .pro…). Nên kiểm tra contract size, digits và giờ giao dịch trên từng broker.</span>
          </label>
          <label className="mt-3 grid gap-1 text-sm">Chỉ copy các symbol (để trống = tất cả)
            <input name="allowed_symbols" defaultValue={(l.allowed_symbols ?? []).join(", ")} placeholder="XAUUSD, BTCUSD" className="font-mono" />
          </label>
        </Panel>

        <div className="xl:col-span-2">
          <button className={btn.primary}>Lưu cấu hình</button>
          <span className="ml-3 text-xs text-muted">Mọi thay đổi được ghi vào nhật ký kèm giá trị cũ và mới.</span>
        </div>
      </form>
    </>
  );
}
