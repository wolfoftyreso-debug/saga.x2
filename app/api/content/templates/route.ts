import { NextRequest, NextResponse } from "next/server";
import { contentTemplateInputSchema } from "@/lib/domain/content-studio";
import { isNeonDatabaseConfigured } from "@/lib/neon/config";
import { neonWriteErrorResponse, requireNeonActor } from "@/lib/neon/http";
import { createStudioTemplate, listStudioTemplates } from "@/lib/neon/studio-content-repository";
import { contentStudioServiceConfigurationResponse } from "@/lib/services/content-studio-http";
import { createContentTemplate, listContentTemplates } from "@/lib/services/content-studio";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthenticatedUserId } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET() {
  if (isNeonDatabaseConfigured()) {
    const resolved = await requireNeonActor("Logga in för att läsa mallar.");
    if (resolved.response) return resolved.response;
    try {
      return NextResponse.json({ templates: await listStudioTemplates(resolved.actor) }, { headers: { "cache-control": "no-store" } });
    } catch (error) {
      return neonWriteErrorResponse(error, "Kunde inte läsa mallarna.");
    }
  }
  const configuration = contentStudioServiceConfigurationResponse();
  if (configuration) return configuration;
  const userId = await getAuthenticatedUserId();
  if (!userId) return NextResponse.json({ error: "Logga in för att läsa mallar." }, { status: 401 });
  try {
    return NextResponse.json({ templates: await listContentTemplates(createAdminClient(), userId) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Kunde inte läsa mallarna." }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  if (isNeonDatabaseConfigured()) {
    const resolved = await requireNeonActor("Logga in för att skapa en mall.");
    if (resolved.response) return resolved.response;
    const body = await readJson(request);
    if (body === null) return NextResponse.json({ error: "Skicka giltig JSON." }, { status: 400 });
    const payload = contentTemplateInputSchema.safeParse(body);
    if (!payload.success) return NextResponse.json({ error: "Mallen innehåller ett ogiltigt värde." }, { status: 400 });
    try {
      const template = await createStudioTemplate(resolved.actor, payload.data);
      return NextResponse.json({ template }, { status: 201, headers: { "cache-control": "no-store" } });
    } catch (error) {
      return neonWriteErrorResponse(error, "Kunde inte skapa mallen.");
    }
  }
  const configuration = contentStudioServiceConfigurationResponse();
  if (configuration) return configuration;
  const userId = await getAuthenticatedUserId();
  if (!userId) return NextResponse.json({ error: "Logga in för att skapa en mall." }, { status: 401 });
  const body = await readJson(request);
  if (body === null) return NextResponse.json({ error: "Skicka giltig JSON." }, { status: 400 });
  const payload = contentTemplateInputSchema.safeParse(body);
  if (!payload.success) return NextResponse.json({ error: "Mallen innehåller ett ogiltigt värde." }, { status: 400 });
  try {
    const template = await createContentTemplate(createAdminClient(), userId, payload.data);
    return NextResponse.json({ template }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Kunde inte skapa mallen." }, { status: 500 });
  }
}

async function readJson(request: NextRequest): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
