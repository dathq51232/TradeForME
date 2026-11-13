export type Tone = "up" | "down" | "warn" | "muted" | "accent";

export const num = (v: number | null | undefined, digits = 2) =>
  v == null ? "—" : Number(v).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** "12345678" -> "•••• 5678": the full login is not needed to operate an account. */
export const maskLogin = (login: number | string) => {
  const s = String(login);
  return s.length <= 4 ? s : "•••• " + s.slice(-4);
};

export const ago = (iso: string | null, now: number) => {
  if (!iso) return "chưa có";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s} giây trước`;
  if (s < 3600) return `${Math.round(s / 60)} phút trước`;
  if (s < 86400) return `${Math.round(s / 3600)} giờ trước`;
  return `${Math.round(s / 86400)} ngày trước`;
};

/** A bridge that has not sent a heartbeat for this long is treated as offline. */
export const HEARTBEAT_STALE_MS = 60_000;

type AccountLike = {
  status: string;
  last_heartbeat_at: string | null;
  disabled?: boolean | null;
  terminal_connected?: boolean | null;
  trade_allowed?: boolean | null;
};

/**
 * Connection state shown to the operator. Separates "bridge alive" from "terminal ready to trade"
 * (design §6.3), and never shows a stale account as online.
 */
export function connection(a: AccountLike, now: number): { label: string; tone: Tone; online: boolean } {
  if (a.disabled) return { label: "Đã tắt", tone: "muted", online: false };
  if (!a.last_heartbeat_at) return { label: "Chưa kết nối EA", tone: "muted", online: false };
  if (now - Date.parse(a.last_heartbeat_at) > HEARTBEAT_STALE_MS) return { label: "Bridge offline", tone: "down", online: false };
  switch (a.status) {
    case "auth_failed": return { label: "Sai token", tone: "down", online: false };
    case "error": return { label: "Lỗi", tone: "down", online: false };
    case "reconnecting": return { label: "Đang kết nối lại", tone: "warn", online: false };
    case "paused": return { label: "Tạm dừng", tone: "warn", online: true };
  }
  if (a.terminal_connected === false) return { label: "Mất kết nối broker", tone: "warn", online: false };
  if (a.trade_allowed === false || a.status === "trading_disabled") return { label: "Không cho giao dịch", tone: "warn", online: true };
  return { label: "Online", tone: "up", online: true };
}

export const GROUP_STATE: Record<string, { label: string; tone: Tone }> = {
  running: { label: "Đang chạy", tone: "up" },
  paused: { label: "Tạm dừng", tone: "warn" },
  stopped: { label: "Đã dừng", tone: "muted" },
  emergency: { label: "Dừng khẩn cấp", tone: "down" },
};

export const LOT_MODE_LABEL: Record<string, string> = {
  fixed: "Lot cố định",
  multiplier: "Hệ số nhân",
  balance_ratio: "Tỷ lệ Balance",
  equity_ratio: "Tỷ lệ Equity",
  risk_percent: "% rủi ro theo SL",
};
