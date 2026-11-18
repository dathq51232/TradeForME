-- Long-term trend alerts: right after each daily candle closes (00:00 UTC), the Edge Function pattern-cron reads the
-- daily closes of the symbols users follow (gold, silver, oil, Bitcoin...) with the shared trend rules
-- (packages/core/src/trend.js: EMA50 / EMA200, a new state confirmed by two closes) and reports
--   trend   the long-term trend changed (up / down / sideways)
--   cross   golden cross or death cross (EMA50 crossing EMA200)
--   ema200  the daily close crossed EMA200
--   weekly  every Monday, where each followed market's long-term trend stands
-- to each user who asked for it: in-app notification, and Telegram when they set a chat id. Each event is sent to
-- a user once (private.pattern_sent, keys starting with "trend|"). A reading aid, not trade signals.

create table public.trend_alert_settings (
  user_id uuid primary key references public.profiles on delete cascade,
  enabled boolean not null default false,
  symbols text[] not null default '{XAUUSD,BTCUSD,WTI,XAGUSD}',
  trend_change boolean not null default true,
  crosses boolean not null default true,
  ema200 boolean not null default false,
  weekly boolean not null default false,
  updated_at timestamptz not null default now()
);
alter table public.trend_alert_settings enable row level security;
create policy "trend_alert_settings: owner" on public.trend_alert_settings for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
revoke all on public.trend_alert_settings from anon;

-- Which symbols anyone follows: ["XAUUSD", ...].
create or replace function public.trend_jobs()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(distinct s), '[]')
  from public.trend_alert_settings t, unnest(t.symbols) s
  where t.enabled;
$$;

-- p_events: [{type: 'trend'|'cross'|'ema200'|'weekly', symbol, key, title, body}]
-- Notifies each user following that symbol and kind of event, once per key. Returns [{chat_id, text}] for Telegram.
create or replace function public.trend_notify(p_events jsonb)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare e jsonb; s record; v_rows int; v_out jsonb := '[]';
begin
  for e in select * from jsonb_array_elements(coalesce(p_events, '[]')) loop
    for s in
      select t.user_id, pr.telegram_chat_id from public.trend_alert_settings t join public.profiles pr on pr.id = t.user_id
      where t.enabled and (e ->> 'symbol') = any (t.symbols)
        and case e ->> 'type' when 'trend' then t.trend_change when 'cross' then t.crosses
                              when 'ema200' then t.ema200 when 'weekly' then t.weekly else false end
    loop
      insert into private.pattern_sent (user_id, key) values (s.user_id, e ->> 'key') on conflict do nothing;
      get diagnostics v_rows = row_count;
      continue when v_rows = 0;
      insert into public.notifications (user_id, level, title, body, link)
      values (s.user_id, 'info', e ->> 'title', e ->> 'body', '/charts?symbol=' || (e ->> 'symbol'));
      if nullif(s.telegram_chat_id, '') is not null then
        v_out := v_out || jsonb_build_object('chat_id', s.telegram_chat_id, 'text', '📈 ' || (e ->> 'title') || E'\n' || coalesce(e ->> 'body', ''));
      end if;
    end loop;
  end loop;
  return v_out;
end $$;

revoke all on function public.trend_jobs, public.trend_notify from public, anon, authenticated;
