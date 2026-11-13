"use client";
import { useState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { signIn, signUp } from "./actions";

export type AuthMode = "login" | "register";

const COPY: Record<AuthMode, { title: string; sub: string }> = {
  login: { title: "Chào mừng trở lại", sub: "Đăng nhập để tiếp tục với biểu đồ và tài khoản copy trade." },
  register: { title: "Tạo tài khoản mới", sub: "Đăng ký bằng email, sau đó xác nhận qua liên kết trong hộp thư." },
};

const MIN_SIGNUP = 10; // must match signUp() in actions.ts

export function AuthForm({ initialMode, error, info, next, email }: {
  initialMode: AuthMode; error?: string; info?: string; next: string; email: string;
}) {
  const [mode, setMode] = useState<AuthMode>(initialMode);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showMsg, setShowMsg] = useState(true);
  const isReg = mode === "register";
  const mismatch = isReg && confirm.length > 0 && confirm !== password;
  const tooShort = isReg && password.length > 0 && password.length < MIN_SIGNUP;

  const switchTo = (m: AuthMode) => {
    setMode(m);
    setShowMsg(false); // a server message belongs to the tab it came from
    setPassword("");
    setConfirm("");
  };

  return (
    <div className="qt-rise w-full max-w-md rounded-2xl border border-border bg-panel/80 p-7 shadow-2xl shadow-black/40 backdrop-blur sm:p-8">
      {/* mobile brand */}
      <div className="mb-6 flex items-center gap-2.5 lg:hidden">
        <span className="grid size-9 place-items-center rounded-lg bg-gradient-to-br from-up to-accent">
          <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="#04130a" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 17 9 11 13 15 21 7" /><polyline points="15 7 21 7 21 13" /></svg>
        </span>
        <span className="font-bold">Quant Terminal <span className="text-up">Cloud</span></span>
      </div>

      {/* tabs */}
      <div role="tablist" className="relative mb-7 grid grid-cols-2 rounded-xl border border-border bg-background p-1">
        <span
          aria-hidden
          className={`absolute inset-y-1 left-1 w-[calc(50%-0.25rem)] rounded-lg bg-gradient-to-br from-up to-[#00a676] shadow-md shadow-up/30 transition-transform duration-300 ease-out ${isReg ? "translate-x-full" : ""}`}
        />
        {(["login", "register"] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            onClick={() => switchTo(m)}
            className={`relative z-10 rounded-lg py-2 text-sm font-semibold transition-colors ${mode === m ? "text-[#04130a]" : "text-muted hover:text-foreground"}`}
          >
            {m === "login" ? "Đăng nhập" : "Đăng ký"}
          </button>
        ))}
      </div>

      <h1 className="text-2xl font-bold tracking-tight">{COPY[mode].title}</h1>
      <p className="mt-1.5 text-sm text-muted">{COPY[mode].sub}</p>

      <form action={isReg ? signUp : signIn} className="mt-6 space-y-4">
        {showMsg && error && <Alert tone="down">{error}</Alert>}
        {showMsg && info && <Alert tone="up">{info}</Alert>}

        <input type="hidden" name="next" value={next} />
        <input type="hidden" name="mode" value={mode} />

        <Field label="Email" icon={<MailIcon />}>
          <input
            name="email"
            type="email"
            required
            autoComplete="email"
            defaultValue={email}
            placeholder="ban@email.com"
            className={inputCls}
          />
        </Field>

        <Field
          label="Mật khẩu"
          icon={<LockIcon />}
          hint={tooShort ? `Cần ít nhất ${MIN_SIGNUP} ký tự` : undefined}
        >
          <PasswordInput
            name="password"
            value={password}
            onChange={setPassword}
            autoComplete={isReg ? "new-password" : "current-password"}
            minLength={isReg ? MIN_SIGNUP : 6}
            placeholder={isReg ? `Tối thiểu ${MIN_SIGNUP} ký tự` : "••••••••"}
            invalid={tooShort}
          />
        </Field>
        {isReg && <Strength value={password} />}

        {isReg && (
          <Field label="Xác nhận mật khẩu" icon={<CheckIcon />} hint={mismatch ? "Mật khẩu xác nhận không khớp" : undefined}>
            <PasswordInput
              name="confirm"
              value={confirm}
              onChange={setConfirm}
              autoComplete="new-password"
              placeholder="Nhập lại mật khẩu"
              invalid={mismatch}
            />
          </Field>
        )}

        {isReg && (
          <label className="flex cursor-pointer items-start gap-2.5 text-sm text-muted">
            <input type="checkbox" name="terms" required className="mt-0.5 size-4 accent-[var(--up)]" />
            <span>Tôi hiểu giao dịch có rủi ro và đồng ý với điều khoản sử dụng.</span>
          </label>
        )}

        <Submit disabled={isReg && (tooShort || mismatch)}>{isReg ? "Tạo tài khoản" : "Đăng nhập"}</Submit>

        <p className="text-center text-sm text-muted">
          {isReg ? "Đã có tài khoản? " : "Chưa có tài khoản? "}
          <button type="button" onClick={() => switchTo(isReg ? "login" : "register")} className="font-medium text-up hover:underline">
            {isReg ? "Đăng nhập" : "Đăng ký ngay"}
          </button>
        </p>
      </form>

      <p className="mt-6 flex items-center justify-center gap-1.5 text-xs text-muted">
        <ShieldIcon /> Xác thực bởi Supabase · mật khẩu được mã hoá
      </p>
    </div>
  );
}

/* ---------- pieces ---------- */

const inputCls =
  "w-full rounded-xl border border-border bg-background py-3 pl-11 pr-11 text-sm text-foreground placeholder:text-muted/60 transition focus:border-up focus:outline-none focus:ring-4 focus:ring-up/15";

function Field({ label, icon, hint, children }: { label: string; icon: ReactNode; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-foreground/85">{label}</span>
      <span className="relative block text-muted focus-within:text-up">
        <span aria-hidden className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2">{icon}</span>
        {children}
      </span>
      {hint && <span role="alert" className="mt-1.5 block text-xs text-down">{hint}</span>}
    </label>
  );
}

function PasswordInput({ name, value, onChange, autoComplete, minLength, placeholder, invalid }: {
  name: string; value: string; onChange: (v: string) => void; autoComplete: string;
  minLength?: number; placeholder?: string; invalid?: boolean;
}) {
  const [show, setShow] = useState(false);
  return (
    <>
      <input
        name={name}
        type={show ? "text" : "password"}
        required
        minLength={minLength}
        autoComplete={autoComplete}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={invalid || undefined}
        className={`${inputCls} ${invalid ? "border-down focus:border-down focus:ring-down/15" : ""}`}
      />
      <button
        type="button"
        onClick={() => setShow((s) => !s)}
        aria-label={show ? "Ẩn mật khẩu" : "Hiện mật khẩu"}
        className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-muted hover:bg-panel-2 hover:text-foreground"
      >
        {show ? <EyeOffIcon /> : <EyeIcon />}
      </button>
    </>
  );
}

const LEVELS = [
  { color: "var(--down)", label: "Yếu" },
  { color: "var(--warn)", label: "Trung bình" },
  { color: "var(--accent)", label: "Khá" },
  { color: "var(--up)", label: "Mạnh" },
];

function Strength({ value }: { value: string }) {
  let score = 0;
  if (value.length >= MIN_SIGNUP) score++;
  if (/[a-z]/.test(value) && /[A-Z]/.test(value)) score++;
  if (/\d/.test(value)) score++;
  if (/[^A-Za-z0-9]/.test(value) || value.length >= 14) score++;
  const level = LEVELS[Math.max(score - 1, 0)];
  return (
    <div className="-mt-1">
      <div className="flex gap-1.5">
        {LEVELS.map((_, i) => (
          <span
            key={i}
            className="h-1 flex-1 rounded-full bg-panel-2 transition-colors duration-300"
            style={value && i < score ? { background: level.color } : undefined}
          />
        ))}
      </div>
      <p className="mt-1.5 text-xs" style={{ color: value ? level.color : "var(--muted)" }}>
        {value ? `Độ mạnh: ${level.label}` : "Nên dùng chữ hoa, chữ thường, số và ký tự đặc biệt"}
      </p>
    </div>
  );
}

function Submit({ children, disabled }: { children: ReactNode; disabled?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending || disabled}
      className="relative w-full rounded-xl bg-gradient-to-br from-up to-[#00a676] py-3 text-sm font-bold text-[#04130a] shadow-lg shadow-up/25 transition hover:-translate-y-px hover:shadow-up/40 hover:brightness-105 active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0"
    >
      <span className={pending ? "invisible" : ""}>{children}</span>
      {pending && (
        <span aria-label="Đang xử lý" className="absolute inset-0 m-auto size-5 animate-spin rounded-full border-[2.5px] border-[#04130a]/30 border-t-[#04130a]" />
      )}
    </button>
  );
}

function Alert({ tone, children }: { tone: "up" | "down"; children: ReactNode }) {
  const cls = tone === "down" ? "border-down/40 bg-down/10 text-down" : "border-up/40 bg-up/10 text-up";
  return (
    <p role={tone === "down" ? "alert" : "status"} className={`flex gap-2 rounded-xl border px-3.5 py-2.5 text-sm ${cls}`}>
      <span aria-hidden>{tone === "down" ? "■" : "●"}</span>
      <span>{children}</span>
    </p>
  );
}

/* ---------- icons ---------- */

const ico = { viewBox: "0 0 24 24", className: "size-[18px]", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
const MailIcon = () => <svg {...ico}><rect x="2" y="4" width="20" height="16" rx="2" /><path d="m22 7-10 6L2 7" /></svg>;
const LockIcon = () => <svg {...ico}><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>;
const CheckIcon = () => <svg {...ico}><path d="M20 6 9 17l-5-5" /></svg>;
const EyeIcon = () => <svg {...ico}><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></svg>;
const EyeOffIcon = () => <svg {...ico}><path d="M17.9 17.9A10.1 10.1 0 0 1 12 20C5 20 1 12 1 12a18.5 18.5 0 0 1 5.1-5.9M9.9 4.2A9.1 9.1 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.2 3.2M1 1l22 22" /></svg>;
const ShieldIcon = () => <svg {...ico} className="size-3.5 text-up"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>;
