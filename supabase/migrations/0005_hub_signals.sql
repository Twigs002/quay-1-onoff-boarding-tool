-- Pagan Hub "Today" command-center signals.
--
-- A flexible snapshot table: a laptop collector (hub_collector.py) upserts one row
-- per metric it gathers from your systems - open request counts, flagged-email
-- counts, automation run stats, etc. - and the hub's Today tab reads them to show
-- your day at a glance. Deliberately generic (domain/key/value) so new signals are
-- a one-line add on the collector, no schema change.
--
-- Pagan-only, same as va_search_records. The collector writes with the service-role
-- key (bypasses RLS); the hub reads as Pagan. Apply in the quay-clock SQL editor.

create table if not exists public.hub_signals (
  id          uuid primary key default gen_random_uuid(),
  domain      text not null,                 -- 'inbox' | 'requests' | 'systems' | 'day'
  key         text not null,                 -- e.g. 'valuations_open', 'va_pending'
  label       text,                          -- human label for the tile
  value_num   numeric,                       -- the headline number (nullable)
  value_text  text,                          -- or a short text value
  detail      jsonb,                         -- optional rows/breakdown for a drill-down
  href        text,                          -- optional deep link (Gmail search, app, sheet)
  updated_at  timestamptz not null default now(),
  unique (domain, key)
);

create index if not exists hub_signals_domain_idx on public.hub_signals (domain);

alter table public.hub_signals enable row level security;

drop policy if exists hub_signals_pagan_only on public.hub_signals;
create policy hub_signals_pagan_only on public.hub_signals
  for all
  using (exists (select 1 from public.staff s where s.auth_user_id = auth.uid() and s.id = 'pagan'))
  with check (exists (select 1 from public.staff s where s.auth_user_id = auth.uid() and s.id = 'pagan'));
