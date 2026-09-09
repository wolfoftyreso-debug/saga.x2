import "server-only";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  composeSocialText,
  readySocialPostSchema,
  type ReadySocialPost,
  type SocialProvider,
  type SocialPublishResult,
} from "@/lib/domain/social";
import { getSocialProviderConfig } from "@/lib/services/social-config";
import { decryptSocialSecret } from "@/lib/services/social-crypto";
import {
  getDefaultSocialConnectionSecret,
  getSocialConnectionSecret,
  markSocialConnectionState,
  type SocialConnectionSecret,
} from "@/lib/services/social-connections";

type DatabaseClient = SupabaseClient;
type RawRecord = Record<string, unknown>;

export class SocialPublishError extends Error {
  constructor(
    message: string,
    readonly code = "publish_failed",
    readonly requiresReauth = false,
  ) {
    super(message);
    this.name = "SocialPublishError";
  }
}

export type PublishReadySocialPostInput = {
  userId: string;
  provider: SocialProvider;
  post: ReadySocialPost;
  connectionId?: string | null;
  contentDraftId?: string | null;
  /** A scheduler job ID is ideal. Without it, the draft/channel pair is used. */
  idempotencyKey?: string | null;
};

/**
 * The durable publish seam. It never lets an unknown provider/network fault
 * escape as a scheduler crash; callers receive a safe result and an audit
 * attempt is retained. It can be called by a cron worker after a draft has
 * passed its own approval rules.
 */
export async function publishReadySocialPost(
  client: DatabaseClient,
  input: PublishReadySocialPostInput,
): Promise<SocialPublishResult> {
  const parsed = readySocialPostSchema.safeParse(input.post);
  if (!parsed.success) return { status: "failed", errorMessage: "Utkastet är inte redo för publicering." };
  const post = parsed.data;
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey, input.contentDraftId, input.provider);
  let attemptId: string | null = null;
  let connection: SocialConnectionSecret | null = null;

  try {
    const prior = await findPublishedAttempt(client, input.userId, input.provider, idempotencyKey);
    if (prior) {
      return { status: "published", externalPostId: prior.providerPostId ?? undefined, publishedAt: prior.finishedAt, attemptId: prior.id };
    }

    connection = input.connectionId
      ? await getSocialConnectionSecret(client, input.userId, input.connectionId)
      : await getDefaultSocialConnectionSecret(client, input.userId, input.provider);
    const attempt = await startSocialPublishAttempt(client, {
      userId: input.userId,
      contentDraftId: input.contentDraftId ?? null,
      connectionId: connection?.id ?? null,
      provider: input.provider,
      idempotencyKey,
      post,
    });
    attemptId = attempt.id;

    if (!connection) {
      return await failAttempt(client, attempt.id, "connection_missing", "Koppla ett enda aktivt konto för kanalen eller välj konto i utkastet.");
    }
    if (connection.provider !== input.provider) {
      return await failAttempt(client, attempt.id, "connection_provider_mismatch", "Det valda kontot tillhör inte den här publiceringskanalen.");
    }
    if (connection.state !== "active") {
      return await failAttempt(client, attempt.id, "connection_inactive", "Kontot behöver kopplas om innan publicering.");
    }
    if (connection.tokenExpiresAt && new Date(connection.tokenExpiresAt).getTime() <= Date.now()) {
      await markSocialConnectionState(client, input.userId, connection.id, "needs_reauth", "OAuth-tokenen har gått ut. Koppla om kontot.");
      return await failAttempt(client, attempt.id, "token_expired", "Kontot behöver kopplas om innan publicering.");
    }

    const published = await publishViaProvider(connection, post);
    return await completeAttempt(client, attempt.id, published);
  } catch (error) {
    // Errors before the attempt exists (such as an unavailable database) still
    // return a status object to the scheduler. Never leak an OAuth token or
    // raw provider response into an API/UI path.
    const message = displayPublishError(error);
    if (connection && error instanceof SocialPublishError && error.requiresReauth) {
      try {
        await markSocialConnectionState(client, input.userId, connection.id, "needs_reauth", "OAuth-tokenen behöver förnyas. Koppla om kontot.");
      } catch {
        // The error is still safely represented by the publish attempt below.
      }
    }
    if (attemptId) {
      try {
        return await failAttempt(client, attemptId, error instanceof SocialPublishError ? error.code : "publish_failed", message);
      } catch {
        // A database problem must not turn into a thrown cron failure.
      }
    }
    return { status: "failed", errorMessage: message };
  }
}

/** Provider adapter interface, exported for direct integration testing/use. */
export async function publishViaProvider(
  connection: SocialConnectionSecret,
  post: ReadySocialPost,
): Promise<{ externalPostId: string; providerResponse: Record<string, unknown> }> {
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

/** Facebook publishing is Page-only; personal profiles are deliberately unsupported. */
export async function publishFacebookPage(
  connection: SocialConnectionSecret,
  post: ReadySocialPost,
  accessToken: string,
): Promise<{ externalPostId: string; providerResponse: Record<string, unknown> }> {
  const config = getSocialProviderConfig("facebook_page");
  if (config.provider === "linkedin") throw new SocialPublishError("Facebook-kopplingen är felkonfigurerad.", "provider_configuration_invalid");
  const text = composeSocialText(post);
  if (post.media.length > 1) throw new SocialPublishError("Facebook-inlägget kan ha en huvudbild i den här versionen.", "facebook_multiple_media_unsupported");

  if (post.media[0]) {
    const imageUrl = publicHttpsMediaUrl(post.media[0].url);
    const body = new URLSearchParams({ url: imageUrl, caption: withLink(text, post.linkUrl) || " " });
    const response = await providerFetch(`${config.graphBaseUrl}/${encodeURIComponent(connection.providerAccountId)}/photos`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/x-www-form-urlencoded" },
      body,
    }, "Facebook");
    const data = await providerJson(response, "Facebook");
    const id = stringField(data, "post_id") ?? stringField(data, "id");
    if (!id) throw new SocialPublishError("Facebook bekräftade inte något inläggs-id.", "facebook_missing_post_id");
    return { externalPostId: id, providerResponse: pickProviderResponse(data, ["id", "post_id"]) };
  }

  const body = new URLSearchParams({ message: text || " " });
  if (post.linkUrl) body.set("link", post.linkUrl);
  const response = await providerFetch(`${config.graphBaseUrl}/${encodeURIComponent(connection.providerAccountId)}/feed`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/x-www-form-urlencoded" },
    body,
  }, "Facebook");
  const data = await providerJson(response, "Facebook");
  const id = stringField(data, "id");
  if (!id) throw new SocialPublishError("Facebook bekräftade inte något inläggs-id.", "facebook_missing_post_id");
  return { externalPostId: id, providerResponse: pickProviderResponse(data, ["id"]) };
}

/**
 * Instagram requires exactly one externally hosted public image in V1. The
 * account was verified as Professional when the Meta connection was created.
 */
export async function publishInstagramProfessional(
  connection: SocialConnectionSecret,
  post: ReadySocialPost,
  accessToken: string,
): Promise<{ externalPostId: string; providerResponse: Record<string, unknown> }> {
  const config = getSocialProviderConfig("instagram_professional");
  if (config.provider === "linkedin") throw new SocialPublishError("Instagram-kopplingen är felkonfigurerad.", "provider_configuration_invalid");
  if (post.media.length !== 1) {
    throw new SocialPublishError("Instagram behöver exakt en offentlig huvudbild i den här versionen.", "instagram_image_required");
  }
  const imageUrl = publicHttpsMediaUrl(post.media[0].url);
  const caption = withLink(composeSocialText(post), post.linkUrl);
  if (caption.length > 2_200) throw new SocialPublishError("Instagram-texten är längre än 2 200 tecken.", "instagram_caption_too_long");

  const createContainer = await providerFetch(`${config.instagramGraphBaseUrl}/${encodeURIComponent(connection.providerAccountId)}/media`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ image_url: imageUrl, caption }),
  }, "Instagram");
  const containerData = await providerJson(createContainer, "Instagram");
  const containerId = stringField(containerData, "id");
  if (!containerId) throw new SocialPublishError("Instagram skapade ingen mediabehållare.", "instagram_missing_container");

  await waitForInstagramContainer(config.instagramGraphBaseUrl, containerId, accessToken);
  const published = await providerFetch(`${config.instagramGraphBaseUrl}/${encodeURIComponent(connection.providerAccountId)}/media_publish`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ creation_id: containerId }),
  }, "Instagram");
  const data = await providerJson(published, "Instagram");
  const id = stringField(data, "id");
  if (!id) throw new SocialPublishError("Instagram bekräftade inte något inläggs-id.", "instagram_missing_post_id");
  return { externalPostId: id, providerResponse: pickProviderResponse(data, ["id"]) };
}

/** LinkedIn Posts API supports a prepared image URN; direct external image URLs cannot be embedded. */
export async function publishLinkedIn(
  connection: SocialConnectionSecret,
  post: ReadySocialPost,
  accessToken: string,
): Promise<{ externalPostId: string; providerResponse: Record<string, unknown> }> {
  const config = getSocialProviderConfig("linkedin");
  if (config.provider !== "linkedin") throw new SocialPublishError("LinkedIn-kopplingen är felkonfigurerad.", "provider_configuration_invalid");
  const commentary = withLink(composeSocialText(post), post.linkUrl);
  if (commentary.length > 3_000) throw new SocialPublishError("LinkedIn-texten är längre än 3 000 tecken.", "linkedin_commentary_too_long");
  if (post.media.length > 1) throw new SocialPublishError("LinkedIn-inlägget kan ha en huvudbild i den här versionen.", "linkedin_multiple_media_unsupported");

  const payload: Record<string, unknown> = {
    author: connection.providerAccountId,
    commentary,
    visibility: "PUBLIC",
    distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
    lifecycleState: "PUBLISHED",
    isReshareDisabledByAuthor: false,
  };
  const assetUrn = post.media[0]?.linkedInAssetUrn?.trim();
  if (post.media.length && !assetUrn) {
    throw new SocialPublishError("LinkedIn-bilden behöver först laddas upp som ett LinkedIn-mediaobjekt.", "linkedin_media_asset_required");
  }
  if (assetUrn) {
    payload.content = { media: { id: assetUrn, title: post.headline ?? post.title ?? "" } };
  }

  const response = await providerFetch(`${config.apiBaseUrl}/rest/posts`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      "x-restli-protocol-version": "2.0.0",
      "linkedin-version": config.apiVersion,
    },
    body: JSON.stringify(payload),
  }, "LinkedIn");
  const data = await maybeProviderJson(response);
  const id = response.headers.get("x-restli-id") ?? stringField(data, "id");
  if (!id) throw new SocialPublishError("LinkedIn bekräftade inte något inläggs-id.", "linkedin_missing_post_id");
  return { externalPostId: id, providerResponse: pickProviderResponse(data, ["id"]) };
}

/**
 * A content/media service that owns bytes may use this to turn a file into a
 * LinkedIn image URN before calling publishLinkedIn. It deliberately accepts
 * bytes rather than fetching arbitrary user-supplied URLs (no server-side
 * SSRF surface).
 */
export async function uploadLinkedInImageAsset(input: {
  connection: SocialConnectionSecret;
  image: Uint8Array;
  contentType: "image/jpeg" | "image/png" | "image/webp";
}): Promise<string> {
  if (input.connection.provider !== "linkedin") throw new SocialPublishError("Kontot är inte ett LinkedIn-konto.", "connection_provider_mismatch");
  if (!input.image.byteLength || input.image.byteLength > 10 * 1024 * 1024) {
    throw new SocialPublishError("LinkedIn-bilden måste vara mellan 1 byte och 10 MB.", "linkedin_image_size_invalid");
  }
  const config = getSocialProviderConfig("linkedin");
  if (config.provider !== "linkedin") throw new SocialPublishError("LinkedIn-kopplingen är felkonfigurerad.", "provider_configuration_invalid");
  const accessToken = decryptSocialSecret(input.connection.tokenCiphertext);
  const initialize = await providerFetch(`${config.apiBaseUrl}/rest/images?action=initializeUpload`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      "x-restli-protocol-version": "2.0.0",
      "linkedin-version": config.apiVersion,
    },
    body: JSON.stringify({ initializeUploadRequest: { owner: input.connection.providerAccountId } }),
  }, "LinkedIn");
  const initializeData = await providerJson(initialize, "LinkedIn");
  const value = isRecord(initializeData.value) ? initializeData.value : {};
  const uploadUrl = stringField(value, "uploadUrl");
  const imageUrn = stringField(value, "image");
  if (!uploadUrl || !imageUrn) throw new SocialPublishError("LinkedIn kunde inte initiera bilduppladdningen.", "linkedin_upload_init_failed");
  const uploadBytes = Uint8Array.from(input.image).buffer;
  const uploadResponse = await fetch(uploadUrl, {
    method: "PUT",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": input.contentType },
    body: uploadBytes,
    signal: AbortSignal.timeout(30_000),
    cache: "no-store",
  });
  if (!uploadResponse.ok) throw new SocialPublishError("LinkedIn kunde inte ladda upp bilden.", "linkedin_upload_failed");
  return imageUrn;
}

/** Rejects local/intranet/IP targets before passing a URL to a social provider. */
export function publicHttpsMediaUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SocialPublishError("Bildlänken är ogiltig.", "media_url_invalid");
  }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || (url.port && url.port !== "443")
    || !host
    || isIP(host) !== 0
    || host === "localhost"
    || host.endsWith(".localhost")
    || host.endsWith(".local")
    || host.endsWith(".internal")
  ) {
    throw new SocialPublishError("Bilden måste ligga på en offentlig HTTPS-adress.", "media_url_not_public");
  }
  return url.toString();
}

async function waitForInstagramContainer(graphBaseUrl: string, containerId: string, accessToken: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const url = new URL(`${graphBaseUrl}/${encodeURIComponent(containerId)}`);
    url.searchParams.set("fields", "status_code,status");
    const response = await providerFetch(url.toString(), { headers: { authorization: `Bearer ${accessToken}` } }, "Instagram");
    const body = await providerJson(response, "Instagram");
    const status = (stringField(body, "status_code") ?? stringField(body, "status") ?? "").toUpperCase();
    if (status === "FINISHED" || status === "READY") return;
    if (status === "ERROR" || status === "EXPIRED") {
      throw new SocialPublishError("Instagram kunde inte behandla bilden. Kontrollera att den är offentligt åtkomlig och stöds av Instagram.", "instagram_media_processing_failed");
    }
    await delay(750);
  }
  throw new SocialPublishError("Instagram bearbetar fortfarande bilden. Försök igen om en stund.", "instagram_media_processing_pending");
}

async function startSocialPublishAttempt(
  client: DatabaseClient,
  input: {
    userId: string;
    contentDraftId: string | null;
    connectionId: string | null;
    provider: SocialProvider;
    idempotencyKey: string;
    post: ReadySocialPost;
  },
): Promise<{ id: string }> {
  const { data, error } = await client
    .from("social_publish_attempts")
    .insert({
      user_id: input.userId,
      content_draft_id: input.contentDraftId,
      connection_id: input.connectionId,
      provider: input.provider,
      idempotency_key: input.idempotencyKey,
      payload_fingerprint: fingerprintPost(input.post),
      payload_summary: {
        title: input.post.title?.slice(0, 120) ?? null,
        hasLink: Boolean(input.post.linkUrl),
        mediaCount: input.post.media.length,
        textLength: composeSocialText(input.post).length,
      },
      state: "running",
      started_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (error || !data?.id) throw databaseError("Kunde inte starta publiceringsförsöket", error);
  return { id: String(data.id) };
}

async function completeAttempt(
  client: DatabaseClient,
  attemptId: string,
  published: { externalPostId: string; providerResponse: Record<string, unknown> },
): Promise<SocialPublishResult> {
  const publishedAt = new Date().toISOString();
  const { error } = await client
    .from("social_publish_attempts")
    .update({
      state: "published",
      provider_post_id: published.externalPostId,
      provider_response: published.providerResponse,
      finished_at: publishedAt,
      error_code: null,
      error_message: null,
    })
    .eq("id", attemptId)
    .eq("state", "running");
  if (error) throw databaseError("Kunde inte spara publiceringsresultatet", error);
  return { status: "published", externalPostId: published.externalPostId, publishedAt, attemptId };
}

async function failAttempt(client: DatabaseClient, attemptId: string, code: string, message: string): Promise<SocialPublishResult> {
  const finishedAt = new Date().toISOString();
  const { error } = await client
    .from("social_publish_attempts")
    .update({ state: "failed", error_code: code.slice(0, 120), error_message: message.slice(0, 1_000), finished_at: finishedAt })
    .eq("id", attemptId)
    .eq("state", "running");
  if (error) throw databaseError("Kunde inte spara publiceringsfelet", error);
  return { status: "failed", errorMessage: message, attemptId };
}

async function findPublishedAttempt(
  client: DatabaseClient,
  userId: string,
  provider: SocialProvider,
  idempotencyKey: string,
): Promise<{ id: string; providerPostId: string | null; finishedAt: string } | null> {
  const { data, error } = await client
    .from("social_publish_attempts")
    .select("id, provider_post_id, finished_at")
    .eq("user_id", userId)
    .eq("provider", provider)
    .eq("idempotency_key", idempotencyKey)
    .eq("state", "published")
    .order("finished_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw databaseError("Kunde inte kontrollera tidigare publicering", error);
  if (!data) return null;
  return {
    id: String(data.id),
    providerPostId: typeof data.provider_post_id === "string" ? data.provider_post_id : null,
    finishedAt: String(data.finished_at),
  };
}

async function providerFetch(url: string, init: RequestInit, provider: string): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(30_000), cache: "no-store" });
  } catch {
    throw new SocialPublishError(`${provider} kunde inte nås just nu.`, "provider_unavailable");
  }
  if (!response.ok) {
    const body = await maybeProviderJson(response);
    const code = nestedErrorCode(body);
    const requiresReauth = response.status === 401 || response.status === 403 || code === "190";
    throw new SocialPublishError(
      requiresReauth
        ? `${provider}-behörigheten gäller inte längre. Koppla om kontot.`
        : `${provider} avvisade publiceringen. Kontrollera utkastet och kontobehörigheten.`,
      `${provider.toLowerCase()}_${response.status}`,
      requiresReauth,
    );
  }
  return response;
}

async function providerJson(response: Response, provider: string): Promise<RawRecord> {
  const body = await maybeProviderJson(response);
  if (!Object.keys(body).length) throw new SocialPublishError(`${provider} returnerade inget läsbart svar.`, "provider_invalid_response");
  return body;
}

async function maybeProviderJson(response: Response): Promise<RawRecord> {
  try {
    const value: unknown = await response.json();
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

function normalizeIdempotencyKey(value: string | null | undefined, contentDraftId: string | null | undefined, provider: SocialProvider): string {
  const fallback = contentDraftId ? `draft:${contentDraftId}:${provider}` : `manual:${provider}:${createHash("sha256").update(String(Date.now())).digest("hex").slice(0, 24)}`;
  const key = (value?.trim() || fallback).slice(0, 220);
  if (!key) throw new Error("Ett idempotens-id saknas.");
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

function withLink(text: string, linkUrl: string | null | undefined): string {
  if (!linkUrl || text.includes(linkUrl)) return text;
  return text ? `${text}\n\n${linkUrl}` : linkUrl;
}

function stringField(record: RawRecord, key: string): string | null {
  return typeof record[key] === "string" && record[key].trim() ? record[key] : null;
}

function nestedErrorCode(record: RawRecord): string | null {
  const error = isRecord(record.error) ? record.error : null;
  const value = error?.code;
  return typeof value === "number" || typeof value === "string" ? String(value) : null;
}

function pickProviderResponse(source: RawRecord, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.flatMap((key) => typeof source[key] === "string" || typeof source[key] === "number" ? [[key, source[key]]] : []));
}

function displayPublishError(error: unknown): string {
  if (error instanceof SocialPublishError) return error.message;
  return "Publiceringen kunde inte genomföras. Försök igen.";
}

function databaseError(context: string, error: { message?: string } | null): Error {
  return new Error(`${context}${error?.message ? `: ${error.message}` : ""}`);
}

function isRecord(value: unknown): value is RawRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
