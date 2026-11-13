"use server";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";

const safeNext = (v: FormDataEntryValue | null) => {
  const s = typeof v === "string" ? v : "";
  return s.startsWith("/") && !s.startsWith("//") ? s : "/dashboard";
};

const back = (key: "error" | "info", msg: string, next: string, email = "") =>
  redirect(`/login?${key}=${encodeURIComponent(msg)}&next=${encodeURIComponent(next)}${email ? `&email=${encodeURIComponent(email)}` : ""}`);

const callbackUrl = async (next: string) => {
  const origin = (await headers()).get("origin") ?? "";
  return `${origin}/auth/callback?next=${encodeURIComponent(next)}`;
};

export async function signIn(form: FormData) {
  const next = safeNext(form.get("next"));
  const email = String(form.get("email") ?? "").trim();
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password: String(form.get("password") ?? "") });
  if (error) {
    if (error.code === "email_not_confirmed") {
      // send the confirmation link again, to this site, rather than leave the user stuck
      await supabase.auth.resend({ type: "signup", email, options: { emailRedirectTo: await callbackUrl(next) } });
      back("info", "Email chưa được xác nhận. Đã gửi lại email xác nhận: mở email và bấm vào liên kết, rồi đăng nhập.", next, email);
    }
    if (error.code === "invalid_credentials") {
      back("error", "Email hoặc mật khẩu không đúng. Chưa có tài khoản thì nhập email, mật khẩu rồi bấm Đăng ký.", next, email);
    }
    if (error.status === 429) back("error", "Thử quá nhiều lần. Đợi vài phút rồi thử lại.", next, email);
    back("error", `Không đăng nhập được: ${error.message}`, next, email);
  }
  redirect(next);
}

export async function signUp(form: FormData) {
  const next = safeNext(form.get("next"));
  const email = String(form.get("email") ?? "").trim();
  const password = String(form.get("password") ?? "");
  if (password.length < 10) back("error", "Mật khẩu cần ít nhất 10 ký tự.", next, email);
  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { emailRedirectTo: await callbackUrl(next) },
  });
  if (error) {
    if (error.status === 429) back("error", "Gửi email quá nhiều lần. Đợi khoảng 1 giờ rồi thử lại.", next, email);
    back("error", `Không đăng ký được: ${error.message}`, next, email);
  }
  // With email confirmation on, an already registered address returns a user with no identities.
  if (data.user && data.user.identities?.length === 0) {
    back("error", "Email này đã đăng ký. Hãy đăng nhập; nếu chưa xác nhận email, bấm Đăng nhập để được gửi lại email xác nhận.", next, email);
  }
  if (data.session) redirect(next); // confirmation turned off: already signed in
  back("info", "Đã gửi email xác nhận tới " + email + ". Mở email, bấm vào liên kết, sau đó đăng nhập.", next, email);
}
