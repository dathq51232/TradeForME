"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

// Design §3.1. Items without a page yet are listed, marked "sắp có", and not clickable.
const NAV: { href: string; label: string; icon: string; soon?: string }[] = [
  { href: "/dashboard", label: "Dashboard", icon: "▦" },
  { href: "/charts", label: "Biểu đồ", icon: "◩" },
  { href: "/accounts", label: "Tài khoản MT5", icon: "▤" },
  { href: "/copy", label: "Copy Trading", icon: "⇉" },
  { href: "/positions", label: "Vị thế", icon: "≡", soon: "sắp có" },
  { href: "/history", label: "Lệnh & lịch sử", icon: "☰", soon: "sắp có" },
  { href: "/risk", label: "Quản lý rủi ro", icon: "△", soon: "sắp có" },
  { href: "/analytics", label: "Phân tích", icon: "∿", soon: "sắp có" },
  { href: "/logs", label: "Nhật ký", icon: "⋮", soon: "sắp có" },
  { href: "/settings", label: "Cài đặt", icon: "⚙", soon: "sắp có" },
];

/** Active-link state needs the URL, so it renders inside Suspense; the fallback is the same nav unhighlighted. */
export function Sidebar() {
  return <SidebarNav path={usePathname()} />;
}

export function SidebarNav({ path }: { path: string }) {
  return (
    <nav className="flex gap-1 overflow-x-auto p-2 md:flex-col md:overflow-visible">
      {NAV.map((n) => {
        const active = path === n.href || path.startsWith(n.href + "/");
        const base = "flex shrink-0 items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm";
        if (n.soon) {
          return (
            <span key={n.href} className={`${base} cursor-not-allowed text-muted/60`} title="Chưa có">
              <span aria-hidden className="w-4 text-center">{n.icon}</span>
              <span className="hidden lg:inline">{n.label}</span>
              <span className="ml-auto hidden rounded bg-panel-2 px-1 text-[0.65rem] lg:inline">{n.soon}</span>
            </span>
          );
        }
        return (
          <Link key={n.href} href={n.href} aria-current={active ? "page" : undefined}
            className={`${base} ${active ? "bg-accent/15 text-foreground" : "text-muted hover:bg-panel-2 hover:text-foreground"}`}>
            <span aria-hidden className="w-4 text-center">{n.icon}</span>
            <span className="md:hidden lg:inline">{n.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
