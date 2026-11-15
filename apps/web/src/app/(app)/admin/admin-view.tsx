import type { ReactNode } from "react";
import { ago } from "@/lib/format";
import { Badge, Empty, Kpi, Notice, PageHeader, Panel, btn, td, th } from "@/components/ui";
import { deleteUser, setLocked, setRole } from "./actions";

export type UserRow = {
  id: string; email: string; full_name: string | null; role: "admin" | "manager" | "user";
  created_at: string; last_sign_in_at: string | null; locked: boolean; telegram: boolean; mt5_accounts: number; radar_alerts: boolean;
};
export type AuditRow = { id: number; actor: string | null; action: string; target: string | null; detail: unknown; at: string };
const ROLE_LABEL = { admin: "Admin", manager: "Quản lý", user: "Người dùng" } as const;
const ROLE_TONE = { admin: "accent", manager: "warn", user: "muted" } as const;
const ACTION_LABEL: Record<string, string> = {
  "admin.set_role": "Đổi quyền", "admin.lock": "Khoá", "admin.unlock": "Mở khoá", "admin.delete_user": "Xoá tài khoản",
};

/** The admin page's content: user list with role / lock / delete forms, and the admin audit log. */
export function AdminView({ all, q, userId, log, now, msg, error }: {
  all: UserRow[]; q: string; userId: string; log: AuditRow[]; now: number; msg?: ReactNode; error?: ReactNode;
}) {
  const users = q ? all.filter((u) => `${u.email} ${u.full_name ?? ""}`.toLowerCase().includes(q)) : all;
  const emailOf = new Map(all.map((u) => [u.id, u.email]));
  return (
    <>
      <PageHeader title="Quản lý người dùng"
        sub="Đổi quyền, khoá hoặc mở khoá đăng nhập, xoá tài khoản. Mọi thao tác được ghi vào nhật ký bên dưới." />
      {msg && <Notice tone="up">{msg}</Notice>}
      {error && <Notice tone="down">{error}</Notice>}

      <div className="mb-4 grid gap-3 sm:grid-cols-4">
        <Kpi label="Người dùng" value={all.length} />
        <Kpi label="Admin / quản lý" value={`${all.filter((u) => u.role === "admin").length} / ${all.filter((u) => u.role === "manager").length}`} />
        <Kpi label="Đang bị khoá" value={all.filter((u) => u.locked).length} tone={all.some((u) => u.locked) ? "warn" : undefined} />
        <Kpi label="Có tài khoản MT5" value={all.filter((u) => u.mt5_accounts > 0).length} />
      </div>

      <Panel title={`Danh sách (${users.length}${q ? ` / ${all.length}` : ""})`} action={
        <form className="flex gap-2">
          <input name="q" defaultValue={q} placeholder="Tìm email hoặc tên…" className="w-56 rounded border border-border bg-background px-2 py-1 text-sm" />
          <button className={btn.ghost}>Tìm</button>
        </form>
      }>
        {users.length ? (
          <div className="-m-4 overflow-x-auto">
            <table className="w-full min-w-[1000px] text-sm">
              <thead className="border-b border-border">
                <tr>
                  <th className={th}>Người dùng</th><th className={th}>Quyền</th><th className={th}>Trạng thái</th>
                  <th className={th}>Tham gia</th><th className={th}>Đăng nhập gần nhất</th><th className={`${th} text-right`}>MT5</th>
                  <th className={th}>Telegram / Radar</th><th className={th}></th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => {
                  const self = u.id === userId;
                  return (
                    <tr key={u.id} className="border-b border-border/60 align-top">
                      <td className={td}>
                        <div>{u.email}{self && <span className="ml-1.5"><Badge tone="accent">bạn</Badge></span>}</div>
                        <div className="text-xs text-muted">{u.full_name ?? "—"}</div>
                      </td>
                      <td className={td}>
                        {self ? <Badge tone={ROLE_TONE[u.role]}>{ROLE_LABEL[u.role]}</Badge> : (
                          <form action={setRole} className="flex items-center gap-1">
                            <input type="hidden" name="user" value={u.id} /><input type="hidden" name="q" value={q} />
                            <select name="role" defaultValue={u.role} className="rounded border border-border bg-background px-1.5 py-0.5 text-xs">
                              {(["user", "manager", "admin"] as const).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                            </select>
                            <button className={`${btn.ghost} px-2 py-0.5 text-xs`}>Lưu</button>
                          </form>
                        )}
                      </td>
                      <td className={td}>{u.locked ? <Badge tone="down">Đã khoá</Badge> : <Badge tone="up">Hoạt động</Badge>}</td>
                      <td className={`${td} text-muted`}>{new Date(u.created_at).toLocaleDateString("vi-VN")}</td>
                      <td className={`${td} text-muted`}>{u.last_sign_in_at ? ago(u.last_sign_in_at, now) : "chưa đăng nhập"}</td>
                      <td className={`${td} text-right font-mono`}>{u.mt5_accounts}</td>
                      <td className={`${td} text-xs text-muted`}>{u.telegram ? "Telegram ✓" : "—"} · {u.radar_alerts ? "Radar ✓" : "—"}</td>
                      <td className={`${td} whitespace-nowrap`}>
                        {!self && (
                          <div className="flex flex-col items-end gap-1.5">
                            <form action={setLocked}>
                              <input type="hidden" name="user" value={u.id} /><input type="hidden" name="q" value={q} />
                              <input type="hidden" name="locked" value={u.locked ? "0" : "1"} />
                              <button className={`${u.locked ? btn.ghost : btn.warn} px-2 py-0.5 text-xs`}
                                title={u.locked ? "Cho phép đăng nhập lại" : "Chặn đăng nhập (phiên đang mở hết hạn trong tối đa 1 giờ)"}>
                                {u.locked ? "Mở khoá" : "Khoá"}
                              </button>
                            </form>
                            <details className="text-xs">
                              <summary className="cursor-pointer text-muted hover:text-down">Xoá…</summary>
                              <form action={deleteUser} className="mt-1 grid gap-1">
                                <input type="hidden" name="user" value={u.id} /><input type="hidden" name="q" value={q} />
                                <span className="text-muted">Gõ lại email để xoá vĩnh viễn<br />(cả tài khoản MT5, layout, cảnh báo):</span>
                                <input name="confirm" autoComplete="off" placeholder={u.email} className="w-56 rounded border border-down/50 bg-background px-1.5 py-0.5" />
                                <button className={`${btn.danger} px-2 py-0.5 text-xs`}>Xoá vĩnh viễn</button>
                              </form>
                            </details>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : <Empty>{q ? `Không có ai khớp “${q}”.` : "Chưa có người dùng nào."}</Empty>}
        <p className="mt-3 text-xs text-muted">
          Bạn không thể tự hạ quyền, tự khoá hay tự xoá mình, nên luôn còn ít nhất một admin. Muốn khoá hoặc xoá một admin khác,
          hạ quyền người đó trước. Quản lý (manager) xem được dữ liệu copy trade của mọi người nhưng không vào được trang này.
        </p>
      </Panel>

      <Panel title="Nhật ký quản trị" className="mt-4">
        {log && log.length ? (
          <ul className="space-y-1 text-sm">
            {log.map((l) => (
              <li key={l.id} className="flex flex-wrap gap-x-2">
                <span className="text-muted">{ago(l.at, now)}</span>
                <span>{emailOf.get(String(l.actor)) ?? "admin"}</span>
                <span className="text-muted">{ACTION_LABEL[l.action] ?? l.action}</span>
                <span>{emailOf.get(String(l.target)) ?? (l.detail as { email?: string } | null)?.email ?? l.target}</span>
                {l.action === "admin.set_role" && <span className="text-muted">({String((l.detail as { from?: string })?.from)} → {String((l.detail as { to?: string })?.to)})</span>}
              </li>
            ))}
          </ul>
        ) : <Empty>Chưa có thao tác nào.</Empty>}
      </Panel>
    </>
  );
}
