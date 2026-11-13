"use client";
import { useActionState, useState } from "react";
import { addAccount, rotateToken, type IssuedToken } from "./actions";
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

const safeName = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 40) || "account";

function Issued({ s }: { s: IssuedToken }) {
  const [copied, setCopied] = useState(false);
  if (s.error) return <p className="mt-3 text-sm text-down">{s.error}</p>;
  if (!s.connection) return null;
  const ea = s.role === "master" ? "QT_MasterSender" : "QT_Receiver";
  const copy = async () => {
    try { await navigator.clipboard.writeText(s.connection!); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* select manually */ }
  };
  return (
    <div className="mt-4 rounded-md border border-warn/50 bg-warn/10 p-3 text-sm">
      <p className="font-medium text-warn">Mã kết nối của “{s.label}” chỉ hiện một lần. Chép hoặc tải file .set ngay.</p>
      <div className="mt-2 flex flex-wrap items-start gap-2">
        <code className="min-w-0 flex-1 select-all break-all rounded border border-border bg-background px-2 py-1.5 font-mono text-xs">{s.connection}</code>
        <button type="button" onClick={copy} className={btn.primary}>{copied ? "Đã chép ✓" : "Chép mã"}</button>
      </div>
      <ol className="mt-3 list-decimal space-y-1 pl-5 text-xs">
        <li>
          Tải <a href={`/ea/${ea}.mq5`} download className="text-accent hover:underline">{ea}.mq5</a>, chép vào
          MT5 → File → Open Data Folder → <code>MQL5/Experts</code>, mở bằng MetaEditor và bấm F7 (biên dịch một lần).
        </li>
        <li>MT5 → Tools → Options → Expert Advisors: bật Algo Trading, thêm <code>https://{s.connection.split(".")[1]}.supabase.co</code> vào Allow WebRequest.</li>
        <li>
          Kéo {ea} vào một chart, dán mã vào ô <b>Mã kết nối</b>, hoặc bấm Load và chọn file{" "}
          <button type="button" onClick={() => downloadSet(`${ea}_${safeName(s.label ?? "")}.set`, s.connection!)} className="text-accent hover:underline">
            {ea}_{safeName(s.label ?? "")}.set
          </button>.
        </li>
        <li>Vài giây sau tài khoản chuyển sang Online ở bảng trên. Nếu sai, EA báo lỗi ngay trên MT5.</li>
      </ol>
      <details className="mt-2 text-xs text-muted">
        <summary className="cursor-pointer">Giá trị chi tiết (chỉ cần khi nhập tay ở mục Nâng cao)</summary>
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
    <form action={action} className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
      <label className="grid gap-1">Vai trò
        <select name="role" defaultValue="receiver" required>
          <option value="master">Master (Sender)</option>
          <option value="receiver">Receiver (Follower)</option>
        </select>
      </label>
      <label className="grid gap-1">Tên hiển thị<input name="label" required maxLength={60} placeholder="VD: Receiver Exness 01" /></label>
      <label className="grid gap-1">Broker<input name="broker" maxLength={60} placeholder="VD: Exness" /></label>
      <label className="grid gap-1">Server MT5<input name="server" required maxLength={80} placeholder="VD: Exness-MT5Real8" /></label>
      <label className="grid gap-1">Số tài khoản (login)<input name="login" required inputMode="numeric" pattern="[0-9]+" /></label>
      <div className="flex items-end">
        <button className={btn.primary} disabled={pending}>{pending ? "Đang tạo…" : "Tạo và cấp token EA"}</button>
      </div>
      <p className="text-xs text-muted sm:col-span-2 lg:col-span-3">
        Không cần mật khẩu MT5: EA chạy trong terminal đã đăng nhập và chỉ dùng token để gọi máy chủ.
      </p>
      <div className="sm:col-span-2 lg:col-span-3"><Issued s={state} /></div>
    </form>
  );
}

export function RotateTokenForm({ id, label, role }: { id: string; label: string; role: string }) {
  const [state, action, pending] = useActionState(rotateToken, {});
  return (
    <form action={action} onSubmit={(e) => { if (!confirm(`Cấp token mới cho "${label}"? EA đang chạy với token cũ sẽ mất kết nối.`)) e.preventDefault(); }}>
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="label" value={label} />
      <input type="hidden" name="role" value={role} />
      <button className="text-xs text-accent hover:underline" disabled={pending}>Cấp lại token</button>
      <Issued s={state} />
    </form>
  );
}
