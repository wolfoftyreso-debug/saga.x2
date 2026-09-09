-- A source URL and its public JSON configuration are returned to tenant
-- viewers.  Remove legacy credentials before the V1 public-source contract is
-- relied on.  Affected connectors are paused instead of silently calling a
-- URL whose authentication semantics have changed.

update public.media_source_connections
set
  base_url = case
    when base_url ~* '^[[:alpha:]][[:alnum:]+.-]*://[^/?#]*@'
      or base_url ~* '[?&](key|token|secret|client[_-]?secret|password|authorization|credential|auth|signature|sig|api[_-]?key|access[_-]?(key|token)|private[_-]?key)='
      then null
    else base_url
  end,
  config_public = case
    when config_public::text ~* '"[^"\\]*(secret|token|password|authorization|credential|api[_-]?key|private[_-]?key|access[_-]?(key|token)|client[_-]?secret|auth|signature|sig|key)[^"\\]*"[[:space:]]*:'
      or config_public::text ~* 'https?://[^"[:space:]]+@'
      or config_public::text ~* 'https?://[^"[:space:]]*[?&](key|token|secret|client[_-]?secret|password|authorization|credential|auth|signature|sig|api[_-]?key|access[_-]?(key|token)|private[_-]?key)='
      then '{}'::jsonb
    else config_public
  end,
  metadata = case
    when metadata::text ~* '"[^"\\]*(secret|token|password|authorization|credential|api[_-]?key|private[_-]?key|access[_-]?(key|token)|client[_-]?secret|auth|signature|sig|key)[^"\\]*"[[:space:]]*:'
      then '{}'::jsonb
    else metadata
  end,
  active = false,
  last_error = 'Källan pausades eftersom äldre publik konfiguration innehöll en möjlig hemlighet. Lägg in en publik URL utan token eller nyckel.'
where
  base_url ~* '^[[:alpha:]][[:alnum:]+.-]*://[^/?#]*@'
  or base_url ~* '[?&](key|token|secret|client[_-]?secret|password|authorization|credential|auth|signature|sig|api[_-]?key|access[_-]?(key|token)|private[_-]?key)='
  or config_public::text ~* '"[^"\\]*(secret|token|password|authorization|credential|api[_-]?key|private[_-]?key|access[_-]?(key|token)|client[_-]?secret|auth|signature|sig|key)[^"\\]*"[[:space:]]*:'
  or config_public::text ~* 'https?://[^"[:space:]]+@'
  or config_public::text ~* 'https?://[^"[:space:]]*[?&](key|token|secret|client[_-]?secret|password|authorization|credential|auth|signature|sig|api[_-]?key|access[_-]?(key|token)|private[_-]?key)='
  or metadata::text ~* '"[^"\\]*(secret|token|password|authorization|credential|api[_-]?key|private[_-]?key|access[_-]?(key|token)|client[_-]?secret|auth|signature|sig|key)[^"\\]*"[[:space:]]*:';

alter table public.media_source_connections
  drop constraint if exists media_source_connections_public_base_url;

-- `not valid` preserves deployability if an exotic percent-encoded legacy URL
-- slipped through the defensive cleanup above, while still enforcing the
-- constraint on every new insert or update.
alter table public.media_source_connections
  add constraint media_source_connections_public_base_url
  check (
    base_url is null
    or (
      base_url !~* '^[[:alpha:]][[:alnum:]+.-]*://[^/?#]*@'
      and base_url !~* '[?&](key|token|secret|client[_-]?secret|password|authorization|credential|auth|signature|sig|api[_-]?key|access[_-]?(key|token)|private[_-]?key)='
    )
  ) not valid;
