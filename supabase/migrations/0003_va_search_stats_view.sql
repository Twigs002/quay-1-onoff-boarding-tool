-- Aggregate view for the VA dashboard's per-sheet breakdown + accurate sheet list.
--
-- The dashboard's headline KPIs use fast COUNT queries and need nothing here, so
-- the app works without this view. This view only powers the "by sheet" table and
-- the exact distinct-sheet filter (the app falls back to a sampled sheet list if
-- it's absent). Apply it in the Supabase SQL editor for quay-clock when convenient.
--
-- security_invoker = on (Postgres 15+) makes the view honour the querying user's
-- RLS on va_search_records, so it stays Pagan-only just like the base table.
-- Idempotent.

create or replace view public.va_search_stats
  with (security_invoker = on) as
select
  entity_type,
  coalesce(sheet, '') as sheet,
  outcome,
  count(*)::int as n
from public.va_search_records
group by entity_type, coalesce(sheet, ''), outcome;
