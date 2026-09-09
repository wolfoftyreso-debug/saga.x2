import { NextRequest, NextResponse } from "next/server";
import { sagaQuarterlyBatchResubmitSchema } from "@/lib/domain/saga-quarterly-planning";
import { resubmitSagaQuarterlyActivityPlanBatchItem } from "@/lib/neon/saga-quarterly-planning-repository";
import {
  containsSagaQuarterlyPlanningForbiddenSelector,
  readSagaQuarterlyPlanningJson,
  requireSagaQuarterlyPlanningActor,
  sagaQuarterlyPlanningErrorResponse,
  sagaQuarterlyPlanningResponse,
} from "@/lib/services/saga-quarterly-planning-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ brandProfileId: string; batchId: string; itemId: string }> };

/** Re-enters human review after the returned private draft has been edited. */
export async function POST(request: NextRequest, context: Context): Promise<NextResponse> {
  const resolved = await requireSagaQuarterlyPlanningActor("Logga in för att skicka tillbaka utkastet till granskning.");
  if (resolved.response) return resolved.response;
  const body = await readSagaQuarterlyPlanningJson(request);
  if (body === null || containsSagaQuarterlyPlanningForbiddenSelector(body)) return invalidRequest();
  const parsed = sagaQuarterlyBatchResubmitSchema.safeParse(body);
  if (!parsed.success) return invalidRequest();
  const params = await context.params;
  try {
    const result = await resubmitSagaQuarterlyActivityPlanBatchItem(
      resolved.actor,
      params.brandProfileId,
      params.batchId,
      params.itemId,
      parsed.data,
    );
    return sagaQuarterlyPlanningResponse({ ...result, noPublication: true });
  } catch (error) {
    return sagaQuarterlyPlanningErrorResponse(error, "Kunde inte skicka tillbaka utkastet till granskning.");
  }
}

function invalidRequest(): NextResponse {
  return sagaQuarterlyPlanningResponse({
    error: "Skicka idempotensnyckel och aktuella revisioner efter att det privata utkastet har redigerats.",
    code: "invalid_quarterly_resubmit_request",
  }, 422);
}
