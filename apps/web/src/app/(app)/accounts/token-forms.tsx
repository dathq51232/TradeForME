"use client";
import { useActionState } from "react";
import { addAccount, rotateToken, type IssuedToken } from "./actions";
import { btn } from "@/components/ui";

function Issued({ s }: { s: IssuedToken }) {
  if (s.error) return <p className="mt-3 text-sm text-down">{s.error}</p>;
  if (!s.token) return null;
  return (
    <div className="mt-4 rounded-md border border-warn/50 bg-warn/10 p-3 text-sm">
      <p className="font-medium text-warn">Chép ngay vào EA của “{s.label}”: hai giá trị này chỉ hiện một lần.</p>
      <dl className="mt-2 grid gap-1 font-mono text-xs">
        <dt className="text-muted">Account ID</dt><dd className="select-all break-all">{s.accountId}</dd>
        <dt className="text-muted">EA token</dt><dd className="select-all break-all">{s.token}</dd>
        <dt className="text-muted">HMAC secret</dt><dd className="select-all break-all">{s.secret}</dd>
      </dl>
      <p className="mt-2 text-xs text-muted">Hệ thống chỉ lưu bản băm của token. Mất token thì bấm “Cấp lại token”; token cũ ngừng hoạt động ngay.</p>
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

export function RotateTokenForm({ id, label }: { id: string; label: string }) {
  const [state, action, pending] = useActionState(rotateToken, {});
  return (
    <form action={action} onSubmit={(e) => { if (!confirm(`Cấp token mới cho "${label}"? EA đang chạy với token cũ sẽ mất kết nối.`)) e.preventDefault(); }}>
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="label" value={label} />
      <button className="text-xs text-accent hover:underline" disabled={pending}>Cấp lại token</button>
      <Issued s={state} />
    </form>
  );
}
