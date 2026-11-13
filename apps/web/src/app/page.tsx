import Link from "next/link";

const MODULES = [
  { title: "Biểu đồ", body: "87 chỉ báo, 13 công cụ vẽ, nhiều khung thời gian, layout lưu theo tài khoản.", status: "Giai đoạn 1" },
  { title: "Tin tức tác động", body: "Tổng hợp tin và lịch kinh tế, chấm điểm tác động lên Vàng, BTC, Dầu.", status: "Giai đoạn 2" },
  { title: "Copy trade MT5", body: "Sao chép lệnh từ 1 tài khoản master sang nhiều receiver, có giới hạn rủi ro.", status: "Giai đoạn 3" },
];

export default function Home() {
  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">Quant Terminal Cloud</h1>
      <p className="mt-3 max-w-2xl text-muted">
        Nền tảng biểu đồ, tin tức tác động và quản lý copy trade MT5, chạy trên Supabase và Vercel.
      </p>
      <div className="mt-6 flex gap-3">
        <Link href="/login" className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white">
          Đăng nhập
        </Link>
        <Link href="/dashboard" className="rounded-md border border-border px-4 py-2 text-sm font-medium">
          Bảng điều khiển
        </Link>
      </div>
      <section className="mt-12 grid gap-4 sm:grid-cols-3">
        {MODULES.map((m) => (
          <article key={m.title} className="rounded-lg border border-border bg-card p-5">
            <div className="text-xs uppercase tracking-wide text-muted">{m.status}</div>
            <h2 className="mt-1 font-medium">{m.title}</h2>
            <p className="mt-2 text-sm text-muted">{m.body}</p>
          </article>
        ))}
      </section>
      <p className="mt-12 text-xs text-muted">
        Phân tích tự động, không phải khuyến nghị đầu tư. Biểu đồ dùng Lightweight Charts™ của TradingView (Apache 2.0).
      </p>
    </main>
  );
}
