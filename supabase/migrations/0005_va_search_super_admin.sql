-- Broaden va_search_records from PAGAN ONLY (0002) back to SUPER ADMINS.
-- The hub is now the Admin Dashboard (web/pagan-hub.html), open to super admins.
-- Apply in the Supabase SQL editor for project quay-clock. Idempotent.
drop policy if exists va_search_pagan_only on public.va_search_records;
drop policy if exists va_search_admin_all  on public.va_search_records;
drop policy if exists va_search_super_all  on public.va_search_records;

create policy va_search_super_all on public.va_search_records
  for all
  using (
    exists (select 1 from public.staff s
            where s.auth_user_id = auth.uid() and s.is_super = true)
  )
  with check (
    exists (select 1 from public.staff s
            where s.auth_user_id = auth.uid() and s.is_super = true)
  );
