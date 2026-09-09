import { NextRequest, NextResponse } from "next/server";
import { contentAutomationRuleIdSchema } from "@/lib/domain/content-studio";
import { isNeonDatabaseConfigured } from "@/lib/neon/config";
import { neonWriteErrorResponse, requireNeonActor } from "@/lib/neon/http";
import { getStudioAutomation, listStudioAutomationJobs } from "@/lib/neon/studio-content-repository";
import {
  getContentAutomationRuleForUser,
  listContentAutomationJobsForRule,
} from "@/lib/services/content-studio";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthenticatedUserId } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** Private, bounded run history for the automation detail UI. */
export async function GET(request: NextRequest, context: Context) {
  if (isNeonDatabaseConfigured()) {
    const resolved = await requireNeonActor("Logga in för att läsa automationshistoriken.");
    if (resolved.response) return resolved.response;
    const id = contentAutomationRuleIdSchema.safeParse((await context.params).id);
    if (!id.success) return NextResponse.json({ error: "Ogiltigt automations-id." }, { status: 400 });
    const limit = parseLimit(new URL(request.url).searchParams.get("limit"));
    if (limit === null) return NextResponse.json({ error: "limit måste vara ett heltal mellan 1 och 100." }, { status: 400 });
    try {
      const automation = await getStudioAutomation(resolved.actor, id.data);
      if (!automation) return NextResponse.json({ error: "Automationen hittades inte." }, { status: 404 });
      const jobs = await listStudioAutomationJobs(resolved.actor, id.data, { limit });
      return NextResponse.json({ automation, jobs }, { headers: { "cache-control": "no-store" } });
    } catch (error) {
      return neonWriteErrorResponse(error, "Kunde inte läsa automationshistoriken.");
    }
  }
  const userId = await getAuthenticatedUserId();
  if (!userId) return NextResponse.json({ error: "Logga in för att läsa automationshistoriken." }, { status: 401 });
  const id = contentAutomationRuleIdSchema.safeParse((await context.params).id);
  if (!id.success) return NextResponse.json({ error: "Ogiltigt automations-id." }, { status: 400 });
  const limit = parseLimit(new URL(request.url).searchParams.get("limit"));
  if (limit === null) return NextResponse.json({ error: "limit måste vara ett heltal mellan 1 och 100." }, { status: 400 });

  try {
    const database = createAdminClient();
    const automation = await getContentAutomationRuleForUser(database, userId, id.data);
    if (!automation) return NextResponse.json({ error: "Automationen hittades inte." }, { status: 404 });
    const jobs = await listContentAutomationJobsForRule(database, userId, id.data, { limit });
    return NextResponse.json({ automation, jobs });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Kunde inte läsa automationshistoriken." }, { status: 500 });
  }
}

function parseLimit(value: string | null): number | null {
  if (value === null) return 20;
  if (!/^\d+$/.test(value)) return null;
  const limit = Number(value);
  return Number.isInteger(limit) && limit >= 1 && limit <= 100 ? limit : null;
}
