import { Suspense } from "react";
import { requestTime, requireUser } from "@/lib/auth";
import { ago, connection, maskLogin, num } from "@/lib/format";
import { Badge, Empty, Notice, PageHeader, Panel, td, th } from "@/components/ui";
import { AddAccountForm, RotateTokenForm } from "./token-forms";
import { deleteAccount, setDisabled } from "./actions";

const EA_SOURCE = "https://github.com/dathq51232/TradeForME/tree/main/mql5";
const supabaseOrigin = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://<project-ref>.supabase.co").replace(/\/$/, "");

export default function AccountsPage(props: PageProps<"/accounts">) {
  return (
    <Suspense fallback={<p className="text-sm text-muted">Đang tải…</p>}>
      <Accounts searchParams={props.searchParams} />
    </Suspense>
  );
}

async function Accounts({ searchParams }: { searchParams: PageProps<"/accounts">["searchParams"] }) {
  const { supabase } = await requireUser("/accounts");
  const sp = await searchParams;
  const { data: accounts, error } = await supabase.from("mt5_accounts")
    .select("id, role, label, broker, server, login, account_type, currency, balance, equity, margin_level, status, last_heartbeat_at, terminal_connected, trade_allowed, last_error, disabled, ea_version")
    .order("role").order("created_at");
  const now = requestTime();

  return (
    <>
      <PageHeader title="Tài khoản MT5"
        sub="Mỗi tài khoản chạy một EA trong terminal MT5 (thường trên Windows VPS). EA gửi heartbeat; quá 60 giây không có heartbeat thì coi là offline." />
      {sp.msg && <Notice tone="up">{String(sp.msg)}</Notice>}
      {(sp.error || error) && <Notice tone="down">{String(sp.error ?? error?.message)}</Notice>}

      <Panel title={`Danh sách (${accounts?.length ?? 0})`}>
        {accounts && accounts.length ? (
          <div className="-m-4 overflow-x-auto">
            <table className="w-full min-w-[960px] text-sm">
              <thead className="border-b border-border">
                <tr>
                  <th className={th}>Tài khoản</th><th className={th}>Broker / Server</th><th className={th}>Vai trò</th>
                  <th className={th}>Loại</th><th className={`${th} text-right`}>Balance</th><th className={`${th} text-right`}>Equity</th>
                  <th className={`${th} text-right`}>Margin lvl</th><th className={th}>Kết nối</th><th className={th}>Heartbeat</th><th className={th}></th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((a) => {
                  const c = connection(a, now);
                  return (
                    <tr key={a.id} className="border-b border-border/60 align-top">
                      <td className={td}>
                        <div>{a.label}</div>
                        <div className="font-mono text-xs text-muted">{maskLogin(a.login)}</div>
                        <div className="select-all font-mono text-[0.65rem] text-muted/70" title="Account ID: gửi cho chủ Master để thêm receiver này vào group">{a.id}</div>
                      </td>
                      <td className={td}><div>{a.broker ?? "—"}</div><div className="text-xs text-muted">{a.server}</div></td>
                      <td className={td}><Badge tone={a.role === "master" ? "accent" : "muted"}>{a.role === "master" ? "Master" : "Receiver"}</Badge></td>
                      <td className={td}>
                        {a.account_type ? (a.account_type === "hedging" ? "Hedging" : "Netting") : "—"}
                        {a.role === "master" && a.account_type === "netting" && <div className="text-xs text-warn">Master nên là Hedging</div>}
                      </td>
                      <td className={`${td} text-right font-mono`}>{num(a.balance)} <span className="text-xs text-muted">{a.currency ?? ""}</span></td>
                      <td className={`${td} text-right font-mono`}>{num(a.equity)}</td>
                      <td className={`${td} text-right font-mono`}>{a.margin_level == null ? "—" : `${num(a.margin_level, 0)}%`}</td>
                      <td className={td}>
                        <Badge tone={c.tone}>{c.label}</Badge>
                        {a.last_error && <div className="mt-1 max-w-48 text-xs text-down">{a.last_error}</div>}
                      </td>
                      <td className={`${td} text-xs text-muted`}>{ago(a.last_heartbeat_at, now)}{a.ea_version && <div>EA {a.ea_version}</div>}</td>
                      <td className={`${td} space-y-1 text-right`}>
                        <RotateTokenForm id={a.id} label={a.label} />
                        <form action={setDisabled}>
                          <input type="hidden" name="id" value={a.id} />
                          <input type="hidden" name="disabled" value={String(!a.disabled)} />
                          <button className="text-xs text-muted hover:text-foreground">{a.disabled ? "Bật lại" : "Tắt"}</button>
                        </form>
                        <details className="text-xs">
                          <summary className="cursor-pointer text-down">Xoá</summary>
                          <form action={deleteAccount} className="mt-1 flex justify-end gap-1">
                            <input type="hidden" name="id" value={a.id} />
                            <input type="hidden" name="label" value={a.label} />
                            <input name="confirm" placeholder="gõ tên để xoá" className="w-28" required />
                            <button className="text-down">OK</button>
                          </form>
                        </details>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : <Empty>Chưa có tài khoản. Thêm tài khoản Master và các Receiver ở dưới.</Empty>}
      </Panel>

      <Panel title="Thêm tài khoản MT5" className="mt-5">
        <div id="add" />
        <ol className="mb-4 list-decimal space-y-0.5 pl-5 text-xs text-muted">
          <li>Điền thông tin và bấm tạo, rồi chép EA token và HMAC secret (chỉ hiện một lần).</li>
          <li>
            Tải mã EA tại <a href={EA_SOURCE} target="_blank" rel="noreferrer" className="text-accent hover:underline">thư mục mql5 trên GitHub</a>,
            chép vào thư mục MQL5 của terminal, biên dịch, rồi chạy script <b>QT_SelfTest</b>: phải ra “tất cả OK”.
          </li>
          <li>Trong MT5: Tools → Options → Expert Advisors, bật Algo Trading và thêm <code className="text-foreground">{supabaseOrigin}</code> vào “Allow WebRequest”.</li>
          <li>
            Gắn <b>QT_MasterSender</b> (master) hoặc <b>QT_Receiver</b> (receiver) vào một chart. API URL:{" "}
            <code className="select-all text-foreground">{supabaseOrigin}/functions/v1</code>, rồi dán token và secret.
          </li>
          <li>Khi heartbeat đầu tiên tới, trạng thái chuyển sang Online và hiện loại tài khoản (Hedging/Netting). Thử trên tài khoản demo trước.</li>
        </ol>
        <AddAccountForm />
      </Panel>
    </>
  );
}
