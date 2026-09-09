import { NextRequest, NextResponse } from "next/server";
import { sagaOutgoingApiCreateSchema } from "@/lib/domain/saga-outgoing-api";
import { createSagaOutgoingApi, listSagaOutgoingApis } from "@/lib/neon/saga-outgoing-api-repository";
import {
  containsSagaOutgoingApiForbiddenSelector,
  readSagaOutgoingApiJson,
  requireSagaOutgoingApiOwner,
  sagaOutgoingApiErrorResponse,
  sagaOutgoingApiResponse,
} from "@/lib/services/saga-outgoing-api-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Owner-only configuration list. Secrets and hashes are never returned here. */
export async function GET(): Promise<NextResponse> {
  const resolved = await requireSagaOutgoingApiOwner("Logga in som arbetsytans ägare för att öppna API-utgåvor.");
  if (resolved.response) return resolved.response;
  try {
    return sagaOutgoingApiResponse({ exports: await listSagaOutgoingApis(resolved.actor) });
  } catch (error) {
    return sagaOutgoingApiErrorResponse(error, "Kunde inte läsa API-utgåvorna.");
  }
}

/** Creates one outgoing API and returns its opaque bearer secret exactly once. */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const resolved = await requireSagaOutgoingApiOwner("Logga in som arbetsytans ägare för att skapa en API-utgåva.");
  if (resolved.response) return resolved.response;
  const body = await readSagaOutgoingApiJson(request);
  if (body === null || containsSagaOutgoingApiForbiddenSelector(body)) return invalidRequest();
  const payload = sagaOutgoingApiCreateSchema.safeParse(body);
  if (!payload.success) return invalidRequest();
  try {
    const created = await createSagaOutgoingApi(resolved.actor, payload.data);
    return sagaOutgoingApiResponse({
      export: created.export,
      secret: created.secret,
      endpoint: "/api/saga/outgoing-content",
    }, 201);
  } catch (error) {
    return sagaOutgoingApiErrorResponse(error, "Kunde inte skapa API-utgåvan.");
  }
}

function invalidRequest(): NextResponse {
  return sagaOutgoingApiResponse({
    error: "Skicka bara namn, innehållstyp, synlighet och ett valfritt slutdatum. Arbetsyta och hemlighet väljs alltid av SAGA.",
    code: "invalid_outgoing_api_request",
  }, 422);
}
