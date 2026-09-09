import "server-only";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { contentMediaAttachmentIdSchema } from "@/lib/domain/content-studio";
import { adaptContentImage, MediaAdaptationError } from "@/lib/services/media-adaptation";

const CONTENT_MEDIA_BUCKET = "content-media";
const IMAGE_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

type DatabaseClient = SupabaseClient;
type RawRecord = Record<string, unknown>;

export type ContentMediaView = {
  id: string;
  contentDraftId: string;
  kind: "image";
  source: "upload" | "generated";
  storagePath: string;
  assetUrl: string;
  filename: string;
  mimeType: string;
  byteSize: number;
  altText: string | null;
  processingStatus: "original" | "ready";
  adaptationPrompt: string | null;
  variants: Record<string, unknown>;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

export class ContentMediaError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ContentMediaError";
  }
}

export function isContentImageFile(file: { type: string; size: number }): boolean {
  return IMAGE_CONTENT_TYPES.has(file.type.toLowerCase()) && file.size > 0 && file.size <= MAX_IMAGE_BYTES;
}

export async function uploadContentImageForUser(input: {
  client: DatabaseClient;
  userId: string;
  draftId: string;
  bytes: Uint8Array;
  fileName: string;
  contentType: string;
  altText?: string | null;
}): Promise<ContentMediaView> {
  await requireOwnedDraft(input.client, input.userId, input.draftId);
  validateImage(input.contentType, input.bytes.byteLength);

  const path = storagePath(input.userId, input.draftId, input.fileName, input.contentType, "upload");
  const upload = await input.client.storage.from(CONTENT_MEDIA_BUCKET).upload(path, input.bytes, {
    contentType: input.contentType,
    cacheControl: "31536000",
    upsert: false,
  });
  if (upload.error) throw new ContentMediaError("Kunde inte lagra bilden.", 502);

  try {
    const attachment = await insertAttachment(input.client, {
      userId: input.userId,
      draftId: input.draftId,
      storagePath: path,
      filename: safeFileName(input.fileName),
      contentType: input.contentType,
      byteSize: input.bytes.byteLength,
      altText: input.altText ?? null,
      source: "upload",
      adaptationPrompt: null,
      variants: {},
    });
    return withSignedUrl(input.client, attachment);
  } catch (error) {
    await input.client.storage.from(CONTENT_MEDIA_BUCKET).remove([path]);
    throw error;
  }
}

/**
 * Creates a new derivative, never overwrites the uploaded file. Its source
 * row remains a full-fidelity original and the returned attachment points to
 * an independent private object.
 */
export async function adaptContentImageForUser(input: {
  client: DatabaseClient;
  userId: string;
  mediaId: string;
  target: "instagram" | "facebook_page" | "linkedin" | "newsletter";
  instruction?: string;
  preserveSubject?: boolean;
  outputStyle?: "editorial" | "clean_product" | "illustrated" | "natural";
}): Promise<ContentMediaView> {
  contentMediaAttachmentIdSchema.parse(input.mediaId);
  const original = await getOwnedImage(input.client, input.userId, input.mediaId);
  if (!original.storagePath) {
    throw new ContentMediaError("Den här bilden kan inte förbättras eftersom originalfilen saknas i ditt bildarkiv.", 409);
  }
  if (!original.mimeType || !IMAGE_CONTENT_TYPES.has(original.mimeType)) {
    throw new ContentMediaError("AI-förbättring stöder JPG, PNG och WebP.", 400);
  }
  const download = await input.client.storage.from(CONTENT_MEDIA_BUCKET).download(original.storagePath);
  if (download.error || !download.data) throw new ContentMediaError("Kunde inte läsa originalbilden.", 502);
  const sourceBytes = new Uint8Array(await download.data.arrayBuffer());
  if (!sourceBytes.byteLength) throw new ContentMediaError("Originalbilden är tom.", 409);

  let adapted;
  try {
    adapted = await adaptContentImage({
      bytes: sourceBytes,
      fileName: original.filename ?? "content-image",
      contentType: original.mimeType,
      userId: input.userId,
      options: {
        target: input.target,
        instruction: input.instruction ?? "",
        preserveSubject: input.preserveSubject ?? true,
        outputStyle: input.outputStyle ?? "editorial",
      },
    });
  } catch (error) {
    if (error instanceof MediaAdaptationError) throw new ContentMediaError(error.message, error.status);
    throw error;
  }

  const path = storagePath(input.userId, original.contentDraftId, original.filename ?? "content-image", adapted.contentType, input.target);
  const upload = await input.client.storage.from(CONTENT_MEDIA_BUCKET).upload(path, adapted.bytes, {
    contentType: adapted.contentType,
    cacheControl: "31536000",
    upsert: false,
  });
  if (upload.error) throw new ContentMediaError("Kunde inte spara den förbättrade bildversionen.", 502);

  try {
    const attachment = await insertAttachment(input.client, {
      userId: input.userId,
      draftId: original.contentDraftId,
      storagePath: path,
      filename: derivativeFileName(original.filename ?? "content-image", input.target),
      contentType: adapted.contentType,
      byteSize: adapted.bytes.byteLength,
      altText: original.altText,
      source: "generated",
      adaptationPrompt: adapted.appliedPrompt,
      variants: {
        adaptedFrom: original.id,
        target: adapted.target,
        model: adapted.model,
        preset: adapted.preset,
      },
      sortOrder: original.sortOrder + 1,
    });
    return withSignedUrl(input.client, attachment);
  } catch (error) {
    await input.client.storage.from(CONTENT_MEDIA_BUCKET).remove([path]);
    throw error;
  }
}

/** Use just-in-time when a provider needs a public HTTPS fetch URL. */
export async function createContentMediaSignedUrl(
  client: DatabaseClient,
  userId: string,
  mediaId: string,
  expiresInSeconds = 60 * 60,
): Promise<string> {
  const media = await getOwnedImage(client, userId, mediaId);
  if (!media.storagePath) throw new ContentMediaError("Bildfilen saknas.", 404);
  const signed = await client.storage.from(CONTENT_MEDIA_BUCKET).createSignedUrl(media.storagePath, expiresInSeconds);
  if (signed.error || !signed.data?.signedUrl) throw new ContentMediaError("Kunde inte skapa en tillfällig bildlänk.", 502);
  return signed.data.signedUrl;
}

/** Trusted publication workers can fetch an owned private image as bytes. */
export async function downloadContentMediaForUser(
  client: DatabaseClient,
  userId: string,
  mediaId: string,
): Promise<{ bytes: Uint8Array; contentType: "image/jpeg" | "image/png" | "image/webp" }> {
  const media = await getOwnedImage(client, userId, mediaId);
  if (!media.storagePath || !media.mimeType || !IMAGE_CONTENT_TYPES.has(media.mimeType)) {
    throw new ContentMediaError("Bilden saknar ett stödd originalformat.", 409);
  }
  const result = await client.storage.from(CONTENT_MEDIA_BUCKET).download(media.storagePath);
  if (result.error || !result.data) throw new ContentMediaError("Kunde inte läsa bildfilen.", 502);
  const bytes = new Uint8Array(await result.data.arrayBuffer());
  if (!bytes.byteLength) throw new ContentMediaError("Bildfilen är tom.", 409);
  return {
    bytes,
    contentType: media.mimeType as "image/jpeg" | "image/png" | "image/webp",
  };
}

async function requireOwnedDraft(client: DatabaseClient, userId: string, draftId: string): Promise<void> {
  const { data, error } = await client
    .from("content_drafts")
    .select("id")
    .eq("id", draftId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw databaseError("Kunde inte kontrollera utkastet", error);
  if (!data) throw new ContentMediaError("Utkastet hittades inte.", 404);
}

async function getOwnedImage(client: DatabaseClient, userId: string, mediaId: string): Promise<{
  id: string;
  contentDraftId: string;
  storagePath: string | null;
  filename: string | null;
  mimeType: string | null;
  altText: string | null;
  sortOrder: number;
}> {
  const { data, error } = await client
    .from("content_media_attachments")
    .select("id, content_draft_id, storage_path, filename, mime_type, alt_text, sort_order, kind")
    .eq("id", mediaId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw databaseError("Kunde inte läsa bilden", error);
  if (!data || data.kind !== "image") throw new ContentMediaError("Bilden hittades inte.", 404);
  return {
    id: String(data.id),
    contentDraftId: String(data.content_draft_id),
    storagePath: typeof data.storage_path === "string" ? data.storage_path : null,
    filename: typeof data.filename === "string" ? data.filename : null,
    mimeType: typeof data.mime_type === "string" ? data.mime_type : null,
    altText: typeof data.alt_text === "string" ? data.alt_text : null,
    sortOrder: typeof data.sort_order === "number" ? data.sort_order : 0,
  };
}

async function insertAttachment(client: DatabaseClient, input: {
  userId: string;
  draftId: string;
  storagePath: string;
  filename: string;
  contentType: string;
  byteSize: number;
  altText: string | null;
  source: "upload" | "generated";
  adaptationPrompt: string | null;
  variants: Record<string, unknown>;
  sortOrder?: number;
}): Promise<ContentMediaView> {
  const { data, error } = await client
    .from("content_media_attachments")
    .insert({
      user_id: input.userId,
      content_draft_id: input.draftId,
      kind: "image",
      source: input.source,
      storage_path: input.storagePath,
      filename: input.filename,
      mime_type: input.contentType,
      byte_size: input.byteSize,
      alt_text: input.altText,
      processing_status: input.source === "generated" ? "ready" : "original",
      adaptation_prompt: input.adaptationPrompt,
      variants: input.variants,
      sort_order: input.sortOrder ?? 0,
    })
    .select("*")
    .single();
  if (error || !data) throw databaseError("Kunde inte spara bildens metadata", error);
  return mapAttachment(data as RawRecord);
}

async function withSignedUrl(client: DatabaseClient, attachment: ContentMediaView): Promise<ContentMediaView> {
  const signed = await client.storage.from(CONTENT_MEDIA_BUCKET).createSignedUrl(attachment.storagePath, 60 * 60);
  if (signed.error || !signed.data?.signedUrl) throw new ContentMediaError("Kunde inte skapa en tillfällig bildlänk.", 502);
  return { ...attachment, assetUrl: signed.data.signedUrl };
}

function mapAttachment(row: RawRecord): ContentMediaView {
  if (typeof row.id !== "string" || typeof row.content_draft_id !== "string" || typeof row.storage_path !== "string") {
    throw new ContentMediaError("Bildens metadata är ogiltiga.", 502);
  }
  return {
    id: row.id,
    contentDraftId: row.content_draft_id,
    kind: "image",
    source: row.source === "generated" ? "generated" : "upload",
    storagePath: row.storage_path,
    assetUrl: "",
    filename: typeof row.filename === "string" ? row.filename : "content-image",
    mimeType: typeof row.mime_type === "string" ? row.mime_type : "image/png",
    byteSize: typeof row.byte_size === "number" ? row.byte_size : 0,
    altText: typeof row.alt_text === "string" ? row.alt_text : null,
    processingStatus: row.processing_status === "ready" ? "ready" : "original",
    adaptationPrompt: typeof row.adaptation_prompt === "string" ? row.adaptation_prompt : null,
    variants: row.variants && typeof row.variants === "object" && !Array.isArray(row.variants) ? row.variants as Record<string, unknown> : {},
    sortOrder: typeof row.sort_order === "number" ? row.sort_order : 0,
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
  };
}

function validateImage(contentType: string, byteLength: number): void {
  if (!IMAGE_CONTENT_TYPES.has(contentType.toLowerCase()) || byteLength <= 0 || byteLength > MAX_IMAGE_BYTES) {
    throw new ContentMediaError("Välj en JPG-, PNG- eller WebP-bild på högst 20 MB.", 400);
  }
}

function storagePath(userId: string, draftId: string, fileName: string, contentType: string, suffix: string): string {
  const extension = contentType === "image/jpeg" ? "jpg" : contentType === "image/webp" ? "webp" : "png";
  return userId + "/" + draftId + "/" + randomUUID() + "-" + suffix + "-" + safeFileName(fileName).replace(/\.[^.]+$/, "") + "." + extension;
}

function derivativeFileName(fileName: string, target: string): string {
  return safeFileName(fileName).replace(/\.[^.]+$/, "") + "-" + target + ".png";
}

function safeFileName(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "content-image";
}

function databaseError(context: string, error: { message?: string } | null): Error {
  return new ContentMediaError(context + (error?.message ? ": " + error.message : ""), 502);
}
