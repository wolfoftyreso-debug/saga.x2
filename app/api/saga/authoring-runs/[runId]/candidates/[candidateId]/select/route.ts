import { NextRequest, NextResponse } from "next/server";
import { sagaAdobeAuthoringCandidateSelectSchema } from "@/lib/domain/saga-adobe-authoring";
import { selectSagaAdobeAuthoringCandidate } from "@/lib/neon/saga-adobe-authoring-repository";
import {
  containsSagaAdobeAuthoringForbiddenSelector,
  readSagaAdobeAuthoringJson,
  requireSagaAdobeAuthoringActor,
  sagaAdobeAuthoringErrorResponse,
  sagaAdobeAuthoringResponse,
} from "@/lib/services/saga-adobe-authoring-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ runId: string; candidateId: string }> };

/** Explicit human choice: atomically creates exactly one editable private Studio `in_review` draft. */
export async function POST(request: NextRequest, context: Context): Promise<NextResponse> {
  const resolved = await requireSagaAdobeAuthoringActor("Logga in för att välja en privat kandidat.", request);
  if (resolved.response) return resolved.response;
  const body = await readSagaAdobeAuthoringJson(request);
  if (body === null || containsSagaAdobeAuthoringForbiddenSelector(body)) return invalidRequest();
  const parsed = sagaAdobeAuthoringCandidateSelectSchema.safeParse(body);
  if (!parsed.success) return invalidRequest();
  const params = await context.params;
  try {
    const selected = await selectSagaAdobeAuthoringCandidate(resolved.actor, params.runId, params.candidateId, parsed.data);
    return sagaAdobeAuthoringResponse({
      run: selected.run,
      selectedDraft: {
        id: selected.draftId,
        href: `/studio/content/${encodeURIComponent(selected.draftId)}?edit=1`,
        status: "in_review",
        scheduledAt: null,
      },
      reused: selected.reused,
      noPublication: true,
    });
  } catch (error) {
    return sagaAdobeAuthoringErrorResponse(error, "Kunde inte välja den privata kandidaten.");
  }
}

function invalidRequest(): NextResponse {
  return sagaAdobeAuthoringResponse({
    error: "Skicka idempotensnyckel samt aktuell körnings- och kandidatrevision. Valet kan inte ändra kanaler, schema eller publicering.",
    code: "invalid_authoring_selection_request",
  }, 422);
}
