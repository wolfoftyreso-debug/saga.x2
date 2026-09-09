import { NextRequest, NextResponse } from "next/server";
import { sagaQuarterlyActivityPlanCreateSchema } from "@/lib/domain/saga-quarterly-planning";
import {
  createSagaQuarterlyActivityPlan,
  listSagaQuarterlyActivityPlanSummaries,
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

export async function GET(): Promise<NextResponse> {
  const resolved = await requireSagaQuarterlyPlanningActor("Logga in för att öppna aktivitetsplanerna.");
  if (resolved.response) return resolved.response;
  try {
    return sagaQuarterlyPlanningResponse({ plans: await listSagaQuarterlyActivityPlanSummaries(resolved.actor) });
  } catch (error) {
    return sagaQuarterlyPlanningErrorResponse(error, "Kunde inte läsa aktivitetsplanerna.");
  }
}

/** Creates only a completed-onboarding brand's private 13-week plan. */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const resolved = await requireSagaQuarterlyPlanningActor("Logga in för att skapa en aktivitetsplan.");
  if (resolved.response) return resolved.response;
  const body = await readSagaQuarterlyPlanningJson(request);
  if (body === null || containsSagaQuarterlyPlanningForbiddenSelector(body)) return invalidRequest();
  const parsed = sagaQuarterlyActivityPlanCreateSchema.safeParse(body);
  if (!parsed.success) return invalidRequest();
  try {
    const created = await createSagaQuarterlyActivityPlan(resolved.actor, parsed.data);
    return sagaQuarterlyPlanningResponse({ plan: created.plan, reused: created.reused }, created.reused ? 200 : 201);
  } catch (error) {
    return sagaQuarterlyPlanningErrorResponse(error, "Kunde inte spara aktivitetsplanen.");
  }
}

function invalidRequest(): NextResponse {
  return sagaQuarterlyPlanningResponse({
    error: "Skicka en komplett 13-veckorsplan utan arbetsyta, användare, schema, publicering eller leveransinställning.",
    code: "invalid_quarterly_plan_request",
  }, 422);
}
