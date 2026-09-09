-- One durable lease coordinates the bounded main Vercel cron invocation.
--
-- Neon HTTP queries do not keep a database session open between statements,
-- so a session advisory lock would disappear immediately. This row is the
-- process-wide fence instead: only one invocation may hold it and a timed-out
-- invocation becomes reclaimable after its short lease expires.

begin;

create table if not exists saga_cron_tick_leases (
  lease_key text primary key check (lease_key = 'saga-main'),
  lease_token uuid not null,
  lease_expires_at timestamptz not null,
  last_started_at timestamptz not null default now(),
  last_completed_at timestamptz,
  last_outcome text check (last_outcome in (
    'idle',
    'completed',
    'completed_with_failures',
    'time_budget_reached',
    'scheduler_unavailable'
  )),
  last_duration_ms integer check (last_duration_ms is null or last_duration_ms between 0 and 120000),
  -- Aggregate counts and timing only. Never store prompt text, source URLs,
  -- draft IDs, user data, credentials, or raw error messages here.
  last_summary jsonb not null default '{}'::jsonb
    check (jsonb_typeof(last_summary) = 'object')
);

commit;
