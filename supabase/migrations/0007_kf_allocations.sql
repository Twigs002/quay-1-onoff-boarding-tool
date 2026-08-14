-- KF Allocations reference - the "MASTER KF Team Allocations" master.
--
-- Which suburb's CMA data (FT full-title vs ST sectional-title) is allocated to which
-- team, its status (active / on ice), and the request/transfer timeline. Imported from
-- the xlsx with scripts/import_kf_allocations.py; browsed on the hub's Allocations tab.
-- Reference alongside the active data_jobs queue. Pagan-only.

create table if not exists public.kf_allocations (
  id            uuid primary key default gen_random_uuid(),
  title_type    text check (title_type in ('FT', 'ST')),   -- Full Title vs Sectional Title
  suburb        text not null,                              -- ExtensionAKA (actual suburb)
  extension_name text,                                      -- ExtensionName (parent/city)
  extension     text,                                       -- Extension
  cma_suburb    text,                                       -- CMA SUBURB dataset label
  team          text,                                       -- Contact Owner
  owner_id      text,                                       -- Contact Owner ID (HubSpot)
  status        text not null default 'active'
                  check (status in ('active', 'on_ice', 'requested', 'transferred', 'inactive', 'cancelled')),
  original_accountability text,
  last_transferred text,
  rt_period     text,
  request_period text,
  notes         text,
  source        text,                                       -- FT master / ST master / new request
  source_key    text unique,                                -- dedupe key for re-import
  created_by    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists kf_alloc_team_idx   on public.kf_allocations (team);
create index if not exists kf_alloc_status_idx on public.kf_allocations (status);
create index if not exists kf_alloc_type_idx   on public.kf_allocations (title_type);
create index if not exists kf_alloc_suburb_idx on public.kf_allocations (suburb);

create or replace function public.kf_alloc_touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;
drop trigger if exists kf_alloc_touch on public.kf_allocations;
create trigger kf_alloc_touch before update on public.kf_allocations
  for each row execute function public.kf_alloc_touch_updated_at();

alter table public.kf_allocations enable row level security;
drop policy if exists kf_alloc_pagan_only on public.kf_allocations;
create policy kf_alloc_pagan_only on public.kf_allocations
  for all
  using (exists (select 1 from public.staff s where s.auth_user_id = auth.uid() and s.id = 'pagan'))
  with check (exists (select 1 from public.staff s where s.auth_user_id = auth.uid() and s.id = 'pagan'));
