-- Simpler EA setup: the dashboard only asks for role + name. The EA reports its own login, server and
-- broker on the first heartbeat (then they are locked), runs its self-test and reports the result,
-- and says which EA it is, so the dashboard can show a live connection checklist and explain mistakes
-- (wrong EA for the role, code pasted into another account, clock skew).

alter table public.mt5_accounts alter column server drop not null, alter column login drop not null;
alter table public.mt5_accounts
  add column ea_kind text check (ea_kind in ('master', 'receiver')),
  add column selftest text,                 -- 'ok' or 'fail: <checks>'
  add column terminal_build int,
  add column first_seen_at timestamptz;     -- first authenticated request from an EA
grant select (ea_kind, selftest, terminal_build, first_seen_at) on public.mt5_accounts to authenticated;

-- Record a setup problem the EA cannot show on the dashboard itself (called by the Edge Function).
create or replace function public.ct_note_error(p_account uuid, p_error text)
returns void language sql security definer set search_path = '' as $$
  update public.mt5_accounts set last_error = left(p_error, 300), first_seen_at = coalesce(first_seen_at, now())
  where id = p_account;
$$;
revoke all on function public.ct_note_error from public, anon, authenticated;

-- Heartbeat: same live state as before, plus identity checks. Returns {error, message} instead of
-- updating when the EA is the wrong kind or runs on another MT5 account.
create or replace function public.ct_heartbeat(p_account uuid, p jsonb)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_last timestamptz;
  a public.mt5_accounts;
  v_login bigint := nullif(p ->> 'login', '')::bigint;
  v_server text := nullif(p ->> 'server', '');
  v_msg text;
begin
  select * into a from public.mt5_accounts where id = p_account;

  if p ->> 'ea_kind' is not null and p ->> 'ea_kind' <> a.role then
    v_msg := case a.role when 'master' then 'Mã này của tài khoản Master: hãy dùng EA QT_MasterSender, không phải QT_Receiver.'
                         else 'Mã này của tài khoản Receiver: hãy dùng EA QT_Receiver, không phải QT_MasterSender.' end;
    perform public.ct_note_error(p_account, v_msg);
    return jsonb_build_object('error', 'WRONG_EA', 'message', v_msg);
  end if;

  if v_login is not null and a.login is not null and v_login <> a.login then
    v_msg := format('Mã này thuộc tài khoản MT5 %s nhưng EA đang chạy trên %s. Đăng nhập đúng tài khoản hoặc tạo mã riêng cho tài khoản này.', a.login, v_login);
    perform public.ct_note_error(p_account, v_msg);
    return jsonb_build_object('error', 'ACCOUNT_MISMATCH', 'message', v_msg);
  end if;

  if v_login is not null and a.login is null then
    begin
      update public.mt5_accounts set login = v_login, server = coalesce(v_server, server),
        broker = coalesce(broker, nullif(p ->> 'broker', '')) where id = p_account;
    exception when unique_violation then
      v_msg := format('Tài khoản MT5 %s trên %s đã được đăng ký ở mục khác. Xoá mục trùng rồi thử lại.', v_login, v_server);
      perform public.ct_note_error(p_account, v_msg);
      return jsonb_build_object('error', 'ACCOUNT_IN_USE', 'message', v_msg);
    end;
  end if;

  update public.mt5_accounts set
    status = case when coalesce((p ->> 'trade_allowed')::boolean, true) then 'online' else 'trading_disabled' end,
    last_heartbeat_at = now(),
    first_seen_at = coalesce(first_seen_at, now()),
    balance = (p ->> 'balance')::numeric,
    equity = (p ->> 'equity')::numeric,
    margin = (p ->> 'margin')::numeric,
    margin_level = (p ->> 'margin_level')::numeric,
    floating_pl = (p ->> 'floating_pl')::numeric,
    open_positions = (p ->> 'open_positions')::int,
    currency = coalesce(p ->> 'currency', currency),
    account_type = coalesce(p ->> 'account_type', account_type),
    terminal_connected = (p ->> 'terminal_connected')::boolean,
    trade_allowed = (p ->> 'trade_allowed')::boolean,
    ea_version = p ->> 'ea_version',
    ea_kind = coalesce(p ->> 'ea_kind', ea_kind),
    selftest = coalesce(p ->> 'selftest', selftest),
    terminal_build = coalesce((p ->> 'terminal_build')::int, terminal_build),
    last_error = nullif(p ->> 'last_error', '')
  where id = p_account;

  select max(ts) into v_last from public.account_snapshots where account_id = p_account;
  if v_last is null or v_last < now() - interval '5 minutes' then
    insert into public.account_snapshots (account_id, balance, equity, margin, margin_level, floating_pl, open_positions)
    values (p_account, (p ->> 'balance')::numeric, (p ->> 'equity')::numeric, (p ->> 'margin')::numeric,
            (p ->> 'margin_level')::numeric, (p ->> 'floating_pl')::numeric, (p ->> 'open_positions')::int);
  end if;

  return jsonb_build_object(
    'disabled', (select disabled from public.mt5_accounts where id = p_account),
    'min_ea_version', (select value #>> '{}' from public.app_settings where key = 'ea_min_version'));
end $$;
revoke all on function public.ct_heartbeat from public, anon, authenticated;
