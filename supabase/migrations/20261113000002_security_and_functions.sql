-- Row Level Security, column privileges and the RPCs used by the web app and Edge Functions.

-- ========== Helpers ==========
create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role in ('admin', 'manager'));
$$;

create or replace function public.owns_account(acc uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.mt5_accounts where id = acc and owner_id = auth.uid());
$$;

-- ========== Enable RLS everywhere ==========
alter table public.profiles enable row level security;
alter table public.watchlists enable row level security;
alter table public.layouts enable row level security;
alter table public.drawings enable row level security;
alter table public.alerts enable row level security;
alter table public.bars_m1 enable row level security;
alter table public.news_sources enable row level security;
alter table public.news_items enable row level security;
alter table public.news_impacts enable row level security;
alter table public.econ_events enable row level security;
alter table public.news_price_reactions enable row level security;
alter table public.mt5_accounts enable row level security;
alter table public.mt5_account_secrets enable row level security;
alter table public.copy_links enable row level security;
alter table public.ct_seq enable row level security;
alter table public.ct_events enable row level security;
alter table public.ct_executions enable row level security;
alter table public.ct_position_map enable row level security;
alter table public.audit_log enable row level security;
alter table public.app_settings enable row level security;

-- ========== Profiles ==========
create policy "profiles: read self or staff" on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_staff());
create policy "profiles: update self" on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());
-- users may not promote themselves: role is only writable by the service role / SQL
revoke update on public.profiles from authenticated;
grant update (full_name, telegram_chat_id) on public.profiles to authenticated;

-- ========== Per-user chart state ==========
create policy "watchlists: owner" on public.watchlists for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "layouts: owner" on public.layouts for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "drawings: owner" on public.drawings for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "alerts: owner" on public.alerts for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ========== Public market & news data (read-only; writes via service role) ==========
create policy "bars: public read" on public.bars_m1 for select to anon, authenticated using (true);
create policy "news_items: public read" on public.news_items for select to anon, authenticated using (status = 'scored');
create policy "news_impacts: public read" on public.news_impacts for select to anon, authenticated using (true);
create policy "econ_events: public read" on public.econ_events for select to anon, authenticated using (true);
create policy "reactions: public read" on public.news_price_reactions for select to anon, authenticated using (true);
create policy "news_sources: staff" on public.news_sources for all to authenticated
  using (public.is_staff()) with check (public.is_staff());

-- ========== Copy trade ==========
-- Accounts: visible to their owner and staff; token_hash never leaves the database.
create policy "mt5_accounts: owner or staff read" on public.mt5_accounts for select to authenticated
  using (owner_id = auth.uid() or public.is_staff());
create policy "mt5_accounts: owner update" on public.mt5_accounts for update to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "mt5_accounts: owner delete" on public.mt5_accounts for delete to authenticated
  using (owner_id = auth.uid());
revoke select, insert, update on public.mt5_accounts from anon, authenticated;
grant select (id, owner_id, role, label, broker, server, login, currency, status, last_heartbeat_at,
              balance, equity, margin, ea_version, created_at) on public.mt5_accounts to authenticated;
grant update (label, broker) on public.mt5_accounts to authenticated;

revoke all on public.mt5_account_secrets from anon, authenticated;
revoke all on public.ct_seq from anon, authenticated;

-- Links: managed by whoever owns the master (or staff); the receiver owner can see and disable.
create policy "copy_links: read" on public.copy_links for select to authenticated
  using (public.owns_account(master_id) or public.owns_account(receiver_id) or public.is_staff());
create policy "copy_links: master owner insert" on public.copy_links for insert to authenticated
  with check (public.owns_account(master_id) or public.is_staff());
create policy "copy_links: update" on public.copy_links for update to authenticated
  using (public.owns_account(master_id) or public.owns_account(receiver_id) or public.is_staff());
create policy "copy_links: master owner delete" on public.copy_links for delete to authenticated
  using (public.owns_account(master_id) or public.is_staff());

create policy "ct_events: read" on public.ct_events for select to authenticated
  using (public.owns_account(master_id) or public.is_staff() or exists (
    select 1 from public.copy_links l where l.master_id = ct_events.master_id and public.owns_account(l.receiver_id)));
create policy "ct_executions: read" on public.ct_executions for select to authenticated
  using (public.is_staff() or exists (
    select 1 from public.copy_links l where l.id = ct_executions.link_id
      and (public.owns_account(l.master_id) or public.owns_account(l.receiver_id))));
create policy "ct_position_map: read" on public.ct_position_map for select to authenticated
  using (public.is_staff() or exists (
    select 1 from public.copy_links l where l.id = ct_position_map.link_id
      and (public.owns_account(l.master_id) or public.owns_account(l.receiver_id))));

create policy "audit_log: staff read" on public.audit_log for select to authenticated using (public.is_staff());
create policy "app_settings: staff" on public.app_settings for all to authenticated
  using (public.is_staff()) with check (public.is_staff());

-- Audit every change to copy settings, whoever makes it.
create or replace function public.audit_copy_links() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.updated_at := now();
  insert into public.audit_log (actor, action, target, detail)
  values (auth.uid(), 'copy_links.' || lower(tg_op), new.id::text,
          jsonb_build_object('old', case when tg_op = 'UPDATE' then to_jsonb(old) end, 'new', to_jsonb(new)));
  return new;
end $$;
create trigger copy_links_audit before insert or update on public.copy_links
  for each row execute function public.audit_copy_links();

-- ========== RPCs ==========

-- Register an MT5 account for the calling user. Returns the EA token and HMAC secret ONCE;
-- only the token's SHA-256 is stored.
create or replace function public.create_mt5_account(
  p_role text, p_label text, p_server text, p_login bigint, p_broker text default null
) returns table (account_id uuid, ea_token text, hmac_secret text)
language plpgsql security definer set search_path = '' as $$
declare
  v_token text := encode(extensions.gen_random_bytes(32), 'hex');
  v_secret text := encode(extensions.gen_random_bytes(32), 'hex');
  v_id uuid;
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '28000'; end if;
  insert into public.mt5_accounts (owner_id, role, label, server, login, broker, token_hash)
  values (auth.uid(), p_role, p_label, p_server, p_login, p_broker,
          encode(extensions.digest(v_token, 'sha256'), 'hex'))
  returning id into v_id;
  insert into public.mt5_account_secrets (account_id, hmac_secret) values (v_id, v_secret);
  if p_role = 'master' then insert into public.ct_seq (master_id) values (v_id); end if;
  insert into public.audit_log (actor, action, target) values (auth.uid(), 'mt5_accounts.create', v_id::text);
  return query select v_id, v_token, v_secret;
end $$;
revoke all on function public.create_mt5_account from public, anon;
grant execute on function public.create_mt5_account to authenticated;

-- Issue a new token + secret (the old ones stop working immediately).
create or replace function public.rotate_mt5_token(p_account uuid)
returns table (ea_token text, hmac_secret text)
language plpgsql security definer set search_path = '' as $$
declare
  v_token text := encode(extensions.gen_random_bytes(32), 'hex');
  v_secret text := encode(extensions.gen_random_bytes(32), 'hex');
begin
  if not exists (select 1 from public.mt5_accounts where id = p_account and owner_id = auth.uid()) then
    raise exception 'not your account' using errcode = '42501';
  end if;
  update public.mt5_accounts set token_hash = encode(extensions.digest(v_token, 'sha256'), 'hex') where id = p_account;
  update public.mt5_account_secrets set hmac_secret = v_secret, rotated_at = now() where account_id = p_account;
  insert into public.audit_log (actor, action, target) values (auth.uid(), 'mt5_accounts.rotate', p_account::text);
  return query select v_token, v_secret;
end $$;
revoke all on function public.rotate_mt5_token from public, anon;
grant execute on function public.rotate_mt5_token to authenticated;

-- Edge Function (service role): resolve an EA token to its account and secret.
create or replace function public.ct_auth(p_token text)
returns table (account_id uuid, role text, hmac_secret text)
language sql stable security definer set search_path = '' as $$
  select a.id, a.role, s.hmac_secret
  from public.mt5_accounts a join public.mt5_account_secrets s on s.account_id = a.id
  where a.token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex');
$$;

-- Edge Function (service role): append a batch of master events. Duplicate event_uids keep their
-- original seq, so a master EA can safely resend after a timeout.
create or replace function public.ct_append_events(p_master uuid, p_events jsonb)
returns table (event_uid text, seq bigint, duplicate boolean)
language plpgsql security definer set search_path = '' as $$
declare
  e jsonb;
  v_seq bigint;
  v_existing bigint;
begin
  perform 1 from public.ct_seq where master_id = p_master for update;  -- serialise per master
  if not found then raise exception 'not a master account' using errcode = '42501'; end if;
  for e in select * from jsonb_array_elements(p_events) loop
    select ce.seq into v_existing from public.ct_events ce
      where ce.master_id = p_master and ce.event_uid = e ->> 'event_uid';
    if v_existing is not null then
      event_uid := e ->> 'event_uid'; seq := v_existing; duplicate := true; return next;
      continue;
    end if;
    update public.ct_seq set last_seq = last_seq + 1 where master_id = p_master returning last_seq into v_seq;
    insert into public.ct_events (master_id, seq, event_uid, type, payload, master_ts)
    values (p_master, v_seq, e ->> 'event_uid', e ->> 'type', e,
            to_timestamp((e ->> 'ts_ms')::double precision / 1000));
    event_uid := e ->> 'event_uid'; seq := v_seq; duplicate := false; return next;
  end loop;
end $$;

-- Edge Function (service role): events after `p_since` for one receiver's link to a master.
create or replace function public.ct_pull(p_receiver uuid, p_master uuid, p_since bigint, p_limit int default 100)
returns table (seq bigint, payload jsonb)
language sql stable security definer set search_path = '' as $$
  select e.seq, e.payload
  from public.ct_events e
  join public.copy_links l on l.master_id = e.master_id and l.receiver_id = p_receiver
  where e.master_id = p_master and e.seq > p_since
  order by e.seq
  limit least(p_limit, 500);
$$;

revoke all on function public.ct_auth, public.ct_append_events, public.ct_pull from public, anon, authenticated;

-- ========== Realtime ==========
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.news_items, public.mt5_accounts, public.ct_executions;
  end if;
end $$;
