import { NextRequest, NextResponse } from "next/server";
import { sagaQuarterlyBatchMaterializeSchema } from "@/lib/domain/saga-quarterly-planning";
import {
  getSagaQuarterlyActivityPlan,
  prepareSagaQuarterlyActivityPlanBatch,
} from "@/lib/neon/saga-quarterly-planning-repository";
import { runSagaQuarterlyActivityPlanWorker } from "@/lib/neon/saga-quarterly-planning-worker";
import {
  containsSagaQuarterlyPlanningForbiddenSelector,
  readSagaQuarterlyPlanningJson,
  requireSagaQuarterlyPlanningActor,
  sagaQuarterlyPlanningErrorResponse,
  sagaQuarterlyPlanningResponse,
} from "@/lib/services/saga-quarterly-planning-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

type Context = { params: Promise<{ brandProfileId: string; batchId: string }> };

/**
 * Reserves/resumes a durable receipt then performs one bounded AI+quality
 * slice. It creates only private `in_review` drafts and never an image,
 * calendar schedule, provider delivery or publication.
 */
export async function POST(request: NextRequest, context: Context): Promise<NextResponse> {
  const resolved = await requireSagaQuarterlyPlanningActor("Logga in för att skapa privata granskningsutkast.");
  if (resolved.response) return resolved.response;
  const body = await readSagaQuarterlyPlanningJson(request);
  if (body === null || containsSagaQuarterlyPlanningForbiddenSelector(body)) return invalidRequest();
  const parsed = sagaQuarterlyBatchMaterializeSchema.safeParse(body);
  if (!parsed.success) return invalidRequest();
  const params = await context.params;
  try {
    const prepared = await prepareSagaQuarterlyActivityPlanBatch(resolved.actor, params.brandProfileId, params.batchId, parsed.data);
    const worker = await runSagaQuarterlyActivityPlanWorker({
      actor: resolved.actor,
      brandProfileId: params.brandProfileId,
      batchId: params.batchId,
      materializationReceiptId: prepared.receipt.id,
      maxJobs: 1,
      workerId: "saga-quarterly-manual",
    });
    const detail = await getSagaQuarterlyActivityPlan(resolved.actor, params.brandProfileId);
    const batch = detail?.batches.find((entry) => entry.id === params.batchId) ?? prepared.batch;
    return sagaQuarterlyPlanningResponse({
      batch,
      receipt: prepared.receipt,
      worker,
      noPublication: true,
      media: "manual_action_required",
    });
  } catch (error) {
    return sagaQuarterlyPlanningErrorResponse(error, "Kunde inte starta den privata utkastsgenereringen.");
  }
}

function invalidRequest(): NextResponse {
  return sagaQuarterlyPlanningResponse({
    error: "Skicka idempotensnyckel samt aktuell plan- och batchrevision. Den här åtgärden kan inte schemalägga eller publicera.",
    code: "invalid_quarterly_materialization_request",
  }, 422);
}
