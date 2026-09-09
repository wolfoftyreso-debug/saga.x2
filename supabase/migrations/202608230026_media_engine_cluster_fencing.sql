-- A status timestamp alone is not a safe lease: an old worker could still
-- finish after a stale takeover.  Persist an opaque fenced token and expiry on
-- the cluster, then require every pipeline-owned dossier/evidence/handoff
-- write that sets a token to match the currently live cluster lease.

alter table public.media_research_clusters
  add column if not exists research_lease_token uuid,
  add column if not exists research_lease_run_id uuid references public.media_research_runs(id) on delete set null,
  add column if not exists research_lease_expires_at timestamptz;

create index if not exists media_research_clusters_lease_idx
  on public.media_research_clusters(tenant_id, status, research_lease_expires_at);

alter table public.media_research_dossiers
  add column if not exists research_lease_token uuid;

alter table public.media_research_evidence
  add column if not exists research_lease_token uuid;

alter table public.media_content_handoffs
  add column if not exists research_lease_token uuid;

create or replace function public.validate_media_research_write_lease()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_live_token uuid;
  v_expires_at timestamptz;
begin
  -- Normal editor actions clear the runner token and must remain possible
  -- after the short lease has expired. Every non-null token is fenced on
  -- every write, including a status-only transition from a stale worker.
  if new.research_lease_token is null then
    return new;
  end if;

  select research_lease_token, research_lease_expires_at
    into v_live_token, v_expires_at
  from public.media_research_clusters
  where id = new.cluster_id and tenant_id = new.tenant_id;

  if v_live_token is distinct from new.research_lease_token
    or v_expires_at is null
    or v_expires_at <= timezone('utc', now()) then
    raise exception 'Media Engine research lease is no longer held';
  end if;
  return new;
end;
$$;

drop trigger if exists media_research_dossiers_lease_fence on public.media_research_dossiers;
create trigger media_research_dossiers_lease_fence
before insert or update on public.media_research_dossiers
for each row execute function public.validate_media_research_write_lease();

drop trigger if exists media_research_evidence_lease_fence on public.media_research_evidence;
create trigger media_research_evidence_lease_fence
before insert or update on public.media_research_evidence
for each row execute function public.validate_media_research_write_lease();

drop trigger if exists media_content_handoffs_lease_fence on public.media_content_handoffs;
create trigger media_content_handoffs_lease_fence
before insert or update on public.media_content_handoffs
for each row execute function public.validate_media_research_write_lease();
