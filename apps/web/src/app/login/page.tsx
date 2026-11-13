import { Suspense } from "react";
import { signIn, signUp } from "./actions";

export default function LoginPage({ searchParams }: PageProps<"/login">) {
  return (
    <main className="mx-auto w-full max-w-sm px-4 py-16">
      <h1 className="text-2xl font-semibold">Đăng nhập</h1>
      <Suspense fallback={null}>
        <LoginForm searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

async function LoginForm({ searchParams }: { searchParams: PageProps<"/login">["searchParams"] }) {
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const error = one(sp.error);
  const info = one(sp.info);
  const next = one(sp.next) ?? "/dashboard";
  const input = "w-full rounded-md border border-border bg-card px-3 py-2 text-sm";
  return (
    <form className="mt-6 space-y-3">
      {error && <p role="alert" className="rounded-md border border-down/40 p-2 text-sm text-down">{error}</p>}
      {info && <p className="rounded-md border border-up/40 p-2 text-sm text-up">{info}</p>}
      <input type="hidden" name="next" value={next} />
      <label className="block text-sm">
        Email
        <input name="email" type="email" required autoComplete="email" className={`mt-1 ${input}`} />
      </label>
      <label className="block text-sm">
        Mật khẩu
        <input name="password" type="password" required minLength={6} autoComplete="current-password" className={`mt-1 ${input}`} />
      </label>
      <div className="flex gap-2 pt-2">
        <button formAction={signIn} className="flex-1 rounded-md bg-accent px-4 py-2 text-sm font-medium text-white">
          Đăng nhập
        </button>
        <button formAction={signUp} className="flex-1 rounded-md border border-border px-4 py-2 text-sm font-medium">
          Đăng ký
        </button>
      </div>
    </form>
  );
}
