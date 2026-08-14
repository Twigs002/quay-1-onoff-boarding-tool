-- Data Tracker - the Knowledge Factory data work queue.
--
-- One row per data JOB Pagan is running: auditing a team's data, ordering new data
-- for a team/area, chasing suburbs owed back, adding new suburbs, or the companies
-- data set. Tracks type, team, area/suburbs, status and the timeline in one place.
-- Reference allocations (the "MASTER KF Team Allocations" sheet) can be imported
-- alongside later; this table is the ACTIVE work. Pagan-only.

create table if not exists public.data_jobs (
  id            uuid primary key default gen_random_uuid(),
  title         text not null,                          -- "Audit Warriors data"
  job_type      text not null default 'other'
                  check (job_type in ('audit', 'new_team', 'new_suburb', 'awaiting_return', 'companies', 'other')),
  team          text,                                   -- Warriors, Gunslingers, new Paarl team...
  area          text,                                   -- Paarl / suburb names
  title_type    text,                                   -- FT | ST | both | (blank)
  suburbs_count integer,                                -- e.g. 4, 2
  supplier      text default 'Knowledge Factory',
  status        text not null default 'to_do'
                  check (status in ('to_do', 'requested', 'awaiting', 'in_progress', 'received', 'done', 'blocked')),
  priority      text not null default 'normal' check (priority in ('normal', 'high')),
  expected      text,                                   -- when it's expected back
  notes         text,
  created_by    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists data_jobs_status_idx on public.data_jobs (status);
create index if not exists data_jobs_team_idx    on public.data_jobs (team);

create or replace function public.data_jobs_touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;
drop trigger if exists data_jobs_touch on public.data_jobs;
create trigger data_jobs_touch before update on public.data_jobs
  for each row execute function public.data_jobs_touch_updated_at();

alter table public.data_jobs enable row level security;
drop policy if exists data_jobs_pagan_only on public.data_jobs;
create policy data_jobs_pagan_only on public.data_jobs
  for all
  using (exists (select 1 from public.staff s where s.auth_user_id = auth.uid() and s.id = 'pagan'))
  with check (exists (select 1 from public.staff s where s.auth_user_id = auth.uid() and s.id = 'pagan'));
