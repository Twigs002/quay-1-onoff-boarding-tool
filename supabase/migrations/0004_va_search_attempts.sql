-- Retry accounting for the VA-lookup bridge.
--
-- The laptop bridge (virtual-agent-lookup/src/supabase_bridge.py) retries a row that
-- errored (e.g. a portal timeout) up to a cap, then parks it. This column holds the
-- attempt count so the retry is BOUNDED (no infinite loop). Rate-limited rows stay
-- pending and don't burn an attempt. The web app never reads this column, so it's a
-- pure additive change - safe to apply anytime in the quay-clock SQL editor. Idempotent.

alter table public.va_search_records
  add column if not exists attempts integer not null default 0;
