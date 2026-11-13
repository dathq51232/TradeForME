import { Suspense } from "react";
import { AuthForm, type AuthMode } from "./auth-form";

export default function LoginPage({ searchParams }: PageProps<"/login">) {
  return (
    <main className="grid min-h-screen flex-1 lg:grid-cols-[1.1fr_1fr]">
      <Hero />
      <section className="flex items-center justify-center px-4 py-12 sm:px-6">
        <Suspense fallback={null}>
          <LoginForm searchParams={searchParams} />
        </Suspense>
      </section>
    </main>
  );
}

async function LoginForm({ searchParams }: { searchParams: PageProps<"/login">["searchParams"] }) {
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const error = one(sp.error);
  const info = one(sp.info);
  const next = one(sp.next) ?? "/dashboard";
  const email = one(sp.email) ?? "";
  const mode: AuthMode = one(sp.mode) === "register" ? "register" : "login";
  // key: reset the client form state each time the server redirects back with a new message
  return (
    <AuthForm
      key={`${mode}|${error ?? ""}|${info ?? ""}`}
      initialMode={mode}
      error={error}
      info={info}
      next={next}
      email={email}
    />
  );
}

/* ---------- Left panel: brand + features (hidden on small screens) ---------- */

const FEATURES = [
  { title: "Biểu đồ realtime", text: "Nến, chỉ báo và terminal ngay trên trình duyệt." },
  { title: "Tin tức tác động", text: "Theo dõi tin ảnh hưởng tới Vàng, BTC và Dầu." },
  { title: "Copy trade MT5", text: "Quản lý tài khoản master / receiver và theo dõi trạng thái khớp lệnh." },
];

function Hero() {
  return (
    <aside className="relative hidden overflow-hidden border-r border-border lg:flex lg:flex-col lg:justify-between lg:p-12">
      {/* glow */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(900px 500px at 10% 0%, color-mix(in oklab, var(--up) 16%, transparent), transparent 60%), radial-gradient(800px 500px at 100% 100%, color-mix(in oklab, var(--accent) 16%, transparent), transparent 60%)",
        }}
      />
      {/* grid + animated chart */}
      <svg aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-2/3 w-full opacity-60" viewBox="0 0 800 400" preserveAspectRatio="none">
        <defs>
          <linearGradient id="qt-fill-up" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="var(--up)" stopOpacity="0.25" />
            <stop offset="1" stopColor="var(--up)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[80, 160, 240, 320].map((y) => (
          <line key={y} x1="0" x2="800" y1={y} y2={y} stroke="var(--border)" strokeOpacity="0.5" />
        ))}
        <path
          d="M0 300 L60 285 L120 295 L180 250 L240 262 L300 215 L360 230 L420 180 L480 196 L540 140 L600 160 L660 110 L720 125 L800 70 L800 400 L0 400 Z"
          fill="url(#qt-fill-up)"
          className="qt-fade"
        />
        <path
          d="M0 300 L60 285 L120 295 L180 250 L240 262 L300 215 L360 230 L420 180 L480 196 L540 140 L600 160 L660 110 L720 125 L800 70"
          fill="none"
          stroke="var(--up)"
          strokeWidth="2.5"
          className="qt-draw"
        />
        <path
          d="M0 330 L80 320 L160 335 L240 300 L320 310 L400 280 L480 290 L560 250 L640 262 L720 225 L800 210"
          fill="none"
          stroke="var(--accent)"
          strokeWidth="2"
          strokeOpacity="0.7"
          className="qt-draw qt-delay"
        />
      </svg>

      <div className="relative flex items-center gap-3">
        <Logo />
        <span className="text-xl font-bold tracking-tight">
          Quant Terminal <span className="text-up">Cloud</span>
        </span>
      </div>

      <div className="relative max-w-lg">
        <h2 className="text-4xl font-bold leading-tight tracking-tight">
          Phân tích thị trường và{" "}
          <span className="bg-gradient-to-r from-up to-accent bg-clip-text text-transparent">copy trade MT5</span>{" "}
          trong một màn hình.
        </h2>
        <ul className="mt-8 space-y-4">
          {FEATURES.map((f) => (
            <li key={f.title} className="flex gap-3">
              <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-up/15 text-up">
                <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
              </span>
              <div>
                <div className="font-medium">{f.title}</div>
                <div className="text-sm text-muted">{f.text}</div>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <p className="relative text-xs text-muted">Giao dịch có rủi ro. Hiệu suất quá khứ không đảm bảo kết quả tương lai.</p>
    </aside>
  );
}

function Logo({ className = "size-10" }: { className?: string }) {
  return (
    <span className={`grid place-items-center rounded-xl bg-gradient-to-br from-up to-accent shadow-lg shadow-up/30 ${className}`}>
      <svg viewBox="0 0 24 24" className="size-1/2" fill="none" stroke="#04130a" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="3 17 9 11 13 15 21 7" />
        <polyline points="15 7 21 7 21 13" />
      </svg>
    </span>
  );
}
