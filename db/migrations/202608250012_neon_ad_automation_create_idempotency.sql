-- Makes a retry of POST /api/ad-automations return the original workflow.

begin;

alter table studio_ad_automations
  add column if not exists create_idempotency_key uuid;

-- Existing local/development records predate the create API. Their own id is
-- a stable server-owned key; new API writes always provide a fresh UUID.
update studio_ad_automations
   set create_idempotency_key = id
 where create_idempotency_key is null;

alter table studio_ad_automations
  alter column create_idempotency_key set not null;

create unique index if not exists studio_ad_automations_workspace_create_idempotency_idx
  on studio_ad_automations(workspace_id, create_idempotency_key);

commit;
