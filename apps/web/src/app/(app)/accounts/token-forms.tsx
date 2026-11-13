"use client";
import { useActionState, useEffect, useState } from "react";
import { addAccount, rotateToken, setupStatus, type IssuedToken, type SetupStatus } from "./actions";
import { btn } from "@/components/ui";

/** MT5 .set preset: UTF-16LE with BOM, as MetaTrader writes them. */
function downloadSet(fileName: string, connection: string) {
  const text = `InpConnection=${connection}\r\n`;
  const buf = new Uint16Array(text.length + 1);
  buf[0] = 0xfeff;
  for (let i = 0; i < text.length; i++) buf[i + 1] = text.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([buf], { type: "application/octet-stream" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

const safeName = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 40) || "account";

function CopyButton({ text, label, primary }: { text: string; label: string; primary?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* select manually */ }
  };
  return <button type="button" onClick={copy} className={primary ? btn.primary : btn.ghost}>{copied ? "Đã chép ✓" : label}</button>;
}

const POLL_MS = 4000;
const POLL_FOR_MS = 20 * 60_000;

/** Live checklist: polls the account until the EA is online, self-tested and allowed to trade. */
function Checklist({ id, role }: { id: string; role: "master" | "receiver" }) {
  const [st, setSt] = useState<SetupStatus | null>(null);
  const [polls, setPolls] = useState(0);
  const done = !!st?.online && st.selftest === "ok" && st.tradeAllowed !== false;

  useEffect(() => {
    if (done) return;
    const started = Date.now();
    const t = setInterval(() => {
      if (Date.now() - started > POLL_FOR_MS) { clearInterval(t); return; }
      setupStatus(id).then((s) => { setSt(s); setPolls((n) => n + 1); }).catch(() => {});
    }, POLL_MS);
    return () => clearInterval(t);
  }, [id, done]);

  const waitingLong = polls * POLL_MS > 90_000;
  type Item = { ok: boolean | null; label: string; detail?: string };
  const items: Item[] = [
    {
      ok: st?.seen ?? null,
      label: "EA đã gọi tới máy chủ",
      detail: !st?.seen && waitingLong
        ? "Chưa thấy EA. Kiểm tra: đã thêm địa chỉ ở bước 2 vào Allow WebRequest, đã kéo EA vào chart, và góc phải chart hiện tên EA."
        : undefined,
    },
    {
      ok: st?.login ? !st.lastError || st.online : null,
      label: st?.login ? `Tài khoản MT5 ${st.login} · ${st.server ?? ""}${st.broker ? ` (${st.broker})` : ""}` : "EA tự nhận login và server",
    },
    { ok: st?.selftest ? st.selftest === "ok" : null, label: "Self-test (chữ ký, JSON, tính lot)", detail: st?.selftest && st.selftest !== "ok" ? st.selftest : undefined },
    {
      ok: st?.tradeAllowed ?? null,
      label: "Cho phép giao dịch tự động",
      detail: st?.tradeAllowed === false ? "Bật nút Algo Trading trên thanh công cụ MT5, và tick “Allow Algo Trading” trong cửa sổ cài EA." : undefined,
    },
    { ok: st ? st.online : null, label: role === "master" ? "Online: Master sẵn sàng gửi lệnh" : "Online: Receiver sẵn sàng nhận lệnh" },
  ];

  return (
    <div className="mt-3 rounded border border-border bg-background p-3">
      <p className="mb-2 text-xs font-medium">
        Trạng thái kết nối {done ? <span className="text-up">· hoàn tất ✓</span> : <span className="text-muted">· tự cập nhật mỗi 4 giây</span>}
      </p>
      <ul className="space-y-1 text-xs">
        {items.map((it) => (
          <li key={it.label}>
            <span className={it.ok ? "text-up" : it.ok === false ? "text-down" : "text-muted"}>{it.ok ? "✓" : it.ok === false ? "✗" : "○"}</span>{" "}
            {it.label}
            {it.detail && <div className="ml-4 text-down">{it.detail}</div>}
          </li>
        ))}
      </ul>
      {st?.lastError && !st.online && <p className="mt-2 text-xs text-down">EA báo: {st.lastError}</p>}
    </div>
  );
}

function Issued({ s }: { s: IssuedToken }) {
  if (s.error) return <p className="mt-3 text-sm text-down">{s.error}</p>;
  if (!s.connection || !s.accountId) return null;
  const role = s.role ?? "receiver";
  const ea = role === "master" ? "QT_MasterSender" : "QT_Receiver";
  const host = `https://${s.connection.split(".")[1]}.supabase.co`;
  const setName = `${ea}_${safeName(s.label ?? "")}.set`;
  return (
    <div className="mt-4 rounded-md border border-warn/50 bg-warn/10 p-3 text-sm">
      <p className="font-medium text-warn">Mã kết nối của “{s.label}” chỉ hiện một lần. Giữ trang này mở tới khi xong.</p>
      <div className="mt-2 flex flex-wrap items-start gap-2">
        <code className="min-w-0 flex-1 select-all break-all rounded border border-border bg-background px-2 py-1.5 font-mono text-xs">{s.connection}</code>
        <CopyButton text={s.connection} label="Chép mã" primary />
      </div>

      <ol className="mt-3 list-decimal space-y-2 pl-5 text-xs">
        <li>
          <a href={`/ea/${ea}.ex5`} download className={btn.primary}>Tải {ea}.ex5</a>
          <div className="mt-1">
            Trong MT5: <b>File → Open Data Folder</b> → mở <code>MQL5\Experts</code> → chép file vào. Quay lại MT5, cửa sổ
            Navigator → chuột phải <b>Expert Advisors → Refresh</b>. Không cần biên dịch.
          </div>
        </li>
        <li>
          <b>Tools → Options → Expert Advisors</b>: tick <i>Allow WebRequest for listed URL</i> và thêm địa chỉ:
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <code className="select-all rounded border border-border bg-background px-2 py-1 font-mono">{host}</code>
            <CopyButton text={host} label="Chép địa chỉ" />
          </div>
        </li>
        <li>
          Kéo <b>{ea}</b> từ Navigator vào <b>một</b> chart bất kỳ → tab <i>Inputs</i> → dán mã vào ô <b>Mã kết nối</b> → OK.
          <span className="text-muted"> (Hoặc bấm Load và chọn file{" "}
            <button type="button" onClick={() => downloadSet(setName, s.connection!)} className="text-accent hover:underline">{setName}</button>.)</span>
        </li>
      </ol>

      <Checklist id={s.accountId} role={role} />

      <details className="mt-2 text-xs text-muted">
        <summary className="cursor-pointer">Nâng cao: mã nguồn và giá trị chi tiết</summary>
        <p className="mt-1">
          Mã nguồn <a href={`/ea/${ea}.mq5`} download className="text-accent hover:underline">{ea}.mq5</a> (biên dịch bằng F7 nếu MT5 báo file .ex5 quá mới: hãy cập nhật MT5 hoặc dùng bản này).
        </p>
        <dl className="mt-1 grid gap-1 font-mono">
          <dt>Account ID</dt><dd className="select-all break-all">{s.accountId}</dd>
          <dt>EA token</dt><dd className="select-all break-all">{s.token}</dd>
          <dt>HMAC secret</dt><dd className="select-all break-all">{s.secret}</dd>
        </dl>
      </details>
      <p className="mt-2 text-xs text-muted">Hệ thống chỉ lưu bản băm của token. Mất mã thì bấm “Cấp lại token”; mã cũ ngừng hoạt động ngay.</p>
    </div>
  );
}

export function AddAccountForm() {
  const [state, action, pending] = useActionState(addAccount, {});
  return (
    <form action={action} className="grid gap-3 text-sm sm:grid-cols-3">
      <label className="grid gap-1">Vai trò
        <select name="role" defaultValue="receiver" required>
          <option value="master">Master: tài khoản gửi lệnh</option>
          <option value="receiver">Receiver: tài khoản nhận lệnh</option>
        </select>
      </label>
      <label className="grid gap-1">Tên hiển thị<input name="label" required maxLength={60} placeholder="VD: Receiver Exness 01" /></label>
      <div className="flex items-end">
        <button className={btn.primary} disabled={pending}>{pending ? "Đang tạo…" : "Tạo mã kết nối"}</button>
      </div>
      <p className="text-xs text-muted sm:col-span-3">
        Không cần login, server hay mật khẩu MT5: EA tự nhận tài khoản đang đăng nhập trong terminal và chỉ dùng mã này để gọi máy chủ.
      </p>
      <div className="sm:col-span-3"><Issued s={state} /></div>
    </form>
  );
}

export function RotateTokenForm({ id, label, role }: { id: string; label: string; role: string }) {
  const [state, action, pending] = useActionState(rotateToken, {});
  return (
    <form action={action} onSubmit={(e) => { if (!confirm(`Cấp mã mới cho "${label}"? EA đang chạy với mã cũ sẽ mất kết nối.`)) e.preventDefault(); }}>
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="label" value={label} />
      <input type="hidden" name="role" value={role} />
      <button className="text-xs text-accent hover:underline" disabled={pending}>Cấp lại mã kết nối</button>
      <div className="ml-auto w-[min(36rem,80vw)] whitespace-normal text-left"><Issued s={state} /></div>
    </form>
  );
}
