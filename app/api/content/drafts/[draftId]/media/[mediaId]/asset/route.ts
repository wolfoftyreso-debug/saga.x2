import { get } from "@vercel/blob";
import { NextRequest, NextResponse } from "next/server";
import { contentDraftIdSchema, contentMediaAttachmentIdSchema } from "@/lib/domain/content-studio";
import { isNeonDatabaseConfigured } from "@/lib/neon/config";
import { requireNeonActor } from "@/lib/neon/http";
import { getOwnedStudioMedia } from "@/lib/neon/studio-content-repository";
import { assertTrustedStudioBlobPath, isVercelBlobConfigured } from "@/lib/vercel/blob-media";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ draftId: string; mediaId: string }> };

/** Streams one private Blob object only after actor + workspace + draft ownership checks. */
export async function GET(request: NextRequest, context: Context) {
  if (!isNeonDatabaseConfigured()) {
    return NextResponse.json({ error: "Privat media är inte konfigurerad i den här deploymenten." }, { status: 503, headers: { "cache-control": "no-store" } });
  }
  const resolved = await requireNeonActor("Logga in för att visa bilden.");
  if (resolved.response) return resolved.response;
  if (!isVercelBlobConfigured()) {
    return NextResponse.json({ error: "Vercel Blob saknas för den här arbetsytan.", missing: ["BLOB_READ_WRITE_TOKEN"] }, { status: 503, headers: { "cache-control": "no-store" } });
  }
  const params = await context.params;
  const draftId = contentDraftIdSchema.safeParse(params.draftId);
  const mediaId = contentMediaAttachmentIdSchema.safeParse(params.mediaId);
  if (!draftId.success || !mediaId.success) return NextResponse.json({ error: "Ogiltigt id för utkast eller mediefil." }, { status: 400 });

  try {
    const media = await getOwnedStudioMedia(resolved.actor, draftId.data, mediaId.data);
    if (!media) return NextResponse.json({ error: "Mediefilen hittades inte." }, { status: 404 });
    const pathname = assertTrustedStudioBlobPath({ workspaceId: resolved.actor.workspaceId, draftId: draftId.data }, media.blobPathname);
    const result = await get(pathname, {
      access: "private",
      token: process.env.BLOB_READ_WRITE_TOKEN?.trim(),
      ifNoneMatch: request.headers.get("if-none-match") ?? undefined,
    });
    if (!result) return NextResponse.json({ error: "Bildfilen hittades inte i Blob." }, { status: 404, headers: { "cache-control": "no-store" } });
    if (result.statusCode === 304) return new NextResponse(null, { status: 304, headers: { etag: result.blob.etag, "cache-control": "private, max-age=60" } });
    return new NextResponse(result.stream, {
      status: 200,
      headers: {
        "content-type": result.blob.contentType,
        "content-length": String(result.blob.size),
        "content-disposition": "inline",
        etag: result.blob.etag,
        "cache-control": "private, max-age=60",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Bilden kunde inte hämtas." }, { status: 502, headers: { "cache-control": "no-store" } });
  }
}
