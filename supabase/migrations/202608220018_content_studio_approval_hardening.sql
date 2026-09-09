-- A scheduled item that required approval must retain the evidence of that
-- approval. This forward-only guard also protects databases where migration
-- 015 was applied before the corrected trigger body reached the deployment.
create or replace function public.preserve_content_draft_approval_on_schedule()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE'
     and new.status = 'scheduled'
     and new.approval_required
     and old.approved_at is not null then
    new.approved_at := old.approved_at;
  end if;
  return new;
end;
$$;

drop trigger if exists zz_content_drafts_preserve_approval_before_write on public.content_drafts;
-- PostgreSQL runs triggers of the same kind alphabetically. `zz_` therefore
-- runs after the original owner/status trigger even on an already-migrated DB.
create trigger zz_content_drafts_preserve_approval_before_write
before insert or update of status, approval_required on public.content_drafts
for each row execute function public.preserve_content_draft_approval_on_schedule();
