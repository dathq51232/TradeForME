-- Market radar: cross-exchange arbitrage, pump detection and new listings on seven crypto exchanges.
-- The Edge Function radar-cron (pg_cron, every minute) scans the public APIs and stores the latest results
-- here; the /radar page reads them. Users who switch alerts on get notifications (and Telegram) through
-- radar_notify(), with their own thresholds and fees. Read-only market data: nothing places an order.

-- ---------- latest scan (one row) ----------
create table public.radar_snapshot (
  id smallint primary key default 1 check (id = 1),
  arbitrage jsonb not null default '[]',   -- [{base, buy, sell, gross, depth: {"100": {gross, full}, ...}, suspect, ...}]
  pumps jsonb not null default '[]',       -- [{base, native, score, stage, chg5m, chg15m, chg60m, volRatio, ...}]
  status jsonb not null default '{}',      -- {"BINANCE": {ok, pairs} | {ok: false, error}}
  rates jsonb not null default '{}',       -- {USD, USDT, USDC, source}
  updated_at timestamptz not null default now()
);

-- ---------- pairs that appeared, or opened for trading ----------
create table public.radar_listings (
  id bigserial primary key,
  exchange text not null,
  native text not null,
  base text not null,
  quote text not null,
  kind text not null check (kind in ('new', 'opened')),
  status text not null,
  opens_at timestamptz,
  elsewhere text[] not null default '{}',  -- exchanges where the coin already trades
  seen_at timestamptz not null default now()
);
create index radar_listings_seen on public.radar_listings (seen_at desc);

-- ---------- per-user alert settings ----------
create table public.radar_settings (
  user_id uuid primary key references public.profiles on delete cascade,
  alerts_on boolean not null default false,
  arb_alert numeric not null default 1 check (arb_alert between -5 and 100),     -- net %, after fees and slippage on $1,000
  pump_alert int not null default 60 check (pump_alert between 0 and 100),        -- pump score
  listing_alert boolean not null default true,
  min_vol numeric not null default 100000 check (min_vol >= 0),                   -- 24h volume in USD
  fees jsonb not null default '{"BINANCE":0.1,"OKX":0.1,"BYBIT":0.1,"KRAKEN":0.4,"KUCOIN":0.1,"GATE":0.1,"COINBASE":0.6}',
  updated_at timestamptz not null default now()
);

alter table public.radar_snapshot enable row level security;
alter table public.radar_listings enable row level security;
alter table public.radar_settings enable row level security;
create policy "radar_snapshot: signed-in read" on public.radar_snapshot for select to authenticated using (true);
create policy "radar_listings: signed-in read" on public.radar_listings for select to authenticated using (true);
create policy "radar_settings: owner" on public.radar_settings for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
revoke all on public.radar_snapshot, public.radar_listings from anon;
revoke insert, update, delete on public.radar_snapshot, public.radar_listings from authenticated;
revoke all on public.radar_settings from anon;

-- ---------- scanner state and alert cooldowns (service role only) ----------
create table private.radar_state (key text primary key, value jsonb not null, updated_at timestamptz not null default now());
create table private.radar_sent (user_id uuid not null, key text not null, sent_at timestamptz not null default now(),
  primary key (user_id, key));

create or replace function public.radar_state_get()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_object_agg(key, value), '{}') from private.radar_state;
$$;

-- Stores one scan: the snapshot, the scanner's state (price history, known pair lists) and new listings.
create or replace function public.radar_save(p_snapshot jsonb, p_state jsonb, p_listings jsonb)
returns int
language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  insert into public.radar_snapshot (id, arbitrage, pumps, status, rates, updated_at)
  values (1, coalesce(p_snapshot -> 'arbitrage', '[]'), coalesce(p_snapshot -> 'pumps', '[]'),
          coalesce(p_snapshot -> 'status', '{}'), coalesce(p_snapshot -> 'rates', '{}'), now())
  on conflict (id) do update set arbitrage = excluded.arbitrage, pumps = excluded.pumps, status = excluded.status,
    rates = excluded.rates, updated_at = now();
  insert into private.radar_state (key, value, updated_at)
  select key, value, now() from jsonb_each(coalesce(p_state, '{}'))
  on conflict (key) do update set value = excluded.value, updated_at = now();
  insert into public.radar_listings (exchange, native, base, quote, kind, status, opens_at, elsewhere)
  select l ->> 'exchange', l ->> 'native', l ->> 'base', l ->> 'quote', l ->> 'kind', l ->> 'status',
         (l ->> 'opens_at')::timestamptz, coalesce(array(select jsonb_array_elements_text(l -> 'elsewhere')), '{}')
  from jsonb_array_elements(coalesce(p_listings, '[]')) l;
  get diagnostics v_n = row_count;
  delete from public.radar_listings where id in (select id from public.radar_listings order by seen_at desc, id desc offset 1000);
  delete from private.radar_sent where sent_at < now() - interval '1 day';
  return v_n;
end $$;

-- Turns scan results into notifications for users with alerts on, each with their own thresholds and fees,
-- at most once per coin/pair every 30 minutes. Returns [{chat_id, text}] for the Telegram messages to send.
-- p_events: [{type: 'arbitrage', key, base, buy, sell, gross, vol} | {type: 'pump', key, base, score, chg15m, vol_ratio, vol}
--            | {type: 'listing', key, exchange, base, quote, kind, status, elsewhere}]
create or replace function public.radar_notify(p_events jsonb)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  e jsonb; s record; v_net numeric; v_title text; v_body text; v_rows int; v_out jsonb := '[]';
begin
  for e in select * from jsonb_array_elements(coalesce(p_events, '[]')) loop
    for s in
      select r.*, p.telegram_chat_id from public.radar_settings r join public.profiles p on p.id = r.user_id where r.alerts_on
    loop
      v_title := null;
      if e ->> 'type' = 'arbitrage' then
        v_net := (e ->> 'gross')::numeric - coalesce((s.fees ->> (e ->> 'buy'))::numeric, 0.1) - coalesce((s.fees ->> (e ->> 'sell'))::numeric, 0.1);
        if v_net >= s.arb_alert and coalesce((e ->> 'vol')::numeric, 0) >= s.min_vol then
          v_title := format('Chênh lệch %s: %s%%', e ->> 'base', round(v_net, 2));
          v_body := format('Mua trên %s, bán trên %s: %s%% sau phí và trượt giá với $1,000. Kiểm tra nạp/rút trên cả hai sàn trước khi làm gì.',
                           e ->> 'buy', e ->> 'sell', round(v_net, 2));
        end if;
      elsif e ->> 'type' = 'pump' then
        if (e ->> 'score')::int >= s.pump_alert and coalesce((e ->> 'vol')::numeric, 0) >= s.min_vol then
          v_title := format('%s đang bị bơm (điểm %s)', e ->> 'base', e ->> 'score');
          v_body := format('+%s%% trong 15 phút, khối lượng gấp %s lần bình thường (Binance).', e ->> 'chg15m', e ->> 'vol_ratio');
        end if;
      elsif e ->> 'type' = 'listing' then
        if s.listing_alert then
          v_title := format('Niêm yết mới: %s/%s trên %s', e ->> 'base', e ->> 'quote', e ->> 'exchange');
          v_body := case
            when e ->> 'kind' = 'opened' then 'Đã mở giao dịch.'
            when e ->> 'status' = 'pre' then 'Đã niêm yết, chưa mở giao dịch.'
            else 'Đang giao dịch.' end
            || case when jsonb_array_length(coalesce(e -> 'elsewhere', '[]')) > 0
                    then ' Đã có trên ' || (select string_agg(x, ', ') from jsonb_array_elements_text(e -> 'elsewhere') x) || '.'
                    else ' Chưa có trên các sàn khác.' end;
        end if;
      end if;
      continue when v_title is null;
      insert into private.radar_sent (user_id, key, sent_at) values (s.user_id, e ->> 'key', now())
      on conflict (user_id, key) do update set sent_at = now()
        where private.radar_sent.sent_at < now() - interval '30 minutes';
      get diagnostics v_rows = row_count;
      continue when v_rows = 0;
      insert into public.notifications (user_id, level, title, body, link) values (s.user_id, 'info', v_title, v_body, '/radar');
      if nullif(s.telegram_chat_id, '') is not null then
        v_out := v_out || jsonb_build_object('chat_id', s.telegram_chat_id, 'text', '📡 ' || v_title || E'\n' || v_body);
      end if;
    end loop;
  end loop;
  return v_out;
end $$;

-- Called once after deploy with the function URL, like schedule_market_cron().
create or replace function public.schedule_radar_cron(p_url text)
returns text
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron')
     or not exists (select 1 from pg_extension where extname = 'pg_net') then
    return 'pg_cron/pg_net not installed: radar-cron not scheduled';
  end if;
  execute 'select cron.schedule($1, $2, $3)' using 'qt-radar', '* * * * *', format(
    $cmd$select net.http_post(url := %L, body := '{}'::jsonb,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-qt-cron', (select secret from private.cron_secret limit 1)),
      timeout_milliseconds := 55000)$cmd$, p_url);
  return 'scheduled qt-radar every minute -> ' || p_url;
end $$;

revoke all on function public.radar_state_get, public.radar_save, public.radar_notify, public.schedule_radar_cron
  from public, anon, authenticated;
