import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isNeonDatabaseConfigured } from "@/lib/neon/config";
import { requireNeonActor } from "@/lib/neon/http";
import { createStudioMediaMetadata, requireOwnedStudioDraft } from "@/lib/neon/studio-content-repository";
import { ContentMediaError, isContentImageFile, uploadContentImageForUser } from "@/lib/services/content-media";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthenticatedUserId } from "@/lib/supabase/server";
import { deleteStudioBlob, uploadStudioBlob, VercelBlobMediaError } from "@/lib/vercel/blob-media";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const draftIdSchema = z.string().uuid();

export async function POST(request: NextRequest, context: { params: Promise<{ draftId: string }> }) {
  if (isNeonDatabaseConfigured()) {
    const resolved = await requireNeonActor("Logga in för att ladda upp en bild.");
    if (resolved.response) return resolved.response;
    const { draftId: rawDraftId } = await context.params;
    const parsedId = draftIdSchema.safeParse(rawDraftId);
    if (!parsedId.success) return NextResponse.json({ error: "Ogiltigt utkast-id." }, { status: 400 });

    try {
      const form = await request.formData();
      const file = form.get("file");
      const altText = form.get("altText");
      if (!(file instanceof File)) return NextResponse.json({ error: "Välj en bildfil." }, { status: 400 });
      // Ownership is checked before a Blob object is created, not just before
      // its metadata is inserted.
      await requireOwnedStudioDraft(resolved.actor, parsedId.data);
      const uploaded = await uploadStudioBlob({
        scope: { workspaceId: resolved.actor.workspaceId, draftId: parsedId.data },
        bytes: new Uint8Array(await file.arrayBuffer()),
        fileName: file.name,
        contentType: file.type,
      });
      try {
        const media = await createStudioMediaMetadata(resolved.actor, {
          draftId: parsedId.data,
          blobUrl: uploaded.url,
          blobPathname: uploaded.pathname,
          contentType: uploaded.contentType,
          byteSize: uploaded.size,
          fileName: file.name,
          altText: typeof altText === "string" ? altText.slice(0, 1_000) : null,
        });
        return NextResponse.json({ media }, { status: 201, headers: { "cache-control": "no-store" } });
      } catch (error) {
        await deleteStudioBlob({ scope: { workspaceId: resolved.actor.workspaceId, draftId: parsedId.data }, pathname: uploaded.pathname }).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      if (error instanceof VercelBlobMediaError) {
        return NextResponse.json({ error: error.message }, { status: error.status, headers: { "cache-control": "no-store" } });
      }
      const message = error instanceof Error ? error.message : "Bilden kunde inte laddas upp.";
      const status = error instanceof Error && error.name === "StudioContentNotFoundError" ? 404 : 502;
      return NextResponse.json({ error: message }, { status, headers: { "cache-control": "no-store" } });
    }
  }
  const userId = await getAuthenticatedUserId();
  if (!userId) return NextResponse.json({ error: "Logga in för att ladda upp en bild." }, { status: 401 });
  const { draftId: rawDraftId } = await context.params;
  const parsedId = draftIdSchema.safeParse(rawDraftId);
  if (!parsedId.success) return NextResponse.json({ error: "Ogiltigt utkast-id." }, { status: 400 });

  try {
    const form = await request.formData();
    const file = form.get("file");
    const altText = form.get("altText");
    if (!(file instanceof File)) return NextResponse.json({ error: "Välj en bildfil." }, { status: 400 });
    if (!isContentImageFile(file)) return NextResponse.json({ error: "Välj en JPG-, PNG- eller WebP-bild på högst 20 MB." }, { status: 400 });
    const attachment = await uploadContentImageForUser({
      client: createAdminClient(),
      userId,
      draftId: parsedId.data,
      bytes: new Uint8Array(await file.arrayBuffer()),
      fileName: file.name,
      contentType: file.type.toLowerCase(),
      altText: typeof altText === "string" ? altText.slice(0, 1_000) : null,
    });
    return NextResponse.json({ media: attachment }, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof ContentMediaError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "Bilden kunde inte laddas upp." }, { status: 502 });
  }
}
