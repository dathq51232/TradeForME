-- Local/dev seed (supabase db reset). Production news sources are managed from /admin.
insert into public.news_sources (name, url, kind, assets, weight, interval_min) values
  ('Federal Reserve – Press releases', 'https://www.federalreserve.gov/feeds/press_all.xml', 'rss', '{XAU,BTC}', 1.5, 5),
  ('BLS – Latest numbers', 'https://www.bls.gov/feed/bls_latest.rss', 'rss', '{XAU,BTC}', 1.5, 5),
  ('EIA – Today in Energy', 'https://www.eia.gov/rss/todayinenergy.xml', 'rss', '{WTI,BRENT}', 1.2, 15),
  ('CoinDesk', 'https://www.coindesk.com/arc/outboundfeeds/rss/', 'rss', '{BTC}', 1.0, 3),
  ('Cointelegraph', 'https://cointelegraph.com/rss', 'rss', '{BTC}', 0.8, 3),
  ('Forex Factory – Weekly calendar', 'https://nfs.faireconomy.media/ff_calendar_thisweek.json', 'json', '{XAU,BTC,WTI,BRENT}', 1.0, 60)
on conflict (url) do nothing;
