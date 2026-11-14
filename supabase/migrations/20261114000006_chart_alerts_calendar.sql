-- Chart package 1: price alerts checked by the server every minute, and the economic calendar kept in
-- econ_events (the public feed only covers the current week, so the table builds the history).
-- Both run in the Edge Function market-cron, which pg_cron calls through pg_net once a minute.

-- ---------- economic calendar: keep the provider's text ("0.3%", "215K") next to the parsed number ----------
alter table public.econ_events
  add column forecast_text text,
  add column previous_text text,
  add column actual_text text;

-- ---------- price alerts ----------
-- rule = {"kind": "price", "op": "above" | "below", "price": 2650.5}; one-shot: disarmed when it fires.
alter table public.alerts
  add column symbol text,
  add column last_price numeric,          -- price seen at the previous check (to detect the cross)
  add column fired_price numeric;
create index alerts_active_symbol on public.alerts (symbol) where active;

-- Fires one alert: disarm it and notify its owner. Returns the owner's Telegram chat id, if set.
create or replace function public.fire_alert(p_alert uuid, p_price numeric)
returns text
language plpgsql security definer set search_path = '' as $$
declare a public.alerts; v_chat text;
begin
  update public.alerts set active = false, last_fired_at = now(), fired_price = p_price, last_price = p_price
  where id = p_alert and active returning * into a;
  if a.id is null then return null; end if;
  insert into public.notifications (user_id, level, title, body, link)
  values (a.user_id, 'warning',
          format('%s %s %s', a.symbol, case a.rule ->> 'op' when 'above' then 'vượt lên' else 'xuống dưới' end, a.rule ->> 'price'),
          format('Giá hiện tại %s. %s', p_price, coalesce(a.name, '')), '/charts?symbol=' || a.symbol);
  select telegram_chat_id into v_chat from public.profiles where id = a.user_id;
  return nullif(v_chat, '');
end $$;
revoke all on function public.fire_alert from public, anon, authenticated;

-- ---------- scheduler: pg_cron -> pg_net -> Edge Function market-cron ----------
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
create table private.cron_secret (secret text not null);
insert into private.cron_secret values (encode(extensions.gen_random_bytes(32), 'hex'));

-- The Edge Function checks the header it receives against the stored secret.
create or replace function public.cron_secret_ok(p_secret text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from private.cron_secret where secret = p_secret);
$$;
revoke all on function public.cron_secret_ok from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_net with schema extensions;
  end if;
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
  end if;
end $$;

-- Called once after deploy with the function URL (the project ref is not known inside a migration).
create or replace function public.schedule_market_cron(p_url text)
returns text
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron')
     or not exists (select 1 from pg_extension where extname = 'pg_net') then
    return 'pg_cron/pg_net not installed: market-cron not scheduled';
  end if;
  execute 'select cron.schedule($1, $2, $3)' using 'qt-market', '* * * * *', format(
    $cmd$select net.http_post(url := %L, body := '{}'::jsonb,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-qt-cron', (select secret from private.cron_secret limit 1)),
      timeout_milliseconds := 25000)$cmd$, p_url);
  return 'scheduled qt-market every minute -> ' || p_url;
end $$;
revoke all on function public.schedule_market_cron from public, anon, authenticated;

-- ---------- RPCs used by market-cron (service role only) ----------
-- Symbols that have armed alerts.
create or replace function public.alert_symbols()
returns text[] language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(distinct symbol), '{}') from public.alerts where active and symbol is not null;
$$;

-- Checks every armed alert against the latest price and fires those whose level was crossed since the
-- previous check. p_prices = {"XAUUSD": 2650.1, ...} from public feeds; a broker M1 close pushed by a
-- master EA in the last 3 minutes wins, so alerts follow the same prices as the chart.
-- Returns [{chat_id, text}] for the Telegram messages to send.
create or replace function public.check_alerts(p_prices jsonb)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r record; v_chat text; v_out jsonb := '[]';
begin
  for r in
    with ext as (select key as symbol, value::numeric as price from jsonb_each_text(p_prices)),
    syms as (select distinct symbol from public.alerts where active and symbol is not null),
    px as (
      select s.symbol, coalesce(
        (select b.c from public.bars_m1 b where b.symbol = s.symbol and b.ts > now() - interval '3 minutes' order by b.ts desc limit 1),
        (select e.price from ext e where e.symbol = s.symbol)) as price
      from syms s)
    select a.id, a.symbol, a.rule, a.last_price, px.price
    from public.alerts a join px on px.symbol = a.symbol
    where a.active and px.price is not null
  loop
    if r.last_price is not null and (
         (r.rule ->> 'op' = 'above' and r.last_price < (r.rule ->> 'price')::numeric and r.price >= (r.rule ->> 'price')::numeric)
      or (r.rule ->> 'op' = 'below' and r.last_price > (r.rule ->> 'price')::numeric and r.price <= (r.rule ->> 'price')::numeric)) then
      v_chat := public.fire_alert(r.id, r.price);
      if v_chat is not null then
        v_out := v_out || jsonb_build_object('chat_id', v_chat, 'text', format('🔔 %s %s %s (giá %s)', r.symbol,
          case r.rule ->> 'op' when 'above' then 'vượt lên' else 'xuống dưới' end, r.rule ->> 'price', r.price));
      end if;
    else
      update public.alerts set last_price = r.price where id = r.id;
    end if;
  end loop;
  return v_out;
end $$;

-- Calendar: refresh at most every 30 minutes.
create or replace function public.calendar_due()
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(max(updated_at) < now() - interval '30 minutes', true) from public.econ_events;
$$;

-- p = [{country, title, scheduled_at, importance, forecast_text, previous_text, actual_text, forecast, previous, actual, assets}]
create or replace function public.upsert_econ_events(p jsonb)
returns int
language sql security definer set search_path = '' as $$
  with rows as (
    insert into public.econ_events (country, title, scheduled_at, importance, forecast, previous, actual,
                                    forecast_text, previous_text, actual_text, assets, updated_at)
    select e ->> 'country', e ->> 'title', (e ->> 'scheduled_at')::timestamptz, (e ->> 'importance')::smallint,
           (e ->> 'forecast')::numeric, (e ->> 'previous')::numeric, (e ->> 'actual')::numeric,
           e ->> 'forecast_text', e ->> 'previous_text', e ->> 'actual_text',
           coalesce(array(select jsonb_array_elements_text(e -> 'assets')), '{}'), now()
    from jsonb_array_elements(p) e
    on conflict (country, title, scheduled_at) do update set
      importance = excluded.importance, forecast = excluded.forecast, previous = excluded.previous,
      actual = coalesce(excluded.actual, public.econ_events.actual),
      forecast_text = excluded.forecast_text, previous_text = excluded.previous_text,
      actual_text = coalesce(excluded.actual_text, public.econ_events.actual_text),
      assets = excluded.assets, updated_at = now()
    returning 1)
  select count(*)::int from rows;
$$;
revoke all on function public.alert_symbols, public.check_alerts, public.calendar_due, public.upsert_econ_events from public, anon, authenticated;
