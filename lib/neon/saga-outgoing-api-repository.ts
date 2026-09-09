import "server-only";

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  normalizeSagaOutgoingApiContentTypes,
  normalizeSagaOutgoingContentChannels,
  encodeSagaOutgoingContentCursor,
  exposeSagaOutgoingApiContentTypes,
  sagaOutgoingApiCreateSchema,
  sagaOutgoingApiPublicationReadyStatusSchema,
  sagaOutgoingApiUpdateSchema,
  sagaOutgoingApiVisibilitySchema,
  type SagaOutgoingApiCreateInput,
  type SagaOutgoingApiExportView,
  type SagaOutgoingApiSecretResult,
  type SagaOutgoingApiUpdateInput,
  type SagaOutgoingContentCursor,
  type SagaOutgoingContentItem,
  type SagaOutgoingContentPage,
  type SagaOutgoingApiVisibility,
} from "@/lib/domain/saga-outgoing-api";
import { contentTypeSchema, type ContentType } from "@/lib/domain/content-studio";
import type { AppActor } from "@/lib/neon/auth-repository";
import { createNeonSql, type NeonSql } from "@/lib/neon/database";

const TOKEN_NAMESPACE = "saga_out_live";
const PREFIX_ID_LENGTH = 12;
const SECRET_LENGTH = 43;

type OutgoingApiRow = {
  id: string;
  workspace_id: string;
  name: string;
  content_type_scope: string;
  content_types: unknown;
  visibility: string;
  key_prefix: string;
  secret_hash?: string;
  expires_at: string | Date | null;
  last_used_at: string | Date | null;
  revoked_at: string | Date | null;
  revision: number | string;
  created_at: string | Date;
  updated_at: string | Date;
};

type OutgoingContentRow = {
  id: string;
  content_type: unknown;
  status: unknown;
  title: unknown;
  body: unknown;
  excerpt: unknown;
  publication_channels: unknown;
  scheduled_at: string | Date | null;
  published_at: string | Date | null;
  updated_at: string | Date;
};

type TokenMaterial = {
  secret: string;
  keyPrefix: string;
  secretHash: string;
};

export type SagaOutgoingApiExternalPrincipal = {
  apiId: string;
  workspaceId: string;
  contentTypes: ContentType[];
  visibility: SagaOutgoingApiVisibility;
  /** Scope updates increment this, so an in-flight read cannot use old scope. */
  revision: number;
  /** Server-only proof used by the final export statement's active-key guard. */
  secretHash: string;
};

export class SagaOutgoingApiAccessError extends Error {
  constructor(message = "Bara arbetsytans ägare kan hantera Utgående innehålls-API.") {
    super(message);
    this.name = "SagaOutgoingApiAccessError";
  }
}

export class SagaOutgoingApiNotFoundError extends Error {
  constructor(message = "API-utgåvan hittades inte i din arbetsyta.") {
    super(message);
    this.name = "SagaOutgoingApiNotFoundError";
  }
}

export class SagaOutgoingApiConflictError extends Error {
  constructor(message = "API-utgåvan ändrades i en annan flik. Läs in den igen innan du sparar.") {
    super(message);
    this.name = "SagaOutgoingApiConflictError";
  }
}

export class SagaOutgoingApiValidationError extends Error {
  constructor(message = "API-utgåvan innehåller ett ogiltigt värde.") {
    super(message);
    this.name = "SagaOutgoingApiValidationError";
  }
}

function assertOwner(actor: AppActor): void {
  if (actor.role !== "owner") throw new SagaOutgoingApiAccessError();
}

function asString(value: unknown, message: string): string {
  if (typeof value === "string" && value.length) return value;
  throw new SagaOutgoingApiValidationError(message);
}

function asTimestamp(value: unknown, message: string): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (typeof value === "string" && value && !Number.isNaN(new Date(value).getTime())) return new Date(value).toISOString();
  throw new SagaOutgoingApiValidationError(message);
}

function nullableTimestamp(value: unknown, message: string): string | null {
  if (value === null || value === undefined) return null;
  return asTimestamp(value, message);
}

function asInteger(value: unknown, message: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new SagaOutgoingApiValidationError(message);
  return parsed;
}

function stringArray(value: unknown): string[] | null {
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string") ? parsed : null;
  } catch {
    return null;
  }
}

function mapOutgoingApi(row: OutgoingApiRow, now = new Date()): SagaOutgoingApiExportView {
  const rawTypes = stringArray(row.content_types);
  if (!rawTypes) throw new SagaOutgoingApiValidationError("API-utgåvans innehållstyp kunde inte läsas säkert.");
  const visibility = sagaOutgoingApiVisibilitySchema.safeParse(row.visibility);
  if (!visibility.success) throw new SagaOutgoingApiValidationError("API-utgåvans synlighet kunde inte läsas säkert.");
  const expiresAt = nullableTimestamp(row.expires_at, "API-utgåvans slutdatum kunde inte läsas säkert.");
  const revokedAt = nullableTimestamp(row.revoked_at, "API-utgåvans status kunde inte läsas säkert.");
  const status = revokedAt
    ? "revoked"
    : expiresAt && new Date(expiresAt).getTime() <= now.getTime()
      ? "expired"
      : "active";
  return {
    id: asString(row.id, "API-utgåvans id kunde inte läsas säkert."),
    name: asString(row.name, "API-utgåvans namn kunde inte läsas säkert."),
    contentTypes: exposeSagaOutgoingApiContentTypes(row.content_type_scope, rawTypes),
    visibility: visibility.data,
    keyPrefix: asString(row.key_prefix, "API-utgåvans nyckelprefix kunde inte läsas säkert."),
    status,
    expiresAt,
    lastUsedAt: nullableTimestamp(row.last_used_at, "API-utgåvans användningstid kunde inte läsas säkert."),
    revision: asInteger(row.revision, "API-utgåvans version kunde inte läsas säkert."),
    createdAt: asTimestamp(row.created_at, "API-utgåvans skapandetid kunde inte läsas säkert."),
    updatedAt: asTimestamp(row.updated_at, "API-utgåvans ändringstid kunde inte läsas säkert."),
  };
}

function createTokenMaterial(): TokenMaterial {
  const prefixId = randomBytes(9).toString("base64url");
  const secretPart = randomBytes(32).toString("base64url");
  const keyPrefix = `${TOKEN_NAMESPACE}_${prefixId}`;
  const secret = `${keyPrefix}_${secretPart}`;
  return { secret, keyPrefix, secretHash: hashSagaOutgoingApiSecret(secret) };
}

export function hashSagaOutgoingApiSecret(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function parseToken(value: string): { secret: string; keyPrefix: string } | null {
  const secret = value.trim();
  const expression = new RegExp(`^${TOKEN_NAMESPACE}_([A-Za-z0-9_-]{${PREFIX_ID_LENGTH}})_([A-Za-z0-9_-]{${SECRET_LENGTH}})$`);
  const match = expression.exec(secret);
  return match ? { secret, keyPrefix: `${TOKEN_NAMESPACE}_${match[1]}` } : null;
}

function constantTimeHashMatches(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function isFuture(value: string | null | undefined, now: Date): boolean {
  return !value || new Date(value).getTime() > now.getTime();
}

function databaseFailure(error: unknown): never {
  if (
    error instanceof SagaOutgoingApiAccessError
    || error instanceof SagaOutgoingApiNotFoundError
    || error instanceof SagaOutgoingApiConflictError
    || error instanceof SagaOutgoingApiValidationError
  ) throw error;
  const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
  const message = error instanceof Error ? error.message : "";
  if (code === "23505") throw new SagaOutgoingApiConflictError("Kunde inte skapa en unik API-hemlighet. Försök igen.");
  if (code === "23514" || /saga_outgoing/i.test(message)) throw new SagaOutgoingApiValidationError();
  throw error;
}

/** Owner-only list. The view deliberately omits `secret_hash` and any secret. */
export async function listSagaOutgoingApis(
  actor: AppActor,
  sql: NeonSql = createNeonSql(),
  now = new Date(),
): Promise<SagaOutgoingApiExportView[]> {
  assertOwner(actor);
  try {
    const rows = await sql.query(
      `select id::text, workspace_id::text, name, content_type_scope, content_types,
              visibility, key_prefix, expires_at::text, last_used_at::text,
              revoked_at::text, revision, created_at::text, updated_at::text
         from saga_outgoing_content_apis
        where workspace_id = $1::uuid
        order by created_at desc`,
      [actor.workspaceId],
    ) as unknown as OutgoingApiRow[];
    return rows.map((row) => mapOutgoingApi(row, now));
  } catch (error) {
    return databaseFailure(error);
  }
}

/** Generates a random bearer secret server-side and persists only its hash. */
export async function createSagaOutgoingApi(
  actor: AppActor,
  input: SagaOutgoingApiCreateInput,
  sql: NeonSql = createNeonSql(),
  now = new Date(),
): Promise<SagaOutgoingApiSecretResult> {
  assertOwner(actor);
  const payload = sagaOutgoingApiCreateSchema.parse(input);
  if (!isFuture(payload.expiresAt, now)) {
    throw new SagaOutgoingApiValidationError("Slutdatumet måste ligga i framtiden.");
  }
  const scope = normalizeSagaOutgoingApiContentTypes(payload.contentTypes);

  // A uniqueness collision is cryptographically unlikely, but retrying turns
  // it into a durable guarantee and never reuses a plaintext secret.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const material = createTokenMaterial();
    try {
      const rows = await sql.query(
        `insert into saga_outgoing_content_apis (
           workspace_id, created_by_user_id, name, content_type_scope,
           content_types, visibility, key_prefix, secret_hash, expires_at
         ) values ($1::uuid, $2::uuid, $3, $4, $5::text[], $6, $7, $8, $9::timestamptz)
         returning id::text, workspace_id::text, name, content_type_scope, content_types,
                   visibility, key_prefix, expires_at::text, last_used_at::text,
                   revoked_at::text, revision, created_at::text, updated_at::text`,
        [
          actor.workspaceId,
          actor.userId,
          payload.name,
          scope.scope,
          scope.contentTypes,
          payload.visibility,
          material.keyPrefix,
          material.secretHash,
          payload.expiresAt ?? null,
        ],
      ) as unknown as OutgoingApiRow[];
      const row = rows[0];
      if (!row) throw new SagaOutgoingApiValidationError("API-utgåvan kunde inte sparas.");
      return { export: mapOutgoingApi(row, now), secret: material.secret };
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
      if (code === "23505" && attempt < 2) continue;
      return databaseFailure(error);
    }
  }
  throw new SagaOutgoingApiConflictError("Kunde inte skapa en unik API-hemlighet. Försök igen.");
}

async function findActiveOutgoingApiRow(actor: AppActor, id: string, sql: NeonSql): Promise<OutgoingApiRow> {
  const rows = await sql.query(
    `select id::text, workspace_id::text, name, content_type_scope, content_types,
            visibility, key_prefix, expires_at::text, last_used_at::text,
            revoked_at::text, revision, created_at::text, updated_at::text
       from saga_outgoing_content_apis
      where workspace_id = $1::uuid
        and id = $2::uuid
        and revoked_at is null
        and (expires_at is null or expires_at > now())
      limit 1`,
    [actor.workspaceId, id],
  ) as unknown as OutgoingApiRow[];
  const row = rows[0];
  if (!row) throw new SagaOutgoingApiNotFoundError();
  return row;
}

/** Updates the selection/visibility only inside the current owner workspace. */
export async function updateSagaOutgoingApi(
  actor: AppActor,
  id: string,
  input: SagaOutgoingApiUpdateInput,
  sql: NeonSql = createNeonSql(),
  now = new Date(),
): Promise<SagaOutgoingApiExportView> {
  assertOwner(actor);
  const payload = sagaOutgoingApiUpdateSchema.parse(input);
  try {
    const existingRow = await findActiveOutgoingApiRow(actor, id, sql);
    const existing = mapOutgoingApi(existingRow, now);
    if (payload.expectedRevision !== existing.revision) {
      throw new SagaOutgoingApiConflictError();
    }
    const scope = payload.contentTypes === undefined
      ? normalizeSagaOutgoingApiContentTypes(existing.contentTypes)
      : normalizeSagaOutgoingApiContentTypes(payload.contentTypes);
    const expiresAt = Object.prototype.hasOwnProperty.call(payload, "expiresAt")
      ? payload.expiresAt ?? null
      : existing.expiresAt;
    if (!isFuture(expiresAt, now)) {
      throw new SagaOutgoingApiValidationError("Slutdatumet måste ligga i framtiden.");
    }
    const rows = await sql.query(
      `update saga_outgoing_content_apis
          set name = $3,
              content_type_scope = $4,
              content_types = $5::text[],
              visibility = $6,
              expires_at = $7::timestamptz,
              revision = revision + 1
        where workspace_id = $1::uuid
          and id = $2::uuid
          and revoked_at is null
          and (expires_at is null or expires_at > now())
          and revision = $8::integer
        returning id::text, workspace_id::text, name, content_type_scope, content_types,
                  visibility, key_prefix, expires_at::text, last_used_at::text,
                  revoked_at::text, revision, created_at::text, updated_at::text`,
      [
        actor.workspaceId,
        id,
        payload.name ?? existing.name,
        scope.scope,
        scope.contentTypes,
        payload.visibility ?? existing.visibility,
        expiresAt,
        existing.revision,
      ],
    ) as unknown as OutgoingApiRow[];
    const row = rows[0];
    if (!row) throw new SagaOutgoingApiConflictError();
    return mapOutgoingApi(row, now);
  } catch (error) {
    return databaseFailure(error);
  }
}

/** Revoke is immediate and permanent; it never returns or reconstitutes the secret. */
export async function revokeSagaOutgoingApi(
  actor: AppActor,
  id: string,
  sql: NeonSql = createNeonSql(),
  now = new Date(),
): Promise<SagaOutgoingApiExportView> {
  assertOwner(actor);
  try {
    const rows = await sql.query(
      `update saga_outgoing_content_apis
          set revoked_at = now(), revision = revision + 1
        where workspace_id = $1::uuid
          and id = $2::uuid
          and revoked_at is null
        returning id::text, workspace_id::text, name, content_type_scope, content_types,
                  visibility, key_prefix, expires_at::text, last_used_at::text,
                  revoked_at::text, revision, created_at::text, updated_at::text`,
      [actor.workspaceId, id],
    ) as unknown as OutgoingApiRow[];
    const row = rows[0];
    if (!row) throw new SagaOutgoingApiNotFoundError();
    return mapOutgoingApi(row, now);
  } catch (error) {
    return databaseFailure(error);
  }
}

/** Rotation replaces the hash atomically; the prior bearer secret stops working immediately. */
export async function rotateSagaOutgoingApiSecret(
  actor: AppActor,
  id: string,
  sql: NeonSql = createNeonSql(),
  now = new Date(),
): Promise<SagaOutgoingApiSecretResult> {
  assertOwner(actor);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const material = createTokenMaterial();
    try {
      const rows = await sql.query(
        `update saga_outgoing_content_apis
            set key_prefix = $3,
                secret_hash = $4,
                revision = revision + 1
          where workspace_id = $1::uuid
            and id = $2::uuid
            and revoked_at is null
            and (expires_at is null or expires_at > now())
          returning id::text, workspace_id::text, name, content_type_scope, content_types,
                    visibility, key_prefix, expires_at::text, last_used_at::text,
                    revoked_at::text, revision, created_at::text, updated_at::text`,
        [actor.workspaceId, id, material.keyPrefix, material.secretHash],
      ) as unknown as OutgoingApiRow[];
      const row = rows[0];
      if (!row) throw new SagaOutgoingApiNotFoundError();
      return { export: mapOutgoingApi(row, now), secret: material.secret };
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
      if (code === "23505" && attempt < 2) continue;
      return databaseFailure(error);
    }
  }
  throw new SagaOutgoingApiConflictError("Kunde inte rotera till en unik API-hemlighet. Försök igen.");
}

/**
 * Authenticates only through the opaque bearer secret. A conditional touch
 * makes revocation/expiry win even if it races the initial lookup.
 */
export async function authenticateSagaOutgoingApiSecret(
  suppliedSecret: string,
  sql: NeonSql = createNeonSql(),
): Promise<SagaOutgoingApiExternalPrincipal | null> {
  const parsed = parseToken(suppliedSecret);
  if (!parsed) return null;
  try {
    const rows = await sql.query(
      `select id::text, workspace_id::text, content_type_scope, content_types,
              visibility, secret_hash, revision
         from saga_outgoing_content_apis
        where key_prefix = $1
          and revoked_at is null
          and (expires_at is null or expires_at > now())
        limit 1`,
      [parsed.keyPrefix],
    ) as unknown as OutgoingApiRow[];
    const row = rows[0];
    if (!row || !row.secret_hash || !constantTimeHashMatches(row.secret_hash, hashSagaOutgoingApiSecret(parsed.secret))) return null;
    const visibility = sagaOutgoingApiVisibilitySchema.safeParse(row.visibility);
    const rawTypes = stringArray(row.content_types);
    if (!visibility.success || !rawTypes) return null;
    const contentTypes = normalizeSagaOutgoingApiContentTypes(exposeSagaOutgoingApiContentTypes(row.content_type_scope, rawTypes)).contentTypes;
    const touched = await sql.query(
      `update saga_outgoing_content_apis
          set last_used_at = now()
        where id = $1::uuid
          and secret_hash = $2
          and revoked_at is null
          and (expires_at is null or expires_at > now())
        returning id::text`,
      [row.id, row.secret_hash],
    ) as unknown as Array<{ id: string }>;
    if (!touched[0]) return null;
    return {
      apiId: row.id,
      workspaceId: row.workspace_id,
      contentTypes,
      visibility: visibility.data,
      revision: asInteger(row.revision, "Ogiltig API-utgåveversion."),
      secretHash: row.secret_hash,
    };
  } catch {
    // Missing Neon, malformed persisted rows and failed touches all fail
    // closed as the same unauthenticated external response.
    return null;
  }
}

/**
 * Reads a narrow, fixed projection. No metadata/source context/prompts or
 * media columns are selected; Blob URLs and pathnames cannot enter this API.
 */
export async function readSagaOutgoingContent(
  principal: SagaOutgoingApiExternalPrincipal,
  input: { cursor: SagaOutgoingContentCursor | null; limit: number; now?: Date },
  sql: NeonSql = createNeonSql(),
): Promise<SagaOutgoingContentPage> {
  const fetchLimit = input.limit + 1;
  const rows = await sql.query(
    `select id::text, content_type, status, title, body, excerpt,
            publication_channels, scheduled_at::text, published_at::text, updated_at::text
       from studio_drafts
      where workspace_id = $1::uuid
        and content_type = any($2::text[])
        and (
          ($3 = 'published_only' and status = 'published' and published_at is not null)
          or (
            $3 = 'publication_ready'
            and status in ('approved', 'scheduled', 'published')
            and (status <> 'published' or published_at is not null)
          )
        )
        -- Private deterministic brief material must never enter an external export,
        -- even if a historical row has an otherwise eligible status.
        and coalesce(metadata ->> 'deliveryLocked', 'false') <> 'true'
        and coalesce(metadata ->> 'privateBrief', 'false') <> 'true'
        and coalesce(metadata ->> 'adAutomationDeliveryLocked', 'false') <> 'true'
        and coalesce(metadata ->> 'adAutomationDraftKind', '') <> 'deterministic_creative_brief'
        -- Recheck the same hash in this statement. A just-revoked or expired
        -- key can therefore never win the auth/read race and receive a page.
        and exists (
          select 1
            from saga_outgoing_content_apis api
           where api.id = $7::uuid
             and api.workspace_id = $1::uuid
             and api.secret_hash = $8
             and api.revoked_at is null
             and (api.expires_at is null or api.expires_at > now())
             and api.revision = $9::integer
        )
        and (
          $4::timestamptz is null
          or updated_at < $4::timestamptz
          or (updated_at = $4::timestamptz and id < $5::uuid)
        )
      order by updated_at desc, id desc
      limit $6`,
    [
      principal.workspaceId,
      principal.contentTypes,
      principal.visibility,
      input.cursor?.updatedAt ?? null,
      input.cursor?.id ?? null,
      fetchLimit,
      principal.apiId,
      principal.secretHash,
      principal.revision,
    ],
  ) as unknown as OutgoingContentRow[];
  const hasMore = rows.length > input.limit;
  const pageRows = hasMore ? rows.slice(0, input.limit) : rows;
  const items = pageRows.flatMap((row) => {
    const item = mapOutgoingContentItem(row);
    return item ? [item] : [];
  });
  const lastRow = pageRows.at(-1);
  return {
    version: "v1",
    generatedAt: (input.now ?? new Date()).toISOString(),
    items,
    nextCursor: hasMore && lastRow
      ? encodeSagaOutgoingContentCursor({ id: lastRow.id, updatedAt: asTimestamp(lastRow.updated_at, "Kunde inte skapa exportcursor.") })
      : null,
    hasMore,
  };
}

function mapOutgoingContentItem(row: OutgoingContentRow): SagaOutgoingContentItem | null {
  const contentType = contentTypeSchema.safeParse(row.content_type);
  const status = sagaOutgoingApiPublicationReadyStatusSchema.safeParse(row.status);
  const channels = normalizeSagaOutgoingContentChannels(row.publication_channels);
  if (!contentType.success || !status.success || !channels) return null;
  if (typeof row.id !== "string" || typeof row.title !== "string" || typeof row.body !== "string") return null;
  if (row.title.length > 240 || row.body.length > 60_000) return null;
  if (row.excerpt !== null && typeof row.excerpt !== "string") return null;
  if (typeof row.excerpt === "string" && row.excerpt.length > 2_000) return null;
  try {
    return {
      id: row.id,
      contentType: contentType.data,
      status: status.data,
      // A user may have pasted a private Vercel Blob URL into editorial copy.
      // The export never becomes a way to disclose it; the wording remains
      // available with a neutral marker instead of silently dropping a post.
      title: redactVercelBlobUrls(row.title),
      body: redactVercelBlobUrls(row.body),
      excerpt: typeof row.excerpt === "string" ? redactVercelBlobUrls(row.excerpt) : null,
      channels,
      scheduledAt: nullableTimestamp(row.scheduled_at, "Ogiltig schematid."),
      publishedAt: nullableTimestamp(row.published_at, "Ogiltig publiceringstid."),
      updatedAt: asTimestamp(row.updated_at, "Ogiltig ändringstid."),
    };
  } catch {
    return null;
  }
}

function redactVercelBlobUrls(value: string): string {
  // Match the hostname itself rather than trusting a well-formed URL. This
  // also strips protocol-relative Markdown links and a URL that has been
  // percent-encoded before a user pasted it into editorial copy.
  return value.replace(/(?:https?:\/\/|\/\/)?[a-z0-9.-]*blob\.vercel-storage\.com[^\s<>"'`\\]*/gi, "[privat media borttagen]");
}
