import { NextRequest, NextResponse } from "next/server";
import { sagaAvatarProfileIdSchema, sagaAvatarReferenceAngleSchema } from "@/lib/domain/saga-avatar";
import { neonConfigurationResponse, requireNeonActor } from "@/lib/neon/http";
import {
  createSagaAvatarReferenceMetadata,
  getSagaAvatarProfile,
  SagaAvatarValidationError,
} from "@/lib/neon/saga-avatar-repository";
import { sagaAvatarErrorResponse, sagaAvatarNoStoreHeaders } from "@/lib/services/saga-avatar-http";
import {
  type AvatarReferenceBlobContentType,
  deleteAvatarReferenceBlob,
  uploadAvatarReferenceBlob,
} from "@/lib/vercel/avatar-reference-blob";
import { isVercelBlobConfigured } from "@/lib/vercel/blob-media";
import { assertAvatarReferenceImageBytes } from "@/lib/vercel/avatar-reference-image-validation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

type Context = { params: Promise<{ profileId: string }> };

/**
 * Stores three to six private reference photographs over one or more uploads.
 * The request is authenticated before any Blob object exists, and a second
 * explicit upload-consent field prevents accidental multipart submissions.
 */
export async function POST(request: NextRequest, context: Context): Promise<NextResponse> {
  const resolved = await requireAvatarActor("Logga in för att ladda upp privata avatarreferenser.");
  if (resolved.response) return resolved.response;
  if (!isVercelBlobConfigured()) {
    return NextResponse.json(
      { error: "Vercel Blob saknas för privata avatarreferenser.", missing: ["BLOB_READ_WRITE_TOKEN"] },
      { status: 503, headers: sagaAvatarNoStoreHeaders },
    );
  }
  const profileId = sagaAvatarProfileIdSchema.safeParse((await context.params).profileId);
  if (!profileId.success) return NextResponse.json({ error: "Ogiltigt profil-id." }, { status: 400, headers: sagaAvatarNoStoreHeaders });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Kunde inte läsa referensbilderna." }, { status: 400, headers: sagaAvatarNoStoreHeaders });
  }
  if (form.get("uploadConsent") !== "true") {
    return NextResponse.json(
      { error: "Bekräfta att du har rätt att använda de privata referensbilderna." },
      { status: 422, headers: sagaAvatarNoStoreHeaders },
    );
  }
  const files = form.getAll("files");
  const parsedFiles = files.filter((entry): entry is File => entry instanceof File);
  if (parsedFiles.length !== files.length || parsedFiles.length < 1 || parsedFiles.length > 6) {
    return NextResponse.json({ error: "Välj mellan en och sex JPG-, PNG- eller WebP-bilder." }, { status: 422, headers: sagaAvatarNoStoreHeaders });
  }
  const angles = parseAngles(form.get("angles"), parsedFiles.length);
  if (!angles) {
    return NextResponse.json({ error: "Varje referensbild måste ha en giltig vinkel." }, { status: 422, headers: sagaAvatarNoStoreHeaders });
  }

  try {
    // This actor-scoped lookup happens before Blob receives any personal data.
    const profile = await getSagaAvatarProfile(resolved.actor, profileId.data);
    if (!profile) return NextResponse.json({ error: "Avatarprofilen hittades inte." }, { status: 404, headers: sagaAvatarNoStoreHeaders });
    assertCapacity(profile.referenceCount, parsedFiles.length);

    const uploads = [] as Awaited<ReturnType<typeof uploadAvatarReferenceBlob>>[];
    try {
      for (const file of parsedFiles) {
        const contentType = supportedImageContentType(file.type);
        if (!contentType) {
          throw new SagaAvatarValidationError("Välj en JPG-, PNG- eller WebP-bild.");
        }
        const bytes = new Uint8Array(await file.arrayBuffer());
        // Validate browser-provided MIME claims before the Blob helper gets
        // called; the helper validates again at the storage boundary.
        assertAvatarReferenceImageBytes(bytes, contentType);
        uploads.push(await uploadAvatarReferenceBlob({
          scope: { workspaceId: resolved.actor.workspaceId, profileId: profileId.data },
          bytes,
          // Filename is intentionally discarded inside the Blob helper.
          fileName: file.name,
          contentType,
        }));
      }
      const saved = await createSagaAvatarReferenceMetadata(resolved.actor, {
        profileId: profileId.data,
        references: uploads.map((upload, index) => ({
          angle: angles[index],
          blobUrl: upload.url,
          blobPathname: upload.pathname,
          contentType: upload.contentType,
          byteSize: upload.size,
        })),
      });
      return NextResponse.json({ profile: saved }, { status: 201, headers: sagaAvatarNoStoreHeaders });
    } catch (error) {
      // When metadata has not committed, delete every generated Blob path. If
      // cleanup fails, the object is still private and unreferenced; the route
      // never returns a URL that could make it reachable from Studio.
      await Promise.all(uploads.map((upload) => deleteAvatarReferenceBlob({
        scope: { workspaceId: resolved.actor.workspaceId, profileId: profileId.data },
        pathname: upload.pathname,
      }).catch(() => undefined)));
      throw error;
    }
  } catch (error) {
    return sagaAvatarErrorResponse(error, "Kunde inte spara privata avatarreferenser.");
  }
}

function parseAngles(value: FormDataEntryValue | null, expectedLength: number) {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== expectedLength) return null;
    const values = parsed.map((angle) => sagaAvatarReferenceAngleSchema.safeParse(angle));
    return values.every((entry) => entry.success)
      ? values.map((entry) => entry.data)
      : null;
  } catch {
    return null;
  }
}

function assertCapacity(existing: number, incoming: number): void {
  if (existing + incoming > 6) {
    throw new SagaAvatarValidationError("En privat avatarprofil kan innehålla högst sex referensbilder.");
  }
  if (existing === 0 && incoming < 3) {
    throw new SagaAvatarValidationError("Lägg in tre till sex referensbilder första gången.");
  }
  if (existing > 0 && existing < 3 && existing + incoming < 3) {
    throw new SagaAvatarValidationError("Lägg in tillräckligt många referensbilder för att nå minst tre bilder.");
  }
}

function supportedImageContentType(value: string): AvatarReferenceBlobContentType | null {
  const contentType = typeof value === "string" ? value.trim().toLowerCase() : "";
  return contentType === "image/jpeg" || contentType === "image/png" || contentType === "image/webp"
    ? contentType
    : null;
}

async function requireAvatarActor(message: string) {
  const configuration = neonConfigurationResponse("Privata avatarreferenser behöver Neon i Vercel.");
  if (configuration) return { response: configuration };
  return requireNeonActor(message);
}
