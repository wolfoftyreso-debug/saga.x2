-- SAGA Ad Automation Builder: Vercel + Neon only.
--
-- This schema stores workflow intent and durable manual-test receipts. It
-- deliberately has no provider credentials, campaign IDs, publishing queue or
-- outbound webhook. A later reviewed execution migration must add those parts
-- explicitly; saving an automation must never publish an ad.

begin;

create table if not exists studio_ad_automations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app_workspaces(id) on delete cascade,
  created_by_user_id uuid not null,
  updated_by_user_id uuid not null,
  create_idempotency_key uuid not null,
  name text not null check (char_length(trim(name)) between 2 and 160),
  active boolean not null default false,
  revision integer not null default 1 check (revision > 0),
  workflow jsonb not null check (jsonb_typeof(workflow) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, create_idempotency_key),
  foreign key (workspace_id, created_by_user_id)
    references app_workspace_memberships(workspace_id, user_id)
    on delete restrict,
  foreign key (workspace_id, updated_by_user_id)
    references app_workspace_memberships(workspace_id, user_id)
    on delete restrict
);

create table if not exists studio_ad_automation_test_receipts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app_workspaces(id) on delete cascade,
  automation_id uuid not null,
  requested_by_user_id uuid not null,
  idempotency_key uuid not null,
  -- `queued` means a private draft request has been recorded only. No worker
  -- or route in this migration can send, buy or publish anything externally.
  state text not null default 'queued' check (state = 'queued'),
  draft_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, automation_id, idempotency_key),
  unique (workspace_id, id),
  foreign key (workspace_id, automation_id)
    references studio_ad_automations(workspace_id, id)
    on delete cascade,
  foreign key (workspace_id, requested_by_user_id)
    references app_workspace_memberships(workspace_id, user_id)
    on delete restrict
);

create index if not exists studio_ad_automations_workspace_updated_idx
  on studio_ad_automations(workspace_id, updated_at desc);
create index if not exists studio_ad_automation_test_receipts_workspace_created_idx
  on studio_ad_automation_test_receipts(workspace_id, created_at desc);

drop trigger if exists studio_ad_automations_set_updated_at on studio_ad_automations;
create trigger studio_ad_automations_set_updated_at
before update on studio_ad_automations
for each row execute function app_set_updated_at();

drop trigger if exists studio_ad_automation_test_receipts_set_updated_at on studio_ad_automation_test_receipts;
create trigger studio_ad_automation_test_receipts_set_updated_at
before update on studio_ad_automation_test_receipts
for each row execute function app_set_updated_at();

commit;
