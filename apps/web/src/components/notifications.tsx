"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";

type Note = { id: number; level: "info" | "warning" | "critical"; title: string; body: string | null; link: string | null; read_at: string | null; created_at: string };
const TONE = { info: "text-muted", warning: "text-warn", critical: "text-down" };

/** Bell in the top bar: unread count (refreshed every minute), latest notifications, Telegram chat id. */
export function NotificationsBell({ unread: initialUnread, telegram: initialTelegram }: { unread: number; telegram: string | null }) {
  const supabase = useMemo(() => createClient(), []);
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(initialUnread);
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [telegram, setTelegram] = useState(initialTelegram ?? "");
  const [saved, setSaved] = useState("");
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setInterval(async () => {
      const { count } = await supabase.from("notifications").select("id", { count: "exact", head: true }).is("read_at", null);
      if (count != null) setUnread(count);
    }, 60_000);
    return () => clearInterval(t);
  }, [supabase]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (!next) return;
    const { data } = await supabase.from("notifications").select("id, level, title, body, link, read_at, created_at")
      .order("created_at", { ascending: false }).limit(15);
    setNotes((data as Note[]) ?? []);
  };
  const markRead = async () => {
    const ids = (notes ?? []).filter((n) => !n.read_at).map((n) => n.id);
    if (!ids.length) return;
    const now = new Date().toISOString();
    await supabase.from("notifications").update({ read_at: now }).in("id", ids);
    setNotes((xs) => xs?.map((n) => (ids.includes(n.id) ? { ...n, read_at: now } : n)) ?? null);
    setUnread((u) => Math.max(0, u - ids.length));
  };
  const saveTelegram = async () => {
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) return;
    const v = telegram.trim();
    if (v && !/^-?\d{5,20}$/.test(v)) return setSaved("Chat ID là một dãy số.");
    const { error } = await supabase.from("profiles").update({ telegram_chat_id: v || null }).eq("id", auth.user.id);
    setSaved(error ? error.message : v ? "Đã lưu: cảnh báo sẽ gửi cả qua Telegram." : "Đã tắt Telegram.");
  };

  return (
    <div ref={box} className="relative">
      <button onClick={toggle} title="Thông báo" className="relative px-1 text-sm">
        🔔{unread > 0 && <span className="absolute -right-1.5 -top-1 rounded-full bg-down px-1 text-[0.6rem] font-medium text-white">{unread > 99 ? "99+" : unread}</span>}
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-2 w-80 rounded-md border border-border bg-panel p-2 text-sm shadow-xl">
          <div className="mb-1 flex items-center justify-between px-1">
            <span className="font-medium">Thông báo</span>
            <button onClick={markRead} className="text-xs text-accent hover:underline">Đánh dấu đã đọc</button>
          </div>
          <ul className="max-h-80 overflow-y-auto">
            {notes == null ? <li className="px-1 py-2 text-xs text-muted">Đang tải…</li>
              : notes.length === 0 ? <li className="px-1 py-2 text-xs text-muted">Chưa có thông báo. Đặt cảnh báo bằng nút 🔔 trên đường giá ở trang Biểu đồ.</li>
              : notes.map((n) => {
                const inner = (
                  <>
                    <div className={`${TONE[n.level]} ${n.read_at ? "" : "font-medium"}`}>{n.title}</div>
                    {n.body && <div className="text-xs text-muted">{n.body}</div>}
                    <div className="text-[0.65rem] text-muted/70">{new Date(n.created_at).toLocaleString("vi-VN")}</div>
                  </>
                );
                return (
                  <li key={n.id} className={`rounded px-1 py-1.5 ${n.read_at ? "" : "bg-accent/5"}`}>
                    {n.link ? <Link href={n.link} onClick={() => setOpen(false)} className="block hover:bg-panel-2">{inner}</Link> : inner}
                  </li>
                );
              })}
          </ul>
          <div className="mt-2 border-t border-border px-1 pt-2 text-xs">
            <label className="grid gap-1">
              <span className="text-muted">Nhận cảnh báo qua Telegram: Chat ID (nhắn cho bot @userinfobot để biết)</span>
              <span className="flex gap-1">
                <input value={telegram} onChange={(e) => setTelegram(e.target.value)} placeholder="VD: 123456789" inputMode="numeric" className="min-w-0 flex-1" />
                <button onClick={saveTelegram} className="rounded border border-border px-2 hover:bg-panel-2">Lưu</button>
              </span>
            </label>
            {saved && <p className="mt-1 text-muted">{saved}</p>}
            <p className="mt-1 text-muted/80">Hãy bấm Start với bot của hệ thống trước, nếu không bot sẽ không nhắn được cho bạn.</p>
          </div>
        </div>
      )}
    </div>
  );
}
