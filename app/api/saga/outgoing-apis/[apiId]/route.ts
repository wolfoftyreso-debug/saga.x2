import { NextRequest, NextResponse } from "next/server";
import { sagaOutgoingApiIdSchema, sagaOutgoingApiUpdateSchema } from "@/lib/domain/saga-outgoing-api";
import { revokeSagaOutgoingApi, updateSagaOutgoingApi } from "@/lib/neon/saga-outgoing-api-repository";
import {
  containsSagaOutgoingApiForbiddenSelector,
  readSagaOutgoingApiJson,
  requireSagaOutgoingApiOwner,
  sagaOutgoingApiErrorResponse,
  sagaOutgoingApiResponse,
} from "@/lib/services/saga-outgoing-api-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ apiId: string }> };

/** Owner-only optimistic update. `expectedRevision` is required. */
export async function PATCH(request: NextRequest, context: Context): Promise<NextResponse> {
  const resolved = await requireSagaOutgoingApiOwner("Logga in som arbetsytans ägare för att ändra en API-utgåva.");
  if (resolved.response) return resolved.response;
  const id = sagaOutgoingApiIdSchema.safeParse((await context.params).apiId);
  if (!id.success) return invalidId();
  const body = await readSagaOutgoingApiJson(request);
  if (body === null || containsSagaOutgoingApiForbiddenSelector(body)) return invalidRequest();
  const payload = sagaOutgoingApiUpdateSchema.safeParse(body);
  if (!payload.success) return invalidRequest();
  try {
    return sagaOutgoingApiResponse({ export: await updateSagaOutgoingApi(resolved.actor, id.data, payload.data) });
  } catch (error) {
    return sagaOutgoingApiErrorResponse(error, "Kunde inte uppdatera API-utgåvan.");
  }
}

/** DELETE is a revoke, not a destructive deletion; any leaked secret stops at once. */
export async function DELETE(_request: NextRequest, context: Context): Promise<NextResponse> {
  const resolved = await requireSagaOutgoingApiOwner("Logga in som arbetsytans ägare för att återkalla en API-utgåva.");
  if (resolved.response) return resolved.response;
  const id = sagaOutgoingApiIdSchema.safeParse((await context.params).apiId);
  if (!id.success) return invalidId();
  try {
    return sagaOutgoingApiResponse({ export: await revokeSagaOutgoingApi(resolved.actor, id.data) });
  } catch (error) {
    return sagaOutgoingApiErrorResponse(error, "Kunde inte återkalla API-utgåvan.");
  }
}

function invalidId(): NextResponse {
  return sagaOutgoingApiResponse({ error: "Ogiltigt API-utgåve-id.", code: "invalid_outgoing_api_id" }, 400);
}

function invalidRequest(): NextResponse {
  return sagaOutgoingApiResponse({
    error: "Ändringen kräver aktuell revision och bara giltiga API-utgåvefält.",
    code: "invalid_outgoing_api_request",
  }, 422);
}
