-- Security hardening for Media Engine V1.
--
-- A tenant must never be able to choose an environment-secret reference and
-- an arbitrary endpoint in the same configuration. V1 supports public RSS,
-- public JSON APIs and web search only. A future authenticated-provider
-- feature must use a server-owned credential broker with an approved origin,
-- not this tenant-controlled table.

update public.media_source_connections
set credential_ref = null
where credential_ref is not null;

alter table public.media_source_connections
  drop constraint if exists media_source_connections_public_only_credentials;

alter table public.media_source_connections
  add constraint media_source_connections_public_only_credentials
  check (credential_ref is null);
