-- SAGA Automation Media: a durable, private-only image stage for Studio
-- automation drafts that already passed the private-draft quality gate.
--
-- Reuses studio_jobs/studio_media so the media receipt, lease and exact Blob
-- metadata share the same Vercel + Neon ownership boundary as the draft.
-- There is deliberately no public URL column, provider delivery table, or
-- publication trigger in this migration.

begin;

-- One immutable automatic image receipt belongs to one quality-passed
-- automation draft. A deliberate future re-render must use an explicit new
-- revision/receipt rather than silently charging for a second image.
create unique index if not exists studio_jobs_saga_media_generation_draft_idx
  on studio_jobs(workspace_id, draft_id)
  where kind = 'media_generation' and draft_id is not null;

-- If a function ends after Neon inserted media but before it completes the
-- job, a reclaimed lease reads this single row and completes it — no second
-- attachment is created.
create unique index if not exists studio_media_saga_media_generation_job_idx
  on studio_media(workspace_id, job_id)
  where kind = 'generated' and job_id is not null;

create index if not exists studio_jobs_saga_media_generation_claimable_idx
  on studio_jobs(run_after, created_at)
  where kind = 'media_generation' and status = 'queued';

create index if not exists studio_jobs_saga_media_generation_lease_idx
  on studio_jobs(lease_expires_at)
  where kind = 'media_generation' and status = 'running';

commit;
