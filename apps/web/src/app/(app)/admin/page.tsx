import { Suspense } from "react";
import { requestTime, requireUser } from "@/lib/auth";
import { Notice, PageHeader } from "@/components/ui";
import { AdminView, type AuditRow, type UserRow } from "./admin-view";

// User management for admins (RPCs in supabase/migrations/*_admin_users.sql, which check the caller is an admin).
export default function AdminPage(props: PageProps<"/admin">) {
  return (
    <Suspense fallback={<p className="text-sm text-muted">Đang tải…</p>}>
      <Admin searchParams={props.searchParams} />
    </Suspense>
  );
}

async function Admin({ searchParams }: { searchParams: PageProps<"/admin">["searchParams"] }) {
  const { supabase, userId } = await requireUser("/admin");
  const sp = await searchParams;
  const { data, error } = await supabase.rpc("admin_list_users");
  if (error) {
    return (
      <>
        <PageHeader title="Quản lý người dùng" />
        <Notice tone="down">{error.message.includes("Chỉ admin") ? "Trang này chỉ dành cho admin." : error.message}</Notice>
      </>
    );
  }
  const { data: log } = await supabase.from("audit_log").select("id, actor, action, target, detail, at")
    .like("action", "admin.%").order("at", { ascending: false }).limit(15);
  return (
    <AdminView all={(data ?? []) as UserRow[]} q={String(sp.q ?? "").trim().toLowerCase()} userId={userId}
      log={(log ?? []) as AuditRow[]} now={requestTime()}
      msg={sp.msg ? String(sp.msg) : undefined} error={sp.error ? String(sp.error) : undefined} />
  );
}
