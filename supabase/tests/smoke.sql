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
  select count(*) into n from public.ct_pull(r, m, 0);
  assert n = 2, 'receiver pulls both events';
  select count(*) into n from public.ct_pull(r, m, 1);
  assert n = 1, 'pull is incremental';
  select count(*) into n from public.ct_pull(m, m, 0);
  assert n = 0, 'an unlinked account pulls nothing';
  assert (select count(*) from public.audit_log where action like 'copy_links.%') = 1, 'link creation is audited';
end $$;

-- ---- as Bob: he can read events of a master he is linked to ----
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000b","role":"authenticated"}', true);
do $$ begin
  assert (select count(*) from public.ct_events) = 2, 'linked receiver owner reads master events';
  assert (select count(*) from public.copy_links) = 1, 'receiver owner sees the link';
end $$;

reset role;
select 'smoke ok' as result;
rollback;
