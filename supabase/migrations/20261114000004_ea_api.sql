-- Server side of the EA API (Edge Functions ct-heartbeat, ct-ingest, ct-pull, ct-ack, ct-bars).
-- Every function here is service-role only: the Edge Function authenticates the EA (token + HMAC)
-- and passes the resolved account id.

insert into public.app_settings (key, value) values ('ea_min_version', '"1.0.0"') on conflict (key) do nothing;

-- ct_auth also reports whether the operator disabled the account, so every endpoint can refuse it.
drop function public.ct_auth(text);
create function public.ct_auth(p_token text)
returns table (account_id uuid, role text, hmac_secret text, disabled boolean)
language sql stable security definer set search_path = '' as $$
  select a.id, a.role, s.hmac_secret, a.disabled
  from public.mt5_accounts a join public.mt5_account_secrets s on s.account_id = a.id
  where a.token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex');
$$;
revoke all on function public.ct_auth from public, anon, authenticated;

-- One row per (link, master event, master ticket): a SNAPSHOT can produce several reconciliation rows.
alter table public.ct_executions add column master_ticket bigint;
alter table public.ct_executions drop constraint ct_executions_link_id_seq_key;
create unique index ct_executions_link_seq_ticket on public.ct_executions (link_id, seq, (coalesce(master_ticket, 0)));

-- ---------- heartbeat ----------
-- Updates the account's live state; stores a snapshot at most every 5 minutes.
create or replace function public.ct_heartbeat(p_account uuid, p jsonb)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_last timestamptz;
begin
  update public.mt5_accounts set
    status = case when coalesce((p ->> 'trade_allowed')::boolean, true) then 'online' else 'trading_disabled' end,
    last_heartbeat_at = now(),
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

-- ---------- receiver: links + events in one call ----------
-- Settings of every link the receiver belongs to, with the group state the server applies.
create or replace function public.ct_receiver_links(p_receiver uuid)
returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'link_id', l.id, 'master_id', l.master_id, 'group_state', g.state, 'enabled', l.enabled,
    'last_seq', s.last_seq,
    'settings', to_jsonb(l) - array['id', 'group_id', 'master_id', 'receiver_id', 'updated_at', 'paused_reason', 'trading_hours'],
    'group_symbols', g.allowed_symbols
  ) order by l.id), '[]'::jsonb)
  from public.copy_links l
  join public.copy_groups g on g.id = l.group_id
  join public.ct_seq s on s.master_id = l.master_id
  where l.receiver_id = p_receiver;
$$;

-- Events for all of a receiver's masters after its cursors ({"<master_id>": seq}).
-- A missing or negative cursor starts at the master's current seq: a new receiver never replays history.
create or replace function public.ct_pull_batch(p_receiver uuid, p_cursors jsonb, p_limit int default 200)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_out jsonb := '[]'::jsonb;
  v_cursors jsonb := '{}'::jsonb;
  r record;
  v_since bigint;
begin
  for r in select l.master_id, s.last_seq from public.copy_links l join public.ct_seq s on s.master_id = l.master_id
           where l.receiver_id = p_receiver loop
    v_since := coalesce((p_cursors ->> r.master_id::text)::bigint, -1);
    if v_since < 0 then v_since := r.last_seq; end if;
    v_cursors := v_cursors || jsonb_build_object(r.master_id::text, v_since);
    v_out := v_out || coalesce((
      select jsonb_agg(jsonb_build_object('master_id', r.master_id, 'seq', p.seq, 'payload', p.payload, 'skip_reason', p.skip_reason) order by p.seq)
      from public.ct_pull(p_receiver, r.master_id, v_since, p_limit) p), '[]'::jsonb);
  end loop;
  return jsonb_build_object('events', v_out, 'cursors', v_cursors);
end $$;

-- ---------- receiver: results ----------
-- Idempotent: the same (link, seq, master_ticket) result can be sent again after a timeout.
create or replace function public.ct_ack(p_receiver uuid, p_results jsonb)
returns int
language plpgsql security definer set search_path = '' as $$
declare
  x jsonb;
  v_link uuid;
  v_group uuid;
  v_owner uuid;
  v_n int := 0;
  v_ticket bigint;
  v_status text;
  v_action text;
begin
  for x in select * from jsonb_array_elements(p_results) loop
    select l.id, l.group_id, g.owner_id into v_link, v_group, v_owner
      from public.copy_links l join public.copy_groups g on g.id = l.group_id
      where l.receiver_id = p_receiver and l.master_id = (x ->> 'master_id')::uuid;
    if v_link is null then continue; end if;
    v_ticket := (x ->> 'master_ticket')::bigint;
    v_status := x ->> 'status';
    v_action := x ->> 'action';

    insert into public.ct_executions as e (link_id, master_id, seq, master_ticket, status, action, symbol, side,
      master_volume, requested_volume, volume, receiver_ticket, fill_price, slippage_points, latency_ms,
      error_class, error_code, reason, received_at, updated_at)
    values (v_link, (x ->> 'master_id')::uuid, (x ->> 'seq')::bigint, v_ticket, v_status, v_action, x ->> 'symbol', x ->> 'side',
      (x ->> 'master_volume')::numeric, (x ->> 'requested_volume')::numeric, (x ->> 'volume')::numeric,
      (x ->> 'receiver_ticket')::bigint, (x ->> 'fill_price')::numeric, (x ->> 'slippage_points')::numeric,
      (x ->> 'latency_ms')::int, x ->> 'error_class', (x ->> 'error_code')::int, left(x ->> 'reason', 300), now(), now())
    on conflict (link_id, seq, (coalesce(master_ticket, 0))) do update set
      status = excluded.status, volume = excluded.volume, receiver_ticket = excluded.receiver_ticket,
      fill_price = excluded.fill_price, slippage_points = excluded.slippage_points, error_class = excluded.error_class,
      error_code = excluded.error_code, reason = excluded.reason, updated_at = now();

    -- position map
    if v_status = 'executed' and v_action = 'OPEN' and (x ->> 'receiver_ticket') is not null then
      insert into public.ct_position_map (link_id, master_ticket, receiver_ticket, symbol, volume)
      values (v_link, v_ticket, (x ->> 'receiver_ticket')::bigint, coalesce(x ->> 'symbol', ''), coalesce((x ->> 'volume')::numeric, 0))
      on conflict (link_id, master_ticket) do update set receiver_ticket = excluded.receiver_ticket, volume = excluded.volume, closed_at = null;
    elsif v_status = 'executed' and v_action in ('CLOSE', 'RECONCILE_CLOSE', 'KILL') then
      update public.ct_position_map set closed_at = now() where link_id = v_link and master_ticket = v_ticket;
    elsif v_status = 'executed' and v_action = 'PARTIAL_CLOSE' then
      update public.ct_position_map set volume = greatest(volume - coalesce((x ->> 'volume')::numeric, 0), 0)
        where link_id = v_link and master_ticket = v_ticket;
    end if;

    -- risk limits: record, and apply pause actions on the server so they hold after the EA restarts
    if x ->> 'error_class' = 'risk_limit' then
      insert into public.risk_events (group_id, link_id, account_id, rule, action, detail)
      values (v_group, v_link, p_receiver, coalesce(x ->> 'reason', 'risk'), coalesce(x ->> 'risk_action', 'reject'), x);
      if x ->> 'risk_action' = 'pause_receiver' then
        update public.copy_links set enabled = false, paused_reason = 'risk: ' || coalesce(x ->> 'reason', '') where id = v_link;
      elsif x ->> 'risk_action' = 'pause_group' then
        update public.copy_groups set state = 'paused', state_reason = 'risk: ' || coalesce(x ->> 'reason', ''),
          state_changed_at = now(), updated_at = now() where id = v_group and state = 'running';
      end if;
    end if;

    -- tell the group owner about failures and discrepancies
    if v_status in ('failed', 'reconciliation_required') or x ->> 'risk_action' in ('pause_receiver', 'pause_group') then
      insert into public.notifications (user_id, level, title, body, link)
      values (v_owner, case when v_status = 'failed' or x ->> 'risk_action' like 'pause_%' then 'critical' else 'warning' end,
              coalesce(v_action, 'Copy') || ' ' || coalesce(x ->> 'symbol', '') || ': ' || v_status,
              left(coalesce(x ->> 'reason', x ->> 'error_class', ''), 300), '/copy');
    end if;
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

-- ---------- master: broker M1 bars for the chart ----------
create or replace function public.ct_push_bars(p_master uuid, p_bars jsonb)
returns int
language plpgsql security definer set search_path = '' as $$
declare v_n int; v_server text;
begin
  select server into v_server from public.mt5_accounts where id = p_master and role = 'master';
  if v_server is null then raise exception 'not a master account' using errcode = '42501'; end if;
  insert into public.bars_m1 (symbol, ts, o, h, l, c, v, source)
  select b ->> 'symbol', to_timestamp((b ->> 't')::bigint), (b ->> 'o')::numeric, (b ->> 'h')::numeric,
         (b ->> 'l')::numeric, (b ->> 'c')::numeric, coalesce((b ->> 'v')::numeric, 0), 'broker:' || v_server
  from jsonb_array_elements(p_bars) b
  where b ->> 'symbol' in ('XAUUSD', 'XAGUSD', 'WTI', 'BRENT')
    and (b ->> 't')::bigint between extract(epoch from now() - interval '3 days') and extract(epoch from now() + interval '2 minutes')
  on conflict (symbol, ts) do update set o = excluded.o, h = excluded.h, l = excluded.l, c = excluded.c, v = excluded.v, source = excluded.source;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

revoke all on function public.ct_heartbeat, public.ct_receiver_links, public.ct_pull_batch, public.ct_ack, public.ct_push_bars
  from public, anon, authenticated;

-- ---------- housekeeping ----------
-- SNAPSHOT events arrive every 30 s per master; keep a week. Broker M1 bars: 90 days (design §4.2).
create or replace function public.ct_cleanup() returns void
language sql security definer set search_path = '' as $$
  delete from public.ct_events where type = 'SNAPSHOT' and received_at < now() - interval '7 days';
  delete from public.bars_m1 where ts < now() - interval '90 days';
  delete from public.account_snapshots where ts < now() - interval '400 days';
$$;
revoke all on function public.ct_cleanup from public, anon, authenticated;

do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('qt-cleanup', '17 3 * * *', 'select public.ct_cleanup()');
  end if;
end $$;
