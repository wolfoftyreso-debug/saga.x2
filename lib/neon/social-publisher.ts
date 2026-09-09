import "server-only";

import { createHash } from "node:crypto";
import {
  composeSocialText,
  providerForChannel,
  readySocialPostSchema,
  type ReadySocialPost,
  type SocialProvider,
} from "@/lib/domain/social";
import type { ContentDraftView } from "@/lib/domain/content-studio";
import type { AppActor } from "@/lib/neon/auth-repository";
import { createNeonSql, type NeonSql } from "@/lib/neon/database";
import { getStudioDraft } from "@/lib/neon/studio-content-repository";
import {
  getNeonSocialConnectionSecret,
  markNeonSocialConnectionState,
  type NeonSocialConnectionSecret,
} from "@/lib/neon/social-connections-repository";
import { getSocialProviderConfig, SocialProviderConfigurationError } from "@/lib/services/social-config";
import { decryptSocialSecret, SocialEncryptionConfigurationError } from "@/lib/services/social-crypto";
import {
  publishFacebookPage,
  publishInstagramProfessional,
  publishLinkedIn,
  SocialPublishError,
} from "@/lib/services/social-provider-adapter";

type JsonObject = Record<string, unknown>;

type AttemptRow = {
  id: string;
  state: "running" | "published" | "failed";
  provider_post_id: string | null;
  finished_at: string | null;
  error_code: string | null;
  error_message: string | null;
};

type ProviderPublishResponse = {
  externalPostId: string;
  providerResponse: Record<string, unknown>;
};

export type PublishNeonApprovedSocialDraftInput = {
  /** Trusted app session actor — workspace is never accepted separately. */
  actor: AppActor;
  draftId: string;
  /** Required: the publisher never guesses a default social account. */
  connectionId: string;
  provider: SocialProvider;
  /** Reusing a key returns its durable result and never makes a second post. */
  idempotencyKey?: string | null;
};

export type NeonSocialPublishResult = {
  status: "published" | "failed" | "unavailable" | "in_progress";
  code?: string;
  externalPostId?: string;
  publishedAt?: string;
  errorMessage?: string;
  attemptId?: string;
};

export type NeonSocialPublisherDependencies = {
  getDraft: (actor: AppActor, draftId: string, sql: NeonSql) => Promise<ContentDraftView | null>;
  getConnection: (actor: AppActor, connectionId: string, sql: NeonSql) => Promise<NeonSocialConnectionSecret | null>;
  markConnectionState: (
    actor: AppActor,
    connectionId: string,
    state: "active" | "needs_reauth" | "error",
    lastError: string | null,
    sql: NeonSql,
  ) => Promise<boolean>;
  validateProvider: (provider: SocialProvider) => void;
  /** Receives ciphertext only; the default decrypts inside this server-only module. */
  publish: (connection: NeonSocialConnectionSecret, post: ReadySocialPost) => Promise<ProviderPublishResponse>;
  now: () => Date;
};

export type PublishNeonApprovedSocialDraftOptions = {
  sql?: NeonSql;
  dependencies?: Partial<NeonSocialPublisherDependencies>;
};

const defaultDependencies: NeonSocialPublisherDependencies = {
  getDraft: getStudioDraft,
  getConnection: getNeonSocialConnectionSecret,
  markConnectionState: markNeonSocialConnectionState,
  validateProvider: (provider) => {
    // This validates provider credentials, public callback origin and the
    // encryption key before any access token is decrypted.
    getSocialProviderConfig(provider);
  },
  publish: publishWithNeonCredential,
  now: () => new Date(),
};

/**
 * Intentional, manual-only publishing seam for the Vercel/Neon runtime.
 *
 * It has no route, cron or UI caller yet. A future caller must explicitly
 * select a connection and supply the authenticated actor. This helper creates
 * a durable audit receipt before contacting a provider and leaves the draft
 * unchanged; it does not silently schedule or auto-publish anything.
 */
export async function publishNeonApprovedSocialDraft(
  input: PublishNeonApprovedSocialDraftInput,
  options: PublishNeonApprovedSocialDraftOptions = {},
): Promise<NeonSocialPublishResult> {
  const sql = options.sql ?? createNeonSql();
  const dependencies: NeonSocialPublisherDependencies = { ...defaultDependencies, ...options.dependencies };
  const idempotencyKey = normalizeIdempotencyKey(input);
  let attempt: AttemptRow | null = null;
  let connection: NeonSocialConnectionSecret | null = null;

  try {
    const draft = await dependencies.getDraft(input.actor, input.draftId, sql);
    if (!draft) return failed("draft_not_found", "Utkastet hittades inte i den här arbetsytan.");

    const post = readyPostForApprovedDraft(draft, input.provider);
    connection = await dependencies.getConnection(input.actor, input.connectionId, sql);
    attempt = await createOrReadAttempt({
      sql,
      actor: input.actor,
      draft,
      connectionId: connection?.id ?? null,
      provider: input.provider,
      idempotencyKey,
      post,
    });
    if (attempt.state === "published") {
      return {
        status: "published",
        attemptId: attempt.id,
        externalPostId: stringOrUndefined(attempt.provider_post_id),
        publishedAt: stringOrUndefined(attempt.finished_at),
      };
    }
    if (attempt.state === "failed") {
      return failed(attempt.error_code ?? "previous_attempt_failed", attempt.error_message ?? "Ett tidigare publiceringsförsök misslyckades.", attempt.id);
    }
    if (attempt.id.startsWith("existing:")) {
      return {
        status: "in_progress",
        code: "idempotency_in_progress",
        attemptId: attempt.id.slice("existing:".length),
        errorMessage: "Ett tidigare publiceringsförsök med samma nyckel pågår eller måste granskas. En ny post skapades inte.",
      };
    }

    if (!connection) {
      return await failAttempt(sql, input.actor.workspaceId, attempt.id, "connection_missing", "Det valda kontot hittades inte i den här arbetsytan.", dependencies.now());
    }
    if (connection.provider !== input.provider) {
      return await failAttempt(sql, input.actor.workspaceId, attempt.id, "connection_provider_mismatch", "Det valda kontot tillhör inte den här publiceringskanalen.", dependencies.now());
    }
    if (connection.state !== "active") {
      return await failAttempt(sql, input.actor.workspaceId, attempt.id, "connection_inactive", "Kontot behöver kopplas om innan publicering.", dependencies.now());
    }
    if (connection.tokenExpiresAt && Date.parse(connection.tokenExpiresAt) <= dependencies.now().getTime()) {
      await safeMarkNeedsReauth(dependencies, input.actor, connection.id, sql, "OAuth-tokenen har gått ut. Koppla om kontot.");
      return await failAttempt(sql, input.actor.workspaceId, attempt.id, "token_expired", "Kontot behöver kopplas om innan publicering.", dependencies.now());
    }

    try {
      dependencies.validateProvider(input.provider);
    } catch (error) {
      if (error instanceof SocialProviderConfigurationError || error instanceof SocialEncryptionConfigurationError) {
        const result = await failAttempt(sql, input.actor.workspaceId, attempt.id, "provider_configuration_required", "Publiceringskopplingen saknar serverkonfiguration.", dependencies.now());
        return { ...result, status: "unavailable", code: "provider_configuration_required" };
      }
      throw error;
    }

    const published = await dependencies.publish(connection, post);
    return await completeAttempt(sql, input.actor.workspaceId, attempt.id, published, dependencies.now());
  } catch (error) {
    if (isSchemaPrerequisiteError(error)) {
      return {
        status: "unavailable",
        code: "neon_social_publish_schema_required",
        errorMessage: "Publicering är inte klar ännu: Neon-migrationen för publiceringskvitton saknas eller är inte åtkomlig.",
        ...(attempt ? { attemptId: attempt.id } : {}),
      };
    }
    const { code, message, unavailable, requiresReauth } = classifyError(error);
    if (connection && requiresReauth) {
      await safeMarkNeedsReauth(dependencies, input.actor, connection.id, sql, "OAuth-tokenen behöver förnyas. Koppla om kontot.");
    }
    if (attempt && !attempt.id.startsWith("existing:")) {
      try {
        const recorded = await failAttempt(sql, input.actor.workspaceId, attempt.id, code, message, dependencies.now());
        return unavailable ? { ...recorded, status: "unavailable", code } : recorded;
      } catch (auditError) {
        if (isSchemaPrerequisiteError(auditError)) {
          return {
            status: "unavailable",
            code: "neon_social_publish_schema_required",
            errorMessage: "Publiceringen stoppades eftersom Neon inte kunde spara ett säkert kvitto.",
            attemptId: attempt.id,
          };
        }
      }
    }
    return unavailable
      ? { status: "unavailable", code, errorMessage: message, ...(attempt ? { attemptId: attempt.id } : {}) }
      : failed(code, message, attempt?.id);
  }
}

function readyPostForApprovedDraft(draft: ContentDraftView, provider: SocialProvider): ReadySocialPost {
  if (draft.deliveryLocked || draft.privateBrief) {
    throw new NeonSocialPublishPrerequisiteError(
      "ad_private_brief_locked",
      "Det här SAGA-annonsutkastet är ett låst privat kreativt underlag och kan inte publiceras via Studio.",
    );
  }
  if (draft.contentType !== "social_post") {
    throw new NeonSocialPublishPrerequisiteError("draft_not_social", "Endast sociala inlägg kan publiceras via en social kanal.");
  }
  if (draft.status !== "approved" || !draft.approvedAt) {
    throw new NeonSocialPublishPrerequisiteError("draft_not_approved", "Godkänn utkastet innan du publicerar det.");
  }
  if (!draft.channels.some((channel) => channel !== "newsletter" && providerForChannel(channel) === provider)) {
    throw new NeonSocialPublishPrerequisiteError("draft_channel_mismatch", "Utkastet är inte godkänt för den valda publiceringskanalen.");
  }
  // Blob originals remain private. Exposing one just to make a provider fetch
  // it would break the media boundary, so media publication is intentionally
  // unavailable until a Vercel public-derivative / provider-upload step lands.
  if (draft.media.length) {
    throw new NeonSocialPublishUnavailableError(
      "private_media_delivery_unavailable",
      "Bildpublicering är inte klar ännu: Studio-media är privat i Vercel Blob och behöver en säker publiceringsvariant först.",
    );
  }
  if (provider === "instagram_professional") {
    throw new NeonSocialPublishUnavailableError(
      "instagram_public_media_required",
      "Instagram kräver en offentlig publiceringsbild. Den säkra Vercel-medievägen är inte klar ännu.",
    );
  }
  const parsed = readySocialPostSchema.safeParse({
    title: draft.title || null,
    headline: draft.headline || null,
    body: [draft.body, draft.hashtags.join(" ")].filter(Boolean).join("\n\n"),
    cta: draft.cta || null,
    media: [],
  });
  if (!parsed.success) throw new NeonSocialPublishPrerequisiteError("draft_not_ready", "Utkastet saknar text eller annat innehåll att publicera.");
  return parsed.data;
}

async function createOrReadAttempt(input: {
  sql: NeonSql;
  actor: AppActor;
  draft: ContentDraftView;
  connectionId: string | null;
  provider: SocialProvider;
  idempotencyKey: string;
  post: ReadySocialPost;
}): Promise<AttemptRow> {
  const rows = await input.sql.query(
    `insert into social_publish_attempts (
       workspace_id,
       draft_id,
       connection_id,
       initiated_by_user_id,
       provider,
       idempotency_key,
       payload_fingerprint,
       payload_summary,
       state,
       started_at
     ) values (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8::jsonb, 'running', now()
     )
     on conflict (workspace_id, provider, idempotency_key) do nothing
     returning id::text, state, provider_post_id, finished_at::text, error_code, error_message`,
    [
      input.actor.workspaceId,
      input.draft.id,
      input.connectionId,
      input.actor.userId,
      input.provider,
      input.idempotencyKey,
      fingerprintPost(input.post),
      JSON.stringify(payloadSummary(input.post)),
    ],
  ) as unknown as AttemptRow[];
  if (rows[0]) return rows[0];

  const existing = await input.sql.query(
    `select id::text, state, provider_post_id, finished_at::text, error_code, error_message
     from social_publish_attempts
     where workspace_id = $1::uuid and provider = $2 and idempotency_key = $3
     limit 1`,
    [input.actor.workspaceId, input.provider, input.idempotencyKey],
  ) as unknown as AttemptRow[];
  const attempt = existing[0];
  if (!attempt) throw new Error("Publiceringskvittot kunde inte skapas eller läsas.");
  return attempt.state === "running" ? { ...attempt, id: `existing:${attempt.id}` } : attempt;
}

async function completeAttempt(
  sql: NeonSql,
  workspaceId: string,
  attemptId: string,
  published: ProviderPublishResponse,
  now: Date,
): Promise<NeonSocialPublishResult> {
  const rows = await sql.query(
    `update social_publish_attempts
        set state = 'published',
            provider_post_id = $3,
            provider_response = $4::jsonb,
            error_code = null,
            error_message = null,
            finished_at = $5::timestamptz
      where workspace_id = $1::uuid and id = $2::uuid and state = 'running'
      returning id::text`,
    [workspaceId, attemptId, published.externalPostId.slice(0, 500), JSON.stringify(safeProviderResponse(published.providerResponse)), now.toISOString()],
  ) as unknown as Array<{ id: string }>;
  if (!rows[0]) throw new Error("Publiceringen kunde inte kvitteras säkert i Neon.");
  return {
    status: "published",
    attemptId,
    externalPostId: published.externalPostId,
    publishedAt: now.toISOString(),
  };
}

async function failAttempt(
  sql: NeonSql,
  workspaceId: string,
  attemptId: string,
  code: string,
  message: string,
  now: Date,
): Promise<NeonSocialPublishResult> {
  const rows = await sql.query(
    `update social_publish_attempts
        set state = 'failed',
            error_code = $3,
            error_message = $4,
            finished_at = $5::timestamptz
      where workspace_id = $1::uuid and id = $2::uuid and state = 'running'
      returning id::text`,
    [workspaceId, attemptId, code.slice(0, 120), message.slice(0, 1_000), now.toISOString()],
  ) as unknown as Array<{ id: string }>;
  if (!rows[0]) throw new Error("Publiceringsfelet kunde inte kvitteras säkert i Neon.");
  return failed(code, message, attemptId);
}

async function publishWithNeonCredential(
  connection: NeonSocialConnectionSecret,
  post: ReadySocialPost,
): Promise<ProviderPublishResponse> {
  // The only plaintext token exists in this server-only function scope while
  // a single provider request is built. It is not logged, returned or stored.
  const accessToken = decryptSocialSecret(connection.tokenCiphertext);
  switch (connection.provider) {
    case "facebook_page":
      return publishFacebookPage(connection, post, accessToken);
    case "instagram_professional":
      return publishInstagramProfessional(connection, post, accessToken);
    case "linkedin":
      return publishLinkedIn(connection, post, accessToken);
  }
}

async function safeMarkNeedsReauth(
  dependencies: NeonSocialPublisherDependencies,
  actor: AppActor,
  connectionId: string,
  sql: NeonSql,
  message: string,
): Promise<void> {
  try {
    await dependencies.markConnectionState(actor, connectionId, "needs_reauth", message, sql);
  } catch {
    // The audit result still records the failure; a telemetry write must not
    // conceal the provider result or retry publishing.
  }
}

function normalizeIdempotencyKey(input: PublishNeonApprovedSocialDraftInput): string {
  const fallback = `draft:${input.draftId}:connection:${input.connectionId}:provider:${input.provider}`;
  const key = (input.idempotencyKey?.trim() || fallback).slice(0, 220);
  if (!key) throw new NeonSocialPublishPrerequisiteError("idempotency_required", "Ett idempotens-id saknas för publiceringen.");
  return key;
}

function fingerprintPost(post: ReadySocialPost): string {
  return createHash("sha256")
    .update(JSON.stringify({
      title: post.title ?? null,
      headline: post.headline ?? null,
      body: post.body,
      cta: post.cta ?? null,
      linkUrl: post.linkUrl ?? null,
      media: post.media.map((media) => ({ url: media.url, altText: media.altText ?? null, linkedInAssetUrn: media.linkedInAssetUrn ?? null })),
    }), "utf8")
    .digest("hex");
}

function payloadSummary(post: ReadySocialPost): JsonObject {
  return {
    title: post.title?.slice(0, 120) ?? null,
    hasLink: Boolean(post.linkUrl),
    mediaCount: post.media.length,
    textLength: composeSocialText(post).length,
  };
}

function safeProviderResponse(value: Record<string, unknown>): JsonObject {
  const result: JsonObject = {};
  for (const key of ["id", "post_id"]) {
    const item = value[key];
    if (typeof item === "string") result[key] = item.slice(0, 500);
    else if (typeof item === "number") result[key] = item;
  }
  return result;
}

function classifyError(error: unknown): { code: string; message: string; unavailable: boolean; requiresReauth: boolean } {
  if (error instanceof NeonSocialPublishUnavailableError) {
    return { code: error.code, message: error.message, unavailable: true, requiresReauth: false };
  }
  if (error instanceof NeonSocialPublishPrerequisiteError) {
    return { code: error.code, message: error.message, unavailable: false, requiresReauth: false };
  }
  if (error instanceof SocialProviderConfigurationError || error instanceof SocialEncryptionConfigurationError) {
    return { code: "provider_configuration_required", message: "Publiceringskopplingen saknar serverkonfiguration.", unavailable: true, requiresReauth: false };
  }
  if (error instanceof SocialPublishError) {
    return { code: error.code, message: error.message, unavailable: false, requiresReauth: error.requiresReauth };
  }
  return { code: "publish_failed", message: "Publiceringen kunde inte genomföras. Ingen ny automatisk retry startades.", unavailable: false, requiresReauth: false };
}

function isSchemaPrerequisiteError(error: unknown): boolean {
  const candidate = error as { code?: unknown; message?: unknown } | null;
  const code = typeof candidate?.code === "string" ? candidate.code : "";
  if (["42P01", "42703", "42830", "3F000"].includes(code)) return true;
  const message = typeof candidate?.message === "string" ? candidate.message : "";
  return /social_publish_attempts|social_connections|studio_drafts|does not exist|undefined table/i.test(message);
}

function failed(code: string, errorMessage: string, attemptId?: string): NeonSocialPublishResult {
  return { status: "failed", code, errorMessage, ...(attemptId ? { attemptId } : {}) };
}

function stringOrUndefined(value: string | null): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

class NeonSocialPublishPrerequisiteError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "NeonSocialPublishPrerequisiteError";
  }
}

class NeonSocialPublishUnavailableError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "NeonSocialPublishUnavailableError";
  }
}
