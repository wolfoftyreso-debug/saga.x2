-- Newsletter delivery is a private, server-operated subsystem. Content Studio
-- owns the authored draft and audience settings; this migration adds the
-- consented contacts and the durable, per-recipient delivery ledger.
--
-- The ledger deliberately treats an interrupted network request as `unknown`
-- rather than retrying it automatically. That favours not sending a duplicate
-- email over pretending that an uncertain provider response was a failure.

create table if not exists public.newsletter_contacts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  newsletter_audience_id uuid not null references public.newsletter_audiences(id) on delete cascade,
  email text not null check (char_length(btrim(email)) between 3 and 320 and position('@' in btrim(email)) > 1),
  email_normalized text generated always as (lower(btrim(email))) stored,
  display_name text check (char_length(display_name) <= 240),
  status text not null default 'subscribed' check (status in ('subscribed', 'unsubscribed', 'bounced', 'complained', 'suppressed')),
  consent_source text not null default 'manual' check (char_length(btrim(consent_source)) between 1 and 160),
  consented_at timestamptz,
  unsubscribed_at timestamptz,
  suppression_reason text check (char_length(suppression_reason) <= 1000),
  contact_metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(contact_metadata) = 'object'),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint newsletter_contacts_consent_shape_check check (
    (status = 'subscribed' and consented_at is not null and unsubscribed_at is null)
    or (status = 'unsubscribed' and unsubscribed_at is not null)
    or (status in ('bounced', 'complained', 'suppressed'))
  ),
  unique (newsletter_audience_id, email_normalized)
);
create index if not exists newsletter_contacts_audience_status_idx
  on public.newsletter_contacts(newsletter_audience_id, status, updated_at desc);
create index if not exists newsletter_contacts_user_email_idx
  on public.newsletter_contacts(user_id, email_normalized);

-- One receipt is one intended recipient of one immutable publication action.
-- No raw recipient email is copied into the receipt: it remains in the
-- private contact table and ordinary draft/audience reads only receive counts.
create table if not exists public.newsletter_delivery_receipts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  content_draft_id uuid not null references public.content_drafts(id) on delete restrict,
  newsletter_audience_id uuid not null references public.newsletter_audiences(id) on delete restrict,
  newsletter_contact_id uuid references public.newsletter_contacts(id) on delete set null,
  recipient_fingerprint text not null check (recipient_fingerprint ~ '^[a-f0-9]{64}$'),
  idempotency_key text not null check (char_length(btrim(idempotency_key)) between 16 and 220),
  provider text not null default 'resend' check (provider in ('resend')),
  state text not null default 'queued' check (state in ('queued', 'sending', 'delivered', 'failed', 'suppressed', 'cancelled', 'unknown')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts integer not null default 4 check (max_attempts between 1 and 10),
  next_attempt_at timestamptz,
  lock_token uuid,
  locked_until timestamptz,
  last_attempt_at timestamptz,
  delivered_at timestamptz,
  provider_message_id text,
  last_error_code text check (char_length(last_error_code) <= 160),
  last_error_message text check (char_length(last_error_message) <= 2000),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint newsletter_delivery_receipts_terminal_shape_check check (
    (state = 'delivered' and delivered_at is not null and provider_message_id is not null)
    or (state <> 'delivered')
  ),
  constraint newsletter_delivery_receipts_lock_shape_check check (
    (state = 'sending' and lock_token is not null and locked_until is not null)
    or (state <> 'sending')
  ),
  unique (user_id, content_draft_id, newsletter_audience_id, recipient_fingerprint),
  unique (user_id, idempotency_key)
);
create index if not exists newsletter_delivery_receipts_due_idx
  on public.newsletter_delivery_receipts(state, next_attempt_at, created_at)
  where state in ('queued', 'failed');
create index if not exists newsletter_delivery_receipts_draft_idx
  on public.newsletter_delivery_receipts(user_id, content_draft_id, created_at desc);
create index if not exists newsletter_delivery_receipts_audience_idx
  on public.newsletter_delivery_receipts(user_id, newsletter_audience_id, state);

create table if not exists public.newsletter_delivery_attempts (
  id uuid primary key default gen_random_uuid(),
  receipt_id uuid not null references public.newsletter_delivery_receipts(id) on delete cascade,
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  attempt_number integer not null check (attempt_number >= 1),
  state text not null default 'sending' check (state in ('sending', 'delivered', 'failed', 'unknown')),
  provider text not null default 'resend' check (provider in ('resend')),
  provider_message_id text,
  provider_request_id text,
  error_code text check (char_length(error_code) <= 160),
  error_message text check (char_length(error_message) <= 2000),
  started_at timestamptz not null default timezone('utc', now()),
  finished_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  constraint newsletter_delivery_attempts_terminal_shape_check check (
    (state = 'sending' and finished_at is null)
    or (state in ('delivered', 'failed', 'unknown') and finished_at is not null)
  ),
  unique (receipt_id, attempt_number)
);
create index if not exists newsletter_delivery_attempts_receipt_idx
  on public.newsletter_delivery_attempts(receipt_id, attempt_number desc);

-- Keep service-role writes honest even though browser roles have no access to
-- contact and receipt data. An audience, draft and contact can never cross a
-- user boundary, and a receipt always belongs to a newsletter draft's chosen
-- audience.
create or replace function public.validate_newsletter_contact_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_audience_owner uuid;
begin
  select user_id into v_audience_owner
  from public.newsletter_audiences where id = new.newsletter_audience_id;
  if v_audience_owner is null or v_audience_owner <> new.user_id then
    raise exception 'Newsletter contact must belong to its audience owner';
  end if;
  if new.status = 'subscribed' and new.consented_at is null then
    new.consented_at := timezone('utc', now());
  end if;
  if new.status = 'unsubscribed' and new.unsubscribed_at is null then
    new.unsubscribed_at := timezone('utc', now());
  end if;
  return new;
end;
$$;

create or replace function public.validate_newsletter_delivery_receipt_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_draft_owner uuid;
  v_draft_type text;
  v_draft_audience uuid;
  v_audience_owner uuid;
  v_contact_owner uuid;
  v_contact_audience uuid;
begin
  select user_id, content_type, newsletter_audience_id
  into v_draft_owner, v_draft_type, v_draft_audience
  from public.content_drafts where id = new.content_draft_id;
  if v_draft_owner is null or v_draft_owner <> new.user_id or v_draft_type <> 'newsletter' or v_draft_audience is distinct from new.newsletter_audience_id then
    raise exception 'Newsletter delivery receipt must match its owner, newsletter draft and selected audience';
  end if;
  select user_id into v_audience_owner
  from public.newsletter_audiences where id = new.newsletter_audience_id;
  if v_audience_owner is null or v_audience_owner <> new.user_id then
    raise exception 'Newsletter delivery receipt audience must belong to its owner';
  end if;
  if new.newsletter_contact_id is not null then
    select user_id, newsletter_audience_id into v_contact_owner, v_contact_audience
    from public.newsletter_contacts where id = new.newsletter_contact_id;
    if v_contact_owner is null or v_contact_owner <> new.user_id or v_contact_audience <> new.newsletter_audience_id then
      raise exception 'Newsletter delivery receipt contact must belong to its audience owner';
    end if;
  end if;
  if tg_op = 'UPDATE' and (
    old.content_draft_id <> new.content_draft_id
    or old.newsletter_audience_id <> new.newsletter_audience_id
    or old.recipient_fingerprint <> new.recipient_fingerprint
    or old.idempotency_key <> new.idempotency_key
  ) then
    raise exception 'Newsletter delivery receipt identity is immutable';
  end if;
  return new;
end;
$$;

create or replace function public.validate_newsletter_delivery_attempt_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_receipt_owner uuid;
begin
  select user_id into v_receipt_owner from public.newsletter_delivery_receipts where id = new.receipt_id;
  if v_receipt_owner is null or v_receipt_owner <> new.user_id then
    raise exception 'Newsletter delivery attempt must belong to its receipt owner';
  end if;
  return new;
end;
$$;

drop trigger if exists newsletter_contacts_validate_owner_before_write on public.newsletter_contacts;
create trigger newsletter_contacts_validate_owner_before_write
before insert or update of user_id, newsletter_audience_id, status, consented_at, unsubscribed_at on public.newsletter_contacts
for each row execute function public.validate_newsletter_contact_owner();

drop trigger if exists newsletter_delivery_receipts_validate_owner_before_write on public.newsletter_delivery_receipts;
create trigger newsletter_delivery_receipts_validate_owner_before_write
before insert or update of user_id, content_draft_id, newsletter_audience_id, newsletter_contact_id, recipient_fingerprint, idempotency_key on public.newsletter_delivery_receipts
for each row execute function public.validate_newsletter_delivery_receipt_owner();

drop trigger if exists newsletter_delivery_attempts_validate_owner_before_write on public.newsletter_delivery_attempts;
create trigger newsletter_delivery_attempts_validate_owner_before_write
before insert or update of user_id, receipt_id on public.newsletter_delivery_attempts
for each row execute function public.validate_newsletter_delivery_attempt_owner();

drop trigger if exists newsletter_contacts_updated_at on public.newsletter_contacts;
create trigger newsletter_contacts_updated_at before update on public.newsletter_contacts
for each row execute function public.set_updated_at();
drop trigger if exists newsletter_delivery_receipts_updated_at on public.newsletter_delivery_receipts;
create trigger newsletter_delivery_receipts_updated_at before update on public.newsletter_delivery_receipts
for each row execute function public.set_updated_at();

-- Stage all consented contacts in one idempotent operation. The input must
-- point to a newsletter draft and precisely the audience selected on it.
create or replace function public.stage_newsletter_delivery_receipts(
  p_user_id uuid,
  p_content_draft_id uuid,
  p_newsletter_audience_id uuid
)
returns table(eligible_count integer, inserted_count integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_eligible_count integer := 0;
  v_inserted_count integer := 0;
begin
  if not exists (
    select 1
    from public.content_drafts d
    join public.newsletter_audiences a on a.id = d.newsletter_audience_id
    where d.id = p_content_draft_id
      and d.user_id = p_user_id
      and d.content_type = 'newsletter'
      and d.newsletter_audience_id = p_newsletter_audience_id
      and d.status in ('approved', 'scheduled', 'publishing')
      and coalesce(nullif(btrim(d.subject), ''), nullif(btrim(d.title), ''), nullif(btrim(d.headline), '')) is not null
      and a.user_id = p_user_id
  ) then
    raise exception 'Newsletter draft and audience do not form an owned publication target';
  end if;

  select count(*)::integer into v_eligible_count
  from public.newsletter_contacts c
  where c.user_id = p_user_id
    and c.newsletter_audience_id = p_newsletter_audience_id
    and c.status = 'subscribed';

  with inserted as (
    insert into public.newsletter_delivery_receipts (
      user_id,
      content_draft_id,
      newsletter_audience_id,
      newsletter_contact_id,
      recipient_fingerprint,
      idempotency_key,
      state,
      next_attempt_at
    )
    select
      p_user_id,
      p_content_draft_id,
      p_newsletter_audience_id,
      c.id,
      encode(digest(c.email_normalized, 'sha256'), 'hex'),
      'newsletter:' || encode(digest(p_content_draft_id::text || ':' || p_newsletter_audience_id::text || ':' || c.email_normalized, 'sha256'), 'hex'),
      'queued',
      timezone('utc', now())
    from public.newsletter_contacts c
    where c.user_id = p_user_id
      and c.newsletter_audience_id = p_newsletter_audience_id
      and c.status = 'subscribed'
    on conflict (user_id, content_draft_id, newsletter_audience_id, recipient_fingerprint) do nothing
    returning id
  )
  select count(*)::integer into v_inserted_count from inserted;

  return query select v_eligible_count, v_inserted_count;
end;
$$;

-- Atomically claim recipients and log their attempt before the provider call.
-- `sending` rows are intentionally never reclaimed automatically: a process
-- may have reached the provider just before it died, so retrying would risk a
-- duplicate email. Operators can reconcile `unknown` rows explicitly.
create or replace function public.claim_newsletter_delivery_receipts(
  p_user_id uuid,
  p_limit integer default 25,
  p_lock_seconds integer default 300
)
returns table(
  receipt_id uuid,
  claim_token uuid,
  user_id uuid,
  content_draft_id uuid,
  newsletter_audience_id uuid,
  newsletter_contact_id uuid,
  recipient_email text,
  recipient_name text,
  subject text,
  headline text,
  body text,
  cta text,
  excerpt text,
  idempotency_key text,
  attempt_number integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := timezone('utc', now());
  v_limit integer := greatest(1, least(coalesce(p_limit, 25), 100));
  v_lock_seconds integer := greatest(60, least(coalesce(p_lock_seconds, 300), 1800));
begin
  -- An edited/cancelled draft must not leak its old audience selection into a
  -- later cron run. The user has changed the publication target, so cancel
  -- unclaimed receipts instead of silently sending the stale version.
  update public.newsletter_delivery_receipts r
  set state = 'cancelled',
      lock_token = null,
      locked_until = null,
      next_attempt_at = null,
      last_error_code = 'publication_target_changed',
      last_error_message = 'Utkastet eller mottagargruppen ändrades före leverans.',
      updated_at = v_now
  where r.user_id = p_user_id
    and r.state in ('queued', 'failed')
    and not exists (
      select 1 from public.content_drafts d
      where d.id = r.content_draft_id
        and d.user_id = r.user_id
        and d.content_type = 'newsletter'
        and d.newsletter_audience_id = r.newsletter_audience_id
        and d.status in ('approved', 'scheduled', 'publishing')
    );

  update public.newsletter_delivery_receipts r
  set state = 'suppressed',
      lock_token = null,
      locked_until = null,
      next_attempt_at = null,
      last_error_code = 'recipient_not_subscribed',
      last_error_message = 'Mottagaren är inte längre aktivt prenumererande.',
      updated_at = v_now
  where r.user_id = p_user_id
    and r.state in ('queued', 'failed')
    and (r.newsletter_contact_id is null or not exists (
      select 1 from public.newsletter_contacts c
      where c.id = r.newsletter_contact_id
        and c.user_id = r.user_id
        and c.newsletter_audience_id = r.newsletter_audience_id
        and c.status = 'subscribed'
    ));

  return query
  with candidates as (
    select r.id
    from public.newsletter_delivery_receipts r
    join public.newsletter_contacts c on c.id = r.newsletter_contact_id
    join public.content_drafts d on d.id = r.content_draft_id
    where r.user_id = p_user_id
      and (
        (r.state = 'queued' and (r.next_attempt_at is null or r.next_attempt_at <= v_now))
        or (r.state = 'failed' and r.next_attempt_at is not null and r.next_attempt_at <= v_now)
      )
      and r.attempt_count < r.max_attempts
      and c.status = 'subscribed'
      and d.user_id = r.user_id
      and d.content_type = 'newsletter'
      and d.newsletter_audience_id = r.newsletter_audience_id
      and d.status in ('approved', 'scheduled', 'publishing')
    order by coalesce(r.next_attempt_at, r.created_at), r.created_at
    limit v_limit
    for update of r skip locked
  ), claimed as (
    update public.newsletter_delivery_receipts r
    set state = 'sending',
        lock_token = gen_random_uuid(),
        locked_until = v_now + make_interval(secs => v_lock_seconds),
        last_attempt_at = v_now,
        attempt_count = r.attempt_count + 1,
        next_attempt_at = null,
        last_error_code = null,
        last_error_message = null,
        updated_at = v_now
    from candidates selected
    where r.id = selected.id
    returning r.*
  ), attempts as (
    insert into public.newsletter_delivery_attempts (
      receipt_id, user_id, attempt_number, state, provider, started_at
    )
    select id, user_id, attempt_count, 'sending', provider, v_now
    from claimed
    returning receipt_id, attempt_number
  )
  select
    r.id,
    r.lock_token,
    r.user_id,
    r.content_draft_id,
    r.newsletter_audience_id,
    r.newsletter_contact_id,
    c.email,
    c.display_name,
    coalesce(nullif(btrim(d.subject), ''), nullif(btrim(d.title), ''), nullif(btrim(d.headline), '')),
    d.headline,
    d.body,
    d.cta,
    d.excerpt,
    r.idempotency_key,
    a.attempt_number
  from claimed r
  join attempts a on a.receipt_id = r.id
  join public.newsletter_contacts c on c.id = r.newsletter_contact_id
  join public.content_drafts d on d.id = r.content_draft_id;
end;
$$;

-- Finalize a claimed provider call. Only the worker holding its one-time
-- claim token can move the receipt or its matching attempt to a terminal
-- state. `unknown` is terminal and is deliberately not queued for retry.
create or replace function public.complete_newsletter_delivery_receipt(
  p_user_id uuid,
  p_receipt_id uuid,
  p_claim_token uuid,
  p_outcome text,
  p_provider_message_id text default null,
  p_error_code text default null,
  p_error_message text default null,
  p_next_attempt_at timestamptz default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_receipt public.newsletter_delivery_receipts%rowtype;
  v_now timestamptz := timezone('utc', now());
begin
  if p_outcome not in ('delivered', 'failed', 'unknown') then
    raise exception 'Newsletter delivery outcome is invalid';
  end if;
  select * into v_receipt
  from public.newsletter_delivery_receipts
  where id = p_receipt_id and user_id = p_user_id and state = 'sending' and lock_token = p_claim_token
  for update;
  if not found then return false; end if;
  if p_outcome = 'delivered' and (p_provider_message_id is null or char_length(btrim(p_provider_message_id)) = 0) then
    raise exception 'Delivered newsletter receipt requires provider message id';
  end if;

  update public.newsletter_delivery_receipts
  set state = p_outcome,
      lock_token = null,
      locked_until = null,
      next_attempt_at = case when p_outcome = 'failed' and v_receipt.attempt_count < v_receipt.max_attempts then p_next_attempt_at else null end,
      delivered_at = case when p_outcome = 'delivered' then v_now else null end,
      provider_message_id = case when p_outcome = 'delivered' then p_provider_message_id else null end,
      last_error_code = case when p_outcome = 'delivered' then null else left(coalesce(p_error_code, 'delivery_failed'), 160) end,
      last_error_message = case when p_outcome = 'delivered' then null else left(coalesce(p_error_message, 'Nyhetsbrevsleveransen kunde inte verifieras.'), 2000) end,
      updated_at = v_now
  where id = p_receipt_id;

  update public.newsletter_delivery_attempts
  set state = p_outcome,
      provider_message_id = case when p_outcome = 'delivered' then p_provider_message_id else null end,
      error_code = case when p_outcome = 'delivered' then null else left(coalesce(p_error_code, 'delivery_failed'), 160) end,
      error_message = case when p_outcome = 'delivered' then null else left(coalesce(p_error_message, 'Nyhetsbrevsleveransen kunde inte verifieras.'), 2000) end,
      finished_at = v_now
  where receipt_id = p_receipt_id and attempt_number = v_receipt.attempt_count and state = 'sending';

  return true;
end;
$$;

alter table public.newsletter_contacts enable row level security;
alter table public.newsletter_delivery_receipts enable row level security;
alter table public.newsletter_delivery_attempts enable row level security;

-- Contacts and per-recipient receipts are sensitive. All browser interaction
-- goes through authenticated API routes with a server-side ownership check.
revoke all on table public.newsletter_contacts from anon, authenticated;
revoke all on table public.newsletter_delivery_receipts from anon, authenticated;
revoke all on table public.newsletter_delivery_attempts from anon, authenticated;
revoke all on function public.stage_newsletter_delivery_receipts(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.claim_newsletter_delivery_receipts(uuid, integer, integer) from public, anon, authenticated;
revoke all on function public.complete_newsletter_delivery_receipt(uuid, uuid, uuid, text, text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.stage_newsletter_delivery_receipts(uuid, uuid, uuid) to service_role;
grant execute on function public.claim_newsletter_delivery_receipts(uuid, integer, integer) to service_role;
grant execute on function public.complete_newsletter_delivery_receipt(uuid, uuid, uuid, text, text, text, text, timestamptz) to service_role;
