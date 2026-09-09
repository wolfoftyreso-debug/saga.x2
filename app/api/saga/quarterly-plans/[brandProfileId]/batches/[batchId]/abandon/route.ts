import { NextRequest, NextResponse } from "next/server";
import { sagaQuarterlyBatchAbandonSchema } from "@/lib/domain/saga-quarterly-planning";
import { abandonFailedSagaQuarterlyActivityPlanBatch } from "@/lib/neon/saga-quarterly-planning-repository";
import {
  containsSagaQuarterlyPlanningForbiddenSelector,
  readSagaQuarterlyPlanningJson,
  requireSagaQuarterlyPlanningActor,
  sagaQuarterlyPlanningErrorResponse,
  sagaQuarterlyPlanningResponse,
} from "@/lib/services/saga-quarterly-planning-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ brandProfileId: string; batchId: string }> };

/**
 * Explicit escape hatch after retry budget exhaustion. It only makes the
 * failed batch terminal/stale; existing private drafts remain auditable and
 * nothing is scheduled, sent, or published.
 */
export async function POST(request: NextRequest, context: Context): Promise<NextResponse> {
  const resolved = await requireSagaQuarterlyPlanningActor("Logga in för att avsluta den misslyckade batchen.");
  if (resolved.response) return resolved.response;
  const body = await readSagaQuarterlyPlanningJson(request);
  if (body === null || containsSagaQuarterlyPlanningForbiddenSelector(body)) return invalidRequest();
  const parsed = sagaQuarterlyBatchAbandonSchema.safeParse(body);
  if (!parsed.success) return invalidRequest();
  const params = await context.params;
  try {
    const result = await abandonFailedSagaQuarterlyActivityPlanBatch(
      resolved.actor,
      params.brandProfileId,
      params.batchId,
      parsed.data,
    );
    return sagaQuarterlyPlanningResponse({ ...result, noPublication: true });
  } catch (error) {
    return sagaQuarterlyPlanningErrorResponse(error, "Kunde inte avsluta den misslyckade batchen.");
  }
}

function invalidRequest(): NextResponse {
  return sagaQuarterlyPlanningResponse({
    error: "Skicka idempotensnyckel, aktuella revisioner och en kort anledning. Endast en misslyckad batch kan avslutas.",
    code: "invalid_quarterly_abandon_request",
  }, 422);
}
