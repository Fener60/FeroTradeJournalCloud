create extension if not exists pgcrypto;

create table if not exists public.user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  starting_balance numeric not null default 10000 check (starting_balance > 0),
  currency text not null default 'USDT' check (currency in ('USDT','USD','TRY')),
  max_leverage integer not null default 20 check (max_leverage between 1 and 125),
  target_margin_pct numeric not null default 10 check (target_margin_pct > 0 and target_margin_pct <= 100),
  total_fee_pct numeric not null default 0.10 check (total_fee_pct >= 0),
  funding_cost_pct numeric not null default 0 check (funding_cost_pct >= 0),
  slippage_pct numeric not null default 0 check (slippage_pct >= 0),
  use_binance_sync boolean not null default false,
  rules jsonb not null default '{
    "htf_alignment": true,
    "zone_touch": true,
    "internal_structure": true,
    "peak_dip": true,
    "quality_07": true,
    "technical_stop": true,
    "target_3r": true
  }'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.trades (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  symbol text not null,
  direction text not null check (direction in ('LONG','SHORT')),
  model text not null default 'Golden Zone' check (model in ('Golden Zone','Order Block')),
  entry_type text not null default 'Confirmation Entry',
  timeframe text,
  htf text,

  entry_price numeric not null check (entry_price > 0),
  stop_price numeric not null check (stop_price > 0),
  take_profit_price numeric not null check (take_profit_price > 0),

  balance_at_entry numeric not null,
  risk_at_entry numeric not null,
  stop_pct numeric not null,
  position_notional numeric not null,
  quantity numeric not null,
  leverage integer not null,
  margin_required numeric not null,
  leverage_feasible boolean not null default true,

  current_price numeric,
  current_price_at timestamptz,

  status text not null default 'OPEN' check (status in ('OPEN','CLOSED')),
  close_price numeric,
  close_reason text,
  close_source text,
  closed_at timestamptz,

  gross_r numeric,
  net_r numeric,
  gross_pnl numeric not null default 0,
  fees numeric not null default 0,
  funding numeric not null default 0,
  slippage numeric not null default 0,
  net_pnl numeric not null default 0,

  emotion text,
  urge integer check (urge is null or (urge between 1 and 10)),
  checklist jsonb not null default '{}'::jsonb,
  checklist_score integer not null default 0,
  reason text,
  notes text,

  manual_early_exit boolean not null default false,
  plan_outcome_pending boolean not null default false,
  plan_outcome text check (plan_outcome is null or plan_outcome in ('TP3','SL')),
  plan_outcome_at timestamptz,
  plan_outcome_r numeric,
  early_exit_difference_r numeric,

  binance_tracking boolean not null default false,
  binance_position_seen boolean not null default false,
  binance_last_position_amt numeric,
  binance_sync_note text
);

create index if not exists trades_user_created_idx on public.trades(user_id, created_at desc);
create index if not exists trades_open_idx on public.trades(status, symbol) where status='OPEN';
create index if not exists trades_plan_pending_idx on public.trades(plan_outcome_pending, symbol) where plan_outcome_pending=true;

-- API credentials are intentionally server-only.
create table if not exists public.binance_connections (
  user_id uuid primary key references auth.users(id) on delete cascade,
  encrypted_api_key text not null,
  encrypted_api_secret text not null,
  enabled boolean not null default true,
  last_sync_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.user_settings enable row level security;
alter table public.trades enable row level security;
alter table public.binance_connections enable row level security;

revoke all on public.user_settings from anon;
revoke all on public.trades from anon;
revoke all on public.binance_connections from anon, authenticated;

grant select, insert, update, delete on public.user_settings to authenticated;
grant select on public.trades to authenticated;

drop policy if exists settings_select_own on public.user_settings;
create policy settings_select_own on public.user_settings for select
to authenticated using (auth.uid() = user_id);

drop policy if exists settings_insert_own on public.user_settings;
create policy settings_insert_own on public.user_settings for insert
to authenticated with check (auth.uid() = user_id);

drop policy if exists settings_update_own on public.user_settings;
create policy settings_update_own on public.user_settings for update
to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists settings_delete_own on public.user_settings;
create policy settings_delete_own on public.user_settings for delete
to authenticated using (auth.uid() = user_id);

drop policy if exists trades_select_own on public.trades;
create policy trades_select_own on public.trades for select
to authenticated using (auth.uid() = user_id);

-- Trades are created/closed through the trusted backend only.
revoke insert, update, delete on public.trades from authenticated;

-- Make trade changes visible to Realtime if not already published.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname='supabase_realtime' and schemaname='public' and tablename='trades'
  ) then
    alter publication supabase_realtime add table public.trades;
  end if;
end $$;
