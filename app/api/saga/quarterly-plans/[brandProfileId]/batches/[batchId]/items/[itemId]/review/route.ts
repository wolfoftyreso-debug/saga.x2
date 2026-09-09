import { NextRequest, NextResponse } from "next/server";
import { sagaQuarterlyBatchReviewSchema } from "@/lib/domain/saga-quarterly-planning";
import { reviewSagaQuarterlyActivityPlanBatchItem } from "@/lib/neon/saga-quarterly-planning-repository";
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

/** Human-only decision after a real, private Studio draft exists. */
export async function POST(request: NextRequest, context: Context): Promise<NextResponse> {
  const resolved = await requireSagaQuarterlyPlanningActor("Logga in för att granska det privata utkastet.");
  if (resolved.response) return resolved.response;
  const body = await readSagaQuarterlyPlanningJson(request);
  if (body === null || containsSagaQuarterlyPlanningForbiddenSelector(body)) return invalidRequest();
  const parsed = sagaQuarterlyBatchReviewSchema.safeParse(body);
  if (!parsed.success) return invalidRequest();
  const params = await context.params;
  try {
    const result = await reviewSagaQuarterlyActivityPlanBatchItem(
      resolved.actor,
      params.brandProfileId,
      params.batchId,
      params.itemId,
      parsed.data,
    );
    return sagaQuarterlyPlanningResponse({ ...result, noPublication: true });
  } catch (error) {
    return sagaQuarterlyPlanningErrorResponse(error, "Kunde inte spara granskningsbeslutet.");
  }
}

function invalidRequest(): NextResponse {
  return sagaQuarterlyPlanningResponse({
    error: "Skicka ett idempotent granskningsbeslut med aktuella plan-, batch-, objekt- och utkastrevisioner. Retur kräver en kommentar.",
    code: "invalid_quarterly_review_request",
  }, 422);
}
