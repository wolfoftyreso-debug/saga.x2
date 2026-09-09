-- Source-level sync intervals were visible but could not be honoured safely:
-- one rule's poll may not suppress another rule's query-specific intake.
-- V1 therefore schedules at the rule layer only. Remove the misleading field
-- rather than silently applying a cross-rule cache policy.

alter table public.media_source_connections
  drop column if exists sync_interval_minutes;
