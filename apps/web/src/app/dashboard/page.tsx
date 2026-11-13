import { Suspense } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export default function DashboardPage() {
  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-10">
      <Suspense fallback={<p className="text-sm text-muted">Đang tải…</p>}>
        <Dashboard />
      </Suspense>
    </main>
  );
}

async function Dashboard() {
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  const userId = claims?.claims?.sub;
  if (!userId) redirect("/login?next=/dashboard");

  const [{ data: profile }, { data: accounts }] = await Promise.all([
    supabase.from("profiles").select("full_name, role").eq("id", userId).maybeSingle(),
    supabase.from("mt5_accounts").select("id, role, label, status, equity").order("created_at"),
  ]);

  return (
    <>
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Xin chào, {profile?.full_name ?? "bạn"}</h1>
          <p className="text-sm text-muted">Vai trò: {profile?.role ?? "user"}</p>
        </div>
        <form action="/auth/signout" method="post">
          <button className="rounded-md border border-border px-3 py-1.5 text-sm">Đăng xuất</button>
        </form>
      </header>

      <section className="mt-8 grid gap-4 sm:grid-cols-3">
        <Card title="Biểu đồ" note="Giai đoạn 1" />
        <Card title="Tin tức tác động" note="Giai đoạn 2" />
        <Card title="Copy trade" note={`${accounts?.length ?? 0} tài khoản MT5`} />
      </section>

      <section className="mt-8 rounded-lg border border-border bg-card p-5">
        <h2 className="font-medium">Tài khoản MT5</h2>
        {accounts && accounts.length > 0 ? (
          <table className="mt-3 w-full text-sm">
            <thead className="text-left text-muted">
              <tr><th className="py-1">Tên</th><th>Vai trò</th><th>Trạng thái</th><th className="text-right">Equity</th></tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.id} className="border-t border-border">
                  <td className="py-1.5">{a.label}</td>
                  <td>{a.role}</td>
                  <td>{a.status}</td>
                  <td className="text-right font-mono">{a.equity ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="mt-2 text-sm text-muted">
            Chưa có tài khoản. Màn hình thêm tài khoản và cấp token EA nằm trong Giai đoạn 3.
          </p>
        )}
      </section>
      <p className="mt-6 text-sm"><Link href="/" className="text-accent">← Trang chủ</Link></p>
    </>
  );
}

function Card({ title, note }: { title: string; note: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <div className="font-medium">{title}</div>
      <div className="mt-1 text-sm text-muted">{note}</div>
    </div>
  );
}
