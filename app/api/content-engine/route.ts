import { NextRequest, NextResponse } from "next/server";
import {
  contentEngineDeleteRequestSchema,
  contentEngineMutationRequestSchema,
  contentEnginePatchRequestSchema,
} from "@/lib/domain/content-engine";
import { requireNeonActor } from "@/lib/neon/http";
import {
  ContentEngineAccessError,
  ContentEngineConflictError,
  ContentEngineNotFoundError,
  ContentEngineReferenceError,
  deleteContentEngineEntity,
  patchContentEngineEntity,
  readContentEngineWorkspace,
  upsertContentEngineEntity,
} from "@/lib/neon/content-engine-repository";
import { isNeonDatabaseConfigured, missingNeonConfiguration } from "@/lib/neon/config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const noStoreHeaders = { "cache-control": "no-store" };

/**
 * Private Content Engine control plane. Workspace identity is derived only
 * from the signed Vercel session — the request contract deliberately has no
 * `workspaceId` field.
 */
export async function GET() {
  const resolved = await resolveActor("Logga in för att öppna Content Engine.");
  if (resolved.response) return resolved.response;
  try {
    return NextResponse.json({ data: await readContentEngineWorkspace(resolved.actor) }, { headers: noStoreHeaders });
  } catch (error) {
    return contentEngineErrorResponse(error, "Kunde inte läsa Content Engine.");
  }
}

/** Idempotent creation uses the entity's workspace-local slug as retry key. */
export async function POST(request: NextRequest) {
  const resolved = await resolveActor("Logga in för att skapa i Content Engine.");
  if (resolved.response) return resolved.response;
  const body = await readJson(request);
  if (body === null || hasWorkspaceField(body)) return invalidBodyResponse();
  const payload = contentEngineMutationRequestSchema.safeParse(body);
  if (!payload.success) return invalidBodyResponse();
  // A canonical brand is more than a voice profile: it needs an annual plan,
  // a budget scenario and a completion gate. Existing profiles remain editable
  // through PATCH below, but creation cannot bypass that onboarding boundary.
  if (payload.data.entity === "brandProfile") {
    return NextResponse.json({
      error: "Nya varumärken skapas i Varumärkes-onboarding så att identitet, årsplan och budgetscenario blir en säker helhet.",
      code: "brand_onboarding_required",
      path: "/api/saga/brand-onboarding",
    }, { status: 422, headers: noStoreHeaders });
  }
  try {
    const data = await upsertContentEngineEntity(resolved.actor, payload.data);
    return NextResponse.json({ entity: payload.data.entity, data }, { status: 201, headers: noStoreHeaders });
  } catch (error) {
    return contentEngineErrorResponse(error, "Kunde inte spara Content Engine-resursen.");
  }
}

/** Full replacement edit for one exact actor-owned resource. */
export async function PATCH(request: NextRequest) {
  const resolved = await resolveActor("Logga in för att ändra Content Engine.");
  if (resolved.response) return resolved.response;
  const body = await readJson(request);
  if (body === null || hasWorkspaceField(body)) return invalidBodyResponse();
  const payload = contentEnginePatchRequestSchema.safeParse(body);
  if (!payload.success) return invalidBodyResponse();
  try {
    const data = await patchContentEngineEntity(resolved.actor, payload.data);
    return NextResponse.json({ entity: payload.data.entity, data }, { headers: noStoreHeaders });
  } catch (error) {
    return contentEngineErrorResponse(error, "Kunde inte uppdatera Content Engine-resursen.");
  }
}

/** Delete remains blocked by Neon FK constraints when a resource is in use. */
export async function DELETE(request: NextRequest) {
  const resolved = await resolveActor("Logga in för att ta bort från Content Engine.");
  if (resolved.response) return resolved.response;
  const body = await readJson(request);
  if (body === null || hasWorkspaceField(body)) return invalidBodyResponse();
  const payload = contentEngineDeleteRequestSchema.safeParse(body);
  if (!payload.success) return invalidBodyResponse();
  try {
    const deleted = await deleteContentEngineEntity(resolved.actor, payload.data);
    if (!deleted) return NextResponse.json({ error: "Resursen hittades inte i arbetsytan." }, { status: 404, headers: noStoreHeaders });
    return NextResponse.json({ entity: payload.data.entity, id: payload.data.id, deleted: true }, { headers: noStoreHeaders });
  } catch (error) {
    return contentEngineErrorResponse(error, "Kunde inte ta bort Content Engine-resursen.");
  }
}

async function resolveActor(message: string) {
  if (!isNeonDatabaseConfigured()) {
    return {
      response: NextResponse.json({
        error: "Content Engine behöver en Vercel-ansluten Neon-databas.",
        code: "configuration_required",
        missing: missingNeonConfiguration(),
      }, { status: 503, headers: noStoreHeaders }),
    };
  }
  return requireNeonActor(message);
}

function contentEngineErrorResponse(error: unknown, fallback: string): NextResponse {
  if (error instanceof ContentEngineAccessError) return NextResponse.json({ error: error.message }, { status: 403, headers: noStoreHeaders });
  if (error instanceof ContentEngineNotFoundError) return NextResponse.json({ error: error.message }, { status: 404, headers: noStoreHeaders });
  if (error instanceof ContentEngineReferenceError || error instanceof ContentEngineConflictError) {
    return NextResponse.json({ error: error.message }, { status: 409, headers: noStoreHeaders });
  }
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (code === "23503" || code === "23505") {
      return NextResponse.json({ error: "Resursen krockar med eller refererar till data utanför arbetsytan." }, { status: 409, headers: noStoreHeaders });
    }
  }
  return NextResponse.json({ error: error instanceof Error ? error.message : fallback }, { status: 500, headers: noStoreHeaders });
}

function invalidBodyResponse(): NextResponse {
  return NextResponse.json({ error: "Skicka en giltig Content Engine-begäran utan workspaceId." }, { status: 422, headers: noStoreHeaders });
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
