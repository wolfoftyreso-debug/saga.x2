-- V1 must not advertise connectors that have no ingestion implementation.
-- Existing unsupported connections are retained for audit but paused, then the
-- durable constraint only allows runner-backed source kinds going forward.

update public.media_source_connections
set active = false,
    last_error = 'Källtypen stöds inte i Media Engine V1. Välj RSS, publikt API eller webbsökning.'
where kind in ('webhook', 'manual');

alter table public.media_source_connections
  drop constraint if exists media_source_connections_kind_check;

alter table public.media_source_connections
  add constraint media_source_connections_kind_check
  check (kind in ('rss', 'api', 'web_search')) not valid;
