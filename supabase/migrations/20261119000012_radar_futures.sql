-- Market radar: USDT perpetuals. The scan now also reads the perpetuals of Binance, Bybit, OKX, Gate and KuCoin:
-- which exchanges list each coin (stored on every spot arbitrage row, as "futures") and the gap between one coin's
-- perpetuals on two exchanges, with funding. That second list goes to its own column.

alter table public.radar_snapshot
  add column futures jsonb not null default '{}'; -- {arbitrage: [{base, long, short, gross, funding8h, ...}], status: {"BINANCE": {ok, contracts}}, coins}

create or replace function public.radar_save(p_snapshot jsonb, p_state jsonb, p_listings jsonb)
returns int
language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  insert into public.radar_snapshot (id, arbitrage, pumps, status, rates, futures, updated_at)
  values (1, coalesce(p_snapshot -> 'arbitrage', '[]'), coalesce(p_snapshot -> 'pumps', '[]'),
          coalesce(p_snapshot -> 'status', '{}'), coalesce(p_snapshot -> 'rates', '{}'), coalesce(p_snapshot -> 'futures', '{}'), now())
  on conflict (id) do update set arbitrage = excluded.arbitrage, pumps = excluded.pumps, status = excluded.status,
    rates = excluded.rates, futures = excluded.futures, updated_at = now();
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

revoke all on function public.radar_save from public, anon, authenticated;
