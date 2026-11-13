import { Suspense } from "react";
import Link from "next/link";
import { requestTime, requireUser } from "@/lib/auth";
import { connection, GROUP_STATE, num, ago } from "@/lib/format";
import { Badge, Empty, Kpi, Notice, PageHeader, Panel, btn } from "@/components/ui";
import { pauseAll } from "../copy/actions";

export default function DashboardPage(props: PageProps<"/dashboard">) {
  return (
    <Suspense fallback={<p className="text-sm text-muted">Đang tải…</p>}>
      <Dashboard searchParams={props.searchParams} />
    </Suspense>
  );
}

async function Dashboard({ searchParams }: { searchParams: PageProps<"/dashboard">["searchParams"] }) {
  const { supabase } = await requireUser("/dashboard");
  const sp = await searchParams;
  const since = new Date(requestTime() - 86_400_000).toISOString();
  const [{ data: accounts }, { data: groups }, { data: tasks }, { data: risks }] = await Promise.all([
    supabase.from("mt5_accounts")
      .select("id, role, label, currency, balance, equity, floating_pl, open_positions, status, last_heartbeat_at, disabled, terminal_connected, trade_allowed"),
    supabase.from("copy_groups").select("id, name, state, state_changed_at, master_id"),
    supabase.from("ct_executions").select("status, latency_ms, created_at").gte("created_at", since).limit(5000),
    supabase.from("risk_events").select("id, rule, action, created_at").order("created_at", { ascending: false }).limit(5),
  ]);
  const now = requestTime();
  const acc = accounts ?? [];

  // Never add up different currencies (design §4.2): one total per currency.
  const byCcy = new Map<string, { balance: number; equity: number; pl: number }>();
  for (const a of acc) {
    if (a.balance == null && a.equity == null) continue;
    const k = a.currency ?? "?";
    const t = byCcy.get(k) ?? { balance: 0, equity: 0, pl: 0 };
    t.balance += Number(a.balance ?? 0); t.equity += Number(a.equity ?? 0); t.pl += Number(a.floating_pl ?? 0);
    byCcy.set(k, t);
  }
  const ccys = [...byCcy.entries()];
  const perCcy = (pick: (t: { balance: number; equity: number; pl: number }) => number) =>
    ccys.length === 0 ? "—" : ccys.map(([c, t]) => `${num(pick(t))} ${c}`).join(" · ");
  const pl = ccys.reduce((s, [, t]) => s + t.pl, 0);

  const online = acc.filter((a) => connection(a, now).online).length;
  const positions = acc.reduce((s, a) => s + (a.open_positions ?? 0), 0);
  const t = tasks ?? [];
  const executed = t.filter((x) => x.status === "executed").length;
  const failed = t.filter((x) => ["failed", "reconciliation_required"].includes(x.status)).length;
  const pending = t.filter((x) => ["received", "validating", "risk_checked", "queued", "executing", "retry_scheduled"].includes(x.status)).length;
  const decided = t.filter((x) => ["executed", "failed", "rejected"].includes(x.status)).length;
  const lat = t.filter((x) => x.latency_ms != null).map((x) => x.latency_ms as number).sort((a, b) => a - b);
  const p50 = lat.length ? lat[Math.floor(lat.length / 2)] : null;
  const running = (groups ?? []).filter((g) => g.state === "running").length;

  return (
    <>
      <PageHeader title="Dashboard" sub="Tổng quan tài khoản MT5 và copy trading. Số liệu lấy từ EA; chưa có EA thì để trống, không dùng số liệu giả."
        action={
          <div className="flex flex-wrap gap-2">
            <Link href="/accounts#add" className={btn.primary}>+ Thêm tài khoản MT5</Link>
            <Link href="/copy" className={btn.ghost}>Copy group</Link>
            {running > 0 && (
              <form action={pauseAll}>
                <input type="hidden" name="back" value="/dashboard" />
                <button className={btn.warn} title="Ngừng nhận lệnh mới ở mọi group đang chạy. Không đóng vị thế.">
                  ❚❚ Tạm dừng tất cả ({running})
                </button>
              </form>
            )}
          </div>
        } />
      {sp.msg && <Notice tone="up">{String(sp.msg)}</Notice>}
      {sp.error && <Notice tone="down">{String(sp.error)}</Notice>}

      <section className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        <Kpi label="Tổng Balance" value={perCcy((x) => x.balance)} />
        <Kpi label="Tổng Equity" value={perCcy((x) => x.equity)} />
        <Kpi label="P/L thả nổi" value={perCcy((x) => x.pl)} tone={pl > 0 ? "up" : pl < 0 ? "down" : undefined} />
        <Kpi label="Tài khoản online" value={`${online}/${acc.length}`} tone={acc.length && online < acc.length ? "warn" : undefined} />
        <Kpi label="Vị thế đang mở" value={positions} />
        <Kpi label="Copy thành công 24h" value={decided ? `${Math.round((executed / decided) * 100)}%` : "—"}
          sub={p50 != null ? `độ trễ trung vị ${p50} ms` : "chưa có lệnh"} />
        <Kpi label="Chờ / lỗi 24h" value={`${pending} / ${failed}`} tone={failed ? "down" : undefined} />
      </section>

      <div className="mt-5 grid gap-5 xl:grid-cols-3">
        <Panel title="Copy groups" className="xl:col-span-2" action={<Link href="/copy" className="text-xs text-accent">Quản lý →</Link>}>
          {groups && groups.length ? (
            <ul className="divide-y divide-border">
              {groups.map((g) => {
                const s = GROUP_STATE[g.state];
                const master = acc.find((a) => a.id === g.master_id);
                const mc = master ? connection(master, now) : null;
                return (
                  <li key={g.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                    <Link href={`/copy#g-${g.id}`} className="font-medium hover:text-accent">{g.name}</Link>
                    <Badge tone={s.tone}>{s.label}</Badge>
                    {mc && <span className="text-xs text-muted">Master: <Badge tone={mc.tone}>{mc.label}</Badge></span>}
                    <span className="ml-auto text-xs text-muted">đổi trạng thái {ago(g.state_changed_at, now)}</span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <Empty>Chưa có copy group. Thêm một tài khoản Master và một Receiver, rồi liên kết chúng ở trang Copy Trading.</Empty>
          )}
        </Panel>

        <Panel title="Cảnh báo rủi ro gần đây">
          {risks && risks.length ? (
            <ul className="space-y-2 text-sm">
              {risks.map((r) => (
                <li key={r.id} className="flex items-center gap-2">
                  <Badge tone="warn">{r.rule}</Badge>
                  <span className="text-xs text-muted">{r.action} · {ago(r.created_at, now)}</span>
                </li>
              ))}
            </ul>
          ) : <Empty>Không có cảnh báo.</Empty>}
        </Panel>
      </div>

      <Panel title="Tài khoản MT5" className="mt-5" action={<Link href="/accounts" className="text-xs text-accent">Tất cả →</Link>}>
        {acc.length ? (
          <div className="flex flex-wrap gap-2">
            {acc.map((a) => {
              const c = connection(a, now);
              return (
                <div key={a.id} className="flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm">
                  <span>{a.label}</span>
                  <span className="text-xs text-muted">{a.role === "master" ? "Master" : "Receiver"}</span>
                  <Badge tone={c.tone}>{c.label}</Badge>
                </div>
              );
            })}
          </div>
        ) : <Empty>Chưa có tài khoản MT5.</Empty>}
      </Panel>
    </>
  );
}
