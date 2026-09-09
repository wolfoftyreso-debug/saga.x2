import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { NextRequest, NextResponse } from "next/server";
import { getSagaAvatarProfile } from "@/lib/neon/saga-avatar-repository";
import { neonConfigurationResponse, requireNeonActor } from "@/lib/neon/http";
import {
  resolveSagaAvatarDirectUploadFile,
  sagaAvatarDirectUploadClientPayloadSchema,
  SagaAvatarDirectUploadError,
  verifySagaAvatarDirectUploadGrant,
} from "@/lib/services/saga-avatar-direct-upload";
import { sagaAvatarErrorResponse, sagaAvatarNoStoreHeaders } from "@/lib/services/saga-avatar-http";
import { isVercelBlobConfigured } from "@/lib/vercel/blob-media";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Issues a client token for exactly one already-signed private Blob pathname.
 * It deliberately has no `onUploadCompleted` callback: finalization happens
 * in a separately authenticated server route that verifies the stored bytes.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const resolved = await requireAvatarActor("Logga in för att ladda upp privata avatarreferenser.");
  if (resolved.response) return resolved.response;
  if (!isVercelBlobConfigured()) {
    return NextResponse.json(
      { error: "Vercel Blob saknas för privata avatarreferenser.", missing: ["BLOB_READ_WRITE_TOKEN"] },
      { status: 503, headers: sagaAvatarNoStoreHeaders },
    );
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Kunde inte läsa den privata uppladdningsbegäran." }, { status: 400, headers: sagaAvatarNoStoreHeaders });
  }
  try {
    const result = await handleUpload({
      body: body as HandleUploadBody,
      request,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        const client = parseClientPayload(clientPayload);
        const grant = verifySagaAvatarDirectUploadGrant(resolved.actor, client.grant);
        const profile = await getSagaAvatarProfile(resolved.actor, grant.profileId);
        if (!profile) throw new SagaAvatarDirectUploadError("Avatarprofilen hittades inte.", 403);
        const upload = resolveSagaAvatarDirectUploadFile(grant, client.uploadId, pathname);
        return {
          allowedContentTypes: [upload.contentType],
          maximumSizeInBytes: upload.byteSize,
          validUntil: grant.expiresAt,
          addRandomSuffix: false,
          allowOverwrite: false,
          cacheControlMaxAge: 0,
        };
      },
    });
    return NextResponse.json(result, { headers: sagaAvatarNoStoreHeaders });
  } catch (error) {
    return sagaAvatarErrorResponse(error, "Kunde inte ge säker uppladdningsbehörighet för den privata referensbilden.");
  }
}

function parseClientPayload(value: string | null) {
  if (!value) throw new SagaAvatarDirectUploadError("Den privata uppladdningsbehörigheten saknas. Välj bilderna igen.", 400);
  let payload: unknown;
  try {
    payload = JSON.parse(value);
  } catch {
    throw new SagaAvatarDirectUploadError("Den privata uppladdningsbehörigheten är ogiltig. Välj bilderna igen.", 400);
  }
  const parsed = sagaAvatarDirectUploadClientPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new SagaAvatarDirectUploadError("Den privata uppladdningsbehörigheten är ogiltig. Välj bilderna igen.", 400);
  }
  return parsed.data;
}

async function requireAvatarActor(message: string) {
  const configuration = neonConfigurationResponse("Privata avatarreferenser behöver Neon i Vercel.");
  if (configuration) return { response: configuration };
  return requireNeonActor(message);
}
