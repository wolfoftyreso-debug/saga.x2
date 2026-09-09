-- A research revision becomes visible only when its complete evidence chain,
-- optional queued handoff and cluster state can cross the boundary together.
-- This removes crash windows between "dossier ready", "handoff editable" and
-- the cluster lease being released.

create or replace function public.finalize_media_research_dossier_revision(
  p_tenant_id uuid,
  p_cluster_id uuid,
  p_dossier_id uuid,
  p_lease_token uuid,
  p_summary text,
  p_framework_key text,
  p_image_brief text,
  p_finalize_handoff boolean
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

  perform 1
  from public.media_research_dossiers
  where id = p_dossier_id
    and tenant_id = p_tenant_id
    and cluster_id = p_cluster_id
    and is_current = false
    and status = 'draft'
    and research_lease_token = p_lease_token
  for update;
  if not found then
    raise exception 'Media Engine dossier revision is not a live draft';
  end if;

  if p_finalize_handoff then
    perform 1
    from public.media_content_handoffs
    where tenant_id = p_tenant_id
      and cluster_id = p_cluster_id
      and state = 'queued'
      and content_draft_id is null
      and research_lease_token = p_lease_token
    for update;
    if not found then
      raise exception 'Media Engine queued handoff is missing for this revision';
    end if;
  end if;

  -- Prior revisions remain auditable but cannot remain the current pointer.
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

  -- The queued handoff becomes editor-owned at the same boundary. Clearing
  -- only this live token prevents later editor state changes from hitting the
  -- runner fence while preserving an already-created Studio draft untouched.
  if p_finalize_handoff then
    update public.media_content_handoffs
    set research_lease_token = null
    where tenant_id = p_tenant_id
      and cluster_id = p_cluster_id
      and state = 'queued'
      and content_draft_id is null
      and research_lease_token = p_lease_token;
  end if;

  update public.media_research_clusters
  set status = 'ready',
      summary = p_summary,
      framework_key = p_framework_key,
      image_brief = p_image_brief,
      research_lease_token = null,
      research_lease_run_id = null,
      research_lease_expires_at = null
  where id = p_cluster_id
    and tenant_id = p_tenant_id
    and status = 'researching'
    and research_lease_token = p_lease_token;
  if not found then
    raise exception 'Media Engine cluster could not be finalized';
  end if;

  return p_dossier_id;
end;
$$;

revoke all on function public.finalize_media_research_dossier_revision(uuid, uuid, uuid, uuid, text, text, text, boolean) from public, anon, authenticated;
grant execute on function public.finalize_media_research_dossier_revision(uuid, uuid, uuid, uuid, text, text, text, boolean) to service_role;
