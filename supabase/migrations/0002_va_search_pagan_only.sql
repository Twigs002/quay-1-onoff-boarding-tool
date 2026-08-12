-- Lock va_search_records to PAGAN ONLY (was super/admin in 0001).
--
-- Part of the private Pagan Hub (web/pagan-hub.html): the VA Searches data is now
-- personal to Pagan, not a shared super/admin team table. This is the REAL access
-- control - the hub's client-side identity check is only convenience.
--
-- Apply in the Supabase SQL editor for project quay-clock (same as 0001). Idempotent.
--
-- Identity match: the signed-in user's `staff` row must be Pagan. Matched on
-- staff.id = 'pagan' (the username; Pagan's staff.email is null, so an email match
-- would lock Pagan out). Keep this in sync with PAGAN in web/pagan-hub.js.
-- To re-check the right value, run in the SQL editor:
--     select id, name, email, is_super from public.staff where lower(name) like '%pagan%';

drop policy if exists va_search_admin_all  on public.va_search_records;
drop policy if exists va_search_pagan_only on public.va_search_records;

create policy va_search_pagan_only on public.va_search_records
  for all
  using (
    exists (
      select 1 from public.staff s
      where s.auth_user_id = auth.uid() and s.id = 'pagan'
    )
  )
  with check (
    exists (
      select 1 from public.staff s
      where s.auth_user_id = auth.uid() and s.id = 'pagan'
    )
  );
