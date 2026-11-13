-- Quant Terminal Cloud — core schema (docs/THIET-KE-HE-THONG.md §7)
create extension if not exists pgcrypto with schema extensions;

-- ========== Users ==========
create table public.profiles (
  id uuid primary key references auth.users on delete cascade,
  full_name text,
  role text not null default 'user' check (role in ('admin', 'manager', 'user')),
  telegram_chat_id text,
  created_at timestamptz not null default now()
);

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)));
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ========== Charts ==========
create table public.watchlists (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles on delete cascade,
  name text not null,
  symbols text[] not null default '{}',
  created_at timestamptz not null default now()
);

create table public.layouts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles on delete cascade,
  name text not null,
  state jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

create table public.drawings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles on delete cascade,
  symbol text not null,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
create index on public.drawings (user_id, symbol);

create table public.alerts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles on delete cascade,
  name text,
  rule jsonb not null,
  channels text[] not null default '{web}',
  active boolean not null default true,
  last_fired_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.bars_m1 (
  symbol text not null,
  ts timestamptz not null,
  o numeric not null, h numeric not null, l numeric not null, c numeric not null,
  v numeric not null default 0,
  source text not null,
  primary key (symbol, ts)
);

-- ========== News ==========
create table public.news_sources (
  id serial primary key,
  name text not null,
  url text not null unique,
  kind text not null check (kind in ('rss', 'json', 'html')),
  assets text[] not null default '{}',
  weight numeric not null default 1,
  interval_min int not null default 5,
  enabled boolean not null default true,
  etag text,
  last_modified text,
  last_fetched_at timestamptz,
  last_error text
);

create table public.news_items (
  id bigserial primary key,
  source_id int references public.news_sources on delete set null,
  url text not null,
  url_hash text not null unique,
  title text not null,
  title_hash text not null,
  summary text,
  published_at timestamptz,
  fetched_at timestamptz not null default now(),
  candidate_assets text[] not null default '{}',
  status text not null default 'pending' check (status in ('pending', 'filtered', 'scored', 'error')),
  attempts smallint not null default 0,
  category text,
  reason_vi text
);
create index on public.news_items (published_at desc);
create index on public.news_items (status) where status = 'pending';
create index on public.news_items (title_hash);

create table public.news_impacts (
  news_id bigint not null references public.news_items on delete cascade,
  asset text not null check (asset in ('XAU', 'BTC', 'WTI', 'BRENT')),
  impact smallint not null check (impact between 1 and 5),
  direction text not null check (direction in ('up', 'down', 'mixed')),
  confidence numeric not null check (confidence between 0 and 1),
  horizon text not null check (horizon in ('intraday', 'days', 'weeks')),
  primary key (news_id, asset)
);
create index on public.news_impacts (asset, impact desc);

create table public.econ_events (
  id bigserial primary key,
  country text not null,
  title text not null,
  scheduled_at timestamptz not null,
  importance smallint not null check (importance between 1 and 3),
  forecast numeric, previous numeric, actual numeric, surprise numeric,
  assets text[] not null default '{}',
  updated_at timestamptz not null default now(),
  unique (country, title, scheduled_at)
);
create index on public.econ_events (scheduled_at);

create table public.news_price_reactions (
  news_id bigint not null references public.news_items on delete cascade,
  asset text not null,
  window_min int not null,
  pct_change numeric,
  atr_multiple numeric,
  primary key (news_id, asset, window_min)
);

-- ========== Copy trade ==========
create table public.mt5_accounts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles on delete cascade,
  role text not null check (role in ('master', 'receiver')),
  label text not null,
  broker text,
  server text not null,
  login bigint not null,
  currency text,
  token_hash text not null unique,
  status text not null default 'offline' check (status in ('online', 'offline', 'paused', 'error')),
  last_heartbeat_at timestamptz,
  balance numeric, equity numeric, margin numeric,
  ea_version text,
  created_at timestamptz not null default now(),
  unique (server, login)
);

-- Service-role only: never granted to anon/authenticated.
create table public.mt5_account_secrets (
  account_id uuid primary key references public.mt5_accounts on delete cascade,
  hmac_secret text not null,
  rotated_at timestamptz not null default now()
);

create table public.copy_links (
  id uuid primary key default gen_random_uuid(),
  master_id uuid not null references public.mt5_accounts on delete cascade,
  receiver_id uuid not null references public.mt5_accounts on delete cascade,
  enabled boolean not null default false,
  lot_mode text not null default 'equity_ratio' check (lot_mode in ('fixed', 'multiplier', 'equity_ratio', 'risk_percent')),
  lot_value numeric not null default 1 check (lot_value > 0),
  symbol_map jsonb not null default '{}',
  allowed_symbols text[],
  reverse boolean not null default false,
  copy_sl_tp boolean not null default true,
  copy_pending boolean not null default false,
  max_lot numeric,
  max_open_positions int,
  max_daily_loss_pct numeric check (max_daily_loss_pct is null or max_daily_loss_pct between 0 and 100),
  max_slippage_points int not null default 50,
  max_signal_age_s int not null default 10,
  catch_up boolean not null default false,
  trading_hours jsonb,
  paused_reason text,
  updated_at timestamptz not null default now(),
  unique (master_id, receiver_id),
  check (master_id <> receiver_id)
);

create table public.ct_seq (
  master_id uuid primary key references public.mt5_accounts on delete cascade,
  last_seq bigint not null default 0
);

create table public.ct_events (
  master_id uuid not null references public.mt5_accounts on delete cascade,
  seq bigint not null,
  event_uid text not null,
  type text not null,
  payload jsonb not null,
  master_ts timestamptz,
  received_at timestamptz not null default now(),
  primary key (master_id, seq),
  unique (master_id, event_uid)
);
create index on public.ct_events (received_at);

create table public.ct_executions (
  id bigserial primary key,
  link_id uuid not null references public.copy_links on delete cascade,
  master_id uuid not null,
  seq bigint not null,
  status text not null check (status in ('done', 'skipped', 'failed')),
  reason text,
  error_code int,
  receiver_ticket bigint,
  volume numeric,
  fill_price numeric,
  slippage_points numeric,
  latency_ms int,
  created_at timestamptz not null default now(),
  unique (link_id, seq)
);
create index on public.ct_executions (created_at desc);

create table public.ct_position_map (
  link_id uuid not null references public.copy_links on delete cascade,
  master_ticket bigint not null,
  receiver_ticket bigint not null,
  symbol text not null,
  volume numeric not null,
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  primary key (link_id, master_ticket)
);

create table public.audit_log (
  id bigserial primary key,
  actor uuid,
  action text not null,
  target text,
  detail jsonb,
  at timestamptz not null default now()
);

create table public.app_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
insert into public.app_settings (key, value) values
  ('llm_daily_budget_usd', '5'),
  ('copy_global_pause', 'false');
