-- Lock va_search_records to PAGAN ONLY (was super/admin in 0001).
--
-- Part of the private Pagan Hub (web/pagan-hub.html): the VA Searches data is now
-- personal to Pagan, not a shared super/admin team table. This is the REAL access
-- control - the hub's client-side identity check is only convenience.
--
-- Apply in the Supabase SQL editor for project quay-clock (same as 0001). Idempotent.
--
-- Identity match: the signed-in user's `staff` row must have email pagan@quay1.co.za.
-- If Pagan's staff.email is different, change the address below (or switch to an id
-- match, e.g. s.id = 'pagan') and keep it in sync with PAGAN in web/pagan-hub.js.
-- To find the right value, run in the SQL editor:
--     select id, name, email, is_super from public.staff where lower(name) like '%pagan%';

drop policy if exists va_search_admin_all  on public.va_search_records;
drop policy if exists va_search_pagan_only on public.va_search_records;

create policy va_search_pagan_only on public.va_search_records
  for all
  using (
    exists (
      select 1 from public.staff s
      where s.auth_user_id = auth.uid()
        and lower(coalesce(s.email, '')) = 'pagan@quay1.co.za'
    )
  )
  with check (
    exists (
      select 1 from public.staff s
      where s.auth_user_id = auth.uid()
        and lower(coalesce(s.email, '')) = 'pagan@quay1.co.za'
    )
  );
