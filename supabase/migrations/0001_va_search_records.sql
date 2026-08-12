-- VA Searches tracker - contact skip-tracing log.
--
-- One row per contact a VA is asked to find a phone number for. Contacts arrive
-- in "sheets" (a submitted batch) and are either a company or a natural person.
-- The dashboard on the web app's "VA Searches" tab counts rows by `outcome`:
--   pending          - not yet worked (NOT counted as "searched")
--   not_found        - number cannot be found
--   found_unchanged  - number found, same as the one we already had
--   found_changed    - number found, different from what we had (incl. we had none)
--
-- Access: this table lives in the shared "quay-clock" Supabase project alongside
-- `staff`. It is read/written DIRECTLY by the browser (like the staff-auth read in
-- web/auth.js), so Postgres RLS is the real access control. v1 policy: only super
-- or admin staff (per their `staff` row) may see or change any row. Tighten later
-- (e.g. a dedicated VA role) without touching the frontend.
--
-- Apply: run this in the Supabase SQL editor for project quay-clock, or via
--   supabase db push  (if the CLI is wired to this project).
-- It is idempotent - safe to re-run.

create table if not exists public.va_search_records (
  id             uuid primary key default gen_random_uuid(),
  entity_type    text not null check (entity_type in ('company', 'person')),
  name           text not null,
  sheet          text not null default '',           -- the submitted batch this contact came in on
  existing_number text,                               -- number on record before the search (nullable)
  found_number   text,                                -- number the VA found (nullable)
  outcome        text not null default 'pending'
                   check (outcome in ('pending', 'not_found', 'found_unchanged', 'found_changed')),
  -- Optional richer fields, populated by bulk imports (e.g. the HubSpot CRM export
  -- via scripts/import_hubspot_va.py). All nullable so a hand-added row needs none.
  id_number      text,                                -- SA ID / registration number
  division       text,
  suburb         text,
  address        text,                                -- composed street address if present
  lead_status    text,                                -- source system's status (e.g. "No Contact Details")
  contact_owner  text,
  source_id      text unique,                         -- stable source key (e.g. 'hubspot:4491916') for dedupe/upsert
  notes          text,
  searched_by    text,                                -- staff name/username who recorded the result
  searched_at    timestamptz,                         -- when the result was recorded
  created_by     text,                                -- staff name/username who submitted the sheet
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists va_search_entity_idx  on public.va_search_records (entity_type);
create index if not exists va_search_sheet_idx    on public.va_search_records (sheet);
create index if not exists va_search_outcome_idx  on public.va_search_records (outcome);

-- Keep updated_at fresh on every write. Uniquely named so it never clobbers an
-- existing shared trigger function in this project.
create or replace function public.va_search_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists va_search_touch on public.va_search_records;
create trigger va_search_touch
  before update on public.va_search_records
  for each row execute function public.va_search_touch_updated_at();

-- ------------------------------------------------------------------ RLS
alter table public.va_search_records enable row level security;

-- Super/admin staff (matched by their Supabase auth uid on the shared `staff`
-- table) get full access. Everyone else - including brokers - sees nothing.
drop policy if exists va_search_admin_all on public.va_search_records;
create policy va_search_admin_all on public.va_search_records
  for all
  using (
    exists (
      select 1 from public.staff s
      where s.auth_user_id = auth.uid() and (s.is_super or s.is_admin)
    )
  )
  with check (
    exists (
      select 1 from public.staff s
      where s.auth_user_id = auth.uid() and (s.is_super or s.is_admin)
    )
  );
