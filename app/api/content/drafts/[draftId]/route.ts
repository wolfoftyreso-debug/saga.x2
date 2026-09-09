import { NextRequest, NextResponse } from "next/server";
import {
  contentDraftCalendarMoveSchema,
  contentDraftIdSchema,
  contentDraftUpdateSchema,
} from "@/lib/domain/content-studio";
import { neonConfigurationResponse, neonWriteErrorResponse, requireNeonActor } from "@/lib/neon/http";
import { resolveSagaBrandActor, SagaBrandScopeError } from "@/lib/neon/saga-brand-api-eligibility";
import {
  deleteStudioDraft,
  getStudioDraft,
  rescheduleStudioDraft,
  updateStudioDraft,
} from "@/lib/neon/studio-content-repository";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ draftId: string }> };

export async function GET(_request: NextRequest, context: Context): Promise<NextResponse> {
  const resolved = await requireVercelNeonActor("Logga in för att läsa utkastet.", _request);
  if (resolved.response) return resolved.response;
  const id = contentDraftIdSchema.safeParse((await context.params).draftId);
  if (!id.success) return invalidDraftIdResponse();
  try {
    const draft = await getStudioDraft(resolved.actor, id.data);
    if (!draft) return missingDraftResponse();
    return NextResponse.json({ draft }, { headers: noStoreHeaders });
  } catch (error) {
    return neonWriteErrorResponse(error, "Kunde inte läsa utkastet.");
  }
}

/**
 * A calendar move is intentionally a narrow, revision-checked PATCH. The
 * broader full-document editor PATCH remains available and may carry an
 * expectedRevision for its own atomic write. A narrow schedule-only request
 * is always treated as a calendar move, so drag/drop cannot bypass its
 * conflict boundary.
 */
export async function PATCH(request: NextRequest, context: Context): Promise<NextResponse> {
  const resolved = await requireVercelNeonActor("Logga in för att ändra utkastet.", request);
  if (resolved.response) return resolved.response;
  const id = contentDraftIdSchema.safeParse((await context.params).draftId);
  if (!id.success) return invalidDraftIdResponse();
  const body = await readJson(request);
  if (body === null) return NextResponse.json({ error: "Skicka giltig JSON." }, { status: 400, headers: noStoreHeaders });
  if (hasWorkspaceField(body)) return invalidPatchResponse();

  if (isCalendarMoveRequest(body)) {
    const move = contentDraftCalendarMoveSchema.safeParse(body);
    if (!move.success) {
      return NextResponse.json(
        { error: "En kalenderflytt kräver exakt tidpunkt, lokalt datum, lokal tid, tidszon och aktuell revision." },
        { status: 422, headers: noStoreHeaders },
      );
    }
    try {
      const draft = await rescheduleStudioDraft(resolved.actor, id.data, move.data);
      if (!draft) return missingDraftResponse();
      return NextResponse.json({ draft }, { headers: noStoreHeaders });
    } catch (error) {
      return neonWriteErrorResponse(error, "Kunde inte flytta kalenderposten.");
    }
  }

  const payload = contentDraftUpdateSchema.safeParse(body);
  if (!payload.success) return invalidPatchResponse();
  try {
    const draft = await updateStudioDraft(resolved.actor, id.data, payload.data);
    if (!draft) return missingDraftResponse();
    return NextResponse.json({ draft }, { headers: noStoreHeaders });
  } catch (error) {
    return neonWriteErrorResponse(error, "Kunde inte uppdatera utkastet.");
  }
}

export async function DELETE(_request: NextRequest, context: Context): Promise<NextResponse> {
  const resolved = await requireVercelNeonActor("Logga in för att ta bort utkastet.", _request);
  if (resolved.response) return resolved.response;
  const id = contentDraftIdSchema.safeParse((await context.params).draftId);
  if (!id.success) return invalidDraftIdResponse();
  try {
    const deleted = await deleteStudioDraft(resolved.actor, id.data);
    if (!deleted) return missingDraftResponse();
    return NextResponse.json({ ok: true }, { headers: noStoreHeaders });
  } catch (error) {
    return neonWriteErrorResponse(error, "Kunde inte ta bort utkastet.");
  }
}

const noStoreHeaders = { "cache-control": "no-store" };
const calendarMoveFields = new Set([
  "scheduledAt",
  "scheduledLocalDate",
  "scheduledLocalTime",
  "timezone",
  "expectedRevision",
]);

async function requireVercelNeonActor(message: string, request: Request) {
  const configuration = neonConfigurationResponse("Studio behöver Neon i Vercel för att hantera utkast.");
  if (configuration) return { response: configuration };
  const resolved = await requireNeonActor(message);
  if (resolved.response) return resolved;
  const selected = new URL(request.url).searchParams.get("brandProfileId");
  if (selected === null) return resolved;
  try {
    return { actor: await resolveSagaBrandActor(resolved.actor, selected) };
  } catch (error) {
    return { response: NextResponse.json(
      error instanceof SagaBrandScopeError ? { error: error.message, code: error.code } : { error: "Varumärket kunde inte verifieras.", code: "brand_unavailable" },
      { status: error instanceof SagaBrandScopeError ? error.status : 503, headers: noStoreHeaders },
    ) };
  }
}

function isCalendarMoveRequest(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  // The dedicated drag/drop payload contains only schedule keys. A complete
  // editor document may also carry expectedRevision and stays on the ordinary
  // atomic update path, preserving its title/body changes.
  return keys.some((key) => calendarMoveFields.has(key))
    && keys.every((key) => calendarMoveFields.has(key));
}

function hasWorkspaceField(value: unknown, depth = 0): boolean {
  if (depth > 8 || !value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((entry) => hasWorkspaceField(entry, depth + 1));
  return Object.entries(value).some(([key, nested]) => (
    key === "workspaceId" || key === "workspace_id" || hasWorkspaceField(nested, depth + 1)
  ));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function invalidDraftIdResponse(): NextResponse {
  return NextResponse.json({ error: "Ogiltigt utkast-id." }, { status: 400, headers: noStoreHeaders });
}

function missingDraftResponse(): NextResponse {
  return NextResponse.json({ error: "Utkastet hittades inte." }, { status: 404, headers: noStoreHeaders });
}

function invalidPatchResponse(): NextResponse {
  return NextResponse.json({ error: "Utkastet innehåller ett ogiltigt värde." }, { status: 422, headers: noStoreHeaders });
}

async function readJson(request: NextRequest): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
