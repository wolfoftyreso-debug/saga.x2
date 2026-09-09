-- SAGA Ad Creative Studio: private, revisioned project documents.
--
-- This is intentionally separate from studio_ad_automations. It stores
-- editable material specifications only: no provider account, budget,
-- audience-targeting payload, Blob locator, model output or delivery receipt
-- can enter this table. A future delivery integration must use a separately
-- reviewed boundary.

begin;

create table if not exists saga_ad_creative_projects (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app_workspaces(id) on delete cascade,
  created_by_user_id uuid not null,
  updated_by_user_id uuid not null,
  create_idempotency_key uuid not null,
  name text not null check (char_length(trim(name)) between 2 and 160),
  master_brief jsonb not null check (jsonb_typeof(master_brief) = 'object'),
  -- Variants are one revisioned project document. The server validates and
  -- normalizes every preset/custom canvas before it is written.
  variants jsonb not null check (jsonb_typeof(variants) = 'array'),
  revision integer not null default 1 check (revision > 0),
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

create index if not exists saga_ad_creative_projects_workspace_updated_idx
  on saga_ad_creative_projects(workspace_id, updated_at desc, id desc);

drop trigger if exists saga_ad_creative_projects_set_updated_at on saga_ad_creative_projects;
create trigger saga_ad_creative_projects_set_updated_at
before update on saga_ad_creative_projects
for each row execute function app_set_updated_at();

commit;
