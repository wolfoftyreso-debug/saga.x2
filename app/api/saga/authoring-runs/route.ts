import { NextRequest, NextResponse } from "next/server";
import { sagaAdobeAuthoringRunCreateSchema } from "@/lib/domain/saga-adobe-authoring";
import {
  createSagaAdobeAuthoringRun,
  listSagaAdobeAuthoringRuns,
} from "@/lib/neon/saga-adobe-authoring-repository";
import {
  containsSagaAdobeAuthoringForbiddenSelector,
  readSagaAdobeAuthoringJson,
  requireSagaAdobeAuthoringActor,
  sagaAdobeAuthoringErrorResponse,
  sagaAdobeAuthoringResponse,
} from "@/lib/services/saga-adobe-authoring-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Lists private authoring runs only in the signed actor's workspace. */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const resolved = await requireSagaAdobeAuthoringActor("Logga in för att öppna Författarstudio.", request);
  if (resolved.response) return resolved.response;
  try {
    return sagaAdobeAuthoringResponse({ runs: await listSagaAdobeAuthoringRuns(resolved.actor) });
  } catch (error) {
    return sagaAdobeAuthoringErrorResponse(error, "Kunde inte läsa författarkörningarna.");
  }
}

/** Captures server-owned snapshots but does not call AI or create a Studio draft. */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const resolved = await requireSagaAdobeAuthoringActor("Logga in för att skapa en privat författarkörning.", request);
  if (resolved.response) return resolved.response;
  const body = await readSagaAdobeAuthoringJson(request);
  if (body === null || containsSagaAdobeAuthoringForbiddenSelector(body)) return invalidRequest();
  const parsed = sagaAdobeAuthoringRunCreateSchema.safeParse(body);
  if (!parsed.success) return invalidRequest();
  try {
    const created = await createSagaAdobeAuthoringRun(resolved.actor, parsed.data);
    return sagaAdobeAuthoringResponse({ run: created.run, reused: created.reused, noPublication: true }, created.reused ? 200 : 201);
  } catch (error) {
    return sagaAdobeAuthoringErrorResponse(error, "Kunde inte fånga referensen för författarkörningen.");
  }
}

function invalidRequest(): NextResponse {
  return sagaAdobeAuthoringResponse({
    error: "Skicka en giltig idempotensnyckel, ett sparat referensutkast med aktuell revision, mål, skrivinstruktion, 1–10 kandidater och valfria kunskaps-ID:n. Skicka inte namn, arbetsyta, referenstext, URL, schema eller publicering.",
    code: "invalid_authoring_run_request",
  }, 422);
}
