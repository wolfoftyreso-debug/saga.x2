import { NextRequest, NextResponse } from "next/server";
import { contentDraftIdSchema, contentMediaAttachmentIdSchema, contentMediaAttachmentUpdateSchema } from "@/lib/domain/content-studio";
import { isNeonDatabaseConfigured } from "@/lib/neon/config";
import { requireNeonActor } from "@/lib/neon/http";
import { deleteStudioMediaMetadata } from "@/lib/neon/studio-content-repository";
import { assertTrustedStudioBlobPath, deleteStudioBlob } from "@/lib/vercel/blob-media";
import { deleteContentMediaAttachment, updateContentMediaAttachment } from "@/lib/services/content-studio";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthenticatedUserId } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ draftId: string; mediaId: string }> };

export async function PATCH(request: NextRequest, context: Context) {
  if (isNeonDatabaseConfigured()) {
    const resolved = await requireNeonActor("Logga in för att ändra mediefilen.");
    if (resolved.response) return resolved.response;
    const params = await context.params;
    const draftId = contentDraftIdSchema.safeParse(params.draftId);
    const mediaId = contentMediaAttachmentIdSchema.safeParse(params.mediaId);
    if (!draftId.success || !mediaId.success) return NextResponse.json({ error: "Ogiltigt id för utkast eller mediefil." }, { status: 400 });
    // Metadata editing is deliberately not exposed before the Vercel-native
    // editor has a focused UI for alt text/caption. Never fall through to a
    // legacy Supabase mutation in a Neon deployment.
    return NextResponse.json({ error: "Ändra bilden genom att ersätta den i Studio." }, { status: 409, headers: { "cache-control": "no-store" } });
  }
  const userId = await getAuthenticatedUserId();
  if (!userId) return NextResponse.json({ error: "Logga in för att ändra mediefilen." }, { status: 401 });
  const params = await context.params;
  const draftId = contentDraftIdSchema.safeParse(params.draftId);
  const mediaId = contentMediaAttachmentIdSchema.safeParse(params.mediaId);
  if (!draftId.success || !mediaId.success) return NextResponse.json({ error: "Ogiltigt id för utkast eller mediefil." }, { status: 400 });
  const body = await readJson(request);
  if (body === null) return NextResponse.json({ error: "Skicka giltig JSON." }, { status: 400 });
  const payload = contentMediaAttachmentUpdateSchema.safeParse(body);
  if (!payload.success) return NextResponse.json({ error: "Mediefilen innehåller ett ogiltigt värde." }, { status: 400 });
  try {
    const media = await updateContentMediaAttachment(createAdminClient(), userId, draftId.data, mediaId.data, payload.data);
    if (!media) return NextResponse.json({ error: "Mediefilen hittades inte." }, { status: 404 });
    return NextResponse.json({ media });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Kunde inte uppdatera mediefilen." }, { status: 500 });
  }
}

export async function DELETE(_request: NextRequest, context: Context) {
  if (isNeonDatabaseConfigured()) {
    const resolved = await requireNeonActor("Logga in för att ta bort mediefilen.");
    if (resolved.response) return resolved.response;
    const params = await context.params;
    const draftId = contentDraftIdSchema.safeParse(params.draftId);
    const mediaId = contentMediaAttachmentIdSchema.safeParse(params.mediaId);
    if (!draftId.success || !mediaId.success) return NextResponse.json({ error: "Ogiltigt id för utkast eller mediefil." }, { status: 400 });
    try {
      const removed = await deleteStudioMediaMetadata(resolved.actor, draftId.data, mediaId.data);
      if (!removed) return NextResponse.json({ error: "Mediefilen hittades inte." }, { status: 404 });
      // Metadata is deleted before the object. A failed Blob cleanup leaves an
      // inaccessible orphan, which is safer than a live UI reference to a
      // deleted file. A later maintenance job can remove such orphans.
      const pathname = assertTrustedStudioBlobPath(
        { workspaceId: resolved.actor.workspaceId, draftId: draftId.data },
        removed.blobPathname,
      );
      const cleanup = await deleteStudioBlob({
        scope: { workspaceId: resolved.actor.workspaceId, draftId: draftId.data },
        pathname,
      }).then(() => "complete" as const).catch(() => "pending" as const);
      return NextResponse.json({ ok: true, cleanup }, { headers: { "cache-control": "no-store" } });
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : "Kunde inte ta bort mediefilen." }, { status: 500, headers: { "cache-control": "no-store" } });
    }
  }
  const userId = await getAuthenticatedUserId();
  if (!userId) return NextResponse.json({ error: "Logga in för att ta bort mediefilen." }, { status: 401 });
  const params = await context.params;
  const draftId = contentDraftIdSchema.safeParse(params.draftId);
  const mediaId = contentMediaAttachmentIdSchema.safeParse(params.mediaId);
  if (!draftId.success || !mediaId.success) return NextResponse.json({ error: "Ogiltigt id för utkast eller mediefil." }, { status: 400 });
  try {
    const deleted = await deleteContentMediaAttachment(createAdminClient(), userId, draftId.data, mediaId.data);
    if (!deleted) return NextResponse.json({ error: "Mediefilen hittades inte." }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Kunde inte ta bort mediefilen." }, { status: 500 });
  }
}

async function readJson(request: NextRequest): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
