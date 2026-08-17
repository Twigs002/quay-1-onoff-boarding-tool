-- P24 (Property24) marketing budget tracker.
--
-- Mirrors the budget sheet: each manager/team has a monthly P24 allocation (weighted
-- by annual sales); individual listing spends are logged against it, and the tab shows
-- spent vs left vs % per team, plus the monthly rollup. Two tables:
--   p24_allocations - the per-team monthly budget (config; seed from the sheet)
--   p24_spend       - individual listing/boost spends logged against a team + month
-- Pagan-only, same pattern as the other hub tables.

create table if not exists public.p24_allocations (
  id                 uuid primary key default gen_random_uuid(),
  team               text not null unique,           -- manager/team name
  email              text,
  monthly_allocation numeric not null default 0,
  weekly_spend       numeric,
  listings_per_week  integer,
  active             boolean not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table if not exists public.p24_spend (
  id          uuid primary key default gen_random_uuid(),
  team        text not null,                          -- matches p24_allocations.team (or Admin/Pagan)
  amount      numeric not null,
  spent_on    date not null default current_date,
  month       text not null,                          -- 'YYYY-MM' for fast per-month rollups
  listing_ref text,                                   -- suburb / listing / boost reference
  notes       text,
  created_by  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists p24_spend_month_idx on public.p24_spend (month);
create index if not exists p24_spend_team_idx  on public.p24_spend (team);

create or replace function public.p24_touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;
drop trigger if exists p24_alloc_touch on public.p24_allocations;
create trigger p24_alloc_touch before update on public.p24_allocations
  for each row execute function public.p24_touch_updated_at();
drop trigger if exists p24_spend_touch on public.p24_spend;
create trigger p24_spend_touch before update on public.p24_spend
  for each row execute function public.p24_touch_updated_at();

alter table public.p24_allocations enable row level security;
alter table public.p24_spend enable row level security;
drop policy if exists p24_alloc_pagan_only on public.p24_allocations;
create policy p24_alloc_pagan_only on public.p24_allocations for all
  using (exists (select 1 from public.staff s where s.auth_user_id = auth.uid() and s.id = 'pagan'))
  with check (exists (select 1 from public.staff s where s.auth_user_id = auth.uid() and s.id = 'pagan'));
drop policy if exists p24_spend_pagan_only on public.p24_spend;
create policy p24_spend_pagan_only on public.p24_spend for all
  using (exists (select 1 from public.staff s where s.auth_user_id = auth.uid() and s.id = 'pagan'))
  with check (exists (select 1 from public.staff s where s.auth_user_id = auth.uid() and s.id = 'pagan'));
