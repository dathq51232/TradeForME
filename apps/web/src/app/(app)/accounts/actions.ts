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

/**
 * Registers an MT5 account and returns the connection code once. Only role + name are asked: the EA
 * reports login, server and broker itself on its first heartbeat. No MT5 password is asked for.
 */
export async function addAccount(_prev: IssuedToken, form: FormData): Promise<IssuedToken> {
  const { supabase } = await requireUser("/accounts");
  const role = String(form.get("role"));
  const label = String(form.get("label") ?? "").trim();
  if (!["master", "receiver"].includes(role)) return { error: "Chọn vai trò Master hoặc Receiver." };
  if (!label) return { error: "Đặt tên cho tài khoản, VD: Receiver Exness 01." };

  const { data, error } = await supabase.rpc("create_mt5_account", {
    p_role: role, p_label: label, p_server: null, p_login: null, p_broker: null,
  }).single<{ account_id: string; ea_token: string; hmac_secret: string }>();
  if (error) return { error: error.message };
  revalidatePath("/accounts");
  return {
    accountId: data.account_id, token: data.ea_token, secret: data.hmac_secret, label,
    role: role as "master" | "receiver", connection: connectionCode(data.ea_token, data.hmac_secret),
  };
}

export type SetupStatus = {
  seen: boolean; login: number | null; server: string | null; broker: string | null; eaKind: string | null;
  eaVersion: string | null; selftest: string | null; tradeAllowed: boolean | null; online: boolean; lastError: string | null;
};

/** Live setup state for the connection checklist (polled by the dashboard while the EA is being set up). */
export async function setupStatus(id: string): Promise<SetupStatus | null> {
  const { supabase } = await requireUser("/accounts");
  const { data } = await supabase.from("mt5_accounts")
    .select("login, server, broker, ea_kind, ea_version, selftest, trade_allowed, last_heartbeat_at, first_seen_at, last_error")
    .eq("id", id).maybeSingle();
  if (!data) return null;
  const hb = data.last_heartbeat_at ? Date.parse(data.last_heartbeat_at) : 0;
  return {
    seen: data.first_seen_at != null, login: data.login, server: data.server, broker: data.broker, eaKind: data.ea_kind,
    eaVersion: data.ea_version, selftest: data.selftest, tradeAllowed: data.trade_allowed,
    online: hb > 0 && Date.now() - hb < 60_000, lastError: data.last_error,
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
