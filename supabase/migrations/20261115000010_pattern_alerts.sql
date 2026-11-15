-- Pattern alerts on Telegram: the Edge Function pattern-cron (pg_cron, every minute) reads the chart's automatic
-- pattern recognition on each closed candle of the symbols and timeframes users follow, and reports
--   formed    a chart pattern (triangle, wedge, double top, head and shoulders...) has formed
--   breakout  a chart pattern broke out (a close past its boundary)
--   wedge     a small continuation wedge is ready to break, or broke
--   candle    a candlestick pattern on the candle that just closed
-- to each user who asked for it: in-app notification, and Telegram when they set a chat id. Each event is sent to
-- a user once. A reading aid, not trade signals.

create table public.pattern_alert_settings (
  user_id uuid primary key references public.profiles on delete cascade,
  enabled boolean not null default false,
  symbols text[] not null default '{XAUUSD,BTCUSD}',
  timeframes text[] not null default '{1h,4h}'
    check (timeframes <@ array['5m', '15m', '1h', '4h', '1D']),
  formed boolean not null default true,
  breakout boolean not null default true,
  wedges boolean not null default true,
  candles boolean not null default false,
  updated_at timestamptz not null default now()
);
alter table public.pattern_alert_settings enable row level security;
create policy "pattern_alert_settings: owner" on public.pattern_alert_settings for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
revoke all on public.pattern_alert_settings from anon;

-- events already sent to each user (kept 30 days)
create table private.pattern_sent (user_id uuid not null, key text not null, sent_at timestamptz not null default now(),
  primary key (user_id, key));

-- Which (symbol, timeframe) pairs anyone follows: [{symbol, tf}].
create or replace function public.pattern_jobs()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(distinct jsonb_build_object('symbol', s, 'tf', t)), '[]')
  from public.pattern_alert_settings p, unnest(p.symbols) s, unnest(p.timeframes) t
  where p.enabled;
$$;

-- The newest broker M1 bars of a symbol (pushed by a master EA), newest first, like the chart reads them.
create or replace function public.broker_bars_m1(p_symbol text, p_limit int)
returns table (ts timestamptz, o numeric, h numeric, l numeric, c numeric, v numeric)
language sql stable security definer set search_path = '' as $$
  select b.ts, b.o, b.h, b.l, b.c, b.v from public.bars_m1 b where b.symbol = p_symbol
  order by b.ts desc limit least(greatest(p_limit, 1), 20000);
$$;

-- p_events: [{type: 'formed'|'breakout'|'wedge'|'candle', symbol, tf, key, title, body}]
-- Notifies each user following that symbol, timeframe and kind of event, once per key.
-- Returns [{chat_id, text}] for the Telegram messages to send.
create or replace function public.pattern_notify(p_events jsonb)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare e jsonb; s record; v_rows int; v_out jsonb := '[]';
begin
  for e in select * from jsonb_array_elements(coalesce(p_events, '[]')) loop
    for s in
      select p.user_id, pr.telegram_chat_id from public.pattern_alert_settings p join public.profiles pr on pr.id = p.user_id
      where p.enabled and (e ->> 'symbol') = any (p.symbols) and (e ->> 'tf') = any (p.timeframes)
        and case e ->> 'type' when 'formed' then p.formed when 'breakout' then p.breakout
                              when 'wedge' then p.wedges when 'candle' then p.candles else false end
    loop
      insert into private.pattern_sent (user_id, key) values (s.user_id, e ->> 'key') on conflict do nothing;
      get diagnostics v_rows = row_count;
      continue when v_rows = 0;
      insert into public.notifications (user_id, level, title, body, link)
      values (s.user_id, 'info', e ->> 'title', e ->> 'body', '/charts?symbol=' || (e ->> 'symbol'));
      if nullif(s.telegram_chat_id, '') is not null then
        v_out := v_out || jsonb_build_object('chat_id', s.telegram_chat_id, 'text', '📐 ' || (e ->> 'title') || E'\n' || coalesce(e ->> 'body', ''));
      end if;
    end loop;
  end loop;
  delete from private.pattern_sent where sent_at < now() - interval '30 days';
  return v_out;
end $$;

-- Called once after deploy with the function URL, like schedule_market_cron().
create or replace function public.schedule_pattern_cron(p_url text)
returns text
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron')
     or not exists (select 1 from pg_extension where extname = 'pg_net') then
    return 'pg_cron/pg_net not installed: pattern-cron not scheduled';
  end if;
  execute 'select cron.schedule($1, $2, $3)' using 'qt-patterns', '* * * * *', format(
    $cmd$select net.http_post(url := %L, body := '{}'::jsonb,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-qt-cron', (select secret from private.cron_secret limit 1)),
      timeout_milliseconds := 55000)$cmd$, p_url);
  return 'scheduled qt-patterns every minute -> ' || p_url;
end $$;

revoke all on function public.pattern_jobs, public.broker_bars_m1, public.pattern_notify, public.schedule_pattern_cron
  from public, anon, authenticated;
