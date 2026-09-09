-- Content Studio is deliberately a user-owned drafting and scheduling layer.
-- It does not contain social-provider credentials, recipient contact data, or
-- any implicit publishing path. Provider integrations consume only approved,
-- explicitly scheduled content through a server-side seam.

create or replace function public.content_channel_array_is_valid(p_channels text[], p_allow_empty boolean default false)
returns boolean
language sql
immutable
set search_path = public
as $$
  select p_channels is not null
    and array_position(p_channels, null) is null
    and (p_allow_empty or cardinality(p_channels) > 0)
    and p_channels <@ array['facebook_page', 'instagram', 'linkedin', 'newsletter']::text[]
    and cardinality(p_channels) = (
      select count(distinct value) from unnest(p_channels) as entry(value)
    );
$$;

create or replace function public.content_weekday_array_is_valid(p_weekdays smallint[])
returns boolean
language sql
immutable
set search_path = public
as $$
  select p_weekdays is not null
    and array_position(p_weekdays, null) is null
    and p_weekdays <@ array[0,1,2,3,4,5,6]::smallint[]
    and cardinality(p_weekdays) = (
      select count(distinct value) from unnest(p_weekdays) as entry(value)
    );
$$;

create table if not exists public.newsletter_audiences (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 2 and 160),
  description text not null default '' check (char_length(description) <= 1000),
  sender_name text check (char_length(sender_name) <= 160),
  sender_email text check (char_length(sender_email) <= 320),
  reply_to_email text check (char_length(reply_to_email) <= 320),
  audience_metadata jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (user_id, name)
);
create index if not exists newsletter_audiences_user_active_idx
  on public.newsletter_audiences(user_id, active, updated_at desc);

-- System templates are durable starter records, not client-side mock data.
-- user_id is null only for these read-only records; custom templates are
-- always owned by exactly one profile.
create table if not exists public.content_templates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(user_id) on delete cascade,
  is_system_template boolean not null default false,
  slug text not null check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' and char_length(slug) between 2 and 80),
  name text not null check (char_length(btrim(name)) between 2 and 120),
  description text not null default '' check (char_length(description) <= 1000),
  content_type text not null check (content_type in ('social_post', 'newsletter', 'article')),
  channels text[] not null default array[]::text[] check (public.content_channel_array_is_valid(channels, content_type = 'article')),
  default_title text not null default '' check (char_length(default_title) <= 240),
  default_headline text check (char_length(default_headline) <= 280),
  default_subject text check (char_length(default_subject) <= 280),
  default_body text not null default '' check (char_length(default_body) <= 60000),
  default_cta text check (char_length(default_cta) <= 280),
  default_excerpt text check (char_length(default_excerpt) <= 280),
  default_hashtags jsonb not null default '[]'::jsonb check (jsonb_typeof(default_hashtags) = 'array'),
  generation_prompt text not null default '' check (char_length(generation_prompt) <= 12000),
  image_prompt text not null default '' check (char_length(image_prompt) <= 12000),
  default_language text not null default 'sv' check (default_language ~ '^[a-z]{2}(-[A-Z]{2})?$'),
  active boolean not null default true,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint content_templates_owner_shape_check check (
    (is_system_template and user_id is null) or (not is_system_template and user_id is not null)
  ),
  constraint content_templates_newsletter_channel_check check (
    (content_type = 'newsletter' and channels = array['newsletter']::text[])
    or (content_type <> 'newsletter' and not ('newsletter' = any(channels)))
  ),
  unique (slug)
);
create index if not exists content_templates_user_active_idx
  on public.content_templates(user_id, active, updated_at desc)
  where user_id is not null;

create table if not exists public.content_automation_rules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 2 and 160),
  active boolean not null default true,
  content_type text not null check (content_type in ('social_post', 'newsletter', 'article')),
  channels text[] not null check (public.content_channel_array_is_valid(channels, false)),
  template_id uuid references public.content_templates(id) on delete set null,
  newsletter_audience_id uuid references public.newsletter_audiences(id) on delete set null,
  generation_prompt text not null default '' check (char_length(generation_prompt) <= 12000),
  image_prompt text not null default '' check (char_length(image_prompt) <= 12000),
  desired_length integer check (desired_length between 20 and 60000),
  tone text check (char_length(tone) <= 500),
  language text not null default 'sv' check (language ~ '^[a-z]{2}(-[A-Z]{2})?$'),
  approval_required boolean not null default true,
  timezone text not null default 'Europe/Stockholm' check (char_length(timezone) between 3 and 80),
  schedule_mode text not null default 'weekly_count' check (schedule_mode in ('weekly_count', 'cron')),
  weekly_count smallint check (weekly_count between 1 and 7),
  weekdays smallint[] not null default array[]::smallint[] check (public.content_weekday_array_is_valid(weekdays)),
  local_times time[] not null default array['09:00'::time] check (
    cardinality(local_times) between 1 and 7 and array_position(local_times, null) is null
  ),
  cron_expression text check (char_length(cron_expression) between 9 and 160),
  starts_on date,
  ends_on date,
  next_run_at timestamptz,
  last_run_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint content_automation_rules_schedule_shape_check check (
    (schedule_mode = 'weekly_count' and weekly_count is not null and cron_expression is null)
    or (schedule_mode = 'cron' and weekly_count is null and cron_expression is not null)
  ),
  constraint content_automation_rules_dates_check check (ends_on is null or starts_on is null or starts_on <= ends_on),
  constraint content_automation_rules_newsletter_channel_check check (
    (content_type = 'newsletter' and channels = array['newsletter']::text[])
    or (content_type <> 'newsletter' and not ('newsletter' = any(channels)))
  )
);
create index if not exists content_automation_rules_user_active_idx
  on public.content_automation_rules(user_id, active, next_run_at);

-- Jobs are scheduled instances. A unique slot makes a 15-minute cron wake-up
-- idempotent: it may safely inspect or seed the same window more than once.
create table if not exists public.content_automation_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  automation_rule_id uuid not null references public.content_automation_rules(id) on delete cascade,
  state text not null default 'queued' check (state in ('queued', 'processing', 'completed', 'failed', 'cancelled', 'skipped')),
  scheduled_for timestamptz not null,
  timezone text not null check (char_length(timezone) between 3 and 80),
  scheduled_local_date date not null,
  scheduled_local_time time not null,
  claim_token uuid,
  locked_until timestamptz,
  claimed_at timestamptz,
  completed_at timestamptz,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  last_error text check (char_length(last_error) <= 4000),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (automation_rule_id, scheduled_for)
);
create index if not exists content_automation_jobs_due_idx
  on public.content_automation_jobs(state, scheduled_for)
  where state in ('queued', 'processing');
create index if not exists content_automation_jobs_user_calendar_idx
  on public.content_automation_jobs(user_id, scheduled_for);

create table if not exists public.content_drafts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  content_type text not null check (content_type in ('social_post', 'newsletter', 'article')),
  channels text[] not null default array[]::text[] check (public.content_channel_array_is_valid(channels, content_type = 'article')),
  title text not null default '' check (char_length(title) <= 240),
  headline text check (char_length(headline) <= 280),
  subject text check (char_length(subject) <= 280),
  body text not null default '' check (char_length(body) <= 60000),
  cta text check (char_length(cta) <= 280),
  excerpt text check (char_length(excerpt) <= 280),
  hashtags jsonb not null default '[]'::jsonb check (jsonb_typeof(hashtags) = 'array'),
  status text not null default 'draft' check (status in ('draft', 'in_review', 'approved', 'scheduled', 'publishing', 'published', 'failed', 'cancelled')),
  generation_prompt text check (char_length(generation_prompt) <= 60000),
  image_prompt text check (char_length(image_prompt) <= 60000),
  language text not null default 'sv' check (language ~ '^[a-z]{2}(-[A-Z]{2})?$'),
  timezone text not null default 'Europe/Stockholm' check (char_length(timezone) between 3 and 80),
  scheduled_at timestamptz,
  scheduled_local_date date,
  scheduled_local_time time,
  approval_required boolean not null default true,
  approved_at timestamptz,
  published_at timestamptz,
  template_id uuid references public.content_templates(id) on delete set null,
  automation_rule_id uuid references public.content_automation_rules(id) on delete set null,
  automation_job_id uuid unique references public.content_automation_jobs(id) on delete set null,
  newsletter_audience_id uuid references public.newsletter_audiences(id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint content_drafts_schedule_shape_check check (
    (scheduled_at is null and scheduled_local_date is null and scheduled_local_time is null)
    or (scheduled_at is not null and scheduled_local_date is not null and scheduled_local_time is not null)
  ),
  constraint content_drafts_scheduled_status_check check (
    status <> 'scheduled' or scheduled_at is not null
  ),
  constraint content_drafts_approval_schedule_check check (
    not approval_required or status <> 'scheduled' or approved_at is not null
  ),
  constraint content_drafts_newsletter_channel_check check (
    (content_type = 'newsletter' and channels = array['newsletter']::text[])
    or (content_type <> 'newsletter' and not ('newsletter' = any(channels)))
  )
);
create index if not exists content_drafts_user_updated_idx
  on public.content_drafts(user_id, updated_at desc);
create index if not exists content_drafts_user_scheduled_idx
  on public.content_drafts(user_id, scheduled_at)
  where scheduled_at is not null;
create index if not exists content_drafts_status_scheduled_idx
  on public.content_drafts(status, scheduled_at)
  where status in ('approved', 'scheduled', 'publishing');

create table if not exists public.content_media_attachments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  content_draft_id uuid not null references public.content_drafts(id) on delete cascade,
  kind text not null check (kind in ('image', 'video', 'document')),
  source text not null check (source in ('upload', 'generated', 'library', 'external')),
  storage_path text check (char_length(storage_path) between 3 and 1000),
  asset_url text check (char_length(asset_url) <= 2000),
  filename text check (char_length(filename) <= 255),
  mime_type text check (char_length(mime_type) <= 120),
  byte_size integer check (byte_size between 0 and 100000000),
  alt_text text check (char_length(alt_text) <= 1000),
  caption text check (char_length(caption) <= 2000),
  processing_status text not null default 'original' check (processing_status in ('original', 'processing', 'ready', 'failed')),
  adaptation_prompt text check (char_length(adaptation_prompt) <= 8000),
  variants jsonb not null default '{}'::jsonb check (jsonb_typeof(variants) = 'object'),
  sort_order smallint not null default 0 check (sort_order between 0 and 100),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint content_media_attachments_asset_check check (storage_path is not null or asset_url is not null)
);
create index if not exists content_media_attachments_draft_order_idx
  on public.content_media_attachments(content_draft_id, sort_order, created_at);

-- Server-side writes still validate every cross-table ownership boundary. This
-- makes an accidental service-role filter omission unable to attach one user's
-- audience, job, template or media to another user's document.
create or replace function public.validate_content_automation_rule_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_template_owner uuid;
  v_template_system boolean;
  v_audience_owner uuid;
begin
  if new.template_id is not null then
    select user_id, is_system_template into v_template_owner, v_template_system
    from public.content_templates where id = new.template_id;
    if not found or (not v_template_system and v_template_owner <> new.user_id) then
      raise exception 'Content template must belong to the automation owner';
    end if;
  end if;
  if new.newsletter_audience_id is not null then
    select user_id into v_audience_owner from public.newsletter_audiences where id = new.newsletter_audience_id;
    if v_audience_owner is null or v_audience_owner <> new.user_id then
      raise exception 'Newsletter audience must belong to the automation owner';
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.validate_content_automation_job_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rule_owner uuid;
  v_rule_timezone text;
begin
  select user_id, timezone into v_rule_owner, v_rule_timezone
  from public.content_automation_rules where id = new.automation_rule_id;
  if v_rule_owner is null or v_rule_owner <> new.user_id then
    raise exception 'Content automation job must belong to its rule owner';
  end if;
  if new.timezone <> v_rule_timezone then
    raise exception 'Content automation job must use its rule timezone';
  end if;
  return new;
end;
$$;

create or replace function public.validate_content_draft_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_template_owner uuid;
  v_template_system boolean;
  v_rule_owner uuid;
  v_job_owner uuid;
  v_job_rule_id uuid;
  v_audience_owner uuid;
begin
  if new.template_id is not null then
    select user_id, is_system_template into v_template_owner, v_template_system
    from public.content_templates where id = new.template_id;
    if not found or (not v_template_system and v_template_owner <> new.user_id) then
      raise exception 'Content template must belong to the draft owner';
    end if;
  end if;
  if new.automation_rule_id is not null then
    select user_id into v_rule_owner from public.content_automation_rules where id = new.automation_rule_id;
    if v_rule_owner is null or v_rule_owner <> new.user_id then
      raise exception 'Content automation rule must belong to the draft owner';
    end if;
  end if;
  if new.automation_job_id is not null then
    select user_id, automation_rule_id into v_job_owner, v_job_rule_id
    from public.content_automation_jobs where id = new.automation_job_id;
    if v_job_owner is null or v_job_owner <> new.user_id then
      raise exception 'Content automation job must belong to the draft owner';
    end if;
    if new.automation_rule_id is not null and new.automation_rule_id <> v_job_rule_id then
      raise exception 'Content automation job and rule must match';
    end if;
  end if;
  if new.newsletter_audience_id is not null then
    select user_id into v_audience_owner from public.newsletter_audiences where id = new.newsletter_audience_id;
    if v_audience_owner is null or v_audience_owner <> new.user_id then
      raise exception 'Newsletter audience must belong to the draft owner';
    end if;
  end if;
  if new.status = 'approved' and new.approved_at is null then
    new.approved_at := timezone('utc', now());
  elsif new.status in ('draft', 'in_review', 'cancelled') then
    new.approved_at := null;
  end if;
  if new.status = 'published' and new.published_at is null then
    new.published_at := timezone('utc', now());
  end if;
  return new;
end;
$$;

create or replace function public.validate_content_media_attachment_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_draft_owner uuid;
begin
  select user_id into v_draft_owner from public.content_drafts where id = new.content_draft_id;
  if v_draft_owner is null or v_draft_owner <> new.user_id then
    raise exception 'Content media must belong to its draft owner';
  end if;
  if new.storage_path is not null and (
    split_part(new.storage_path, '/', 1) <> new.user_id::text
    or split_part(new.storage_path, '/', 2) <> new.content_draft_id::text
  ) then
    raise exception 'Content storage path must be user-id/draft-id/...';
  end if;
  return new;
end;
$$;

drop trigger if exists content_automation_rules_validate_owner_before_write on public.content_automation_rules;
create trigger content_automation_rules_validate_owner_before_write
before insert or update of user_id, template_id, newsletter_audience_id on public.content_automation_rules
for each row execute function public.validate_content_automation_rule_owner();

drop trigger if exists content_automation_jobs_validate_owner_before_write on public.content_automation_jobs;
create trigger content_automation_jobs_validate_owner_before_write
before insert or update of user_id, automation_rule_id, timezone on public.content_automation_jobs
for each row execute function public.validate_content_automation_job_owner();

drop trigger if exists content_drafts_validate_owner_before_write on public.content_drafts;
create trigger content_drafts_validate_owner_before_write
before insert or update of user_id, template_id, automation_rule_id, automation_job_id, newsletter_audience_id, status on public.content_drafts
for each row execute function public.validate_content_draft_owner();

drop trigger if exists content_media_attachments_validate_owner_before_write on public.content_media_attachments;
create trigger content_media_attachments_validate_owner_before_write
before insert or update of user_id, content_draft_id, storage_path on public.content_media_attachments
for each row execute function public.validate_content_media_attachment_owner();

drop trigger if exists newsletter_audiences_updated_at on public.newsletter_audiences;
create trigger newsletter_audiences_updated_at before update on public.newsletter_audiences
for each row execute function public.set_updated_at();
drop trigger if exists content_templates_updated_at on public.content_templates;
create trigger content_templates_updated_at before update on public.content_templates
for each row execute function public.set_updated_at();
drop trigger if exists content_automation_rules_updated_at on public.content_automation_rules;
create trigger content_automation_rules_updated_at before update on public.content_automation_rules
for each row execute function public.set_updated_at();
drop trigger if exists content_automation_jobs_updated_at on public.content_automation_jobs;
create trigger content_automation_jobs_updated_at before update on public.content_automation_jobs
for each row execute function public.set_updated_at();
drop trigger if exists content_drafts_updated_at on public.content_drafts;
create trigger content_drafts_updated_at before update on public.content_drafts
for each row execute function public.set_updated_at();
drop trigger if exists content_media_attachments_updated_at on public.content_media_attachments;
create trigger content_media_attachments_updated_at before update on public.content_media_attachments
for each row execute function public.set_updated_at();

-- Real starter templates make a fresh account useful before the user has made
-- anything. They remain globally readable and are intentionally immutable.
insert into public.content_templates (
  user_id, is_system_template, slug, name, description, content_type, channels,
  default_title, default_headline, default_subject, default_body, default_cta,
  default_excerpt, default_hashtags, generation_prompt, image_prompt, default_language, active
) values
  (
    null, true, 'founder-insight', 'Grundarens insikt',
    'Ett rakt inlägg med en konkret lärdom, ståndpunkt eller observation.', 'social_post',
    array['linkedin', 'facebook_page', 'instagram']::text[], '', 'En sak jag har lärt mig.', null,
    '', 'Vad har du sett i din verksamhet?', null, '[]'::jsonb,
    'Skriv rakt, konkret och utan marknadsföringsspråk. Börja med poängen. Lägg till ett exempel och avsluta med en enkel fråga.',
    'Redaktionell, varm och trovärdig bild som stödjer en grundares konkreta insikt. Ingen text i bilden.', 'sv', true
  ),
  (
    null, true, 'product-update', 'Produktnyhet',
    'För en faktisk produktförändring och varför den spelar roll för kunden.', 'social_post',
    array['linkedin', 'facebook_page', 'instagram']::text[], '', 'Vi har byggt detta för att lösa ett konkret problem.', null,
    '', 'Se vad det betyder i praktiken.', null, '[]'::jsonb,
    'Beskriv först den verkliga förändringen, sedan vem den hjälper och hur. Undvik superlativ och tomma lanseringsord.',
    'Ren produktnära redaktionell bild med verklig miljö eller detalj. Ingen fejkad användargränssnittstext.', 'sv', true
  ),
  (
    null, true, 'weekly-newsletter', 'Veckans nyhetsbrev',
    'En tydlig veckoutgåva med det viktigaste, ett perspektiv och nästa steg.', 'newsletter',
    array['newsletter']::text[], '', 'Det här var veckan som faktiskt spelade roll.', 'Veckans viktigaste',
    '', 'Svara gärna direkt på detta mejl.', 'Det viktigaste från veckan, utan brus.', '[]'::jsonb,
    'Skriv ett lättläst nyhetsbrev med kort intro, tre konkreta punkter och en tydlig avslutning. Säg vad läsaren bör göra eller tänka annorlunda.',
    'Lugn redaktionell omslagsbild som fångar veckans ämne. Ingen text i bilden.', 'sv', true
  ),
  (
    null, true, 'deep-dive-article', 'Fördjupande artikel',
    'För ett sammanhängande resonemang som kan bli artikel eller längre LinkedIn-inlägg.', 'article',
    array[]::text[], '', 'Det här är förändringen som är värd att förstå.', null,
    '', null, 'Kort sammanfattning av varför ämnet spelar roll.', '[]'::jsonb,
    'Skriv en sammanhängande, konkret artikel med tydlig tes, fakta, konsekvens och avslutande nästa steg. Ingen utfyllnad.',
    'Dokumentär redaktionell huvudbild som visar det verkliga ämnet. Ingen text i bilden.', 'sv', true
  )
on conflict (slug) do update set
  name = excluded.name,
  description = excluded.description,
  content_type = excluded.content_type,
  channels = excluded.channels,
  default_title = excluded.default_title,
  default_headline = excluded.default_headline,
  default_subject = excluded.default_subject,
  default_body = excluded.default_body,
  default_cta = excluded.default_cta,
  default_excerpt = excluded.default_excerpt,
  default_hashtags = excluded.default_hashtags,
  generation_prompt = excluded.generation_prompt,
  image_prompt = excluded.image_prompt,
  default_language = excluded.default_language,
  active = excluded.active
where public.content_templates.is_system_template;

alter table public.newsletter_audiences enable row level security;
alter table public.content_templates enable row level security;
alter table public.content_automation_rules enable row level security;
alter table public.content_automation_jobs enable row level security;
alter table public.content_drafts enable row level security;
alter table public.content_media_attachments enable row level security;

create policy "Users manage their newsletter audiences" on public.newsletter_audiences
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users read own and system content templates" on public.content_templates
  for select using (is_system_template or auth.uid() = user_id);
create policy "Users create custom content templates" on public.content_templates
  for insert with check (auth.uid() = user_id and not is_system_template);
create policy "Users update custom content templates" on public.content_templates
  for update using (auth.uid() = user_id and not is_system_template)
  with check (auth.uid() = user_id and not is_system_template);
create policy "Users delete custom content templates" on public.content_templates
  for delete using (auth.uid() = user_id and not is_system_template);
create policy "Users manage their content automation rules" on public.content_automation_rules
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users manage their content automation jobs" on public.content_automation_jobs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users manage their content drafts" on public.content_drafts
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users manage their content media" on public.content_media_attachments
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Private Storage is addressed as `user_id/draft_id/file-name`. The database
-- trigger above requires that same shape before an attachment record exists.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'content-media',
  'content-media',
  false,
  104857600,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'application/pdf']::text[]
)
on conflict (id) do nothing;

drop policy if exists "Users read their content media objects" on storage.objects;
drop policy if exists "Users upload their content media objects" on storage.objects;
drop policy if exists "Users update their content media objects" on storage.objects;
drop policy if exists "Users delete their content media objects" on storage.objects;
create policy "Users read their content media objects" on storage.objects
  for select to authenticated using (
    bucket_id = 'content-media'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
create policy "Users upload their content media objects" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'content-media'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
create policy "Users update their content media objects" on storage.objects
  for update to authenticated using (
    bucket_id = 'content-media'
    and (storage.foldername(name))[1] = auth.uid()::text
  ) with check (
    bucket_id = 'content-media'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
create policy "Users delete their content media objects" on storage.objects
  for delete to authenticated using (
    bucket_id = 'content-media'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
