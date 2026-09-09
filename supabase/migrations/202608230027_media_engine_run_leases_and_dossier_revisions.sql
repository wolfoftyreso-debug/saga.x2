-- Runs use a fenced, expiring lease so a timed-out worker cannot complete a
-- receipt after a reclaimer takes it over. Dossiers keep history: a new
-- revision remains draft until its evidence is present and a single database
-- function atomically switches the current pointer.

alter table public.media_research_runs
  add column if not exists lease_token uuid,
  add column if not exists lease_expires_at timestamptz;

create index if not exists media_research_runs_lease_idx
  on public.media_research_runs(tenant_id, state, lease_expires_at)
  where state in ('queued', 'running');

alter table public.media_research_dossiers
  drop constraint if exists media_research_dossiers_cluster_id_key;

alter table public.media_research_dossiers
  add column if not exists revision integer not null default 1 check (revision >= 1),
  add column if not exists is_current boolean not null default true;

with numbered as (
  select id, cluster_id, row_number() over (partition by cluster_id order by created_at asc, id asc)::integer as revision
  from public.media_research_dossiers
)
update public.media_research_dossiers dossier
set revision = numbered.revision,
    is_current = case when numbered.revision = (
      select max(inner_numbered.revision)
      from numbered inner_numbered
      where inner_numbered.cluster_id = numbered.cluster_id
    ) then true else false end
from numbered
where dossier.id = numbered.id;

-- Existing V1 has one dossier per cluster; this partial unique index protects
-- the same invariant for the currently visible revision while retaining prior
-- ready/failed history for audit.
create unique index if not exists media_research_dossiers_current_cluster_idx
  on public.media_research_dossiers(cluster_id)
  where is_current;
create unique index if not exists media_research_dossiers_cluster_revision_idx
  on public.media_research_dossiers(cluster_id, revision);

alter table public.media_research_evidence
  drop constraint if exists media_research_evidence_cluster_id_source_url_claim_key;

create unique index if not exists media_research_evidence_revision_source_idx
  on public.media_research_evidence(cluster_id, research_lease_token, source_url, claim);

create or replace function public.activate_media_research_dossier_revision(
  p_tenant_id uuid,
  p_cluster_id uuid,
  p_dossier_id uuid,
  p_lease_token uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
begin
  perform 1
  from public.media_research_clusters
  where id = p_cluster_id
    and tenant_id = p_tenant_id
    and status = 'researching'
    and research_lease_token = p_lease_token
    and research_lease_expires_at > timezone('utc', now())
  for update;
  if not found then
    raise exception 'Media Engine research lease is no longer held';
  end if;

  -- Clearing the old fence token lets completed historical dossiers remain
  -- read-only/auditable after the active cluster lease moves to a new run.
  update public.media_research_dossiers
  set is_current = false,
      research_lease_token = null
  where tenant_id = p_tenant_id
    and cluster_id = p_cluster_id
    and is_current
    and id <> p_dossier_id;

  update public.media_research_dossiers
  set is_current = true,
      status = 'ready'
  where id = p_dossier_id
    and tenant_id = p_tenant_id
    and cluster_id = p_cluster_id
    and is_current = false
    and status = 'draft'
    and research_lease_token = p_lease_token;
  if not found then
    raise exception 'Media Engine dossier revision could not be activated';
  end if;
  return p_dossier_id;
end;
$$;

-- SECURITY DEFINER helpers are internal worker primitives. Tenant/user roles
-- must never invoke them merely because they can guess an opaque lease token.
revoke all on function public.activate_media_research_dossier_revision(uuid, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.activate_media_research_dossier_revision(uuid, uuid, uuid, uuid) to service_role;
