-- Updating a rule's next_run_at is part of a run's durable outcome. Keep the
-- lease check and rule write in one row-locked transaction so a reclaimed
-- worker cannot move the schedule after it has lost the run receipt.

create or replace function public.touch_media_research_rule_from_run(
  p_tenant_id uuid,
  p_rule_id uuid,
  p_run_id uuid,
  p_lease_token uuid,
  p_checked_at timestamptz,
  p_next_run_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  perform 1
  from public.media_research_runs
  where id = p_run_id
    and tenant_id = p_tenant_id
    and rule_id = p_rule_id
    and state = 'running'
    and lease_token = p_lease_token
    and lease_expires_at > timezone('utc', now())
  for update;
  if not found then
    return false;
  end if;

  update public.media_research_rules
  set last_run_at = p_checked_at,
      last_checked_at = p_checked_at,
      next_run_at = p_next_run_at
  where id = p_rule_id and tenant_id = p_tenant_id;
  if not found then
    return false;
  end if;
  return true;
end;
$$;

-- This RPC is a service-worker fence, never a browser/RLS escape hatch.
revoke all on function public.touch_media_research_rule_from_run(uuid, uuid, uuid, uuid, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.touch_media_research_rule_from_run(uuid, uuid, uuid, uuid, timestamptz, timestamptz) to service_role;
