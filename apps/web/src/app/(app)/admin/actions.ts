"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser, withMsg } from "@/lib/auth";

// User management (RPCs in supabase/migrations/*_admin_users.sql). The database checks that the caller is an admin
// and refuses self-demotion, self-lock and self-delete; these only pass the form along and report back.
const back = (form: FormData) => {
  const q = String(form.get("q") ?? "").trim();
  return q ? `/admin?q=${encodeURIComponent(q)}` : "/admin";
};
const done = (form: FormData, error: { message: string } | null, ok: string) => {
  revalidatePath("/admin");
  redirect(withMsg(back(form), error ? "error" : "msg", error ? error.message : ok));
};

export async function setRole(form: FormData) {
  const { supabase } = await requireUser("/admin");
  const role = String(form.get("role"));
  const { error } = await supabase.rpc("admin_set_role", { p_user: String(form.get("user")), p_role: role });
  done(form, error, `Đã đổi quyền thành ${role}.`);
}

export async function setLocked(form: FormData) {
  const { supabase } = await requireUser("/admin");
  const locked = form.get("locked") === "1";
  const { error } = await supabase.rpc("admin_set_locked", { p_user: String(form.get("user")), p_locked: locked });
  done(form, error, locked
    ? "Đã khoá: người này không đăng nhập được nữa (phiên đang mở hết hạn trong tối đa 1 giờ)."
    : "Đã mở khoá: người này đăng nhập lại được.");
}

export async function deleteUser(form: FormData) {
  const { supabase } = await requireUser("/admin");
  const { error } = await supabase.rpc("admin_delete_user", { p_user: String(form.get("user")), p_confirm_email: String(form.get("confirm") ?? "") });
  done(form, error, "Đã xoá tài khoản và toàn bộ dữ liệu của người này.");
}
