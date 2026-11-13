-- Copy groups, group controls, richer account state, per-receiver filters and risk limits,
-- copy-task state machine, risk events, reconciliation, account snapshots, notifications.
-- Rationale: docs/PHAN-TICH-NANG-CAP.md.

-- ========== Accounts: connection detail ==========
alter table public.mt5_accounts drop constraint mt5_accounts_status_check;
alter table public.mt5_accounts add constraint mt5_accounts_status_check check (status in (
  'online', 'offline', 'reconnecting', 'auth_failed', 'bridge_offline', 'trading_disabled', 'paused', 'error'));
alter table public.mt5_accounts
  add column account_type text check (account_type in ('hedging', 'netting')),
  add column margin_level numeric,
  add column floating_pl numeric,
  add column open_positions int,
  add column terminal_connected boolean,   -- MT5 terminal is connected to the broker
  add column trade_allowed boolean,        -- algo trading enabled and account allowed to trade
  add column last_error text,
  add column disabled boolean not null default false;
grant select (account_type, margin_level, floating_pl, open_positions, terminal_connected, trade_allowed,
              last_error, disabled) on public.mt5_accounts to authenticated;
grant update (disabled) on public.mt5_accounts to authenticated;

-- ========== Copy groups: one master, many receivers ==========
create table public.copy_groups (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles on delete cascade,
  name text not null,
  master_id uuid not null unique references public.mt5_accounts on delete cascade,
  state text not null default 'paused' check (state in ('running', 'paused', 'stopped', 'emergency')),
  state_reason text,
  state_changed_at timestamptz not null default now(),
  state_changed_by uuid,
  allowed_symbols text[],
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.copy_links
  add column group_id uuid references public.copy_groups on delete cascade,
  add column copy_buy boolean not null default true,
  add column copy_sell boolean not null default true,
  add column copy_market boolean not null default true,
  add column copy_close boolean not null default true,
  add column copy_modify boolean not null default true,
  add column copy_partial_close boolean not null default true,
  add column min_lot numeric check (min_lot is null or min_lot > 0),
  add column below_min text not null default 'skip' check (below_min in ('skip', 'min_lot')),
  add column max_spread_points int check (max_spread_points is null or max_spread_points >= 0),
  add column max_drawdown_pct numeric check (max_drawdown_pct is null or max_drawdown_pct between 0 and 100),
  add column max_exposure_lots numeric check (max_exposure_lots is null or max_exposure_lots > 0),
  add column max_margin_usage_pct numeric check (max_margin_usage_pct is null or max_margin_usage_pct between 0 and 100),
  add column risk_action text not null default 'reject'
    check (risk_action in ('reject', 'pause_receiver', 'pause_group', 'alert', 'manual_approval'));
alter table public.copy_links drop constraint copy_links_lot_mode_check;
alter table public.copy_links add constraint copy_links_lot_mode_check
  check (lot_mode in ('fixed', 'multiplier', 'balance_ratio', 'equity_ratio', 'risk_percent'));

-- Every link belongs to its master's group; the group is created on first link if missing.
-- Named so it fires before copy_links_audit (triggers run in name order).
create or replace function public.copy_links_assign_group() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_group uuid;
begin
  if new.group_id is not null then
    select g.master_id into new.master_id from public.copy_groups g where g.id = new.group_id;
    return new;
  end if;
  select g.id into v_group from public.copy_groups g where g.master_id = new.master_id;
  if v_group is null then
    insert into public.copy_groups (owner_id, name, master_id)
    select a.owner_id, a.label, a.id from public.mt5_accounts a where a.id = new.master_id
    returning id into v_group;
  end if;
  new.group_id := v_group;
  return new;
end $$;
create trigger copy_links_0_group before insert or update of master_id, group_id on public.copy_links
  for each row execute function public.copy_links_assign_group();
alter table public.copy_links alter column group_id set not null;

-- ========== Copy tasks: state machine + error classes ==========
alter table public.ct_executions drop constraint ct_executions_status_check;
alter table public.ct_executions add constraint ct_executions_status_check check (status in (
  'received', 'validating', 'risk_checked', 'queued', 'executing', 'executed',
  'rejected', 'retry_scheduled', 'reconciliation_required', 'failed'));
alter table public.ct_executions
  add column action text,
  add column symbol text,
  add column side text,
  add column master_volume numeric,
  add column requested_volume numeric,
  add column error_class text check (error_class in (
    'market_closed', 'insufficient_margin', 'invalid_volume', 'symbol_not_found', 'slippage_exceeded',
    'spread_too_high', 'mt5_disconnected', 'bridge_timeout', 'trade_disabled', 'broker_rejected',
    'risk_limit', 'stale_signal', 'filtered', 'group_paused', 'other')),
  add column received_at timestamptz,
  add column updated_at timestamptz not null default now();

-- ========== Risk, reconciliation, snapshots, notifications ==========
create table public.risk_events (
  id bigserial primary key,
  group_id uuid references public.copy_groups on delete cascade,
  link_id uuid references public.copy_links on delete cascade,
  account_id uuid references public.mt5_accounts on delete cascade,
  rule text not null,
  action text not null check (action in ('reject', 'pause_receiver', 'pause_group', 'alert', 'manual_approval')),
  detail jsonb,
  created_at timestamptz not null default now()
);
create index on public.risk_events (created_at desc);

create table public.reconciliation_runs (
  id bigserial primary key,
  group_id uuid not null references public.copy_groups on delete cascade,
  trigger text not null check (trigger in ('schedule', 'reconnect', 'manual')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  discrepancies int not null default 0
);

create table public.reconciliation_items (
  id bigserial primary key,
  run_id bigint not null references public.reconciliation_runs on delete cascade,
  link_id uuid references public.copy_links on delete cascade,
  kind text not null check (kind in ('missing_on_receiver', 'orphan_on_receiver', 'volume_mismatch', 'state_mismatch')),
  master_ticket bigint,
  receiver_ticket bigint,
  detail jsonb,
  resolution text check (resolution in ('alerted', 'blocked', 'fixed', 'ignored')),
  resolved_at timestamptz
);

create table public.account_snapshots (
  account_id uuid not null references public.mt5_accounts on delete cascade,
  ts timestamptz not null default now(),
  balance numeric, equity numeric, margin numeric, margin_level numeric, floating_pl numeric,
  open_positions int,
  primary key (account_id, ts)
);

create table public.notifications (
  id bigserial primary key,
  user_id uuid not null references public.profiles on delete cascade,
  level text not null default 'info' check (level in ('info', 'warning', 'critical')),
  title text not null,
  body text,
  link text,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index on public.notifications (user_id, created_at desc);

-- ========== RLS ==========
alter table public.copy_groups enable row level security;
alter table public.risk_events enable row level security;
alter table public.reconciliation_runs enable row level security;
alter table public.reconciliation_items enable row level security;
alter table public.account_snapshots enable row level security;
alter table public.notifications enable row level security;

create or replace function public.can_see_group(g uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.is_staff() or exists (
    select 1 from public.copy_groups cg where cg.id = g and (cg.owner_id = auth.uid() or public.owns_account(cg.master_id)))
  or exists (select 1 from public.copy_links l where l.group_id = g and public.owns_account(l.receiver_id));
$$;

create policy "copy_groups: read" on public.copy_groups for select to authenticated using (public.can_see_group(id));
create policy "copy_groups: master owner insert" on public.copy_groups for insert to authenticated
  with check (owner_id = auth.uid() and public.owns_account(master_id));
create policy "copy_groups: master owner update" on public.copy_groups for update to authenticated
  using (public.owns_account(master_id) or public.is_staff());
create policy "copy_groups: master owner delete" on public.copy_groups for delete to authenticated
  using (public.owns_account(master_id) or public.is_staff());
-- state only changes through copy_group_control (audited)
revoke insert, update on public.copy_groups from anon, authenticated;
grant insert (owner_id, name, master_id, allowed_symbols) on public.copy_groups to authenticated;
grant update (name, allowed_symbols) on public.copy_groups to authenticated;

create policy "risk_events: read" on public.risk_events for select to authenticated
  using (public.is_staff() or (group_id is not null and public.can_see_group(group_id))
         or (account_id is not null and public.owns_account(account_id)));
create policy "reconciliation_runs: read" on public.reconciliation_runs for select to authenticated
  using (public.can_see_group(group_id));
create policy "reconciliation_items: read" on public.reconciliation_items for select to authenticated
  using (exists (select 1 from public.reconciliation_runs r where r.id = run_id and public.can_see_group(r.group_id)));
create policy "account_snapshots: read" on public.account_snapshots for select to authenticated
  using (public.owns_account(account_id) or public.is_staff());
create policy "notifications: own" on public.notifications for select to authenticated using (user_id = auth.uid());
create policy "notifications: mark read" on public.notifications for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
revoke insert, update, delete on public.risk_events, public.reconciliation_runs, public.reconciliation_items,
  public.account_snapshots, public.notifications from anon, authenticated;
grant update (read_at) on public.notifications to authenticated;

-- ========== Group controls ==========
create or replace function public.copy_group_control(p_group uuid, p_action text, p_reason text default null)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_from text;
  v_to text := case p_action
    when 'start' then 'running' when 'resume' then 'running'
    when 'pause' then 'paused' when 'stop' then 'stopped' when 'emergency_stop' then 'emergency' end;
begin
  if v_to is null then raise exception 'unknown action %', p_action using errcode = '22023'; end if;
  select g.state into v_from from public.copy_groups g
    where g.id = p_group and (public.owns_account(g.master_id) or public.is_staff()) for update;
  if not found then raise exception 'not your copy group' using errcode = '42501'; end if;
  if v_from = 'emergency' and v_to = 'running' and coalesce(btrim(p_reason), '') = '' then
    raise exception 'leaving emergency stop needs a reason' using errcode = '22023';
  end if;
  update public.copy_groups
    set state = v_to, state_reason = p_reason, state_changed_at = now(), state_changed_by = auth.uid(), updated_at = now()
    where id = p_group;
  insert into public.audit_log (actor, action, target, detail)
  values (auth.uid(), 'copy_groups.' || p_action, p_group::text,
          jsonb_build_object('from', v_from, 'to', v_to, 'reason', p_reason));
  return v_to;
end $$;

-- Pause every running group the caller controls. Returns how many were paused.
create or replace function public.copy_pause_all(p_reason text default null)
returns int
language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '28000'; end if;
  with g as (
    update public.copy_groups
      set state = 'paused', state_reason = coalesce(p_reason, 'pause all'), state_changed_at = now(),
          state_changed_by = auth.uid(), updated_at = now()
      where state = 'running' and public.owns_account(master_id)
      returning id
  ), a as (
    insert into public.audit_log (actor, action, target, detail)
    select auth.uid(), 'copy_groups.pause_all', g.id::text, jsonb_build_object('reason', p_reason) from g
    returning 1
  )
  select count(*) into v_n from a;
  return v_n;
end $$;

-- Close All: a separate, confirmed action. Emits a KILL event that every receiver of the group
-- receives whatever the group state. The caller must type the group name to confirm.
create or replace function public.copy_request_close_all(p_group uuid, p_confirm text)
returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  v_master uuid;
  v_name text;
  v_seq bigint;
begin
  select g.master_id, g.name into v_master, v_name from public.copy_groups g
    where g.id = p_group and (public.owns_account(g.master_id) or public.is_staff());
  if not found then raise exception 'not your copy group' using errcode = '42501'; end if;
  if p_confirm is distinct from v_name then
    raise exception 'type the group name to confirm' using errcode = '22023';
  end if;
  select a.seq into v_seq from public.ct_append_events(v_master, jsonb_build_array(jsonb_build_object(
    'event_uid', 'close-all-' || gen_random_uuid(), 'type', 'KILL', 'close_all', true,
    'ts_ms', floor(extract(epoch from clock_timestamp()) * 1000)::bigint))) a;
  insert into public.audit_log (actor, action, target, detail)
  values (auth.uid(), 'copy_groups.close_all', p_group::text, jsonb_build_object('seq', v_seq));
  return v_seq;
end $$;

-- Receivers of a group with their live status. The master owner may not own the receiver accounts,
-- so this exposes only operational fields (never server/login/token) to people who can see the group.
create or replace function public.copy_group_receivers(p_group uuid)
returns table (link_id uuid, receiver_id uuid, label text, currency text, status text,
               last_heartbeat_at timestamptz, balance numeric, equity numeric, open_positions int,
               trade_allowed boolean, enabled boolean, lot_mode text, lot_value numeric, mine boolean)
language sql stable security definer set search_path = '' as $$
  select l.id, a.id, a.label, a.currency, a.status, a.last_heartbeat_at, a.balance, a.equity, a.open_positions,
         a.trade_allowed, l.enabled, l.lot_mode, l.lot_value, a.owner_id = auth.uid()
  from public.copy_links l join public.mt5_accounts a on a.id = l.receiver_id
  where l.group_id = p_group and public.can_see_group(p_group)
  order by a.label;
$$;

revoke all on function public.copy_group_control, public.copy_pause_all, public.copy_request_close_all,
  public.copy_group_receivers from public, anon;
grant execute on function public.copy_group_control, public.copy_pause_all, public.copy_request_close_all,
  public.copy_group_receivers to authenticated;

-- ========== ct_pull: deliver by group state (docs/PHAN-TICH-NANG-CAP.md §4) ==========
-- Skipped events are still returned with skip_reason so the EA records them and advances its cursor;
-- an OPEN sent while paused is therefore never executed late after resume.
drop function public.ct_pull(uuid, uuid, bigint, int);
create function public.ct_pull(p_receiver uuid, p_master uuid, p_since bigint, p_limit int default 100)
returns table (seq bigint, payload jsonb, skip_reason text)
language sql stable security definer set search_path = '' as $$
  with ctx as (
    select l.enabled,
           case when g.state = 'running'
                 and coalesce((select s.value = 'true'::jsonb from public.app_settings s where s.key = 'copy_global_pause'), false)
                then 'paused' else g.state end as state
    from public.copy_links l join public.copy_groups g on g.id = l.group_id
    where l.master_id = p_master and l.receiver_id = p_receiver
  )
  select e.seq, e.payload,
    case
      when e.type = 'KILL' then null
      when not ctx.enabled then 'receiver_disabled'
      when ctx.state = 'running' then null
      when ctx.state = 'paused' and e.type in ('MODIFY', 'CLOSE', 'PARTIAL_CLOSE', 'PENDING_DELETE') then null
      else 'group_' || ctx.state
    end
  from public.ct_events e, ctx
  where e.master_id = p_master and e.seq > p_since
  order by e.seq
  limit least(p_limit, 500);
$$;
revoke all on function public.ct_pull from public, anon, authenticated;

-- ========== Realtime ==========
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.copy_groups, public.risk_events, public.notifications;
  end if;
end $$;
