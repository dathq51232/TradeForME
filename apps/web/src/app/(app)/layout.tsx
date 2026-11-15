import { Suspense, type ReactNode } from "react";
import Link from "next/link";
import { Sidebar, SidebarNav } from "@/components/sidebar";
import { Badge } from "@/components/ui";
import { createClient } from "@/lib/supabase/server";
import { requestTime } from "@/lib/auth";
import { connection } from "@/lib/format";
import { NotificationsBell } from "@/components/notifications";
import { PanelToggle } from "@/components/panel-toggle";

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <aside className="border-b border-border bg-panel transition-[width] md:flex md:w-14 md:flex-col md:border-b-0 md:border-r lg:w-56 nav-collapsed:lg:w-14">
        <Link href="/dashboard" className="hidden items-center gap-2 px-4 py-3.5 md:flex">
          <span className="grid h-6 w-6 place-items-center rounded bg-accent text-xs font-bold text-white">Q</span>
          <span className="hidden text-sm font-semibold lg:inline nav-collapsed:lg:hidden">Quant Terminal</span>
        </Link>
        <Suspense fallback={<SidebarNav path="" />}>
          <Sidebar />
        </Suspense>
        {/* only wide screens have a full sidebar to collapse; tablets already show icons only */}
        <PanelToggle panel="nav" title="Thu gọn / mở rộng menu"
          className="mx-2 mb-3 mt-auto hidden items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm text-muted hover:bg-panel-2 hover:text-foreground lg:flex">
          <span aria-hidden className="w-4 text-center nav-collapsed:hidden">«</span>
          <span aria-hidden className="w-4 text-center nav-expanded:hidden">»</span>
          <span className="nav-collapsed:hidden">Thu gọn menu</span>
        </PanelToggle>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 items-center justify-end gap-3 border-b border-border px-4">
          <Suspense fallback={<span className="text-xs text-muted">…</span>}>
            <TopBar />
          </Suspense>
        </header>
        <main className="min-w-0 flex-1 p-4 lg:p-6">{children}</main>
        <footer className="px-6 pb-4 text-xs text-muted">Không phải khuyến nghị đầu tư.</footer>
      </div>
    </div>
  );
}

async function TopBar() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const userId = data?.claims?.sub;
  if (!userId) return null;
  const [{ data: profile }, { data: accounts }, { count: unread }] = await Promise.all([
    supabase.from("profiles").select("full_name, role, telegram_chat_id").eq("id", userId).maybeSingle(),
    supabase.from("mt5_accounts").select("status, last_heartbeat_at, disabled, terminal_connected, trade_allowed"),
    supabase.from("notifications").select("id", { count: "exact", head: true }).is("read_at", null),
  ]);
  const now = requestTime();
  const online = (accounts ?? []).filter((a) => connection(a, now).online).length;
  const total = accounts?.length ?? 0;
  return (
    <>
      <Badge tone={total === 0 ? "muted" : online === total ? "up" : online === 0 ? "down" : "warn"}>
        MT5 {online}/{total} online
      </Badge>
      <NotificationsBell unread={unread ?? 0} telegram={profile?.telegram_chat_id ?? null} />
      <span className="text-sm">{profile?.full_name ?? "bạn"}</span>
      {profile?.role === "admin" ? (
        <Link href="/admin" title="Quản lý người dùng" className="rounded border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-xs text-accent hover:bg-accent/20">
          ⚙ Quản trị
        </Link>
      ) : profile?.role && profile.role !== "user" && <Badge tone="accent">{profile.role}</Badge>}
      <form action="/auth/signout" method="post">
        <button className="text-xs text-muted hover:text-foreground">Đăng xuất</button>
      </form>
    </>
  );
}
