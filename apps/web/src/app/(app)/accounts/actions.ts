"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser, withMsg } from "@/lib/auth";

export type IssuedToken = {
  error?: string; accountId?: string; token?: string; secret?: string; label?: string;
  role?: "master" | "receiver";
  /** "QT1.<project-ref>.<token>.<secret>": the one value pasted into the EA. */
  connection?: string;
};

/** Project ref from NEXT_PUBLIC_SUPABASE_URL (https://<ref>.supabase.co). */
function connectionCode(token: string, secret: string) {
  const host = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://unknown.supabase.co").hostname;
  return `QT1.${host.split(".")[0]}.${token}.${secret}`;
}

/** Registers an MT5 account and returns the EA token + HMAC secret once. No MT5 password is asked for. */
export async function addAccount(_prev: IssuedToken, form: FormData): Promise<IssuedToken> {
  const { supabase } = await requireUser("/accounts");
  const role = String(form.get("role"));
  const label = String(form.get("label") ?? "").trim();
  const server = String(form.get("server") ?? "").trim();
  const broker = String(form.get("broker") ?? "").trim() || null;
  const login = Number(form.get("login"));
  if (!["master", "receiver"].includes(role)) return { error: "Chọn vai trò Master hoặc Receiver." };
  if (!label || !server) return { error: "Cần tên hiển thị và server MT5." };
  if (!Number.isSafeInteger(login) || login <= 0) return { error: "Số tài khoản (login) phải là số nguyên dương." };

  const { data, error } = await supabase.rpc("create_mt5_account", {
    p_role: role, p_label: label, p_server: server, p_login: login, p_broker: broker,
  }).single<{ account_id: string; ea_token: string; hmac_secret: string }>();
  if (error) {
    return { error: error.code === "23505" ? "Tài khoản này (server + login) đã được đăng ký." : error.message };
  }
  revalidatePath("/accounts");
  return {
    accountId: data.account_id, token: data.ea_token, secret: data.hmac_secret, label,
    role: role as "master" | "receiver", connection: connectionCode(data.ea_token, data.hmac_secret),
  };
}

export async function rotateToken(_prev: IssuedToken, form: FormData): Promise<IssuedToken> {
  const { supabase } = await requireUser("/accounts");
  const id = String(form.get("id"));
  const { data, error } = await supabase.rpc("rotate_mt5_token", { p_account: id })
    .single<{ ea_token: string; hmac_secret: string }>();
  if (error) return { error: error.message };
  return {
    accountId: id, token: data.ea_token, secret: data.hmac_secret, label: String(form.get("label") ?? ""),
    role: form.get("role") === "master" ? "master" : "receiver", connection: connectionCode(data.ea_token, data.hmac_secret),
  };
}

export async function setDisabled(form: FormData) {
  const { supabase } = await requireUser("/accounts");
  const disabled = form.get("disabled") === "true";
  const { error } = await supabase.from("mt5_accounts").update({ disabled }).eq("id", String(form.get("id")));
  revalidatePath("/accounts");
  redirect(error ? withMsg("/accounts", "error", error.message)
    : withMsg("/accounts", "msg", disabled ? "Đã tắt tài khoản. EA sẽ không nhận lệnh mới." : "Đã bật lại tài khoản."));
}

export async function deleteAccount(form: FormData) {
  const { supabase } = await requireUser("/accounts");
  const label = String(form.get("label") ?? "");
  if (String(form.get("confirm") ?? "") !== label) {
    redirect(withMsg("/accounts", "error", `Gõ đúng tên "${label}" để xoá.`));
  }
  const { error } = await supabase.from("mt5_accounts").delete().eq("id", String(form.get("id")));
  revalidatePath("/accounts");
  redirect(error ? withMsg("/accounts", "error", error.message) : withMsg("/accounts", "msg", `Đã xoá ${label}.`));
}
