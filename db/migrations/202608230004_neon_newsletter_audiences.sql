-- Vercel + Neon newsletter audience core.
--
-- This migration deliberately stores audience membership and consent only.
-- It does not add a delivery provider, delivery queue, or sender secrets.

begin;

create table if not exists newsletter_audiences (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app_workspaces(id) on delete cascade,
  created_by_user_id uuid not null,
  name text not null check (char_length(trim(name)) between 2 and 160),
  description text not null default '' check (char_length(description) <= 1000),
  sender_name text check (sender_name is null or char_length(trim(sender_name)) between 1 and 160),
  sender_email text check (sender_email is null or char_length(sender_email) <= 320),
  reply_to_email text check (reply_to_email is null or char_length(reply_to_email) <= 320),
  audience_metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(audience_metadata) = 'object'),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, created_by_user_id)
    references app_workspace_memberships(workspace_id, user_id)
    on delete restrict
);

create table if not exists newsletter_contacts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references app_workspaces(id) on delete cascade,
  audience_id uuid not null,
  email text not null check (email = lower(email) and char_length(email) between 3 and 320),
  display_name text check (display_name is null or char_length(trim(display_name)) <= 240),
  status text not null default 'subscribed'
    check (status in ('subscribed', 'unsubscribed', 'bounced', 'complained', 'suppressed')),
  consent_source text not null check (char_length(trim(consent_source)) between 1 and 160),
  consented_at timestamptz,
  unsubscribed_at timestamptz,
  suppression_reason text check (suppression_reason is null or char_length(suppression_reason) <= 1000),
  contact_metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(contact_metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, audience_id, email),
  check (status <> 'subscribed' or consented_at is not null),
  foreign key (workspace_id, audience_id)
    references newsletter_audiences(workspace_id, id)
    on delete cascade
);

create index if not exists newsletter_audiences_workspace_active_idx
  on newsletter_audiences (workspace_id, active, lower(name));
create index if not exists newsletter_contacts_workspace_audience_created_idx
  on newsletter_contacts (workspace_id, audience_id, created_at desc);
create index if not exists newsletter_contacts_workspace_audience_status_idx
  on newsletter_contacts (workspace_id, audience_id, status);

drop trigger if exists newsletter_audiences_set_updated_at on newsletter_audiences;
create trigger newsletter_audiences_set_updated_at
before update on newsletter_audiences
for each row execute function app_set_updated_at();

drop trigger if exists newsletter_contacts_set_updated_at on newsletter_contacts;
create trigger newsletter_contacts_set_updated_at
before update on newsletter_contacts
for each row execute function app_set_updated_at();

commit;
