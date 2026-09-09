import { NextRequest, NextResponse } from "next/server";
import {
  sagaSeriesReferenceCreateSchema,
  sagaSeriesReferenceDeleteSchema,
  sagaSeriesReferencePatchSchema,
} from "@/lib/domain/saga-series-reference";
import {
  createSagaSeriesReference,
  deleteSagaSeriesReference,
  listSagaSeriesReferences,
  patchSagaSeriesReference,
} from "@/lib/neon/saga-series-reference-repository";
import {
  containsSagaSeriesReferenceWorkspaceId,
  readSagaSeriesReferenceJson,
  requireSagaSeriesReferenceActor,
  sagaSeriesReferenceErrorResponse,
  sagaSeriesReferenceNoStore,
} from "@/lib/services/saga-series-reference-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Lists only series captured in the signed user's current workspace. */
export async function GET(): Promise<NextResponse> {
  const resolved = await requireSagaSeriesReferenceActor("Logga in för att öppna SAGA-serier.");
  if (resolved.response) return resolved.response;
  try {
    return sagaSeriesReferenceNoStore({ series: await listSagaSeriesReferences(resolved.actor) });
  } catch (error) {
    return sagaSeriesReferenceErrorResponse(error, "Kunde inte läsa SAGA-serierna.");
  }
}

/** Creates revision 1 by snapshotting an existing, actor-scoped Studio draft on the server. */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const resolved = await requireSagaSeriesReferenceActor("Logga in för att skapa en SAGA-serie.");
  if (resolved.response) return resolved.response;
  const body = await readSagaSeriesReferenceJson(request);
  if (body === null || containsSagaSeriesReferenceWorkspaceId(body)) return invalidSeriesRequest();
  const payload = sagaSeriesReferenceCreateSchema.safeParse(body);
  if (!payload.success) return invalidSeriesRequest();
  try {
    return sagaSeriesReferenceNoStore({ series: await createSagaSeriesReference(resolved.actor, payload.data) }, 201);
  } catch (error) {
    return sagaSeriesReferenceErrorResponse(error, "Kunde inte skapa SAGA-serien.");
  }
}

/** Every edit requires the last observed revision and writes a new immutable reference revision. */
export async function PATCH(request: NextRequest): Promise<NextResponse> {
  const resolved = await requireSagaSeriesReferenceActor("Logga in för att ändra en SAGA-serie.");
  if (resolved.response) return resolved.response;
  const body = await readSagaSeriesReferenceJson(request);
  if (body === null || containsSagaSeriesReferenceWorkspaceId(body)) return invalidSeriesRequest();
  const payload = sagaSeriesReferencePatchSchema.safeParse(body);
  if (!payload.success) return invalidSeriesRequest();
  try {
    return sagaSeriesReferenceNoStore({ series: await patchSagaSeriesReference(resolved.actor, payload.data) });
  } catch (error) {
    return sagaSeriesReferenceErrorResponse(error, "Kunde inte uppdatera SAGA-serien.");
  }
}

/** Deletes only the exact revision the caller last read; a stale delete returns a conflict. */
export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const resolved = await requireSagaSeriesReferenceActor("Logga in för att ta bort en SAGA-serie.");
  if (resolved.response) return resolved.response;
  const body = await readSagaSeriesReferenceJson(request);
  if (body === null || containsSagaSeriesReferenceWorkspaceId(body)) return invalidSeriesRequest();
  const payload = sagaSeriesReferenceDeleteSchema.safeParse(body);
  if (!payload.success) return invalidSeriesRequest();
  try {
    await deleteSagaSeriesReference(resolved.actor, payload.data);
    return sagaSeriesReferenceNoStore({ deleted: { id: payload.data.id } });
  } catch (error) {
    return sagaSeriesReferenceErrorResponse(error, "Kunde inte ta bort SAGA-serien.");
  }
}

function invalidSeriesRequest(): NextResponse {
  return sagaSeriesReferenceNoStore({
    error: "Skicka en giltig SAGA-seriebegäran utan workspaceId och med expectedRevision för ändring eller borttagning.",
    code: "invalid_series_request",
  }, 422);
}
