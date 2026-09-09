import { NextRequest, NextResponse } from "next/server";
import { sagaPersonaContextInputSchema } from "@/lib/domain/saga-persona-context";
import {
  deleteSagaPersonaContext,
  getSagaPersonaContext,
  replaceSagaPersonaContext,
} from "@/lib/neon/saga-persona-context-repository";
import {
  containsSagaPersonaScopeSelector,
  readSagaPersonaContextJson,
  requireSagaPersonaContextActor,
  sagaPersonaContextErrorResponse,
  sagaPersonaContextResponse,
} from "@/lib/services/saga-persona-context-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The owner can read only their own private persona record. */
export async function GET(): Promise<NextResponse> {
  const resolved = await requireSagaPersonaContextActor("Logga in som arbetsytans ägare för att öppna din privata personakontext.");
  if (resolved.response) return resolved.response;
  try {
    return sagaPersonaContextResponse({ context: await getSagaPersonaContext(resolved.actor) });
  } catch (error) {
    return sagaPersonaContextErrorResponse(error, "Kunde inte läsa din privata personakontext.");
  }
}

/** Full owner-only replacement. The request never selects a workspace or user. */
export async function PUT(request: NextRequest): Promise<NextResponse> {
  const resolved = await requireSagaPersonaContextActor("Logga in som arbetsytans ägare för att spara din privata personakontext.");
  if (resolved.response) return resolved.response;
  const body = await readSagaPersonaContextJson(request);
  if (body === null || containsSagaPersonaScopeSelector(body)) return invalidPersonaRequest();
  const payload = sagaPersonaContextInputSchema.safeParse(body);
  if (!payload.success) return invalidPersonaRequest();
  try {
    return sagaPersonaContextResponse({ context: await replaceSagaPersonaContext(resolved.actor, payload.data) });
  } catch (error) {
    return sagaPersonaContextErrorResponse(error, "Kunde inte spara din privata personakontext.");
  }
}

/** Explicit owner-only erasure; database cascade removes the immutable history too. */
export async function DELETE(): Promise<NextResponse> {
  const resolved = await requireSagaPersonaContextActor("Logga in som arbetsytans ägare för att radera din privata personakontext.");
  if (resolved.response) return resolved.response;
  try {
    return sagaPersonaContextResponse({ deleted: await deleteSagaPersonaContext(resolved.actor) });
  } catch (error) {
    return sagaPersonaContextErrorResponse(error, "Kunde inte radera din privata personakontext.");
  }
}

function invalidPersonaRequest(): NextResponse {
  return sagaPersonaContextResponse({
    error: "Skicka bara giltiga, frivilliga profilfält. Arbetsyta och användare väljs alltid från din inloggning.",
    code: "invalid_persona_request",
  }, 422);
}
