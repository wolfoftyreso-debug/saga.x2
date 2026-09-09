-- `fetched_at` is intentionally refreshed on every poll. Trigger freshness
-- needs an immutable receipt, otherwise an undated old RSS item can look new
-- forever merely because the feed was read again.

alter table public.media_research_items
  add column if not exists first_observed_at timestamptz;

update public.media_research_items
set first_observed_at = coalesce(first_observed_at, created_at, fetched_at, timezone('utc', now()))
where first_observed_at is null;

alter table public.media_research_items
  alter column first_observed_at set default timezone('utc', now()),
  alter column first_observed_at set not null;

create index if not exists media_research_items_tenant_first_observed_idx
  on public.media_research_items(tenant_id, first_observed_at desc);
