-- Dedupe key for auto-captured P24 spends (from the property24 approval emails,
-- via src/p24_spend_capture.py). Lets the capture upsert without duplicating a spend
-- on re-run. Additive; apply in the quay-clock SQL editor after 0008.

alter table public.p24_spend add column if not exists source_key text;
create unique index if not exists p24_spend_source_key_idx on public.p24_spend (source_key)
  where source_key is not null;
