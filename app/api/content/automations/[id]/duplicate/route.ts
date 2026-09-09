import { NextRequest, NextResponse } from "next/server";
import { contentAutomationRuleIdSchema } from "@/lib/domain/content-studio";
import { isNeonDatabaseConfigured } from "@/lib/neon/config";
import { requireNeonActor } from "@/lib/neon/http";
import { studioAutomationErrorResponse as neonWriteErrorResponse } from "@/lib/services/studio-automation-http";
import { createStudioAutomation, getStudioAutomation } from "@/lib/neon/studio-content-repository";
import { duplicateContentAutomationRule } from "@/lib/services/content-studio";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthenticatedUserId } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** Copies settings only. The new automation starts paused so it cannot queue work unexpectedly. */
export async function POST(_request: NextRequest, context: Context) {
  if (isNeonDatabaseConfigured()) {
    const resolved = await requireNeonActor("Logga in för att duplicera automationen.");
    if (resolved.response) return resolved.response;
    const id = contentAutomationRuleIdSchema.safeParse((await context.params).id);
    if (!id.success) return NextResponse.json({ error: "Ogiltigt automations-id." }, { status: 400 });
    try {
      const source = await getStudioAutomation(resolved.actor, id.data);
      if (!source) return NextResponse.json({ error: "Automationen hittades inte." }, { status: 404 });
      const automation = await createStudioAutomation(resolved.actor, {
        brandProfileId: source.brandProfileId,
        name: `${source.name} (kopia)`.slice(0, 160),
        active: false,
        contentType: source.contentType,
        channels: source.channels,
        templateId: source.templateId,
        seriesId: source.seriesId,
        newsletterAudienceId: source.newsletterAudienceId,
        generationPrompt: source.generationPrompt,
        imagePrompt: source.imagePrompt,
        desiredLength: source.desiredLength,
        tone: source.tone,
        language: source.language,
        approvalRequired: source.approvalRequired,
        timezone: source.timezone,
        scheduleMode: source.scheduleMode,
        weeklyCount: source.weeklyCount,
        weekdays: source.weekdays,
        localTimes: source.localTimes,
        cronExpression: source.cronExpression,
        startsOn: source.startsOn,
        endsOn: source.endsOn,
      });
      return NextResponse.json({ automation }, { status: 201, headers: { "cache-control": "no-store" } });
    } catch (error) {
      return neonWriteErrorResponse(error, "Kunde inte duplicera automationen.");
    }
  }
  const userId = await getAuthenticatedUserId();
  if (!userId) return NextResponse.json({ error: "Logga in för att duplicera automationen." }, { status: 401 });
  const id = contentAutomationRuleIdSchema.safeParse((await context.params).id);
  if (!id.success) return NextResponse.json({ error: "Ogiltigt automations-id." }, { status: 400 });
  try {
    const automation = await duplicateContentAutomationRule(createAdminClient(), userId, id.data);
    if (!automation) return NextResponse.json({ error: "Automationen hittades inte." }, { status: 404 });
    return NextResponse.json({ automation }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Kunde inte duplicera automationen." }, { status: 500 });
  }
}
