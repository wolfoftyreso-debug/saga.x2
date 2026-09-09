import { get } from "@vercel/blob";
import { NextRequest, NextResponse } from "next/server";
import { sagaAvatarProfileIdSchema } from "@/lib/domain/saga-avatar";
import { neonConfigurationResponse, requireNeonActor } from "@/lib/neon/http";
import { finalizeSagaAvatarDirectReferenceUpload } from "@/lib/neon/saga-avatar-repository";
import {
  sagaAvatarDirectUploadFinalizeSchema,
  verifySagaAvatarDirectUploadGrant,
} from "@/lib/services/saga-avatar-direct-upload";
import { readSagaAvatarJson, sagaAvatarErrorResponse, sagaAvatarNoStoreHeaders } from "@/lib/services/saga-avatar-http";
import {
  assertPrivateAvatarReferenceBlobUrl,
  assertTrustedAvatarReferenceBlobPath,
} from "@/lib/vercel/avatar-reference-blob";
import { assertAvatarReferenceImageBytes } from "@/lib/vercel/avatar-reference-image-validation";
import { isVercelBlobConfigured } from "@/lib/vercel/blob-media";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

type Context = { params: Promise<{ profileId: string }> };

/**
 * The only point where direct client uploads become SAGA avatar references.
 * It re-reads each private Blob object server-to-server, validates actual
 * bytes, then commits all references as one idempotent metadata batch.
 */
export async function POST(request: NextRequest, context: Context): Promise<NextResponse> {
  const resolved = await requireAvatarActor("Logga in för att slutföra privata avatarreferenser.");
  if (resolved.response) return resolved.response;
  if (!isVercelBlobConfigured()) {
    return NextResponse.json(
      { error: "Vercel Blob saknas för privata avatarreferenser.", missing: ["BLOB_READ_WRITE_TOKEN"] },
      { status: 503, headers: sagaAvatarNoStoreHeaders },
    );
  }
  const profileId = sagaAvatarProfileIdSchema.safeParse((await context.params).profileId);
  if (!profileId.success) return NextResponse.json({ error: "Ogiltigt profil-id." }, { status: 400, headers: sagaAvatarNoStoreHeaders });
  const body = await readSagaAvatarJson(request);
  const payload = sagaAvatarDirectUploadFinalizeSchema.safeParse(body);
  if (!payload.success) return NextResponse.json({ error: "Den privata uppladdningsbehörigheten saknas eller är ogiltig." }, { status: 422, headers: sagaAvatarNoStoreHeaders });

  try {
    const grant = verifySagaAvatarDirectUploadGrant(resolved.actor, payload.data.grant, profileId.data);
    const token = process.env.BLOB_READ_WRITE_TOKEN?.trim();
    if (!token) {
      return NextResponse.json(
        { error: "Vercel Blob saknas för privata avatarreferenser.", missing: ["BLOB_READ_WRITE_TOKEN"] },
        { status: 503, headers: sagaAvatarNoStoreHeaders },
      );
    }
    const references = [] as Array<{
      angle: (typeof grant.files)[number]["angle"];
      blobUrl: string;
      blobPathname: (typeof grant.files)[number]["pathname"];
      contentType: (typeof grant.files)[number]["contentType"];
      byteSize: number;
    }>;
    for (const file of grant.files) {
      const pathname = assertTrustedAvatarReferenceBlobPath(
        { workspaceId: resolved.actor.workspaceId, profileId: profileId.data },
        file.pathname,
      );
      let result: Awaited<ReturnType<typeof get>>;
      try {
        result = await get(pathname, { access: "private", token, useCache: false });
      } catch {
        return NextResponse.json(
          { error: "Kunde inte läsa en privat referensbild just nu. Försök igen.", pending: true, retryAfterMs: 1_000 },
          { status: 202, headers: sagaAvatarNoStoreHeaders },
        );
      }
      if (!result) {
        return NextResponse.json(
          { error: "Väntar på att den privata referensbilden ska bli tillgänglig.", pending: true, retryAfterMs: 1_000 },
          { status: 202, headers: sagaAvatarNoStoreHeaders },
        );
      }
      if (
        result.statusCode !== 200
        || result.blob.pathname !== pathname
        || result.blob.contentType !== file.contentType
        || result.blob.size !== file.byteSize
      ) {
        return NextResponse.json(
          { error: "En privat referensbild matchar inte den valda filen. Välj bilderna igen." },
          { status: 422, headers: sagaAvatarNoStoreHeaders },
        );
      }
      const bytes = new Uint8Array(await new Response(result.stream).arrayBuffer());
      if (bytes.byteLength !== file.byteSize) {
        return NextResponse.json(
          { error: "En privat referensbild kunde inte läsas korrekt. Välj bilderna igen." },
          { status: 422, headers: sagaAvatarNoStoreHeaders },
        );
      }
      assertAvatarReferenceImageBytes(bytes, file.contentType);
      references.push({
        angle: file.angle,
        blobUrl: assertPrivateAvatarReferenceBlobUrl(result.blob.url, pathname),
        blobPathname: pathname,
        contentType: file.contentType,
        byteSize: file.byteSize,
      });
    }
    const profile = await finalizeSagaAvatarDirectReferenceUpload(resolved.actor, {
      profileId: profileId.data,
      references,
    });
    return NextResponse.json({ profile }, { status: 201, headers: sagaAvatarNoStoreHeaders });
  } catch (error) {
    return sagaAvatarErrorResponse(error, "Kunde inte slutföra privata avatarreferenser.");
  }
}

async function requireAvatarActor(message: string) {
  const configuration = neonConfigurationResponse("Privata avatarreferenser behöver Neon i Vercel.");
  if (configuration) return { response: configuration };
  return requireNeonActor(message);
}
