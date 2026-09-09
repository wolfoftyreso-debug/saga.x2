import { NextRequest, NextResponse } from "next/server";
import { sagaQuarterlyBatchRequestSchema } from "@/lib/domain/saga-quarterly-planning";
import { requestSagaQuarterlyActivityPlanBatch } from "@/lib/neon/saga-quarterly-planning-repository";
import {
  containsSagaQuarterlyPlanningForbiddenSelector,
  readSagaQuarterlyPlanningJson,
  requireSagaQuarterlyPlanningActor,
  sagaQuarterlyPlanningErrorResponse,
  sagaQuarterlyPlanningResponse,
} from "@/lib/services/saga-quarterly-planning-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ brandProfileId: string }> };

/** Reserves 1–10 plan slots only. The next batch stays server-locked until review resolves this one. */
export async function POST(request: NextRequest, context: Context): Promise<NextResponse> {
  const resolved = await requireSagaQuarterlyPlanningActor("Logga in för att skapa en granskningsbatch.");
  if (resolved.response) return resolved.response;
  const body = await readSagaQuarterlyPlanningJson(request);
  if (body === null || containsSagaQuarterlyPlanningForbiddenSelector(body)) return invalidRequest();
  const parsed = sagaQuarterlyBatchRequestSchema.safeParse(body);
  if (!parsed.success) return invalidRequest();
  try {
    const created = await requestSagaQuarterlyActivityPlanBatch(resolved.actor, (await context.params).brandProfileId, parsed.data);
    return sagaQuarterlyPlanningResponse({ batch: created.batch, reused: created.reused }, created.reused ? 200 : 201);
  } catch (error) {
    return sagaQuarterlyPlanningErrorResponse(error, "Kunde inte reservera granskningsbatchen.");
  }
}

function invalidRequest(): NextResponse {
  return sagaQuarterlyPlanningResponse({
    error: "Välj 1–10 unika planerade aktiviteter och skicka aktuell planrevision. Batchen kan aldrig skapa schema eller publicering.",
    code: "invalid_quarterly_batch_request",
  }, 422);
}
