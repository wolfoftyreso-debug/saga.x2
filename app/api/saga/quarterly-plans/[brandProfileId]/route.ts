import { NextRequest, NextResponse } from "next/server";
import { sagaQuarterlyActivityPlanUpdateSchema } from "@/lib/domain/saga-quarterly-planning";
import {
  getSagaQuarterlyActivityPlan,
  updateSagaQuarterlyActivityPlan,
} from "@/lib/neon/saga-quarterly-planning-repository";
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

export async function GET(_request: NextRequest, context: Context): Promise<NextResponse> {
  const resolved = await requireSagaQuarterlyPlanningActor("Logga in för att öppna aktivitetsplanen.");
  if (resolved.response) return resolved.response;
  try {
    const detail = await getSagaQuarterlyActivityPlan(resolved.actor, (await context.params).brandProfileId);
    if (!detail) return sagaQuarterlyPlanningResponse({ error: "Aktivitetsplanen hittades inte i den här arbetsytan.", code: "not_found" }, 404);
    return sagaQuarterlyPlanningResponse(detail);
  } catch (error) {
    return sagaQuarterlyPlanningErrorResponse(error, "Kunde inte läsa aktivitetsplanen.");
  }
}

/**
 * Full revisioned replacement is the explicit roll/extend action: provide a
 * new Monday horizon start to replenish the next complete 13 weeks. Open
 * batches deliberately block this so no real private drafts are rewritten.
 */
export async function PATCH(request: NextRequest, context: Context): Promise<NextResponse> {
  const resolved = await requireSagaQuarterlyPlanningActor("Logga in för att ändra aktivitetsplanen.");
  if (resolved.response) return resolved.response;
  const body = await readSagaQuarterlyPlanningJson(request);
  if (body === null || containsSagaQuarterlyPlanningForbiddenSelector(body)) return invalidRequest();
  const parsed = sagaQuarterlyActivityPlanUpdateSchema.safeParse(body);
  if (!parsed.success) return invalidRequest();
  try {
    const plan = await updateSagaQuarterlyActivityPlan(resolved.actor, (await context.params).brandProfileId, parsed.data);
    return sagaQuarterlyPlanningResponse({ plan });
  } catch (error) {
    return sagaQuarterlyPlanningErrorResponse(error, "Kunde inte uppdatera aktivitetsplanen.");
  }
}

function invalidRequest(): NextResponse {
  return sagaQuarterlyPlanningResponse({
    error: "Ändringen behöver aktuell revision och ett komplett 13-veckorsunderlag utan schema, publicering eller leveransinställning.",
    code: "invalid_quarterly_plan_update",
  }, 422);
}
