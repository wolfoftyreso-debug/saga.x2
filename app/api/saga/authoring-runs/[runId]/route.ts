import { NextRequest, NextResponse } from "next/server";
import { getSagaAdobeAuthoringRun } from "@/lib/neon/saga-adobe-authoring-repository";
import {
  requireSagaAdobeAuthoringActor,
  sagaAdobeAuthoringErrorResponse,
  sagaAdobeAuthoringResponse,
} from "@/lib/services/saga-adobe-authoring-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ runId: string }> };

export async function GET(_request: NextRequest, context: Context): Promise<NextResponse> {
  const resolved = await requireSagaAdobeAuthoringActor("Logga in för att öppna författarkörningen.", _request);
  if (resolved.response) return resolved.response;
  try {
    const run = await getSagaAdobeAuthoringRun(resolved.actor, (await context.params).runId);
    return run
      ? sagaAdobeAuthoringResponse({ run })
      : sagaAdobeAuthoringResponse({ error: "Författarkörningen hittades inte i den här arbetsytan.", code: "not_found" }, 404);
  } catch (error) {
    return sagaAdobeAuthoringErrorResponse(error, "Kunde inte läsa författarkörningen.");
  }
}
