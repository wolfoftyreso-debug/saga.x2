import { NextRequest, NextResponse } from "next/server";
import { sagaEditorialLensInputSchema } from "@/lib/domain/saga-editorial-lens";
import { requireNeonActor, type NeonActorResolution } from "@/lib/neon/http";
import {
  resolveSagaBrandActor,
  SagaBrandScopeError,
} from "@/lib/neon/saga-brand-api-eligibility";
import {
  deleteSagaEditorialLens,
  getSagaEditorialLens,
  SagaEditorialLensAccessError,
  SagaEditorialLensConflictError,
  SagaEditorialLensReferenceError,
  upsertSagaEditorialLens,
} from "@/lib/neon/saga-editorial-lens-repository";
import { isNeonDatabaseConfigured, missingNeonConfiguration } from "@/lib/neon/config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const noStoreHeaders = { "cache-control": "no-store" };

/**
 * One private Editorial Lens per workspace. The signed session determines
 * workspace identity; request bodies cannot select another tenant.
 */
export async function GET(request?: NextRequest) {
  const resolved = await resolveActor("Logga in för att öppna SAGA Editorial Lens.", request);
  if (resolved.response) return resolved.response;
  try {
    return NextResponse.json({ data: await getSagaEditorialLens(resolved.actor) }, { headers: noStoreHeaders });
  } catch (error) {
    return sagaEditorialLensErrorResponse(error, "Kunde inte läsa SAGA Editorial Lens.");
  }
}

/** Idempotent full replacement of the single workspace doctrine. */
export async function PUT(request: NextRequest) {
  return saveLens(request, "Logga in för att spara SAGA Editorial Lens.");
}

/** PATCH intentionally uses the same full-document contract as PUT. */
export async function PATCH(request: NextRequest) {
  return saveLens(request, "Logga in för att ändra SAGA Editorial Lens.");
}

/** Owner-only reset. A later save can recreate the Lens with the same endpoint. */
export async function DELETE(request?: NextRequest) {
  const resolved = await resolveActor("Logga in för att återställa SAGA Editorial Lens.", request);
  if (resolved.response) return resolved.response;
  try {
    const deleted = await deleteSagaEditorialLens(resolved.actor);
    return NextResponse.json({ deleted }, { headers: noStoreHeaders });
  } catch (error) {
    return sagaEditorialLensErrorResponse(error, "Kunde inte återställa SAGA Editorial Lens.");
  }
}

async function saveLens(request: NextRequest, authenticationMessage: string): Promise<NextResponse> {
  const resolved = await resolveActor(authenticationMessage, request);
  if (resolved.response) return resolved.response;
  const body = await readJson(request);
  if (body === null || hasWorkspaceField(body)) return invalidBodyResponse();
  const payload = sagaEditorialLensInputSchema.safeParse(body);
  if (!payload.success) return invalidBodyResponse();
  try {
    return NextResponse.json(
      { data: await upsertSagaEditorialLens(resolved.actor, payload.data) },
      { headers: noStoreHeaders },
    );
  } catch (error) {
    return sagaEditorialLensErrorResponse(error, "Kunde inte spara SAGA Editorial Lens.");
  }
}

async function resolveActor(message: string, request?: Request): Promise<NeonActorResolution> {
  if (!isNeonDatabaseConfigured()) {
    return {
      response: NextResponse.json({
        error: "SAGA Editorial Lens behöver en Vercel-ansluten Neon-databas.",
        code: "configuration_required",
        missing: missingNeonConfiguration(),
      }, { status: 503, headers: noStoreHeaders }),
    };
  }
  const resolved = await requireNeonActor(message);
  if (resolved.response) return resolved;
  try {
    return { actor: await resolveSagaBrandActor(resolved.actor, request ? new URL(request.url).searchParams.get("brandProfileId") : null) };
  } catch (error) {
    return { response: error instanceof SagaBrandScopeError
      ? NextResponse.json({ error: error.message, code: error.code }, { status: error.status, headers: noStoreHeaders })
      : NextResponse.json({ error: "Varumärket kunde inte verifieras.", code: "brand_unavailable" }, { status: 503, headers: noStoreHeaders }) };
  }
}

function sagaEditorialLensErrorResponse(error: unknown, fallback: string): NextResponse {
  if (error instanceof SagaEditorialLensAccessError) {
    return NextResponse.json({ error: error.message }, { status: 403, headers: noStoreHeaders });
  }
  if (error instanceof SagaEditorialLensReferenceError || error instanceof SagaEditorialLensConflictError) {
    return NextResponse.json({ error: error.message }, { status: 409, headers: noStoreHeaders });
  }
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (code === "23503" || code === "23505" || code === "P0001") {
      return NextResponse.json({ error: "Lens-konfigurationen refererar till data som inte längre är giltig i arbetsytan." }, { status: 409, headers: noStoreHeaders });
    }
  }
  return NextResponse.json({ error: error instanceof Error ? error.message : fallback }, { status: 500, headers: noStoreHeaders });
}

function invalidBodyResponse(): NextResponse {
  return NextResponse.json({
    error: "Skicka en giltig komplett Lens-konfiguration utan workspaceId.",
  }, { status: 422, headers: noStoreHeaders });
}

function hasWorkspaceField(value: unknown, depth = 0): boolean {
  if (depth > 8 || !value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((entry) => hasWorkspaceField(entry, depth + 1));
  return Object.entries(value).some(([key, nested]) => (
    key === "workspaceId" || key === "workspace_id" || hasWorkspaceField(nested, depth + 1)
  ));
}

async function readJson(request: NextRequest): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
