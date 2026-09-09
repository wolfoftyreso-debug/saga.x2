import { NextRequest, NextResponse } from "next/server";
import { listSagaQuarterlyActivityPlanCalendarSlots } from "@/lib/neon/saga-quarterly-planning-repository";
import {
  requireSagaQuarterlyPlanningActor,
  sagaQuarterlyPlanningErrorResponse,
  sagaQuarterlyPlanningResponse,
} from "@/lib/services/saga-quarterly-planning-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Read-only `kind: plan_slot` overlay for Studio Calendar. It deliberately
 * exposes planned local time separately from a real draft's `scheduled_at`.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const resolved = await requireSagaQuarterlyPlanningActor("Logga in för att öppna aktivitetsplanens kalender.");
  if (resolved.response) return resolved.response;
  const from = request.nextUrl.searchParams.get("from") ?? "";
  const to = request.nextUrl.searchParams.get("to") ?? "";
  const timezone = request.nextUrl.searchParams.get("timezone")?.trim() || "Europe/Stockholm";
  try {
    const slots = await listSagaQuarterlyActivityPlanCalendarSlots(resolved.actor, { from, to, timezone });
    return sagaQuarterlyPlanningResponse({
      entries: slots,
      readOnly: true,
      noPublication: true,
      message: "Planerade aktiviteter är inte schemalagda eller publicerade inlägg.",
    });
  } catch (error) {
    return sagaQuarterlyPlanningErrorResponse(error, "Kunde inte läsa aktivitetsplanens kalender.");
  }
}
