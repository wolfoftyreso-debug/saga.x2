import { NextRequest, NextResponse } from "next/server";
import { contentAutomationRuleInputSchema } from "@/lib/domain/content-studio";
import { isNeonDatabaseConfigured } from "@/lib/neon/config";
import { requireNeonActor } from "@/lib/neon/http";
import { studioAutomationErrorResponse as neonWriteErrorResponse } from "@/lib/services/studio-automation-http";
import { createStudioAutomation, listStudioAutomations } from "@/lib/neon/studio-content-repository";
import { contentStudioServiceConfigurationResponse } from "@/lib/services/content-studio-http";
import { createContentAutomationRule, listContentAutomationRules } from "@/lib/services/content-studio";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthenticatedUserId } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET() {
  if (isNeonDatabaseConfigured()) {
    const resolved = await requireNeonActor("Logga in för att läsa automationer.");
    if (resolved.response) return resolved.response;
    try {
      return NextResponse.json({ automations: await listStudioAutomations(resolved.actor) }, { headers: { "cache-control": "no-store" } });
    } catch (error) {
      return neonWriteErrorResponse(error, "Kunde inte läsa automationerna.");
    }
  }
  const configuration = contentStudioServiceConfigurationResponse();
  if (configuration) return configuration;
  const userId = await getAuthenticatedUserId();
  if (!userId) return NextResponse.json({ error: "Logga in för att läsa automationer." }, { status: 401 });
  try {
    return NextResponse.json({ automations: await listContentAutomationRules(createAdminClient(), userId) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Kunde inte läsa automationerna." }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  if (isNeonDatabaseConfigured()) {
    const resolved = await requireNeonActor("Logga in för att skapa en automation.");
    if (resolved.response) return resolved.response;
    const body = await readJson(request);
    if (body === null) return NextResponse.json({ error: "Skicka giltig JSON." }, { status: 400 });
    const payload = contentAutomationRuleInputSchema.safeParse(body);
    if (!payload.success) return NextResponse.json({ error: "Automationen innehåller ett ogiltigt värde." }, { status: 400 });
    try {
      const automation = await createStudioAutomation(resolved.actor, payload.data);
      return NextResponse.json({ automation }, { status: 201, headers: { "cache-control": "no-store" } });
    } catch (error) {
      return neonWriteErrorResponse(error, "Kunde inte skapa automationen.");
    }
  }
  const configuration = contentStudioServiceConfigurationResponse();
  if (configuration) return configuration;
  const userId = await getAuthenticatedUserId();
  if (!userId) return NextResponse.json({ error: "Logga in för att skapa en automation." }, { status: 401 });
  const body = await readJson(request);
  if (body === null) return NextResponse.json({ error: "Skicka giltig JSON." }, { status: 400 });
  const payload = contentAutomationRuleInputSchema.safeParse(body);
  if (!payload.success) return NextResponse.json({ error: "Automationen innehåller ett ogiltigt värde." }, { status: 400 });
  try {
    const automation = await createContentAutomationRule(createAdminClient(), userId, payload.data);
    return NextResponse.json({ automation }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Kunde inte skapa automationen." }, { status: 500 });
  }
}

async function readJson(request: NextRequest): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
