-- Fair, durable cursor for bounded Vercel ad-automation scheduler scans.
-- The worker locks and advances this row in the same SQL statement that
-- chooses work, preventing the first UUIDs/workspaces from monopolizing each
-- cron tick.

begin;

create table if not exists studio_ad_automation_scheduler_cursors (
  scheduler_key text primary key check (char_length(scheduler_key) between 3 and 120),
  last_workspace_id uuid,
  updated_at timestamptz not null default now()
);

commit;
