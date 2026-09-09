-- Conversation-first workspace. The event register remains the source of truth;
-- this migration adds user-owned control, delivery and profile layers around it.

create table if not exists public.profile_context (
  user_id uuid primary key references public.profiles(user_id) on delete cascade,
  work_summary text not null default '',
  role_title text not null default '',
  organizations jsonb not null default '[]'::jsonb,
  sectors jsonb not null default '[]'::jsonb,
  markets jsonb not null default '[]'::jsonb,
  dependencies jsonb not null default '[]'::jsonb,
  decisions jsonb not null default '[]'::jsonb,
  risks jsonb not null default '[]'::jsonb,
  opportunities jsonb not null default '[]'::jsonb,
  interests jsonb not null default '[]'::jsonb,
  exclusions jsonb not null default '[]'::jsonb,
  languages jsonb not null default '["sv", "en"]'::jsonb,
  onboarding_complete boolean not null default false,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.brief_definitions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  name text not null check (char_length(name) between 2 and 80),
  kind text not null default 'main' check (kind in ('main', 'company', 'economy', 'technology', 'regulation', 'creator', 'local', 'custom')),
  instructions text not null default '',
  cadence text not null default 'daily' check (cadence in ('daily', 'weekly')),
  local_time time not null default '07:00',
  weekday smallint check (weekday between 0 and 6),
  timezone text not null default 'Europe/Stockholm',
  max_items smallint not null default 5 check (max_items between 0 and 5),
  brief_depth text not null default 'short' check (brief_depth in ('short', 'deep')),
  relevance_threshold smallint not null default 65 check (relevance_threshold between 0 and 100),
  alert_threshold smallint not null default 85 check (alert_threshold between 0 and 100),
  only_when_changed boolean not null default true,
  active boolean not null default true,
  is_primary boolean not null default false,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (user_id, name)
);

create unique index if not exists brief_definitions_one_primary_per_user_idx
  on public.brief_definitions(user_id) where is_primary;
create index if not exists brief_definitions_user_active_idx
  on public.brief_definitions(user_id, active, created_at);

insert into public.profile_context (user_id)
select user_id from public.profiles
on conflict (user_id) do nothing;

insert into public.brief_definitions (
  user_id, name, kind, cadence, local_time, timezone, max_items, brief_depth,
  relevance_threshold, alert_threshold, only_when_changed, active, is_primary
)
select
  p.user_id, 'Huvudbrief', 'main', 'daily', p.daily_brief_time, p.timezone,
  p.max_items, p.brief_depth, p.relevance_threshold, p.alert_threshold, true, true, true
from public.profiles p
where not exists (
  select 1 from public.brief_definitions d where d.user_id = p.user_id and d.is_primary
);

create or replace function public.ensure_workspace_for_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profile_context (user_id) values (new.user_id)
  on conflict (user_id) do nothing;

  insert into public.brief_definitions (
    user_id, name, kind, cadence, local_time, timezone, max_items, brief_depth,
    relevance_threshold, alert_threshold, only_when_changed, active, is_primary
  ) values (
    new.user_id, 'Huvudbrief', 'main', 'daily', new.daily_brief_time, new.timezone,
    new.max_items, new.brief_depth, new.relevance_threshold, new.alert_threshold, true, true, true
  ) on conflict (user_id, name) do nothing;
  return new;
end;
$$;

drop trigger if exists profiles_workspace_after_insert on public.profiles;
create trigger profiles_workspace_after_insert
after insert on public.profiles
for each row execute function public.ensure_workspace_for_profile();

alter table public.briefs add column if not exists brief_definition_id uuid references public.brief_definitions(id) on delete set null;
alter table public.briefs add column if not exists delivered_to_chat_at timestamptz;
alter table public.processing_runs add column if not exists brief_definition_id uuid references public.brief_definitions(id) on delete set null;

update public.briefs b
set brief_definition_id = d.id
from public.brief_definitions d
where d.user_id = b.user_id
  and d.is_primary
  and b.brief_definition_id is null;

create or replace function public.assign_primary_brief_definition()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.brief_definition_id is null then
    select id into new.brief_definition_id
    from public.brief_definitions
    where user_id = new.user_id and is_primary
    limit 1;
  end if;
  return new;
end;
$$;

drop trigger if exists briefs_assign_definition_before_insert on public.briefs;
create trigger briefs_assign_definition_before_insert
before insert on public.briefs
for each row execute function public.assign_primary_brief_definition();

drop trigger if exists processing_runs_assign_definition_before_insert on public.processing_runs;
create trigger processing_runs_assign_definition_before_insert
before insert on public.processing_runs
for each row execute function public.assign_primary_brief_definition();

alter table public.briefs drop constraint if exists briefs_user_id_brief_date_key;
create unique index if not exists briefs_definition_date_idx
  on public.briefs(brief_definition_id, brief_date);

drop index if exists public.processing_runs_one_active_per_day_idx;
create unique index if not exists processing_runs_one_active_per_definition_day_idx
  on public.processing_runs(user_id, brief_definition_id, local_brief_date) where state = 'running';

create table if not exists public.brief_event_state (
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  brief_definition_id uuid not null references public.brief_definitions(id) on delete cascade,
  event_id uuid not null references public.events(id) on delete cascade,
  last_considered_update_id uuid references public.event_updates(id) on delete set null,
  last_published_update_id uuid references public.event_updates(id) on delete set null,
  last_published_at timestamptz,
  last_score smallint check (last_score between 0 and 100),
  primary key (user_id, brief_definition_id, event_id)
);

create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  kind text not null default 'main' check (kind in ('main', 'event')),
  title text not null default 'Din omvärldsbrief',
  event_id uuid references public.events(id) on delete cascade,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create unique index if not exists conversations_one_main_per_user_idx
  on public.conversations(user_id) where kind = 'main';
create unique index if not exists conversations_one_event_thread_idx
  on public.conversations(user_id, event_id) where kind = 'event' and event_id is not null;

create table if not exists public.watches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  event_id uuid references public.events(id) on delete cascade,
  kind text not null default 'event' check (kind in ('event', 'topic')),
  title text not null check (char_length(title) between 2 and 220),
  query_text text,
  rationale text not null default '',
  trigger_statuses jsonb not null default '["changed", "reversed"]'::jsonb,
  only_material_change boolean not null default true,
  state text not null default 'active' check (state in ('active', 'paused', 'completed')),
  last_event_update_id uuid references public.event_updates(id) on delete set null,
  last_triggered_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);
create index if not exists watches_user_state_idx on public.watches(user_id, state, updated_at desc);
create index if not exists watches_event_idx on public.watches(event_id) where event_id is not null;

create table if not exists public.watch_deliveries (
  id uuid primary key default gen_random_uuid(),
  watch_id uuid not null references public.watches(id) on delete cascade,
  event_update_id uuid not null references public.event_updates(id) on delete cascade,
  conversation_message_id uuid,
  delivered_at timestamptz not null default timezone('utc', now()),
  unique (watch_id, event_update_id)
);

create table if not exists public.conversation_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  role text not null check (role in ('system', 'user', 'assistant')),
  kind text not null default 'text' check (kind in ('text', 'brief', 'action', 'watch_update')),
  text text not null default '',
  blocks jsonb not null default '[]'::jsonb,
  action jsonb,
  brief_id uuid references public.briefs(id) on delete set null,
  event_id uuid references public.events(id) on delete set null,
  watch_id uuid references public.watches(id) on delete set null,
  model_name text,
  response_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);
create index if not exists conversation_messages_thread_created_idx
  on public.conversation_messages(conversation_id, created_at);
create unique index if not exists conversation_messages_one_brief_delivery_idx
  on public.conversation_messages(conversation_id, brief_id) where brief_id is not null;

alter table public.watch_deliveries
  add constraint watch_deliveries_message_fkey
  foreign key (conversation_message_id) references public.conversation_messages(id) on delete set null;

create table if not exists public.source_catalog (
  id uuid primary key default gen_random_uuid(),
  domain text not null unique check (char_length(domain) between 3 and 255),
  name text not null,
  kind text not null check (kind in ('primary', 'editorial', 'company', 'creator', 'podcast', 'custom')),
  default_roles jsonb not null default '["discovery", "verification", "citation"]'::jsonb,
  is_default_enabled boolean not null default true,
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.user_source_policies (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  source_id uuid references public.source_catalog(id) on delete set null,
  domain text not null check (char_length(domain) between 3 and 255),
  source_name text not null,
  source_kind text not null default 'editorial' check (source_kind in ('primary', 'editorial', 'company', 'creator', 'podcast', 'custom')),
  active boolean not null default true,
  blocked boolean not null default false,
  priority text not null default 'normal' check (priority in ('high', 'normal', 'low')),
  roles jsonb not null default '["discovery", "verification", "citation"]'::jsonb,
  topic_filter text not null default '',
  verification_requirement text not null default 'verify_material' check (verification_requirement in ('none', 'verify_material', 'primary_only', 'two_independent')),
  frequency text not null default 'material' check (frequency in ('all_relevant', 'daily', 'weekly', 'material')),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (user_id, domain)
);
create index if not exists user_source_policies_user_idx on public.user_source_policies(user_id, blocked, active);

insert into public.source_catalog (domain, name, kind, default_roles)
values
  ('reuters.com', 'Reuters', 'editorial', '["discovery", "verification", "citation"]'::jsonb),
  ('apnews.com', 'Associated Press', 'editorial', '["discovery", "verification", "citation"]'::jsonb),
  ('ft.com', 'Financial Times', 'editorial', '["discovery", "verification", "citation"]'::jsonb),
  ('bloomberg.com', 'Bloomberg', 'editorial', '["discovery", "verification", "citation"]'::jsonb),
  ('wsj.com', 'Wall Street Journal', 'editorial', '["discovery", "verification", "citation"]'::jsonb),
  ('cnn.com', 'CNN', 'editorial', '["discovery", "citation"]'::jsonb),
  ('regeringen.se', 'Regeringen', 'primary', '["discovery", "verification", "citation"]'::jsonb),
  ('riksbank.se', 'Riksbanken', 'primary', '["discovery", "verification", "citation"]'::jsonb),
  ('europa.eu', 'Europeiska unionen', 'primary', '["discovery", "verification", "citation"]'::jsonb),
  ('ec.europa.eu', 'Europeiska kommissionen', 'primary', '["discovery", "verification", "citation"]'::jsonb),
  ('federalreserve.gov', 'Federal Reserve', 'primary', '["discovery", "verification", "citation"]'::jsonb),
  ('sec.gov', 'SEC', 'primary', '["discovery", "verification", "citation"]'::jsonb),
  ('openai.com', 'OpenAI', 'company', '["discovery", "citation"]'::jsonb),
  ('platform.openai.com', 'OpenAI Platform', 'company', '["discovery", "citation"]'::jsonb),
  ('aws.amazon.com', 'AWS', 'company', '["discovery", "citation"]'::jsonb),
  ('cloud.google.com', 'Google Cloud', 'company', '["discovery", "citation"]'::jsonb),
  ('azure.microsoft.com', 'Microsoft Azure', 'company', '["discovery", "citation"]'::jsonb),
  ('nvidia.com', 'NVIDIA', 'company', '["discovery", "citation"]'::jsonb),
  ('stripe.com', 'Stripe', 'company', '["discovery", "citation"]'::jsonb)
on conflict (domain) do update set
  name = excluded.name,
  kind = excluded.kind,
  default_roles = excluded.default_roles;

alter table public.event_sources add column if not exists source_id uuid references public.source_catalog(id) on delete set null;

create table if not exists public.command_audit (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  conversation_message_id uuid references public.conversation_messages(id) on delete set null,
  command_type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create trigger profile_context_updated_at before update on public.profile_context
for each row execute function public.set_updated_at();
create trigger brief_definitions_updated_at before update on public.brief_definitions
for each row execute function public.set_updated_at();
create trigger conversations_updated_at before update on public.conversations
for each row execute function public.set_updated_at();
create trigger watches_updated_at before update on public.watches
for each row execute function public.set_updated_at();
create trigger user_source_policies_updated_at before update on public.user_source_policies
for each row execute function public.set_updated_at();

alter table public.profile_context enable row level security;
alter table public.brief_definitions enable row level security;
alter table public.brief_event_state enable row level security;
alter table public.conversations enable row level security;
alter table public.conversation_messages enable row level security;
alter table public.watches enable row level security;
alter table public.watch_deliveries enable row level security;
alter table public.source_catalog enable row level security;
alter table public.user_source_policies enable row level security;
alter table public.command_audit enable row level security;

create policy "Users manage their profile context" on public.profile_context
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users manage their brief definitions" on public.brief_definitions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users read their brief delivery state" on public.brief_event_state
  for select using (auth.uid() = user_id);
create policy "Users manage their conversations" on public.conversations
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users manage their conversation messages" on public.conversation_messages
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users manage their watches" on public.watches
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users read their watch deliveries" on public.watch_deliveries
  for select using (exists (select 1 from public.watches w where w.id = watch_deliveries.watch_id and w.user_id = auth.uid()));
create policy "Authenticated users read the source catalog" on public.source_catalog
  for select using (auth.role() = 'authenticated');
create policy "Users manage their source policies" on public.user_source_policies
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users read their command audit" on public.command_audit
  for select using (auth.uid() = user_id);

create policy "Users read watched events" on public.events
  for select using (exists (select 1 from public.watches w where w.event_id = events.id and w.user_id = auth.uid()));
create policy "Users read watched updates" on public.event_updates
  for select using (exists (select 1 from public.watches w where w.event_id = event_updates.event_id and w.user_id = auth.uid()));
create policy "Users read sources for watched events" on public.event_sources
  for select using (exists (select 1 from public.watches w where w.event_id = event_sources.event_id and w.user_id = auth.uid()));
