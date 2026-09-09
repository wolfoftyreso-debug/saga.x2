import "server-only";

import {
  socialConnectionStateSchema,
  socialProviderSchema,
  type SocialConnectionState,
  type SocialConnectionView,
  type SocialProvider,
} from "@/lib/domain/social";
import type { AppActor } from "@/lib/neon/auth-repository";
import { createNeonSql, type NeonSql } from "@/lib/neon/database";
import type { ResolvedSocialAccount } from "@/lib/services/social-connections";
import { encryptSocialSecret } from "@/lib/services/social-crypto";

type JsonObject = Record<string, unknown>;

type SocialConnectionRow = {
  id: string;
  workspace_id?: string;
  connected_by_user_id?: string;
  provider: string;
  provider_account_id: string;
  account_label: string;
  account_handle: string | null;
  state: string;
  scopes: unknown;
  token_expires_at: string | null;
  last_verified_at: string | null;
  last_error: string | null;
  metadata?: unknown;
  token_ciphertext?: string;
  refresh_token_ciphertext?: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * Server-only projection used by a future publisher.  It is deliberately
 * separate from `SocialConnectionView`, which is the only shape API routes
 * return to Studio.
 */
export type NeonSocialConnectionSecret = SocialConnectionView & {
  workspaceId: string;
  connectedByUserId: string;
  tokenCiphertext: string;
  refreshTokenCiphertext: string | null;
  metadata: JsonObject;
};

export class NeonSocialConnectionAccessError extends Error {
  constructor(message = "Du har inte behörighet att ändra sociala konton i den här arbetsytan.") {
    super(message);
    this.name = "NeonSocialConnectionAccessError";
  }
}

export class NeonSocialConnectionNotFoundError extends Error {
  constructor(message = "Kontot hittades inte i den här arbetsytan.") {
    super(message);
    this.name = "NeonSocialConnectionNotFoundError";
  }
}

/** Safe UI metadata only. The query intentionally does not select ciphertexts. */
export async function listNeonSocialConnections(
  actor: AppActor,
  sql: NeonSql = createNeonSql(),
): Promise<SocialConnectionView[]> {
  const rows = await sql.query(
    `select
       id::text,
       provider,
       provider_account_id,
       account_label,
       account_handle,
       state,
       scopes,
       token_expires_at::text,
       last_verified_at::text,
       last_error,
       created_at::text,
       updated_at::text
     from social_connections
     where workspace_id = $1::uuid
     order by updated_at desc`,
    [actor.workspaceId],
  ) as unknown as SocialConnectionRow[];

  return rows.flatMap((row) => {
    const connection = mapView(row);
    return connection ? [connection] : [];
  });
}

/**
 * Inserts/replaces credentials for accounts selected by a provider.  OAuth
 * tokens are encrypted before SQL receives them and this method only returns
 * the safe Studio projection.
 */
export async function upsertNeonSocialConnections(
  actor: AppActor,
  accounts: readonly ResolvedSocialAccount[],
  sql: NeonSql = createNeonSql(),
): Promise<SocialConnectionView[]> {
  assertCanWrite(actor);
  const saved: SocialConnectionView[] = [];

  for (const unresolved of accounts) {
    const account = normalizeResolvedAccount(unresolved);
    const tokenCiphertext = encryptSocialSecret(account.accessToken);
    const refreshTokenCiphertext = account.refreshToken ? encryptSocialSecret(account.refreshToken) : null;
    const rows = await sql.query(
      `insert into social_connections (
         workspace_id,
         connected_by_user_id,
         provider,
         provider_account_id,
         account_label,
         account_handle,
         token_ciphertext,
         refresh_token_ciphertext,
         token_expires_at,
         scopes,
         metadata,
         state,
         last_verified_at,
         last_error
       ) values (
         $1::uuid, $2::uuid, $3, $4, $5, $6,
         $7, $8, $9::timestamptz, $10::text[], $11::jsonb,
         'active', now(), null
       )
       on conflict (workspace_id, provider, provider_account_id) do update
         set connected_by_user_id = excluded.connected_by_user_id,
             account_label = excluded.account_label,
             account_handle = excluded.account_handle,
             token_ciphertext = excluded.token_ciphertext,
             refresh_token_ciphertext = excluded.refresh_token_ciphertext,
             token_expires_at = excluded.token_expires_at,
             scopes = excluded.scopes,
             metadata = excluded.metadata,
             state = 'active',
             last_verified_at = now(),
             last_error = null
       returning
         id::text,
         provider,
         provider_account_id,
         account_label,
         account_handle,
         state,
         scopes,
         token_expires_at::text,
         last_verified_at::text,
         last_error,
         created_at::text,
         updated_at::text`,
      [
        actor.workspaceId,
        actor.userId,
        account.provider,
        account.providerAccountId,
        account.accountLabel,
        account.accountHandle,
        tokenCiphertext,
        refreshTokenCiphertext,
        account.tokenExpiresAt,
        account.scopes,
        JSON.stringify(account.metadata),
      ],
    ) as unknown as SocialConnectionRow[];
    const connection = rows[0] && mapView(rows[0]);
    if (!connection) throw new Error("Det anslutna kontot kunde inte sparas säkert.");
    saved.push(connection);
  }

  return saved;
}

/**
 * Deletes the row (and therefore both encrypted tokens) only in the trusted
 * actor workspace.  There is no soft-delete that leaves a usable credential
 * behind after the user selects disconnect.
 */
export async function disconnectNeonSocialConnection(
  actor: AppActor,
  connectionId: string,
  sql: NeonSql = createNeonSql(),
): Promise<boolean> {
  assertCanWrite(actor);
  const rows = await sql.query(
    `delete from social_connections
      where workspace_id = $1::uuid and id = $2::uuid
      returning id::text`,
    [actor.workspaceId, connectionId],
  ) as unknown as Array<{ id: string }>;
  return Boolean(rows[0]);
}

/** Server-only only: never call this from an API route that returns JSON. */
export async function getNeonSocialConnectionSecret(
  actor: AppActor,
  connectionId: string,
  sql: NeonSql = createNeonSql(),
): Promise<NeonSocialConnectionSecret | null> {
  assertCanWrite(actor);
  const rows = await sql.query(
    `select
       id::text,
       workspace_id::text,
       connected_by_user_id::text,
       provider,
       provider_account_id,
       account_label,
       account_handle,
       token_ciphertext,
       refresh_token_ciphertext,
       token_expires_at::text,
       state,
       scopes,
       metadata,
       last_verified_at::text,
       last_error,
       created_at::text,
       updated_at::text
     from social_connections
     where workspace_id = $1::uuid and id = $2::uuid
     limit 1`,
    [actor.workspaceId, connectionId],
  ) as unknown as SocialConnectionRow[];
  return rows[0] ? mapSecret(rows[0]) : null;
}

/**
 * Returns one active credential only when the workspace has exactly one
 * active account for the provider.  An ambiguous choice is never guessed.
 */
export async function getDefaultNeonSocialConnectionSecret(
  actor: AppActor,
  provider: SocialProvider,
  sql: NeonSql = createNeonSql(),
): Promise<NeonSocialConnectionSecret | null> {
  assertCanWrite(actor);
  const rows = await sql.query(
    `select
       id::text,
       workspace_id::text,
       connected_by_user_id::text,
       provider,
       provider_account_id,
       account_label,
       account_handle,
       token_ciphertext,
       refresh_token_ciphertext,
       token_expires_at::text,
       state,
       scopes,
       metadata,
       last_verified_at::text,
       last_error,
       created_at::text,
       updated_at::text
     from social_connections
     where workspace_id = $1::uuid
       and provider = $2
       and state = 'active'
     order by updated_at desc
     limit 2`,
    [actor.workspaceId, provider],
  ) as unknown as SocialConnectionRow[];
  return rows.length === 1 ? mapSecret(rows[0]) : null;
}

/** Marks a stored credential stale without ever returning token material. */
export async function markNeonSocialConnectionState(
  actor: AppActor,
  connectionId: string,
  state: Exclude<SocialConnectionState, "disconnected">,
  lastError: string | null,
  sql: NeonSql = createNeonSql(),
): Promise<boolean> {
  assertCanWrite(actor);
  const parsedState = socialConnectionStateSchema.parse(state);
  const rows = await sql.query(
    `update social_connections
        set state = $3,
            last_error = $4
      where workspace_id = $1::uuid and id = $2::uuid
      returning id::text`,
    [actor.workspaceId, connectionId, parsedState, lastError?.trim().slice(0, 1_000) || null],
  ) as unknown as Array<{ id: string }>;
  return Boolean(rows[0]);
}

function assertCanWrite(actor: AppActor): void {
  if (actor.role === "viewer") throw new NeonSocialConnectionAccessError();
}

function mapView(row: SocialConnectionRow): SocialConnectionView | null {
  const provider = socialProviderSchema.safeParse(row.provider);
  const state = socialConnectionStateSchema.safeParse(row.state);
  if (
    !provider.success
    || !state.success
    || !nonEmptyString(row.id)
    || !nonEmptyString(row.provider_account_id)
    || !nonEmptyString(row.account_label)
  ) return null;

  return {
    id: row.id,
    provider: provider.data,
    providerAccountId: row.provider_account_id,
    accountLabel: row.account_label,
    accountHandle: stringOrNull(row.account_handle),
    state: state.data,
    scopes: stringList(row.scopes),
    tokenExpiresAt: stringOrNull(row.token_expires_at),
    lastVerifiedAt: stringOrNull(row.last_verified_at),
    lastError: stringOrNull(row.last_error),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSecret(row: SocialConnectionRow): NeonSocialConnectionSecret | null {
  const connection = mapView(row);
  if (
    !connection
    || !nonEmptyString(row.workspace_id)
    || !nonEmptyString(row.connected_by_user_id)
    || !nonEmptyString(row.token_ciphertext)
  ) return null;
  return {
    ...connection,
    workspaceId: row.workspace_id,
    connectedByUserId: row.connected_by_user_id,
    tokenCiphertext: row.token_ciphertext,
    refreshTokenCiphertext: stringOrNull(row.refresh_token_ciphertext),
    metadata: objectValue(row.metadata),
  };
}

function normalizeResolvedAccount(account: ResolvedSocialAccount): ResolvedSocialAccount {
  const provider = socialProviderSchema.parse(account.provider);
  const providerAccountId = boundedText(account.providerAccountId, 300, "Kontots leverantörsid är ogiltigt.");
  const accountLabel = boundedText(account.accountLabel, 240, "Kontots namn är ogiltigt.");
  const accountHandle = account.accountHandle ? boundedText(account.accountHandle, 240, "Kontots användarnamn är ogiltigt.") : null;
  const accessToken = boundedText(account.accessToken, 16_000, "OAuth-tokenen är ogiltig.");
  const refreshToken = account.refreshToken ? boundedText(account.refreshToken, 16_000, "OAuth-förnyelsetokenen är ogiltig.") : null;
  const tokenExpiresAt = account.tokenExpiresAt && Number.isFinite(Date.parse(account.tokenExpiresAt)) ? account.tokenExpiresAt : null;
  const metadata = objectValue(account.metadata);
  assertCredentialFreeMetadata(metadata);
  // A JSON round trip prevents accidental non-serializable provider payloads
  // from reaching Neon. It also keeps only ordinary data, never Response/etc.
  const metadataJson = JSON.stringify(metadata);
  if (metadataJson.length > 30_000) throw new Error("Kontots säkra metadata är för stor.");
  return {
    provider,
    providerAccountId,
    accountLabel,
    accountHandle,
    accessToken,
    refreshToken,
    tokenExpiresAt,
    scopes: [...new Set(stringList(account.scopes).map((scope) => scope.slice(0, 240)))],
    metadata: JSON.parse(metadataJson) as JsonObject,
  };
}

function boundedText(value: string, max: number, message: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max) throw new Error(message);
  return normalized;
}

function objectValue(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as JsonObject;
}

/** Dedicated ciphertext fields are the only permitted place for credentials. */
function assertCredentialFreeMetadata(value: JsonObject, depth = 0): void {
  if (depth > 8) throw new Error("Kontots säkra metadata är för djupt nästlad.");
  for (const [key, nested] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (/(token|secret|authorization|password|credential)/.test(normalized)) {
      throw new Error("Kontots metadata får inte innehålla OAuth-hemligheter.");
    }
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      assertCredentialFreeMetadata(nested as JsonObject, depth + 1);
    }
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
