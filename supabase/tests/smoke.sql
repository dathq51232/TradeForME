-- Smoke test for RLS and the copy-trade RPCs. Runs in one transaction and rolls back.
-- CI: psql ... -f supabase/tests/smoke.sql   (after `supabase db start`)
begin;

-- Two users: Alice runs the master, Bob owns a receiver.
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-00000000000a', 'alice@example.test', '{"full_name":"Alice"}'),
  ('00000000-0000-0000-0000-00000000000b', 'bob@example.test', '{}');

do $$ begin
  assert (select count(*) from public.profiles where id in ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000b')) = 2,
    'profiles are created by the auth trigger';
  assert (select full_name from public.profiles where id = '00000000-0000-0000-0000-00000000000b') = 'bob',
    'full_name falls back to the email name';
end $$;

create temp table t_ids (k text primary key, v text) on commit drop;
grant all on t_ids to authenticated;

-- ---- as Alice: create a master account ----
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}', true);
insert into t_ids select 'master', account_id::text from public.create_mt5_account('master', 'Master XAU', 'Broker-Live', 1001);

do $$ begin
  -- token_hash is not readable by users
  begin
    perform token_hash from public.mt5_accounts;
    raise exception 'token_hash must not be selectable';
  exception when insufficient_privilege then null;
  end;
  -- users cannot promote themselves
  begin
    update public.profiles set role = 'admin' where id = auth.uid();
    raise exception 'role must not be updatable';
  exception when insufficient_privilege then null;
  end;
end $$;

-- ---- as Bob: create a receiver; Bob must not see Alice's master ----
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000b","role":"authenticated"}', true);
insert into t_ids select 'receiver', account_id::text from public.create_mt5_account('receiver', 'Bob receiver', 'Broker-Live', 2002);

do $$ begin
  assert (select count(*) from public.mt5_accounts) = 1, 'Bob sees only his own account';
  -- Bob cannot link Alice's master to himself
  begin
    insert into public.copy_links (master_id, receiver_id)
    select (select v::uuid from t_ids where k = 'master'), (select v::uuid from t_ids where k = 'receiver');
    raise exception 'receiver owner must not create links';
  exception when insufficient_privilege then null;
  end;
end $$;

-- ---- as Alice: link her master to Bob's receiver ----
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}', true);
insert into public.copy_links (master_id, receiver_id, enabled)
select (select v::uuid from t_ids where k = 'master'), (select v::uuid from t_ids where k = 'receiver'), true;

-- linking created the master's copy group, paused by default; Alice starts it
do $$ begin
  assert (select state from public.copy_groups) = 'paused', 'a new group starts paused';
  assert (select count(*) from public.copy_links where group_id is not null) = 1, 'link is assigned to the group';
end $$;
insert into t_ids select 'group', id::text from public.copy_groups;
select public.copy_group_control((select v::uuid from t_ids where k = 'group'), 'start');

-- ---- as Bob: he cannot control Alice's group ----
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000b","role":"authenticated"}', true);
do $$ begin
  assert (select count(*) from public.copy_groups) = 1, 'receiver owner sees the group';
  assert (select mine from public.copy_group_receivers((select v::uuid from t_ids where k = 'group'))), 'Bob sees his receiver in the group';
  begin
    perform public.copy_group_control((select v::uuid from t_ids where k = 'group'), 'stop');
    raise exception 'receiver owner must not control the group';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.copy_groups set state = 'running';
    raise exception 'state must not be writable directly';
  exception when insufficient_privilege then null;
  end;
end $$;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}', true);

-- anon sees no accounts and no unscored news
set local role anon;
do $$ begin
  assert (select count(*) from public.news_items where status <> 'scored') = 0, 'anon reads scored news only';
end $$;

-- ---- service role (Edge Functions): append, dedupe, pull ----
reset role;
do $$
declare
  m uuid := (select v::uuid from t_ids where k = 'master');
  r uuid := (select v::uuid from t_ids where k = 'receiver');
  n int;
begin
  perform public.ct_append_events(m, '[
    {"event_uid":"1001-DEAL-1","type":"OPEN","master_ticket":1,"symbol":"XAUUSD","side":"BUY","volume":0.5,"price":2650.3,"master_equity":10000,"ts_ms":1794567890123},
    {"event_uid":"1001-DEAL-2","type":"CLOSE","master_ticket":1,"ts_ms":1794567899123}
  ]'::jsonb);
  -- resend the first one: must keep seq 1 and not create a row
  assert (select seq from public.ct_append_events(m, '[{"event_uid":"1001-DEAL-1","type":"OPEN","ts_ms":1}]'::jsonb)) = 1,
    'duplicate keeps its original seq';
  assert (select count(*) from public.ct_events where master_id = m) = 2, 'no duplicate rows';
  select count(*) into n from public.ct_pull(r, m, 0) where skip_reason is null;
  assert n = 2, 'running group: receiver gets both events';
  select count(*) into n from public.ct_pull(r, m, 1);
  assert n = 1, 'pull is incremental';
  select count(*) into n from public.ct_pull(m, m, 0);
  assert n = 0, 'an unlinked account pulls nothing';
  assert (select count(*) from public.audit_log where action like 'copy_links.%') = 1, 'link creation is audited';

  -- paused: exits still flow, opens are returned as skipped so the EA advances past them
  update public.copy_groups set state = 'paused' where master_id = m;
  assert (select skip_reason from public.ct_pull(r, m, 0) where seq = 1) = 'group_paused', 'paused group skips OPEN';
  assert (select skip_reason from public.ct_pull(r, m, 1) where seq = 2) is null, 'paused group still delivers CLOSE';
  -- global pause acts like paused
  update public.copy_groups set state = 'running' where master_id = m;
  update public.app_settings set value = 'true' where key = 'copy_global_pause';
  assert (select skip_reason from public.ct_pull(r, m, 0) where seq = 1) = 'group_paused', 'global pause skips OPEN';
  update public.app_settings set value = 'false' where key = 'copy_global_pause';
  -- emergency: nothing but KILL
  update public.copy_groups set state = 'emergency' where master_id = m;
  select count(*) into n from public.ct_pull(r, m, 0) where skip_reason is null;
  assert n = 0, 'emergency delivers nothing';
end $$;

-- ---- as Alice: leaving emergency needs a reason; Close All needs the group name ----
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}', true);
do $$
declare g uuid := (select v::uuid from t_ids where k = 'group');
begin
  begin
    perform public.copy_group_control(g, 'resume');
    raise exception 'resume from emergency without reason must fail';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.copy_request_close_all(g, 'wrong name');
    raise exception 'close all without the right name must fail';
  exception when invalid_parameter_value then null;
  end;
  assert (select label from public.copy_group_receivers(g)) = 'Bob receiver', 'master owner sees receiver status';
  assert (select count(*) from public.mt5_accounts) = 1, 'but not the receiver account row itself';
  perform public.copy_request_close_all(g, 'Master XAU');
  assert public.copy_pause_all() = 0, 'nothing running to pause';
  perform public.copy_group_control(g, 'resume', 'checked positions');
  assert public.copy_pause_all('end of day') = 1, 'pause all pauses the running group';
end $$;

reset role;
do $$
declare
  m uuid := (select v::uuid from t_ids where k = 'master');
  r uuid := (select v::uuid from t_ids where k = 'receiver');
begin
  update public.copy_groups set state = 'emergency' where master_id = m;
  assert (select count(*) from public.ct_pull(r, m, 2) where payload ->> 'type' = 'KILL' and skip_reason is null) = 1,
    'KILL reaches receivers even in emergency';
  assert (select count(*) from public.audit_log where action like 'copy_groups.%') = 4,
    'start, close_all, resume and pause_all are audited; failed attempts are not';
end $$;

-- ---- as Bob: he can read events of a master he is linked to ----
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000b","role":"authenticated"}', true);
do $$ begin
  assert (select count(*) from public.ct_events) = 3, 'linked receiver owner reads master events (incl. KILL)';
  assert (select count(*) from public.copy_links) = 1, 'receiver owner sees the link';
end $$;

reset role;
select 'smoke ok' as result;
rollback;
