import { Suspense } from "react";
import Link from "next/link";
import { requestTime, requireUser } from "@/lib/auth";
import { ago, connection, GROUP_STATE, LOT_MODE_LABEL, num } from "@/lib/format";
import { Badge, Empty, Notice, PageHeader, Panel, btn, td, th } from "@/components/ui";
import { addReceiver, closeAll, groupControl, removeReceiver, setLinkEnabled } from "./actions";

export default function CopyPage(props: PageProps<"/copy">) {
  return (
    <Suspense fallback={<p className="text-sm text-muted">Đang tải…</p>}>
      <Copy searchParams={props.searchParams} />
    </Suspense>
  );
}

type Receiver = {
  link_id: string; receiver_id: string; label: string; currency: string | null; status: string;
  last_heartbeat_at: string | null; balance: number | null; equity: number | null; open_positions: number | null;
  trade_allowed: boolean | null; enabled: boolean; lot_mode: string; lot_value: number; mine: boolean;
};

const TASK_TONE: Record<string, "up" | "down" | "warn" | "muted"> = {
  executed: "up", rejected: "muted", failed: "down", reconciliation_required: "down", retry_scheduled: "warn",
};

async function Copy({ searchParams }: { searchParams: PageProps<"/copy">["searchParams"] }) {
  const { supabase } = await requireUser("/copy");
  const sp = await searchParams;
  const [{ data: groups }, { data: mine }, { data: tasks }] = await Promise.all([
    supabase.from("copy_groups").select("id, name, state, state_reason, state_changed_at, master_id, owner_id").order("created_at"),
    supabase.from("mt5_accounts").select("id, role, label, status, last_heartbeat_at, disabled, terminal_connected, trade_allowed, account_type").order("label"),
    supabase.from("ct_executions")
      .select("id, link_id, seq, action, symbol, side, master_volume, volume, status, error_class, reason, latency_ms, created_at")
      .order("created_at", { ascending: false }).limit(50),
  ]);
  const receiversByGroup = new Map<string, Receiver[]>();
  await Promise.all((groups ?? []).map(async (g) => {
    const { data } = await supabase.rpc("copy_group_receivers", { p_group: g.id });
    receiversByGroup.set(g.id, (data ?? []) as Receiver[]);
  }));
  const now = requestTime();
  const masters = (mine ?? []).filter((a) => a.role === "master");
  const myReceivers = (mine ?? []).filter((a) => a.role === "receiver");
  const mastersWithoutGroup = masters.filter((m) => !(groups ?? []).some((g) => g.master_id === m.id));
  const linkLabel = new Map<string, string>();
  for (const rs of receiversByGroup.values()) for (const r of rs) linkLabel.set(r.link_id, r.label);

  return (
    <>
      <PageHeader title="Copy Trading" sub="Mỗi group có 1 Master (Hedging) và nhiều Receiver; mỗi Receiver có cấu hình lot, rủi ro và symbol mapping riêng." />
      {sp.msg && <Notice tone="up">{String(sp.msg)}</Notice>}
      {sp.error && <Notice tone="down">{String(sp.error)}</Notice>}

      <details className="mb-5 rounded-lg border border-border bg-panel px-4 py-2 text-sm">
        <summary className="cursor-pointer text-muted">Các nút điều khiển khác nhau thế nào?</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-muted">
          <li><b className="text-foreground">Tạm dừng</b>: không mở lệnh mới. Lệnh đóng, đóng một phần, sửa SL/TP của vị thế đã copy vẫn được sao chép để receiver không giữ vị thế mồ côi.</li>
          <li><b className="text-foreground">Dừng</b>: không phát thêm lệnh nào, kể cả lệnh đóng. Vị thế đang mở được giữ nguyên.</li>
          <li><b className="text-foreground">Dừng khẩn cấp</b>: như Dừng, có hiệu lực ngay, và muốn chạy lại phải ghi lý do.</li>
          <li><b className="text-foreground">Close All</b>: thao tác riêng, gửi lệnh đóng mọi vị thế copy trên tất cả receiver, kể cả khi đang dừng khẩn cấp. Phải gõ tên group để xác nhận.</li>
          <li>Lệnh mở phát ra trong lúc tạm dừng bị bỏ qua hẳn, không thực thi muộn khi chạy lại.</li>
        </ul>
      </details>

      {(groups ?? []).length === 0 && <Panel><Empty>Chưa có group. Thêm receiver cho một tài khoản Master ở dưới, group sẽ được tạo tự động ở trạng thái Tạm dừng.</Empty></Panel>}

      <div className="space-y-5">
        {(groups ?? []).map((g) => {
          const s = GROUP_STATE[g.state];
          const master = (mine ?? []).find((a) => a.id === g.master_id);
          const mc = master ? connection(master, now) : null;
          const controls = Boolean(master); // only the master's owner (or staff via SQL) controls a group
          const rs = receiversByGroup.get(g.id) ?? [];
          const onlineRs = rs.filter((r) => connection(r, now).online).length;
          return (
            <Panel key={g.id}
              title={<span id={`g-${g.id}`} className="flex flex-wrap items-center gap-2">{g.name} <Badge tone={s.tone}>{s.label}</Badge>
                <span className="text-xs font-normal text-muted">Receiver online {onlineRs}/{rs.length}</span></span>}
              action={controls && (
                <div className="flex flex-wrap gap-2">
                  {g.state !== "running" && g.state !== "emergency" && <Ctl group={g.id} action={g.state === "paused" ? "resume" : "start"} label="▶ Chạy" cls={btn.primary} />}
                  {g.state === "running" && <Ctl group={g.id} action="pause" label="❚❚ Tạm dừng" cls={btn.warn} />}
                  {(g.state === "running" || g.state === "paused") && <Ctl group={g.id} action="stop" label="■ Dừng" cls={btn.ghost} />}
                </div>
              )}>
              <div className="mb-3 flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
                <span>Master: <b>{master?.label ?? "(không thuộc bạn)"}</b> {mc && <Badge tone={mc.tone}>{mc.label}</Badge>}</span>
                {master?.account_type === "netting" && <Badge tone="warn">Master là Netting: thiết kế giả định Hedging</Badge>}
                <span className="text-xs text-muted">Đổi trạng thái {ago(g.state_changed_at, now)}{g.state_reason ? ` · ${g.state_reason}` : ""}</span>
              </div>

              {rs.length ? (
                <div className="-mx-4 overflow-x-auto">
                  <table className="w-full min-w-[760px] text-sm">
                    <thead className="border-y border-border"><tr>
                      <th className={th}>Receiver</th><th className={th}>Kết nối</th><th className={th}>Lot</th>
                      <th className={`${th} text-right`}>Equity</th><th className={`${th} text-right`}>Vị thế</th><th className={th}>Copy</th><th className={th}></th>
                    </tr></thead>
                    <tbody>
                      {rs.map((r) => {
                        const c = connection(r, now);
                        return (
                          <tr key={r.link_id} className="border-b border-border/60">
                            <td className={td}>{r.label}{r.mine && <span className="ml-1 text-xs text-muted">(của bạn)</span>}</td>
                            <td className={td}><Badge tone={c.tone}>{c.label}</Badge></td>
                            <td className={td}>{LOT_MODE_LABEL[r.lot_mode] ?? r.lot_mode} × {num(r.lot_value)}</td>
                            <td className={`${td} text-right font-mono`}>{num(r.equity)} <span className="text-xs text-muted">{r.currency ?? ""}</span></td>
                            <td className={`${td} text-right font-mono`}>{r.open_positions ?? "—"}</td>
                            <td className={td}>
                              <form action={setLinkEnabled}>
                                <input type="hidden" name="link" value={r.link_id} />
                                <input type="hidden" name="enabled" value={String(!r.enabled)} />
                                <button title={r.enabled ? "Bấm để tắt" : "Bấm để bật"}>
                                  <Badge tone={r.enabled ? "up" : "muted"}>{r.enabled ? "Bật" : "Tắt"}</Badge>
                                </button>
                              </form>
                            </td>
                            <td className={`${td} whitespace-nowrap text-right text-xs`}>
                              <Link href={`/copy/receivers/${r.link_id}`} className="text-accent hover:underline">Cấu hình</Link>
                              {controls && (
                                <form action={removeReceiver} className="ml-3 inline">
                                  <input type="hidden" name="link" value={r.link_id} />
                                  <button className="text-muted hover:text-down">Gỡ</button>
                                </form>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : <Empty>Group chưa có receiver.</Empty>}

              {controls && (
                <div className="mt-4 grid gap-3 lg:grid-cols-3">
                  <AddReceiverForm master={g.master_id} receivers={myReceivers.filter((r) => !rs.some((x) => x.receiver_id === r.id))} />
                  {g.state !== "emergency" ? (
                    <form action={groupControl} className="rounded-md border border-down/40 p-3 text-sm">
                      <input type="hidden" name="group" value={g.id} /><input type="hidden" name="action" value="emergency_stop" />
                      <div className="font-medium text-down">Dừng khẩn cấp</div>
                      <label className="mt-2 flex items-start gap-2 text-xs text-muted">
                        <input type="checkbox" name="ack" required className="mt-0.5" />
                        Chặn mọi lệnh tới receiver ngay lập tức. Không tự đóng vị thế.
                      </label>
                      <input name="reason" placeholder="Lý do (khuyến nghị)" className="mt-2 w-full" />
                      <button className={`${btn.danger} mt-2`}>⛔ Dừng khẩn cấp</button>
                    </form>
                  ) : (
                    <form action={groupControl} className="rounded-md border border-down/40 p-3 text-sm">
                      <input type="hidden" name="group" value={g.id} /><input type="hidden" name="action" value="resume" />
                      <div className="font-medium text-down">Đang dừng khẩn cấp</div>
                      <input name="reason" required placeholder="Lý do chạy lại (bắt buộc)" className="mt-2 w-full" />
                      <button className={`${btn.primary} mt-2`}>▶ Chạy lại</button>
                    </form>
                  )}
                  <form action={closeAll} className="rounded-md border border-down/40 p-3 text-sm">
                    <input type="hidden" name="group" value={g.id} />
                    <div className="font-medium text-down">Close All</div>
                    <p className="mt-1 text-xs text-muted">Đóng mọi vị thế đã copy trên tất cả receiver của group. Gõ <b className="text-foreground">{g.name}</b> để xác nhận.</p>
                    <input name="confirm" required autoComplete="off" className="mt-2 w-full" />
                    <button className={`${btn.danger} mt-2`}>Đóng toàn bộ vị thế copy</button>
                  </form>
                </div>
              )}
            </Panel>
          );
        })}
      </div>

      {mastersWithoutGroup.length > 0 && (
        <Panel title="Tạo group mới" className="mt-5">
          <p className="mb-3 text-xs text-muted">Thêm receiver đầu tiên cho một Master; group được tạo ở trạng thái Tạm dừng.</p>
          <div className="grid gap-3 lg:grid-cols-2">
            {mastersWithoutGroup.map((m) => (
              <div key={m.id}>
                <div className="mb-1 text-sm font-medium">{m.label}</div>
                <AddReceiverForm master={m.id} receivers={myReceivers} />
              </div>
            ))}
          </div>
        </Panel>
      )}
      {masters.length === 0 && (groups ?? []).length === 0 && (
        <Notice tone="muted">Bạn chưa có tài khoản Master. <Link href="/accounts#add" className="text-accent">Thêm tài khoản MT5 →</Link></Notice>
      )}

      <Panel title="Sự kiện copy gần đây" className="mt-5">
        {tasks && tasks.length ? (
          <div className="-m-4 overflow-x-auto">
            <table className="w-full min-w-[860px] text-sm">
              <thead className="border-b border-border"><tr>
                <th className={th}>Thời gian</th><th className={th}>Receiver</th><th className={th}>Hành động</th><th className={th}>Symbol</th>
                <th className={th}>Chiều</th><th className={`${th} text-right`}>Lot master → receiver</th><th className={th}>Trạng thái</th>
                <th className={`${th} text-right`}>Độ trễ</th><th className={th}>Lỗi</th>
              </tr></thead>
              <tbody>
                {tasks.map((t) => (
                  <tr key={t.id} className="border-b border-border/60">
                    <td className={`${td} whitespace-nowrap text-xs text-muted`}>{new Date(t.created_at).toLocaleString("vi-VN")}</td>
                    <td className={td}>{linkLabel.get(t.link_id) ?? "—"}</td>
                    <td className={td}>{t.action ?? "—"}</td>
                    <td className={td}>{t.symbol ?? "—"}</td>
                    <td className={`${td} ${t.side === "BUY" ? "text-up" : t.side === "SELL" ? "text-down" : ""}`}>{t.side ?? "—"}</td>
                    <td className={`${td} text-right font-mono`}>{num(t.master_volume)} → {num(t.volume)}</td>
                    <td className={td}><Badge tone={TASK_TONE[t.status] ?? "muted"}>{t.status}</Badge></td>
                    <td className={`${td} text-right font-mono`}>{t.latency_ms != null ? `${t.latency_ms} ms` : "—"}</td>
                    <td className={`${td} text-xs text-down`}>{t.error_class ?? t.reason ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <Empty>Chưa có sự kiện. Sự kiện xuất hiện khi EA Master gửi lệnh và EA Receiver báo kết quả.</Empty>}
      </Panel>
    </>
  );
}

function Ctl({ group, action, label, cls }: { group: string; action: string; label: string; cls: string }) {
  return (
    <form action={groupControl}>
      <input type="hidden" name="group" value={group} /><input type="hidden" name="action" value={action} />
      <button className={cls}>{label}</button>
    </form>
  );
}

function AddReceiverForm({ master, receivers }: { master: string; receivers: { id: string; label: string }[] }) {
  return (
    <form action={addReceiver} className="rounded-md border border-border p-3 text-sm">
      <input type="hidden" name="master" value={master} />
      <div className="font-medium">Thêm receiver</div>
      <label className="mt-2 grid gap-1 text-xs text-muted">Chọn tài khoản của bạn, hoặc dán Account ID của receiver
        <input name="receiver" list={`r-${master}`} required placeholder="Account ID" className="font-mono" />
        <datalist id={`r-${master}`}>
          {receivers.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
        </datalist>
      </label>
      <button className={`${btn.ghost} mt-2`}>+ Thêm (ở trạng thái tắt)</button>
    </form>
  );
}
