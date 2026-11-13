"use server";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";

const safeNext = (v: FormDataEntryValue | null) => {
  const s = typeof v === "string" ? v : "";
  return s.startsWith("/") && !s.startsWith("//") ? s : "/dashboard";
};

const back = (msg: string, next: string) =>
  redirect(`/login?error=${encodeURIComponent(msg)}&next=${encodeURIComponent(next)}`);

export async function signIn(form: FormData) {
  const next = safeNext(form.get("next"));
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({
    email: String(form.get("email") ?? ""),
    password: String(form.get("password") ?? ""),
  });
  if (error) back("Email hoặc mật khẩu không đúng.", next);
  redirect(next);
}

export async function signUp(form: FormData) {
  const next = safeNext(form.get("next"));
  const password = String(form.get("password") ?? "");
  if (password.length < 10) back("Mật khẩu cần ít nhất 10 ký tự.", next);
  const origin = (await headers()).get("origin") ?? "";
  const supabase = await createClient();
  const { error } = await supabase.auth.signUp({
    email: String(form.get("email") ?? ""),
    password,
    options: { emailRedirectTo: `${origin}/auth/callback?next=${encodeURIComponent(next)}` },
  });
  if (error) back(error.message, next);
  redirect(`/login?info=${encodeURIComponent("Đã gửi email xác nhận. Mở email để kích hoạt tài khoản.")}`);
}
