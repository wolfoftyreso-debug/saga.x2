-- Complete the canonical source catalog and add durable, service-owned
-- delivery state for proactive direct alerts. This migration is forward-only:
-- browser clients may read their own receipts but cannot manufacture alerts.

-- The TypeScript SOURCE_ALLOWLIST is intentionally mirrored here. A catalog
-- row is needed for every visible built-in source so global and
-- brief-definition-specific source policies resolve to the same stable id.
insert into public.source_catalog (domain, name, kind, default_roles)
values
  -- Swedish, EU and international public institutions.
  ('regeringen.se', 'Regeringen', 'primary', '["discovery", "verification", "citation"]'::jsonb),
  ('riksbank.se', 'Riksbanken', 'primary', '["discovery", "verification", "citation"]'::jsonb),
  ('scb.se', 'Statistiska centralbyrån', 'primary', '["discovery", "verification", "citation"]'::jsonb),
  ('fi.se', 'Finansinspektionen', 'primary', '["discovery", "verification", "citation"]'::jsonb),
  ('msb.se', 'Myndigheten för samhällsskydd och beredskap', 'primary', '["discovery", "verification", "citation"]'::jsonb),
  ('digg.se', 'Myndigheten för digital förvaltning', 'primary', '["discovery", "verification", "citation"]'::jsonb),
  ('europa.eu', 'Europeiska unionen', 'primary', '["discovery", "verification", "citation"]'::jsonb),
  ('ec.europa.eu', 'Europeiska kommissionen', 'primary', '["discovery", "verification", "citation"]'::jsonb),
  ('eur-lex.europa.eu', 'EUR-Lex', 'primary', '["discovery", "verification", "citation"]'::jsonb),
  ('consilium.europa.eu', 'Europeiska unionens råd', 'primary', '["discovery", "verification", "citation"]'::jsonb),
  ('ecb.europa.eu', 'Europeiska centralbanken', 'primary', '["discovery", "verification", "citation"]'::jsonb),
  ('esma.europa.eu', 'ESMA', 'primary', '["discovery", "verification", "citation"]'::jsonb),
  ('edpb.europa.eu', 'Europeiska dataskyddsstyrelsen', 'primary', '["discovery", "verification", "citation"]'::jsonb),
  ('enisa.europa.eu', 'ENISA', 'primary', '["discovery", "verification", "citation"]'::jsonb),
  ('echa.europa.eu', 'ECHA', 'primary', '["discovery", "verification", "citation"]'::jsonb),
  ('whitehouse.gov', 'The White House', 'primary', '["discovery", "verification", "citation"]'::jsonb),
  ('congress.gov', 'US Congress', 'primary', '["discovery", "verification", "citation"]'::jsonb),
  ('federalreserve.gov', 'Federal Reserve', 'primary', '["discovery", "verification", "citation"]'::jsonb),
  ('treasury.gov', 'US Treasury', 'primary', '["discovery", "verification", "citation"]'::jsonb),
  ('sec.gov', 'US Securities and Exchange Commission', 'primary', '["discovery", "verification", "citation"]'::jsonb),
  ('commerce.gov', 'US Department of Commerce', 'primary', '["discovery", "verification", "citation"]'::jsonb),
  ('bis.gov', 'Bureau of Industry and Security', 'primary', '["discovery", "verification", "citation"]'::jsonb),
  ('ofac.treasury.gov', 'OFAC', 'primary', '["discovery", "verification", "citation"]'::jsonb),
  ('ustr.gov', 'United States Trade Representative', 'primary', '["discovery", "verification", "citation"]'::jsonb),
  ('cisa.gov', 'CISA', 'primary', '["discovery", "verification", "citation"]'::jsonb),
  ('nist.gov', 'NIST', 'primary', '["discovery", "verification", "citation"]'::jsonb),
  ('centralbank.ae', 'Central Bank of the UAE', 'primary', '["discovery", "verification", "citation"]'::jsonb),
  ('uaelegislation.gov.ae', 'UAE Legislation', 'primary', '["discovery", "verification", "citation"]'::jsonb),
  ('moec.gov.ae', 'UAE Ministry of Economy', 'primary', '["discovery", "verification", "citation"]'::jsonb),
  ('u.ae', 'UAE Government', 'primary', '["discovery", "verification", "citation"]'::jsonb),
  ('gcc-sg.org', 'GCC Secretariat', 'primary', '["discovery", "verification", "citation"]'::jsonb),
  ('imf.org', 'International Monetary Fund', 'primary', '["discovery", "verification", "citation"]'::jsonb),
  ('oecd.org', 'OECD', 'primary', '["discovery", "verification", "citation"]'::jsonb),
  ('wto.org', 'World Trade Organization', 'primary', '["discovery", "verification", "citation"]'::jsonb),
  ('bis.org', 'Bank for International Settlements', 'primary', '["discovery", "verification", "citation"]'::jsonb),
  ('worldbank.org', 'World Bank', 'primary', '["discovery", "verification", "citation"]'::jsonb),

  -- First-party platform and infrastructure sources may be cited, but do not
  -- independently verify unrelated claims by default.
  ('openai.com', 'OpenAI', 'company', '["discovery", "citation"]'::jsonb),
  ('platform.openai.com', 'OpenAI Platform', 'company', '["discovery", "citation"]'::jsonb),
  ('anthropic.com', 'Anthropic', 'company', '["discovery", "citation"]'::jsonb),
  ('aws.amazon.com', 'Amazon Web Services', 'company', '["discovery", "citation"]'::jsonb),
  ('azure.microsoft.com', 'Microsoft Azure', 'company', '["discovery", "citation"]'::jsonb),
  ('cloud.google.com', 'Google Cloud', 'company', '["discovery", "citation"]'::jsonb),
  ('microsoft.com', 'Microsoft', 'company', '["discovery", "citation"]'::jsonb),
  ('nvidia.com', 'NVIDIA', 'company', '["discovery", "citation"]'::jsonb),
  ('amd.com', 'AMD', 'company', '["discovery", "citation"]'::jsonb),
  ('intel.com', 'Intel', 'company', '["discovery", "citation"]'::jsonb),
  ('oracle.com', 'Oracle', 'company', '["discovery", "citation"]'::jsonb),
  ('stripe.com', 'Stripe', 'company', '["discovery", "citation"]'::jsonb),
  ('adyen.com', 'Adyen', 'company', '["discovery", "citation"]'::jsonb),
  ('visa.com', 'Visa', 'company', '["discovery", "citation"]'::jsonb),
  ('mastercard.com', 'Mastercard', 'company', '["discovery", "citation"]'::jsonb),
  ('paypal.com', 'PayPal', 'company', '["discovery", "citation"]'::jsonb),

  -- Established editorial sources.
  ('reuters.com', 'Reuters', 'editorial', '["discovery", "verification", "citation"]'::jsonb),
  ('apnews.com', 'Associated Press', 'editorial', '["discovery", "verification", "citation"]'::jsonb),
  ('ft.com', 'Financial Times', 'editorial', '["discovery", "verification", "citation"]'::jsonb),
  ('bloomberg.com', 'Bloomberg', 'editorial', '["discovery", "verification", "citation"]'::jsonb),
  ('wsj.com', 'Wall Street Journal', 'editorial', '["discovery", "verification", "citation"]'::jsonb),
  ('nytimes.com', 'The New York Times', 'editorial', '["discovery", "verification", "citation"]'::jsonb),
  ('theinformation.com', 'The Information', 'editorial', '["discovery", "verification", "citation"]'::jsonb),
  ('techcrunch.com', 'TechCrunch', 'editorial', '["discovery", "verification", "citation"]'::jsonb),
  ('cnn.com', 'CNN', 'editorial', '["discovery", "verification", "citation"]'::jsonb),
  ('svd.se', 'Svenska Dagbladet', 'editorial', '["discovery", "verification", "citation"]'::jsonb),
  ('di.se', 'Dagens industri', 'editorial', '["discovery", "verification", "citation"]'::jsonb),
  ('dn.se', 'Dagens Nyheter', 'editorial', '["discovery", "verification", "citation"]'::jsonb)
on conflict (domain) do update set
  name = excluded.name,
  kind = excluded.kind,
  default_roles = excluded.default_roles;

-- Policies written before a catalog entry existed are upgraded in place. The
-- existing ownership triggers continue to enforce user/brief ownership.
update public.user_source_policies p
set source_id = c.id
from public.source_catalog c
where lower(p.domain) = c.domain
  and p.source_id is distinct from c.id;

update public.brief_source_policies p
set source_id = c.id
from public.source_catalog c
where lower(p.domain) = c.domain
  and p.source_id is distinct from c.id;

-- A direct alert is independent of a particular brief delivery but is
-- idempotent per user and event update. It can therefore be retried without
-- ever sending two chat messages for the same material change.
create table if not exists public.direct_alert_deliveries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  event_id uuid not null references public.events(id) on delete cascade,
  event_update_id uuid not null references public.event_updates(id) on delete cascade,
  brief_id uuid references public.briefs(id) on delete set null,
  conversation_message_id uuid references public.conversation_messages(id) on delete set null,
  delivery_state text not null default 'pending',
  attempt_count integer not null default 0 check (attempt_count >= 0),
  claimed_at timestamptz,
  last_attempt_at timestamptz,
  next_attempt_at timestamptz,
  last_error text,
  delivered_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

alter table public.direct_alert_deliveries
  add column if not exists event_id uuid references public.events(id) on delete cascade,
  add column if not exists event_update_id uuid references public.event_updates(id) on delete cascade,
  add column if not exists brief_id uuid references public.briefs(id) on delete set null,
  add column if not exists conversation_message_id uuid references public.conversation_messages(id) on delete set null,
  add column if not exists delivery_state text,
  add column if not exists attempt_count integer not null default 0,
  add column if not exists claimed_at timestamptz,
  add column if not exists last_attempt_at timestamptz,
  add column if not exists next_attempt_at timestamptz,
  add column if not exists last_error text,
  add column if not exists delivered_at timestamptz,
  add column if not exists created_at timestamptz not null default timezone('utc', now()),
  add column if not exists updated_at timestamptz not null default timezone('utc', now());

update public.direct_alert_deliveries
set delivery_state = case when conversation_message_id is null then 'pending' else 'delivered' end
where delivery_state is null;

alter table public.direct_alert_deliveries
  alter column delivery_state set default 'pending',
  alter column delivery_state set not null;

create unique index if not exists direct_alert_deliveries_one_per_user_update_idx
  on public.direct_alert_deliveries(user_id, event_update_id);
create unique index if not exists direct_alert_deliveries_message_once_idx
  on public.direct_alert_deliveries(conversation_message_id)
  where conversation_message_id is not null;
create index if not exists direct_alert_deliveries_retry_idx
  on public.direct_alert_deliveries(delivery_state, next_attempt_at, created_at)
  where delivery_state in ('pending', 'delivering', 'failed');
create index if not exists direct_alert_deliveries_user_created_idx
  on public.direct_alert_deliveries(user_id, created_at desc);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'direct_alert_deliveries_state_check'
      and conrelid = 'public.direct_alert_deliveries'::regclass
  ) then
    alter table public.direct_alert_deliveries
      add constraint direct_alert_deliveries_state_check
      check (delivery_state in ('pending', 'delivering', 'delivered', 'failed'));
  end if;
end;
$$;

-- Extend the durable conversation protocol rather than encoding alerts as a
-- generic text message. This makes receipts, audit and UI rendering explicit.
alter table public.conversation_messages
  drop constraint if exists conversation_messages_kind_check;
alter table public.conversation_messages
  add constraint conversation_messages_kind_check
  check (kind in ('text', 'brief', 'action', 'watch_update', 'direct_alert'));

-- Include direct-alert deliveries in the existing event grant vocabulary.
alter table public.user_event_access_grants
  drop constraint if exists user_event_access_grants_grant_reason_check;
alter table public.user_event_access_grants
  add constraint user_event_access_grants_grant_reason_check
  check (grant_reason in ('brief', 'watch_delivery', 'direct_alert'));

-- A direct-alert message is written after its delivery row exists but before
-- that row is marked delivered. This narrow service-owned pending state is a
-- valid pre-grant event reference, just like a pending watch delivery.
create or replace function public.enforce_conversation_message_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_conversation_user_id uuid;
  v_brief_user_id uuid;
  v_watch_user_id uuid;
begin
  select user_id into v_conversation_user_id
  from public.conversations
  where id = new.conversation_id;
  if v_conversation_user_id is null or v_conversation_user_id <> new.user_id then
    raise exception 'Conversation message must belong to its conversation owner';
  end if;

  if new.brief_id is not null then
    select user_id into v_brief_user_id from public.briefs where id = new.brief_id;
    if v_brief_user_id is null or v_brief_user_id <> new.user_id then
      raise exception 'Conversation brief must belong to the message owner';
    end if;
  end if;

  if new.watch_id is not null then
    select user_id into v_watch_user_id from public.watches where id = new.watch_id;
    if v_watch_user_id is null or v_watch_user_id <> new.user_id then
      raise exception 'Conversation watch must belong to the message owner';
    end if;
  end if;

  if new.event_id is not null and not exists (
    select 1 from public.user_event_access_grants g
    where g.user_id = new.user_id and g.event_id = new.event_id
  ) and not exists (
    select 1
    from public.brief_items bi
    join public.briefs b on b.id = bi.brief_id
    where bi.event_id = new.event_id and b.user_id = new.user_id
  ) and not exists (
    select 1
    from public.watch_deliveries d
    join public.watches w on w.id = d.watch_id
    join public.event_updates u on u.id = d.event_update_id
    where d.watch_id = new.watch_id
      and w.user_id = new.user_id
      and u.event_id = new.event_id
      and d.delivery_state in ('pending', 'failed')
  ) and not exists (
    select 1
    from public.direct_alert_deliveries d
    join public.event_updates u on u.id = d.event_update_id
    where d.user_id = new.user_id
      and d.event_id = new.event_id
      and u.event_id = new.event_id
      and d.delivery_state in ('pending', 'delivering', 'failed')
  ) then
    raise exception 'Conversation event has not been delivered to the message owner';
  end if;
  return new;
end;
$$;

-- The row itself must be internally consistent even when it is written by a
-- server-side integration. In particular, a delivered receipt cannot point at
-- somebody else's message or at a message about another event.
create or replace function public.validate_direct_alert_delivery()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_update_event_id uuid;
  v_brief_user_id uuid;
  v_message_user_id uuid;
  v_message_event_id uuid;
  v_message_role text;
  v_message_kind text;
begin
  select event_id into v_update_event_id
  from public.event_updates
  where id = new.event_update_id;
  if v_update_event_id is null or v_update_event_id <> new.event_id then
    raise exception 'Direct alert event must match its event update';
  end if;

  if new.brief_id is not null then
    select user_id into v_brief_user_id from public.briefs where id = new.brief_id;
    if v_brief_user_id is null or v_brief_user_id <> new.user_id then
      raise exception 'Direct alert brief must belong to the delivery user';
    end if;
  end if;

  if new.conversation_message_id is not null then
    select user_id, event_id, role, kind
    into v_message_user_id, v_message_event_id, v_message_role, v_message_kind
    from public.conversation_messages
    where id = new.conversation_message_id;
    if v_message_user_id is null
       or v_message_user_id <> new.user_id
       or v_message_event_id is distinct from new.event_id
       or v_message_role <> 'assistant'
       or v_message_kind <> 'direct_alert' then
      raise exception 'Direct alert message must be an owned assistant alert for the same event';
    end if;
  end if;

  if new.delivery_state = 'delivering' then
    if tg_op = 'INSERT' then
      new.attempt_count := greatest(coalesce(new.attempt_count, 0), 1);
    elsif old.delivery_state is distinct from 'delivering' then
      new.attempt_count := greatest(coalesce(new.attempt_count, 0), old.attempt_count + 1);
    end if;
    new.claimed_at := coalesce(new.claimed_at, timezone('utc', now()));
    new.last_attempt_at := coalesce(new.last_attempt_at, timezone('utc', now()));
  end if;

  -- ON DELETE SET NULL on the message FK reaches this trigger as an UPDATE.
  -- Downgrade the receipt before enforcing the delivered-message invariant.
  if tg_op = 'UPDATE'
     and old.delivery_state = 'delivered'
     and new.conversation_message_id is null then
    new.delivery_state := 'failed';
    new.delivered_at := null;
    new.claimed_at := null;
    new.last_error := coalesce(new.last_error, 'Kopplat direktnotismeddelande saknas.');
    new.next_attempt_at := coalesce(new.next_attempt_at, timezone('utc', now()));
  end if;

  if new.delivery_state = 'delivered' then
    if new.conversation_message_id is null then
      raise exception 'A delivered direct alert must reference its conversation message';
    end if;
    if tg_op = 'INSERT' or old.delivery_state is distinct from 'delivered' then
      new.delivered_at := timezone('utc', now());
    end if;
    new.claimed_at := null;
    new.next_attempt_at := null;
    new.last_error := null;
  end if;

  return new;
end;
$$;

drop trigger if exists direct_alert_deliveries_validate_before_write on public.direct_alert_deliveries;
create trigger direct_alert_deliveries_validate_before_write
before insert or update on public.direct_alert_deliveries
for each row execute function public.validate_direct_alert_delivery();

drop trigger if exists direct_alert_deliveries_updated_at on public.direct_alert_deliveries;
create trigger direct_alert_deliveries_updated_at
before update on public.direct_alert_deliveries
for each row execute function public.set_updated_at();

-- A completed direct alert becomes an explicit event-access grant, so an
-- alert card may safely open the same event detail route as a brief item.
create or replace function public.grant_event_access_from_direct_alert_delivery()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.delivery_state = 'delivered'
     and (tg_op = 'INSERT' or old.delivery_state is distinct from 'delivered') then
    insert into public.user_event_access_grants (user_id, event_id, grant_reason)
    values (new.user_id, new.event_id, 'direct_alert')
    on conflict (user_id, event_id) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists direct_alert_deliveries_grant_event_access_after_delivery on public.direct_alert_deliveries;
create trigger direct_alert_deliveries_grant_event_access_after_delivery
after insert or update of delivery_state on public.direct_alert_deliveries
for each row execute function public.grant_event_access_from_direct_alert_delivery();

alter table public.direct_alert_deliveries enable row level security;
drop policy if exists "Users read their direct alert deliveries" on public.direct_alert_deliveries;
create policy "Users read their direct alert deliveries" on public.direct_alert_deliveries
  for select using (auth.uid() = user_id);
